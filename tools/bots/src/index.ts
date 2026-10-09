import WebSocket from 'ws';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { getHeapSpaceStatistics } from 'node:v8';
import { mulberry32, type ServerMsg } from '@aetherfall/shared';
import {
  baselineFromEntities,
  encodeInputBinary,
  P2_MAGIC,
  P2SnapshotDecoder,
  PROTO2_VERSION,
  P2Type,
  type P2ApplyInPlaceResult,
  type P2Baseline,
  type P2ServerFrame,
} from '@aetherfall/shared/dist/protocol2.js';
// TERRAIN: water and lava are solid + damaging on the server, so the
// swarm steers around hazardAt() tiles instead of drowning on its waypoints.
import { DEFAULT_WORLD_SEED } from '@aetherfall/engine';
import { hazardAvoid, pickSafeWaypoint, steerAwayFromHazards } from './hazards.js';

/** How far a bot walks away from a hazard it happens to start inside. */
export const HAZARD_ESCAPE_UNITS = 4;

// Headless bot swarm: scale-harden load harness for AETHERFALL (Node 22, ws).
// Usage (call the entry DIRECTLY — never via `npm run start -- --flags`):
//   node tools/bots/dist/index.js --bots 100 --server ws://localhost:8081 --duration 20 --report tools/bots/report.csv
//   npm v11 swallows `--flag value` (runs `node dist/index.js <values>` = defaults:
//   20 bots). `=` form survives as npm_config_* and is honoured, but direct
//   `node` is the only supported path (see docs/SCALE.md "scale runbook").
//   node dist/index.js --bots 100 --proto 2 --server ws://localhost:8081 --duration 20
//     -> binary wire (same profiles/inputs, frames decoded via protocol2; the
//        server must accept proto:2 — default offer-accept or PROTO=2)
//   node dist/index.js --bots 1000 --workers 5 --server ws://localhost:8081 --duration 30
//     -> orchestrator forks 5 x 200-bot shards (recommend 200/process: ~40-80MB RSS each)
//   node dist/index.js --bots 200 --offset 400 --workers 0   # manual shard (5th of 5x200)
//   node dist/index.js --bots 150 --chunk 0 --server ws://localhost:8081 --duration 10
//     -> --chunk 0 (default) = fully concurrent, peak == --bots. --chunk 100
//        restores the old sequential batches (peak == chunk) to bound RAM.
//        Budget ~0.65MB RSS/bot (measured: 653MB for 1000) => 150 bots ≈ 100MB.
// Env fallback: SERVER, BOTS, DURATION, CHAOS, ANTICHEAT
//   (+ CHUNK, PROTO, WORKERS, RECONNECT, SEED, INPUT_HZ, REPORT;
//   npm `=` form via npm_config_*).
// Probes: --chaos (packet flood vs server 15ms rate-limit), --anticheat (teleport clamp check)
//         --no-chaos / --no-anticheat to skip. Both ON by default (shard 0 / orchestrator only).
// Profiles: deterministic 20/60/20 split by bot index — idle 20% (i%5==0),
//   fighter 20% (i%5==1), roam 60% (else). Honest 20Hz input (server floor 15ms),
//   unit-circle normalized moves -> 0 anticheat violations expected.

export type Args = {
  bots: number;
  server: string;
  duration: number;
  chaos: boolean;
  anticheat: boolean;
  seed: number;
  report: string;
  inputHz: number;
  workers: number;
  offset: number;
  reconnect: boolean;
  /** Wire protocol the swarm speaks: 1 = v1 JSON, 2 = binary (auto-fallback to JSON when declined). */
  proto: 1 | 2;
  /**
   * Per-process concurrency cap: 0 (default) = all bots concurrently
   * (peak == --bots). >0 restores sequential batching (peak == chunk) to
   * bound RAM at ~0.65MB/bot. Env CHUNK, flag --chunk.
   */
  chunk: number;
};

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    // --flag=value form
    const pref = flag + '=';
    const found = argv.find((a) => a.startsWith(pref));
    return found ? found.slice(pref.length) : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const envTrue = (v: string | undefined): boolean | undefined => {
    if (v === undefined) return undefined;
    return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
  };
  // npm v11 swallows `--flag value` (space form) into bare positionals and
  // `--flag=value` (= form) into npm_config_* env. Honour the = form so
  // `npm run start -- --bots=7` still works; the space form is unrecoverable
  // (flag names are lost) and must be run via `node dist/index.js` directly.
  // Values of exactly "true"/"false" are the space-form artefact — ignore
  // them for numeric/string options.
  const npmVal = (name: string): string | undefined => {
    const v = process.env[`npm_config_${name}`] ?? process.env[`NPM_CONFIG_${name.toUpperCase()}`];
    if (v === undefined || v === '' || v === 'true' || v === 'false') return undefined;
    return v;
  };
  const bots = Number(get('--bots') ?? process.env.BOTS ?? npmVal('bots') ?? 20);
  const server = get('--server') ?? process.env.SERVER ?? npmVal('server') ?? 'ws://localhost:8081';
  const duration = Number(get('--duration') ?? process.env.DURATION ?? npmVal('duration') ?? 30);
  // Probes default ON (cheap, single connection each). Opt out with --no-chaos/--no-anticheat.
  let chaos = envTrue(process.env.CHAOS) ?? true;
  let anticheat = envTrue(process.env.ANTICHEAT) ?? true;
  if (has('--chaos')) chaos = true;
  if (has('--no-chaos')) chaos = false;
  if (has('--anticheat')) anticheat = true;
  if (has('--no-anticheat')) anticheat = false;
  const seed = Number(get('--seed') ?? process.env.SEED ?? npmVal('seed') ?? 1337);
  const report =
    get('--report') ??
    process.env.REPORT ??
    npmVal('report') ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'report.csv');
  const inputHz = Number(get('--input-hz') ?? process.env.INPUT_HZ ?? npmVal('input-hz') ?? npmVal('inputhz') ?? 20);
  const workersRaw = Number(get('--workers') ?? process.env.WORKERS ?? npmVal('workers') ?? 1);
  const offsetRaw = Number(get('--offset') ?? process.env.OFFSET ?? npmVal('offset') ?? 0);
  let reconnect = envTrue(process.env.RECONNECT) ?? true;
  // npm = form for booleans: --reconnect=false / --no-reconnect=true land here.
  const npmReconnect = process.env.npm_config_reconnect ?? process.env.npm_config_no_reconnect;
  if (npmReconnect !== undefined && npmReconnect !== '' && npmReconnect !== 'true' && has('--reconnect') === false && has('--no-reconnect') === false) {
    // Only the = form carries a usable value; bare "true" is the space-form artefact.
    if (npmReconnect !== 'true') reconnect = envTrue(npmReconnect) ?? reconnect;
  }
  if (has('--no-reconnect')) reconnect = false;
  if (has('--reconnect')) reconnect = true;
  const protoRaw = String(get('--proto') ?? process.env.PROTO ?? npmVal('proto') ?? '1').toLowerCase();
  const proto: 1 | 2 = protoRaw === '2' || protoRaw === 'v2' || protoRaw === 'binary' ? 2 : 1;
  const chunkRaw = Number(get('--chunk') ?? process.env.CHUNK ?? npmVal('chunk') ?? 0);
  return {
    bots: Number.isFinite(bots) ? Math.max(0, Math.floor(bots)) : 20,
    server,
    duration: Number.isFinite(duration) ? Math.max(1, duration) : 30,
    chaos,
    anticheat,
    seed: Number.isFinite(seed) ? seed : 1337,
    report,
    inputHz: Number.isFinite(inputHz) && inputHz > 0 ? Math.min(66, inputHz) : 20,
    workers: Number.isFinite(workersRaw) ? Math.max(0, Math.floor(workersRaw)) : 1,
    offset: Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0,
    reconnect,
    proto,
    chunk: Number.isFinite(chunkRaw) ? Math.max(0, Math.floor(chunkRaw)) : 0,
  };
}

/**
 * True when argv looks like npm-mangled flags: bare values with no dashes
 * (npm v11 runs `node dist/index.js 7 1 ...` for `--bots 7 --duration 1`).
 * Callers should fail fast with "use node directly" instead of silently
 * running defaults (20 bots). Exported for tests.
 */
export function isNpmMangledArgs(argv: string[]): boolean {
  if (argv.length === 0) return false;
  if (argv.some((a) => a.startsWith('-'))) return false;
  // All bare tokens + running under npm lifecycle = mangled.
  if (!process.env.npm_lifecycle_event && !process.env.npm_config_bots) return false;
  return true;
}

/**
 * Batch sizes for runShard: chunk<=0 => single fully-concurrent batch;
 * else sequential batches of `chunk`. Exported for tests.
 */
export function chunkBatchSizes(total: number, chunk: number): number[] {
  const n = Math.max(0, Math.floor(total));
  const c = Math.max(0, Math.floor(chunk));
  if (n === 0) return [];
  if (c <= 0 || c >= n) return [n];
  const out: number[] = [];
  for (let s = 0; s < n; s += c) out.push(Math.min(c, n - s));
  return out;
}

/**
 * Extract the redirect target from a server `event` message.
 * Returns the ws/wss URL or null when this is not a redirect.
 * Accepts v1 JSON payload objects ({url}) and binary-lane string payloads.
 */
export function parseRedirectUrl(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { t?: unknown; kind?: unknown; payload?: unknown };
  if (m.t !== 'event' || m.kind !== 'redirect') return null;
  const p = m.payload;
  if (typeof p === 'string') {
    // Binary lane carries payload as a string: try JSON, else raw URL.
    const s = p.trim();
    if (!s) return null;
    try {
      const o = JSON.parse(s) as { url?: unknown };
      if (typeof o.url === 'string' && o.url) return o.url;
    } catch { /* not JSON */ }
    return /^wss?:\/\//.test(s) ? s : null;
  }
  if (p && typeof p === 'object') {
    const url = (p as { url?: unknown }).url;
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

export type BotProfile = 'idle' | 'roam' | 'fighter';

/** Deterministic 20/60/20 split: i%5==0 -> idle, i%5==1 -> fighter, else roam. */
export function profileFor(i: number): BotProfile {
  const m = ((i % 5) + 5) % 5;
  if (m === 0) return 'idle';
  if (m === 1) return 'fighter';
  return 'roam';
}

export type BotMetrics = {
  bot: number;
  name: string;
  profile: BotProfile;
  connectMs: number;
  welcomeMs: number;
  snapshots: number;
  msgs: number;
  inputsSent: number;
  chatsSent: number;
  attacksSent: number;
  reconnects: number;
  /** Shard redirects followed (event kind=redirect with payload.url). */
  redirects: number;
  tickGaps: number;
  maxTickGap: number;
  disconnected: number;
  /** Ticks where hazard repulsion bent the heading away from water/lava. */
  hazardAvoids: number;
  /** Waypoints rejected because they sat in a hazard tile. */
  hazardWaypoints: number;
  /** Highest hazard dps the bot ever stood next to (0 = never approached). */
  hazardSeenDps: number;
  error: string;
  /** Wire protocol this bot actually spoke (2 only after a binary welcome). */
  proto: 1 | 2;
  /** Inbound payload bytes (JSON text + binary frames) for B/s comparisons. */
  bytesDown: number;
  /** Binary frames decoded (0 on a v1 connection). */
  binaryFrames: number;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Opt-in RSS sampler (`BOT_MEMLOG=1`): logs process rss/heap/ext every 5s so
 * soak runs can attribute memory slope without a profiler attached.
 */
if (process.env.BOT_MEMLOG === '1') {
  const t0 = Date.now();
  setInterval(() => {
    const mu = process.memoryUsage();
    const mb = (v: number): string => (v / 1024 / 1024).toFixed(1);
    let spaces = '';
    try {
      spaces =
        ' ' +
        getHeapSpaceStatistics()
          .map((s) => `${s.space_name}=${mb(s.space_used_size)}MB`)
          .join(' ');
    } catch {
      /* v8 stats unavailable */
    }
    console.log(
      `[bots-memlog] t=${((Date.now() - t0) / 1000).toFixed(0)}s rss=${mb(mu.rss)}MB heap=${mb(mu.heapUsed)}MB ext=${mb(mu.external + mu.arrayBuffers)}MB${spaces}`,
    );
  }, 5000).unref?.();
}

const CHAT_LINES = [
  'gg', 'lfg', 'anyone at spawn?', 'lag?', 'nice', 'watch out east',
  'heal pls', 'push mid', 'brb', 'wp', 'need backup', 'lol',
];

/**
 * Pooled-lane hit counters (module scope, reported in `summarize`):
 * `pooled` = snapshot frames decoded into reused scratch + applied in
 * place, `classic` = binary frames that fell through to the allocating
 * decode. Steady state should be ~100% pooled.
 */
export const pooledLane = { pooled: 0, classic: 0, skipped: 0 };

export async function runBot(
  i: number,
  server: string,
  durationSec: number,
  seed: number,
  inputHz: number,
  reconnect: boolean,
  wantProto: 1 | 2 = 1,
): Promise<BotMetrics> {
  const profile = profileFor(i);
  const rng = mulberry32(seed + i * 7919);
  const name = `bot${i}`;
  const m: BotMetrics = {
    bot: i, name, profile, connectMs: -1, welcomeMs: -1,
    snapshots: 0, msgs: 0, inputsSent: 0, chatsSent: 0,
    attacksSent: 0, reconnects: 0, redirects: 0, tickGaps: 0, maxTickGap: 0,
    disconnected: 0, hazardAvoids: 0, hazardWaypoints: 0, hazardSeenDps: 0, error: '',
    proto: 1, bytesDown: 0, binaryFrames: 0,
  };
  // Stagger connects: 5 bots per ms -> bot i waits floor(i/5) ms (2x gentler
  // than the old 10/ms burst; 1000 bots => ~200ms spread, no SYN storm).
  if (i >= 5) await sleep(Math.floor(i / 5));
  const deadline = Date.now() + durationSec * 1000;
  let attempt = 0;
  // Redirect follow: sticky/overflow routing sends {t:event,kind=redirect,
  // payload:{url,shard}} then closes. Reconnect to the new URL with the SAME
  // name (preserves identity) and count it separately from reconnects.
  // Redirects never consume the reconnect budget and use no backoff.
  let targetServer = server;
  const MAX_REDIRECTS = 10;
  // PERF (v2 decode pooling): one pooled snapshot decoder per bot, reused
  // across every frame and reconnect. Snapshot scratch (readers, string
  // table, entity records) is overwritten index-aligned per frame and the
  // baseline map is mutated in place, so the steady-state receive path
  // allocates nothing per snapshot (see P2SnapshotDecoder).
  const decoder = new P2SnapshotDecoder();

  // Reconnect loop with exponential backoff (200ms * 2^attempt + jitter, cap 2s,
  // max 5 reconnects). Honest bots should see 0 reconnects; anything higher
  // signals server accept/backpressure trouble.
  while (true) {
    const outcome = await connectOnce(targetServer);
    if (outcome.redirect) {
      m.redirects++;
      if (m.redirects > MAX_REDIRECTS) {
        if (!m.error) m.error = `too-many-redirects:${m.redirects}`;
        break;
      }
      targetServer = outcome.redirect;
      continue;
    }
    if (Date.now() >= deadline) break;
    // connectOnce resolves graceful on end-of-run, drop otherwise.
    if (outcome.graceful) break;
    if (!reconnect || attempt >= 5) break;
    const backoff = Math.min(2000, 200 * 2 ** attempt) + rng() * 100;
    attempt++;
    m.reconnects++;
    await sleep(backoff);
  }
  m.disconnected = 1;
  return m;

  function connectOnce(target: string): Promise<{ graceful: boolean; redirect: string | null }> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let ws: WebSocket;
      try {
        ws = new WebSocket(target);
      } catch (e) {
        if (!m.error) m.error = `connect-throw:${String(e).slice(0, 80)}`;
        resolve({ graceful: false, redirect: null });
        return;
      }
      let seq = 0;
      let done = false;
      let gotWelcome = m.welcomeMs >= 0;
      let lastTick = -1;
      // Redirect target captured from an event before the server closes.
      // finish() reports it so the outer loop reconnects to the new URL.
      let redirectUrl: string | null = null;
      // Proto-2 state: set once the binary welcome arrives (auto-fallback keeps
      // JSON when the server answers in v1 instead — `upgraded` stays false).
      let upgraded = false;
      let baseline: P2Baseline = new Map();
      let baseTick = 0;
      // Waypoint steering state (roam/fighter).
      // TERRAIN: the shard's world seed — hazards are a pure function of it,
      // so the client-side steering agrees with the server's collision + DOT.
      const worldSeed = Number(process.env.WORLD_SEED ?? DEFAULT_WORLD_SEED);
      let wx = rng() * 100;
      let wy = rng() * 100;
      let wpAge = 0;
      let px = 50 + (rng() - 0.5) * 20;
      let py = 50 + (rng() - 0.5) * 20;
      // Snap the bot onto a hazard-free tile so a run never starts drowning.
      const startProbe = hazardAvoid(px, py, worldSeed);
      if (startProbe.weight > 0) {
        px -= startProbe.x * HAZARD_ESCAPE_UNITS;
        py -= startProbe.y * HAZARD_ESCAPE_UNITS;
        const wp = pickSafeWaypoint(rng, worldSeed);
        wx = wp.x;
        wy = wp.y;
      }
      const finish = (graceful: boolean): void => {
        if (done) return;
        done = true;
        try { ws.close(); } catch { /* noop */ }
        resolve({ graceful, redirect: redirectUrl });
      };
      const failTimer = setTimeout(() => {
        if (m.connectMs < 0 && m.reconnects === 0 && !redirectUrl) {
          if (!m.error) m.error = 'connect-timeout';
          finish(false);
        }
      }, 10000);
      const remaining = Math.max(500, deadline - Date.now());
      const stopTimer = setTimeout(() => finish(true), Math.min(remaining + 1500, durationSec * 1000 + 2000));

      ws.on('open', () => {
        if (m.connectMs < 0) m.connectMs = Date.now() - t0;
        ws.send(
          wantProto === 2
            ? JSON.stringify({
              t: 'hello',
              name,
              proto: 2,
              caps: { binary: true, deltas: true, keyframe: 50, chat: true, event: true },
            })
            : JSON.stringify({ t: 'hello', name, proto: 1 }),
        );
      });
      /** One input out on whichever lane the connection negotiated. */
      const sendInputFrame = (input: {
        seq: number;
        dt: number;
        move: { x: number; y: number };
        attack?: boolean;
        chat?: string;
      }): void => {
        try {
          // An upgraded socket only accepts binary frames (anything else is an
          // anticheat strike); chat rides inside the input, never as `t:chat`.
          ws.send(upgraded ? encodeInputBinary({ t: 'input', input }) : JSON.stringify({ t: 'input', input }));
          m.inputsSent++;
        } catch (e) {
          if (!m.error) m.error = `send-err:${String(e).slice(0, 60)}`;
        }
      };
      ws.on('error', (e: Error) => {
        if (!m.error) m.error = `ws-error:${String(e.message ?? e).slice(0, 80)}`;
      });
      ws.on('close', () => {
        clearTimeout(failTimer);
        clearTimeout(stopTimer);
        if (iv) clearInterval(iv);
        // A redirect close reconnects to the new URL (outer loop), not a drop.
        if (redirectUrl) {
          finish(false);
          return;
        }
        // Early close before the deadline = drop (reconnect may retry).
        // Close at/after deadline or after graceful stop = end of run.
        finish(Date.now() >= deadline - 500);
      });
      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        m.msgs++;
        m.bytesDown += raw.length;
        // ---- binary lane (proto:2 negotiated) ----
        if (isBinary) {
          m.binaryFrames++;
          // Fast drop: the swarm never reads chat/ack content (no branch
          // below consumes them), so they are counted and released without a
          // decode — observably identical to decode-then-ignore, minus the
          // per-frame table decode. Welcome/event/snapshot still decode.
          if (
            raw.length >= 5 &&
            raw[0] === P2_MAGIC &&
            raw[1] === PROTO2_VERSION &&
            (raw[2] === P2Type.Chat || raw[2] === P2Type.Ack)
          ) {
            pooledLane.skipped++;
            return;
          }
          // Single-decode pooled dispatch: one framing pass per message.
          // Snapshot records come from reused decoder scratch and apply
          // into the baseline in place (no per-frame Maps / entity copies).
          let bmsg: P2ServerFrame;
          try {
            bmsg = decoder.decodeServerFrame(raw, baseline);
          } catch {
            return;
          }
          pooledLane.pooled++;
          if (bmsg.t === 'welcome') {
            upgraded = true;
            m.proto = 2;
            if (!gotWelcome) {
              gotWelcome = true;
              m.welcomeMs = Date.now() - t0;
            }
            baseline = baselineFromEntities(bmsg.snapshot);
            baseTick = bmsg.tick;
            lastTick = bmsg.tick;
            return;
          }
          if (bmsg.t === 'snapshot') {
            m.snapshots++;
            // Same tick-drift probe as the JSON lane below (10Hz => steps of 2).
            if (lastTick >= 0 && bmsg.tick > lastTick + 2) {
              const gap = bmsg.tick - lastTick - 2;
              m.tickGaps += gap;
              if (gap > m.maxTickGap) m.maxTickGap = gap;
            }
            lastTick = bmsg.tick;
            let applied: P2ApplyInPlaceResult;
            try {
              applied = decoder.applySnapshotInPlace(bmsg, baseline, baseTick);
            } catch {
              return;
            }
            if (!applied.ok) return; // drift: wait for the next keyframe
            baseTick = applied.baseTick;
            return;
          }
          if (bmsg.t === 'event' && bmsg.kind === 'kicked' && !m.error) m.error = 'kicked:shadowban';
          if (bmsg.t === 'event') {
            const url = parseRedirectUrl(bmsg);
            if (url && !redirectUrl) {
              redirectUrl = url;
              try { ws.close(); } catch { /* noop */ }
            }
          }
          return;
        }
        // ---- v1 JSON lane (unchanged, also the proto:2 fallback) ----
        try {
          const msg = JSON.parse(String(raw)) as ServerMsg;
          if (msg.t === 'welcome' && !gotWelcome) {
            gotWelcome = true;
            m.welcomeMs = Date.now() - t0;
          } else if (msg.t === 'snapshot') {
            m.snapshots++;
            // Tick-drift probe: gaps in the server tick sequence per connection.
            // Nominal 10Hz => tick steps of 2 (20Hz sim, snapshot every 2nd tick).
            if (lastTick >= 0 && msg.tick > lastTick + 2) {
              const gap = msg.tick - lastTick - 2;
              m.tickGaps += gap;
              if (gap > m.maxTickGap) m.maxTickGap = gap;
            }
            lastTick = msg.tick;
          } else if (msg.t === 'event') {
            const kind = (msg as { kind?: string }).kind;
            if (kind === 'kicked' && !m.error) m.error = 'kicked:shadowban';
            const url = parseRedirectUrl(msg);
            if (url && !redirectUrl) {
              redirectUrl = url;
              try { ws.close(); } catch { /* noop */ }
            }
          }
        } catch { /* ignore malformed */ }
      });

      // Input loop per profile:
      // - idle: 1Hz heartbeat (seq only, zero move) — keeps the connection live
      //   without load, models AFK/tabbed-out players.
      // - roam: waypoint steering at inputHz + jitter; 5% chat, 2% attack.
      // - fighter: same steering, 8% chat, 30% attack (models combat load).
      // Moves are unit-circle normalized honest input (no anticheat trips).
      const period = Math.round(1000 / inputHz);
      const idlePeriod = 1000;
      const iv = setInterval(
        () => {
          if (ws.readyState !== 1) return;
          if (Date.now() >= deadline) return;
          seq++;
          if (profile === 'idle') {
            sendInputFrame({ seq, dt: 1, move: { x: 0, y: 0 } });
            return;
          }
          wpAge++;
          const dx = wx - px;
          const dy = wy - py;
          const dist = Math.hypot(dx, dy);
          if (dist < 3 || wpAge > inputHz * 8) {
            // TERRAIN: waypoints avoid hazard tiles (water/lava) so the swarm
            // spends its time moving and fighting, not drowning.
            const wp = pickSafeWaypoint(rng, worldSeed);
            wx = wp.x; wy = wp.y; wpAge = 0;
          }
          const inv = 1 / Math.max(1e-6, Math.hypot(wx - px, wy - py));
          const jx = (rng() - 0.5) * 0.6;
          const jy = (rng() - 0.5) * 0.6;
          let mx = (wx - px) * inv + jx;
          let my = (wy - py) * inv + jy;
          let ml = Math.hypot(mx, my) || 1;
          mx /= ml; my /= ml;
          // TERRAIN: bend the heading away from any hazard within ~11u. On dry
          // ground this is a no-op, so bots that never approach water steer
          // exactly as they did before terrain existed.
          const steered = steerAwayFromHazards(px, py, mx, my, worldSeed);
          if (steered.avoid.weight > 0) {
            m.hazardAvoids++;
            if (steered.avoid.threat > m.hazardSeenDps) m.hazardSeenDps = steered.avoid.threat;
          }
          mx = steered.x;
          my = steered.y;
          px += mx * 8 * (period / 1000);
          py += my * 8 * (period / 1000);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const input: any = { seq, dt: period / 1000, move: { x: mx, y: my } };
          const attackP = profile === 'fighter' ? 0.3 : 0.02;
          const chatP = profile === 'fighter' ? 0.08 : 0.05;
          if (rng() < attackP) { input.attack = true; m.attacksSent++; }
          if (rng() < chatP) {
            input.chat = CHAT_LINES[Math.floor(rng() * CHAT_LINES.length)];
            m.chatsSent++;
          }
          sendInputFrame(input);
        },
        profile === 'idle' ? idlePeriod : period,
      );

      // Normal end of this attempt: stop input, close gracefully.
      const myRemaining = Math.max(500, deadline - Date.now());
      setTimeout(() => {
        clearInterval(iv);
        clearTimeout(failTimer);
        try { ws.close(); } catch { /* noop */ }
        setTimeout(() => finish(true), 1500);
      }, myRemaining);
    });
  }
}

// --- Chaos probe: packet flood to verify server rate-limit (15ms min gap) ---
// Sends 300 inputs back-to-back on one connection, then checks the server
// survived (still sending snapshots) and rate-limited (accepted seq << sent,
// because inputs <15ms apart are dropped). A shadow-ban KICK after
// 3 strikes also counts as PASS (abuser contained). PASS = survived+limited OR kicked.
async function chaosProbe(server: string): Promise<{ pass: boolean; detail: string }> {
  const FLOOD = 300;
  return new Promise((resolve) => {
    const ws = new WebSocket(server);
    let sent = 0;
    let snapshots = 0;
    let lastSeq = -1;
    let myId = -1;
    let kicked = false;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      resolve({ pass: false, detail: `timeout sent=${sent} snaps=${snapshots}` });
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'chaos-probe', proto: 1 })));
    ws.on('error', (e: Error) => {
      // A kick-close surfaces as ws error/close; verdict below handles it.
      if (!kicked) {
        clearTimeout(timer);
        resolve({ pass: false, detail: `ws-error ${String(e.message ?? e).slice(0, 100)}` });
      }
    });
    ws.on('close', () => {
      if (kicked) {
        clearTimeout(timer);
        const limited = lastSeq >= 0 && lastSeq < FLOOD / 2;
        resolve({
          pass: limited || sent > 0,
          detail: `sent=${sent} acceptedSeq=${lastSeq} snaps=${snapshots} SHADOWBAN-KICK (contained)`,
        });
      }
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as ServerMsg;
        if (msg.t === 'welcome') {
          myId = msg.id;
          // Flood: 300 inputs with zero delay (violates 15ms min gap on purpose).
          for (let s = 1; s <= FLOOD; s++) {
            ws.send(JSON.stringify({
              t: 'input',
              input: { seq: s, dt: 0.001, move: { x: 1, y: 0 } },
            }));
            sent = s;
          }
        } else if (msg.t === 'snapshot') {
          snapshots++;
          const me = msg.entities.find((e) => e.id === myId);
          if (me && typeof me.seq === 'number') lastSeq = me.seq;
          // Give the server ~2s of snapshots post-flood, then verdict.
          if (Date.now() - t0 > 2500 && snapshots >= 2) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* noop */ }
            // Server applies first input then drops the burst: accepted seq should be
            // far below sent (only inputs spaced >=15ms apart pass; a tight loop
            // passes ~1). Allow generous margin: pass if accepted < 50% of sent.
            const limited = lastSeq >= 0 && lastSeq < FLOOD / 2;
            const pass = snapshots > 0 && limited;
            resolve({
              pass,
              detail: `sent=${sent} acceptedSeq=${lastSeq} snaps=${snapshots} ` +
                (limited ? 'rate-limit ACTIVE' : 'rate-limit NOT observed'),
            });
          }
        } else if (msg.t === 'event' && (msg as { kind?: string }).kind === 'kicked') {
          kicked = true;
          // Verdict on close (server will drop the socket right after the event).
          setTimeout(() => {
            clearTimeout(timer);
            try { ws.close(); } catch { /* noop */ }
            resolve({
              pass: true,
              detail: `sent=${sent} acceptedSeq=${lastSeq} snaps=${snapshots} SHADOWBAN-KICK (contained)`,
            });
          }, 500);
        }
      } catch { /* ignore */ }
    });
  });
}

// --- Anticheat probe: teleport hack attempt must be rejected ---
// The protocol has no client-position write; movement is velocity-only and the
// server clamps move to [-1,1] (speed 8 u/s). We send an illegal move
// {x:9999,y:9999} and verify the resulting velocity/position stays clamped:
// |v| <= 8*sqrt(2) and no position jump. PASS = clamped.
async function anticheatProbe(server: string): Promise<{ pass: boolean; detail: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(server);
    let myId = -1;
    let before: { x: number; y: number } | null = null;
    let snaps = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      resolve({ pass: false, detail: `timeout snaps=${snaps}` });
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'anticheat-probe', proto: 1 })));
    ws.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ pass: false, detail: `ws-error ${String(e.message ?? e).slice(0, 100)}` });
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as ServerMsg;
        if (msg.t === 'welcome') {
          myId = msg.id;
          const me = msg.snapshot.find((e) => e.id === myId);
          if (me) before = { x: me.p.x, y: me.p.y };
          // Teleport hack attempt: illegal move magnitude (honest client: |move|<=1).
          ws.send(JSON.stringify({
            t: 'input',
            input: { seq: 1, dt: 0.05, move: { x: 9999, y: 9999 } },
          }));
        } else if (msg.t === 'snapshot') {
          const me = msg.entities.find((e) => e.id === myId);
          if (!me) return;
          snaps++;
          if (snaps >= 3 && before) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* noop */ }
            const moved = Math.hypot(me.p.x - before.x, me.p.y - before.y);
            const speed = Math.hypot(me.v.x, me.v.y);
            // Generous bounds: 3 snapshots @10Hz worst case ~= 0.4s * 8u/s = 3.2u
            // plus spawn jitter; teleport would move hundreds of units.
            const clamped = moved < 20 && speed <= 8 * Math.SQRT2 + 0.01;
            resolve({
              pass: clamped,
              detail: `moved=${moved.toFixed(2)}u speed=${speed.toFixed(2)}u/s ` +
                (clamped ? 'CLAMPED (rejected)' : 'NOT clamped - EXPLOITABLE'),
            });
          }
        }
      } catch { /* ignore */ }
    });
  });
}

export function summarize(rows: BotMetrics[], wallMs: number): void {
  const ok = rows.filter((r) => r.connectMs >= 0);
  const conn = ok.map((r) => r.connectMs).sort((a, b) => a - b);
  const avg = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const p50 = conn.length ? conn[Math.floor(conn.length * 0.5)] : 0;
  const p95 = conn.length ? conn[Math.floor(conn.length * 0.95)] : 0;
  const totSnaps = rows.reduce((s, r) => s + r.snapshots, 0);
  const totMsgs = rows.reduce((s, r) => s + r.msgs, 0);
  const totInputs = rows.reduce((s, r) => s + r.inputsSent, 0);
  const totChats = rows.reduce((s, r) => s + r.chatsSent, 0);
  const totAttacks = rows.reduce((s, r) => s + r.attacksSent, 0);
  const totReconnects = rows.reduce((s, r) => s + r.reconnects, 0);
  const totRedirects = rows.reduce((s, r) => s + r.redirects, 0);
  const totGaps = rows.reduce((s, r) => s + r.tickGaps, 0);
  const maxGap = rows.reduce((m, r) => Math.max(m, r.maxTickGap), 0);
  const totBytes = rows.reduce((s, r) => s + r.bytesDown, 0);
  const totBin = rows.reduce((s, r) => s + r.binaryFrames, 0);
  const v2bots = rows.filter((r) => r.proto === 2).length;
  const totAvoid = rows.reduce((s, r) => s + r.hazardAvoids, 0);
  const totHazardWp = rows.reduce((s, r) => s + r.hazardWaypoints, 0);
  const maxDps = rows.reduce((m, r) => Math.max(m, r.hazardSeenDps), 0);
  const drops = rows.filter((r) => r.disconnected).length;
  const errs = rows.filter((r) => r.error).length;
  const profCount = (p: BotProfile): number => rows.filter((r) => r.profile === p).length;
  const mu = process.memoryUsage();
  const rssMb = mu.rss / 1024 / 1024;
  const heapMb = mu.heapUsed / 1024 / 1024;
  const extMb = (mu.external + mu.arrayBuffers) / 1024 / 1024;
  const wallS = Math.max(0.001, wallMs / 1000);
  const perBot = Math.max(1, ok.length);
  console.log('--- swarm summary ---');
  console.log(`bots: requested=${rows.length} connected=${ok.length} errors=${errs} disconnects=${drops} reconnects=${totReconnects} redirects=${totRedirects}`);
  console.log(`profiles: idle=${profCount('idle')} roam=${profCount('roam')} fighter=${profCount('fighter')}`);
  console.log(`connect ms: avg=${avg(conn).toFixed(1)} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)}`);
  console.log(`snapshots: total=${totSnaps} rate=${(totSnaps / wallS).toFixed(1)}/s (≈${(totSnaps / perBot / wallS).toFixed(2)}/s/bot, server emits 10Hz)`);
  console.log(`messages: total=${totMsgs} rate=${(totMsgs / wallS).toFixed(1)}/s`);
  console.log(`inputs sent: total=${totInputs} rate=${(totInputs / wallS).toFixed(1)}/s chats=${totChats} attacks=${totAttacks}`);
  console.log(`tick drift: totalGaps=${totGaps} maxGap=${maxGap} ticks (gap = missed 20Hz sim ticks between snapshots)`);
  console.log(`wire: proto mix v1=${rows.length - v2bots} v2=${v2bots} bytesDown=${totBytes} rate=${(totBytes / wallS).toFixed(0)}B/s (≈${(totBytes / perBot / wallS).toFixed(0)}B/s/bot) binaryFrames=${totBin}`);
  console.log(`pooled decode: pooled=${pooledLane.pooled} classic=${pooledLane.classic} skipped=${pooledLane.skipped} (chat/ack content is never read by the swarm)`);
  console.log(`terrain: hazardAvoidTicks=${totAvoid} hazardWaypoints=${totHazardWp} maxDpsSeen=${maxDps.toFixed(1)}`);
  console.log(`memory: rss=${rssMb.toFixed(1)}MB heap=${heapMb.toFixed(1)}MB ext=${extMb.toFixed(1)}MB total (${(rssMb / Math.max(1, rows.length)).toFixed(3)}MB/bot this process)`);
}

export function writeCsv(rows: BotMetrics[], path: string): void {
  const header = 'bot,name,profile,connect_ms,welcome_ms,snapshots,msgs,inputs_sent,chats_sent,attacks_sent,reconnects,redirects,tick_gaps,max_tick_gap,disconnected,hazard_avoids,hazard_waypoints,hazard_max_dps,error,proto,bytes_down,binary_frames';
  const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [r.bot, r.name, r.profile, r.connectMs, r.welcomeMs, r.snapshots, r.msgs, r.inputsSent,
      r.chatsSent, r.attacksSent, r.reconnects, r.redirects, r.tickGaps, r.maxTickGap, r.disconnected,
      r.hazardAvoids, r.hazardWaypoints, r.hazardSeenDps, esc(r.error),
      r.proto, r.bytesDown, r.binaryFrames].join(','),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, header + '\n' + lines.join('\n') + '\n');
}

/** Merge per-shard CSVs (same CSV header + redirects/proto/bytes columns) into one report. */
function mergeShardCsvs(dir: string, base: string, shards: number, out: string): void {
  const header = 'bot,name,profile,connect_ms,welcome_ms,snapshots,msgs,inputs_sent,chats_sent,attacks_sent,reconnects,redirects,tick_gaps,max_tick_gap,disconnected,hazard_avoids,hazard_waypoints,hazard_max_dps,error,proto,bytes_down,binary_frames';
  const lines: string[] = [header];
  for (let k = 0; k < shards; k++) {
    const p = resolve(dir, `${base}.shard${k}.csv`);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8').trim().split('\n');
    for (let i = 1; i < raw.length; i++) {
      if (raw[i].trim()) lines.push(raw[i]);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + '\n');
}

async function runShard(a: Args): Promise<BotMetrics[]> {
  const rows: BotMetrics[] = [];
  // Concurrency: chunk<=0 (default) launches all bots concurrently
  // (peak == --bots). --chunk N restores sequential batches (peak == N)
  // to bound RAM at ~0.65MB/bot. runBot staggers connects at 5/ms.
  for (const size of chunkBatchSizes(a.bots, a.chunk)) {
    const chunk: Promise<BotMetrics>[] = [];
    const start = rows.length;
    for (let i = start; i < start + size; i++) {
      chunk.push(runBot(a.offset + i, a.server, a.duration, a.seed, a.inputHz, a.reconnect, a.proto));
    }
    rows.push(...await Promise.all(chunk));
  }
  return rows;
}

async function main(): Promise<void> {
  // npm v11 swallows `--flag value` (space form): `npm run start -- --bots 150`
  // runs `node dist/index.js 150 ...` (bare values, flag names lost) and the
  // swarm would silently run DEFAULTS (20 bots). Fail fast instead; the only
  // supported paths are `node dist/index.js --bots 150 ...` or the `=` form
  // (`npm run start -- --bots=150`, honoured via npm_config_*). See docs/SCALE.md.
  if (isNpmMangledArgs(process.argv.slice(2))) {
    console.error('[bots] ERROR: flags were swallowed by npm (got bare values, no --flags).');
    console.error('[bots] Run the entry directly: node tools/bots/dist/index.js --bots 150 --server ws://localhost:8081 --duration 20');
    console.error('[bots] (or use the = form: npm run start -- --bots=150 --server=ws://localhost:8081 --duration=20)');
    process.exit(2);
    return;
  }
  const a = parseArgs(process.argv.slice(2));
  const isChild = !!process.env.AETHERFALL_BOT_SHARD;
  // Sharded launcher: --workers K forks K child processes (200/process recommended
  // for 1000 bots: --bots 1000 --workers 5). Each child runs a slice with --offset.
  if (a.workers > 1 && !isChild) {
    const shards = Math.min(a.workers, Math.max(1, a.bots));
    const perShard = Math.ceil(a.bots / shards);
    console.log(`[bots] sharded launcher shards=${shards} bots=${a.bots} perShard≈${perShard} server=${a.server} duration=${a.duration}s`);
    const selfPath = process.argv[1];
    const dir = dirname(a.report);
    const base = basename(a.report, '.csv');
    const kids: Promise<number>[] = [];
    for (let k = 0; k < shards; k++) {
      const start = k * perShard;
      const count = Math.min(perShard, a.bots - start);
      if (count <= 0) continue;
      const shardReport = resolve(dir, `${base}.shard${k}.csv`);
      const args = [
        selfPath,
        '--bots', String(count),
        '--offset', String(a.offset + start),
        '--workers', '0',
        '--server', a.server,
        '--duration', String(a.duration),
        '--seed', String(a.seed),
        '--input-hz', String(a.inputHz),
        '--proto', String(a.proto),
        '--chunk', String(a.chunk),
        '--report', shardReport,
        '--no-chaos',
        '--no-anticheat',
        ...(a.reconnect ? [] : ['--no-reconnect']),
      ];
      kids.push(new Promise((resolveKid) => {
        const child = spawn(process.execPath, args, {
          env: { ...process.env, AETHERFALL_BOT_SHARD: String(k) },
          stdio: 'inherit',
        });
        child.on('exit', (code) => resolveKid(code ?? 0));
        child.on('error', () => resolveKid(1));
      }));
    }
    const t0 = Date.now();
    const codes = await Promise.all(kids);
    const wallMs = Date.now() - t0;
    mergeShardCsvs(dir, base, shards, a.report);
    console.log(`[bots] shards done exit=[${codes.join(',')}] wall=${(wallMs / 1000).toFixed(1)}s csv -> ${a.report}`);
    if (a.chaos) {
      console.log('[bots] chaos probe: packet flood (300 inputs, zero delay)...');
      const r = await chaosProbe(a.server).catch((e) => ({ pass: false, detail: `throw ${String(e).slice(0, 100)}` }));
      console.log(`[bots] chaos probe: ${r.pass ? 'PASS' : 'FAIL'} - ${r.detail}`);
    }
    if (a.anticheat) {
      console.log('[bots] anticheat probe: teleport hack attempt (move=9999)...');
      const r = await anticheatProbe(a.server).catch((e) => ({ pass: false, detail: `throw ${String(e).slice(0, 100)}` }));
      console.log(`[bots] anticheat probe: ${r.pass ? 'PASS' : 'FAIL'} - ${r.detail}`);
    }
    const bad = codes.filter((c) => c !== 0).length;
    process.exit(bad > shards / 2 ? 1 : 0);
    return;
  }

  console.log(`[bots] swarm start bots=${a.bots} offset=${a.offset} server=${a.server} duration=${a.duration}s ` +
    `inputHz=${a.inputHz} proto=${a.proto} chunk=${a.chunk} chaos=${a.chaos} anticheat=${a.anticheat} seed=${a.seed} reconnect=${a.reconnect}`);
  const wall0 = Date.now();
  const rows = await runShard(a);
  const wallMs = Date.now() - wall0;
  summarize(rows, wallMs);
  writeCsv(rows, a.report);
  console.log(`[bots] csv -> ${a.report}`);

  // Probes run on single-process runs with offset 0 and on the orchestrator;
  // per-shard children skip them (orchestrator runs once) to avoid N floods.
  const runProbes = a.offset === 0 && !isChild;
  if (a.chaos && runProbes) {
    console.log('[bots] chaos probe: packet flood (300 inputs, zero delay)...');
    const r = await chaosProbe(a.server).catch((e) => ({ pass: false, detail: `throw ${String(e).slice(0, 100)}` }));
    console.log(`[bots] chaos probe: ${r.pass ? 'PASS' : 'FAIL'} - ${r.detail}`);
  }
  if (a.anticheat && runProbes) {
    console.log('[bots] anticheat probe: teleport hack attempt (move=9999)...');
    const r = await anticheatProbe(a.server).catch((e) => ({ pass: false, detail: `throw ${String(e).slice(0, 100)}` }));
    console.log(`[bots] anticheat probe: ${r.pass ? 'PASS' : 'FAIL'} - ${r.detail}`);
  }
  const failed = rows.filter((r) => r.connectMs < 0).length;
  process.exit(failed > rows.length / 2 ? 1 : 0);
}

// Import-safe: tests import parseArgs without launching the swarm.
const invokedAsMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch((e) => { console.error('[bots] fatal', e); process.exit(1); });
}
