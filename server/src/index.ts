// @aetherfall/server — authoritative 20Hz WS, snapshots 10Hz, interest-filtered.
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL_VERSION, TICK_HZ, type ClientMsg, type ServerMsg } from '@aetherfall/shared';
import { Sim } from './sim.js';
import { InterestIndex, InterestTracker } from './interest.js';
import { AntiCheat, safeParseClientMsg } from './anticheat.js';
import { DB } from './db.js';
import { maxPlayersPerShard, queuePositionEvent, resolveIdentity, revokeToken, revokedTokenCount, validateHello } from './auth.js';
import { auditKick, auditJoin, auditQueue, auditRedirect, auditWallChange, auditWallRejected } from './audit.js';
import { ShardNode, ShardRouter } from './shard.js';
import { helloRouteKey } from './router/hash.js';
import { Matchmaker } from './matchmaking.js';
import { createChatBus } from './router/pubsub.js';
import { metrics } from './metrics.js';
import { TickScheduler } from './tick.js';
// OPS: structured JSON logging (LOG_JSON=1) with
// tick/request correlation, plus SIGTERM drain mode (stop accepting -> finish
// tick -> flush DB -> 5s hard timeout). Additive: nothing below is removed.
import { OpsLog, nextRequestId } from './opslog.js';
import { DrainController } from './drain.js';
// PERF: tick histogram + slow-tick (>50ms) log w/ section
// breakdown, appended to GET /metrics.
import { perf } from './perf.js';
// PROTO2: negotiated binary protocol v2 + the serialize-once
// per-tick pre-pass that feeds it (quantize the world once, splice per viewer).
import {
  binaryProtocolEnabled,
  createSession,
  dropSession,
  keyframeEveryFromEnv,
  negotiateInbound,
  prequantizeSnapshot,
  v1Forced,
  v2Forced,
  type BinarySession,
} from './net/binary.js';
import { createServer } from 'node:http';
// WALLS: boot load + admin POST /walls (additive).
import { findWallsFile, isAdminRequest, loadWallsFile, parseWallsBody, saveWallsFile, wallsToDoc } from './walls.js';
import {
  checkWallsRateLimit,
  isAdminAllowed,
  warnIfDefaultAdmin,
  MAX_WALLS_BODY_BYTES,
} from './walls.js';
// GAMEPLAY: aggregate mob/quest/trade events; protocol-v1 safe (`event` payloads only).
// MELEE: playerMeleeAttack resolves `input.attack` against SPAWNER mobs
// (the deterministic worldgen population) in addition to the AI brains, and is
// what finally calls onMobKilled -> mob-die / xp-gain / pickup-spawn.
import {
  clearMeleeCooldown,
  createGameState,
  ensurePlayer as ensureGamePlayer,
  playerMeleeAttack,
  removePlayer as removeGamePlayer,
  sanitizeChat,
  setPlayerPos as setGamePlayerPos,
  tickGameplay,
} from './game/index.js';
const __game = createGameState(1337);
const __mobEntity = new Map<number, number>(); // gameplay mob id -> engine entity id
import { NPCManager } from './ai/npc.js';
import { QuestGiverDialogue } from './ai/dialogue.js';
import { unifiedMobSnapshot } from './game/mobs.js';
// SYSTEMS: composes the pure systems/* modules (progression,
// social, economy) into one session behind the `SYSTEMS` feature flag.
// Defaults to on; `SYSTEMS=0` restores the legacy XP/inventory/chat path
// verbatim (nothing in game/* was removed). See docs/SYSTEMS.md#Integration.
import {
  applyIntegratedChat,
  createGameSession,
  parseChatCommand as parseSysCommand,
  systemsEnabledFromEnv,
  tickIntegrated,
  type IntegratedOut,
  type SessionPlayer,
} from './game/integrated.js';

const __systems = createGameSession({ enabled: systemsEnabledFromEnv(process.env, true) });

const PORT = Number(process.env.PORT ?? 8081);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9090);

const sim = new Sim();
const interest = new InterestTracker();
// Perf path (snapshot hot path): bucket entities once per snapshot tick, per-viewer
// collect via stamp-marked scratch — replaces O(P*E) filter per player.
const interestIndex = new InterestIndex(20);
/** Reused per viewer; holds indices into the current `full` snapshot. */
const visibleScratch: number[] = [];
// PROTO2: reused per tick; index-aligned with `full` after prequantizeSnapshot.
const quantScratch: import('@aetherfall/shared/dist/protocol2.js').P2Quant[] = [];
// WALLS: load ./data/walls.json on boot when present (open arena otherwise).
try {
  const walls = loadWallsFile();
  sim.setWalls(walls);
  const src = findWallsFile();
  console.log(`[server] walls loaded=${walls.length}${src ? ` file=${src}` : ' (open arena)'}`);
} catch (err) {
  console.warn('[server] walls: boot load failed, using open arena', err);
}
// SEC: warn when the admin surface runs on the dev default token.
warnIfDefaultAdmin();
const anticheat = new AntiCheat();
const db = new DB();
const shards = ShardRouter.fromEnv();
const shardNode = new ShardNode(shards.localShardId);
const matchmaker = new Matchmaker(shards);
// Overflow admission: when set, a full local shard enqueues the join and
// redirects to the least-loaded shard. Default 500 (see auth.ts).
const MAX_PLAYERS_PER_SHARD = maxPlayersPerShard();
// Cross-shard global chat relay (in-process bus, redis when REDIS_URL set).
// Echo suppression via origin: our own publishes never rebroadcast locally.
const chatBus = createChatBus();
chatBus.subscribe((msg) => {
  if (msg.origin === shards.localShardId || msg.channel !== 'global') return;
  broadcast({ t: 'chat', from: msg.from.slice(0, 16), text: msg.text.slice(0, 200), channel: 'global' });
});
// AI-NPC: minions (FSM+BT) + 2 bosses, ticked at 10Hz inside the sim loop.
const npcs = new NPCManager();
const dialogues = new Map<number, QuestGiverDialogue>();

/** Players + spawner mobs + NPCs/bosses merged — the single source for interest + snapshots. */
function fullSnapshot() {
  return sim.snapshot().concat(unifiedMobSnapshot(__game.spawner, npcs));
}

// Perf path (snapshot hot path): serialize each entity ONCE per snapshot tick instead of
// once per viewer that can see it. JSON.stringify was measured at 92-98% of the
// snapshot section; pre-serializing the entity list and splicing per-viewer
// fragments is byte-identical to the old output and ~10-15x faster on that
// stage (see docs/BENCHMARKS.md).
const entityJson: string[] = [];
/**
 * Pooled fragment scratch for snapshotFrame (egress-profile).
 *
 * `Array.join('')` materializes the frame in a single flat string, while the
 * old `+=` loop built a rope of one segment per visible entity that `ws.send`
 * then had to flatten (a second O(bytes) pass) before utf8-encoding. Loopback
 * measurement with real `ws` sockets: join+send is ~31% cheaper end-to-end
 * per 10KB frame than rope+send at identical bytes (see docs/BENCHMARKS.md).
 * The array is sized once (2V+5 entries) and reused every tick; use is strictly
 * sequential inside the viewer loop, so sharing is safe.
 */
const frameParts: string[] = [];
/**
 * Build the snapshot frame for a viewer without re-serializing entities.
 * Byte-identical to JSON.stringify({t:'snapshot',tick,entities,removed}).
 */
function snapshotFrame(tick: number, visibleIdx: number[], removed: number[]): string {
  frameParts.length = 0;
  frameParts.push('{"t":"snapshot","tick":', String(tick), ',"entities":[');
  for (let i = 0; i < visibleIdx.length; i++) {
    if (i > 0) frameParts.push(',');
    frameParts.push(entityJson[visibleIdx[i]!]!);
  }
  frameParts.push('],"removed":[');
  for (let i = 0; i < removed.length; i++) {
    if (i > 0) frameParts.push(',');
    frameParts.push(String(removed[i]));
  }
  frameParts.push(']}');
  return frameParts.join('');
}
/** Pre-serialize every entity for this tick (call once, before the viewer loop). */
function serializeEntities(full: import('@aetherfall/shared').EntitySnapshot[]): void {
  entityJson.length = full.length;
  for (let i = 0; i < full.length; i++) entityJson[i] = JSON.stringify(full[i]);
}

// Example gameplay extension point (combat/AI systems plug in here):
// sim.registerSystem((s, dt) => { /* mutate s.players */ }, false);

const wss = new WebSocketServer({ port: PORT });
const sockets = new Map<number, WebSocket>();
/** Raw auth token per player (for server-side revocation on kick). */
const tokensByPid = new Map<number, string>();
let nextId = 1;

/** Revoke + kick bookkeeping shared by every shadowban-kick site. */
function kickPlayer(pid: number, ws: WebSocket, reason: string): void {
  const tok = tokensByPid.get(pid);
  if (tok) revokeToken(tok);
  metrics.incReject('shadowban');
  auditKick({ pid, reason, strikes: anticheat.getStrikes(pid) });
  send(ws, { t: 'event', kind: 'kicked', payload: { reason, strikes: anticheat.getStrikes(pid) } });
  try { ws.close(4403, reason); } catch { /* noop */ }
}

console.log(`[server] AETHERFALL authoritative tick=${TICK_HZ}Hz port=${PORT} shard=${shards.localShardId} db=${db.backend} systems=${__systems.enabled ? 'on' : 'off'}`);

// OPS: identity labels on aetherfall_info + the drain
// controller. `drain` is referenced by the WS connection gate, the tick loop
// and /healthz; it is declared here because those sites need it at call time.
const opsLog = new OpsLog({ base: { shard: shards.localShardId, port: PORT } });
opsLog.event('server-boot', {
  tickHz: TICK_HZ,
  port: PORT,
  metricsPort: METRICS_PORT,
  db: db.backend,
  logJson: opsLog.json,
});
metrics.setInfo({
  shard: shards.localShardId,
  version: process.env.AETHERFALL_VERSION ?? '0.1.0',
  protocol: PROTOCOL_VERSION,
  backend: db.backend,
});
metrics.setShardCapacity(MAX_PLAYERS_PER_SHARD);

// OPS: never die silently. An uncaught exception or unhandled
// rejection outside the per-message try/catch (tick loop, timers, connection
// setup) used to kill the process with only a stderr line as evidence —
// invisible unless CI artefacts are downloaded. Now the stack is logged to
// BOTH stderr (captured in shard-0.err.log, uploaded as a CI artefact) and
// the structured log, then the process exits non-zero so supervisors and CI
// gates observe a clean failure instead of a hang followed by ECONNREFUSED.
function fatal(kind: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? message) : message;
  try {
    console.error(`[fatal] ${kind}: ${stack}`);
  } catch {
    /* stderr may be gone; opsLog below is the backup */
  }
  try {
    opsLog.error(`fatal-${kind}`, { message });
  } catch {
    /* logging must never throw inside a fatal handler */
  }
  process.exit(1);
}
process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
console.log(`[server] runtime node=${process.version} platform=${process.platform} arch=${process.arch}`);

// TICK: drift-compensating scheduler handle. Declared here so
// the drain `stop-loop` step registered below can stop it; assigned once the
// fixed-step loop is created at the bottom of this module.
let tickScheduler: TickScheduler | null = null;

const drain = new DrainController({
  log: opsLog,
  onState: (state) => {
    metrics.draining = state === 'draining' ? 1 : 0;
  },
});
drain.addSteps({
  // 1) stop accepting: new handshakes are refused with 1013 (try again elsewhere).
  'stop-accepting': () => {
    opsLog.event('drain-stop-accepting', { players: sockets.size });
  },
  // 2) tell live clients to reconnect elsewhere before the sockets go away.
  'notify-clients': () => {
    broadcast({ t: 'event', kind: 'server-draining', payload: { shard: shards.localShardId } });
    for (const ws of wss.clients) {
      try {
        ws.close(1013, 'server draining');
      } catch {
        /* noop */
      }
    }
  },
  // 3) stop the loop, then flush + close persistence.
  'stop-loop': () => {
    tickScheduler?.stop();
  },
  'flush-db': () => {
    try {
      db.flushSnapshots();
      db.close();
      opsLog.event('drain-db-flushed', { players: sockets.size });
    } catch (err) {
      opsLog.error('drain-db-flush-failed', { err });
    }
  },
  'close-listeners': () => {
    try {
      metricsServer.close();
      wss.close();
    } catch {
      /* noop */
    }
  },
});

// OPS: opt-in control port. POSIX gets SIGTERM for
// free; Windows has no equivalent, so `CONTROL_PORT=<port>` exposes the same
// drain through HTTP. Off by default — never expose it publicly.
//   POST /drain  -> begin the drain (202), or 200 with the previous report
//   GET  /healthz-> same body as the metrics port plus `controlPort`
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 0);
let controlServer: import('node:http').Server | null = null;
if (Number.isFinite(CONTROL_PORT) && CONTROL_PORT > 0) {
  controlServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/drain' && req.method === 'POST') {
      const first = drain.state === 'running';
      void drain.shutdown('control-drain').then((report) => {
        opsLog.event('drain-report', { reason: report.reason, steps: report.steps, timedOut: report.timedOut });
      });
      res.writeHead(first ? 202 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, draining: true, alreadyDraining: !first }));
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...shardNode.health(sim.tick), players: sockets.size, controlPort: CONTROL_PORT, draining: drain.state !== 'running' }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  controlServer.listen(CONTROL_PORT, () => {
    opsLog.event('control-listening', { controlPort: CONTROL_PORT });
  });
}
drain.addStep('close-control', () => {
  try {
    controlServer?.close();
  } catch {
    /* noop */
  }
});

// PROTO2: negotiated binary protocol v2 (default) + the
// serialize-once per-tick pre-pass that feeds it (quantize the world once,
// splice per viewer). A connection speaks binary when its hello offered
// `proto:2` + `caps.binary` and the env policy allowed it (`PROTO=1` pins v1,
// `PROTO=2` forces v2 with caps probing bypassed, unset/garbage = offer
// accepted); every other socket keeps the exact v1 JSON path below.
// See docs/PROTOCOL2.md.
const proto2Forced = v2Forced();
const proto2Enabled = binaryProtocolEnabled();
const proto2Pinned = v1Forced();
console.log(
  `[server] protocol v2 binary default, v1 JSON fallback (${
    proto2Pinned ? 'PROTO=1 pins v1' : proto2Forced ? 'PROTO=2 forces v2' : 'client capability offer'
  }) keyframeEvery=${keyframeEveryFromEnv()}`,
);
/** Per-connection v2 state (delta baseline, keyframe counter, last input seq). */
const sessions = new WeakMap<WebSocket, BinarySession>();
/** Sockets currently upgraded to binary frames. */
const binarySockets = new WeakSet<WebSocket>();
/** Live count of upgraded sockets, so the tick loop skips unused pre-passes. */
let binaryCount = 0;

/** The v2 session for this socket, created on first frame (v2 default unless pinned). */
function sessionOf(ws: WebSocket): BinarySession {
  let sess = sessions.get(ws);
  if (!sess) {
    sess = createSession({ enabled: proto2Enabled && !proto2Pinned });
    sessions.set(ws, sess);
  }
  return sess;
}

/** Flip a socket onto binary frames after the handshake agreed. */
function upgradeSession(ws: WebSocket, keyframeEvery: number): void {
  const sess = sessionOf(ws);
  sess.enableBinary(keyframeEvery);
  sess.upgrade();
  if (!binarySockets.has(ws)) {
    binarySockets.add(ws);
    binaryCount++;
  }
}

/** Forget v2 state on disconnect (keeps the live counter honest). */
function releaseSession(ws: WebSocket): void {
  if (binarySockets.delete(ws)) binaryCount--;
  dropSession(sessions, ws);
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState !== 1) return;
  // Binary lane: after the upgrade every frame in both directions is binary.
  const sess = binarySockets.has(ws) ? sessions.get(ws) : undefined;
  if (sess) {
    const bytes = sess.encode(msg);
    ws.send(bytes);
    // OPS: frame-kind + wire-byte accounting for the /metrics wire panel.
    metrics.observeFrame('binary', bytes.length);
    if (msg.t === 'snapshot' || msg.t === 'welcome') metrics.observeSnapshot(bytes.length);
    return;
  }
  const s = JSON.stringify(msg);
  ws.send(s);
  metrics.observeFrame('json', s.length);
  if (msg.t === 'snapshot' || msg.t === 'welcome') metrics.observeSnapshot(s.length);
}

/** Perf path: send an already-serialized frame (skips JSON.stringify). */
function sendRaw(ws: WebSocket, s: string): void {
  if (ws.readyState === 1) {
    ws.send(s);
    metrics.observeFrame('json', s.length);
    metrics.observeSnapshot(s.length);
  }
}

/** Perf path (v2): send a binary frame from the tick-wide pre-pass. */
function sendBinary(ws: WebSocket, bytes: Uint8Array): void {
  if (ws.readyState === 1) {
    ws.send(bytes);
    metrics.observeFrame('binary', bytes.length);
    metrics.observeSnapshot(bytes.length);
  }
}

/** Personal event lane: deliver to one player only (no-op if they left). */
/**
 * PROTO2: one message out on whichever lane the socket negotiated.
 * Broadcast lanes keep the single-`JSON.stringify` fan-out for v1 sockets and
 * encode per upgraded socket, so a mixed fleet never sees a frame its
 * negotiated protocol cannot decode.
 */
function sendLane(ws: WebSocket, msg: ServerMsg, preSerialized: string | null = null): void {
  if (ws.readyState !== 1) return;
  const sess = binarySockets.has(ws) ? sessions.get(ws) : undefined;
  if (sess) {
    ws.send(sess.encode(msg));
    return;
  }
  ws.send(preSerialized ?? JSON.stringify(msg));
}

function sendTo(id: number, msg: ServerMsg): void {
  const ws = sockets.get(id);
  if (ws) sendLane(ws, msg);
}

/** Proximity lane: deliver to an explicit recipient list (unknown ids ignored). */
function sendToMany(ids: number[], msg: ServerMsg): void {
  let json: string | null = null;
  for (const id of ids) {
    const ws = sockets.get(id);
    if (!ws || ws.readyState !== 1) continue;
    const sess = binarySockets.has(ws) ? sessions.get(ws) : undefined;
    if (sess) {
      ws.send(sess.encode(msg));
      continue;
    }
    if (json === null) json = JSON.stringify(msg);
    ws.send(json);
  }
}

/**
 * MELEE: fan one gameplay event out on the correct lane.
 *
 * Events whose payload carries `playerId` describe that player's private state
 * (xp-gain, quest-progress/complete, levelup, and the pickup-spawn echoes of
 * their own kills), so they go to exactly one socket. World-visible events
 * (mob-die, mob-spawn/respawn/aggro) broadcast. Before this split every kill's
 * XP and loot landed on all N sockets, which both leaked private state and
 * multiplied the per-kill fan-out by N at the one place the snapshot profile
 * called out as the hot path.
 */
function emitGameEvent(kind: string, payload: unknown): void {
  const owner = (payload as { playerId?: number } | null)?.playerId;
  if (__systems.enabled && owner !== undefined && __systems.has(owner)) {
    const absorbed = absorbLegacyXp(kind, payload as Record<string, unknown>, owner);
    if (absorbed) return;
  }
  if (owner === undefined) {
    broadcast({ t: 'event', kind, payload });
    return;
  }
  sendTo(owner, { t: 'event', kind, payload });
}

/**
 * SYSTEMS: with the composed session on, the systems progression curve is
 * the SINGLE XP authority, so the legacy `quests.addXp` events must not also
 * reach the client — otherwise two curves (level*100 and 50*L*(L+1)) would race
 * on the same HUD bar.
 *
 * - `xp-gain`      -> absorbed, the amount is re-granted through
 *                    `GameSession.awardXp` (progression curve + party split).
 * - `levelup`      -> absorbed; the session emits its own, carrying the talent
 *                    points awarded.
 * - `quest-complete`-> still forwarded (the client tracks the chain) but its
 *                    `rewardXp` is also granted through the session.
 *
 * Returns true when the event must NOT be forwarded. Safe no-op when the
 * feature flag is off: the legacy path is byte-for-byte unchanged.
 */
function absorbLegacyXp(kind: string, payload: Record<string, unknown>, playerId: number): boolean {
  const xp = Number(payload['rewardXp'] ?? payload['amount'] ?? 0);
  if (kind === 'xp-gain') {
    if (Number.isFinite(xp) && xp > 0) deliverSystems(__systems.awardXp(playerId, xp, Date.now()));
    return true;
  }
  if (kind === 'levelup') return true;
  if (kind === 'quest-complete') {
    if (Number.isFinite(xp) && xp > 0) deliverSystems(__systems.awardXp(playerId, xp, Date.now()));
    return false;
  }
  return false;
}

function broadcast(msg: ServerMsg, except?: number): void {
  // PROTO2: one JSON.stringify for the v1 sockets (unchanged fan-out),
  // one binary encode per upgraded socket.
  let json: string | null = null;
  for (const [id, ws] of sockets) {
    if (id === except || ws.readyState !== 1) continue;
    const sess = binarySockets.has(ws) ? sessions.get(ws) : undefined;
    if (sess) {
      const bytes = sess.encode(msg);
      ws.send(bytes);
      metrics.observeFrame('binary', bytes.length);
      continue;
    }
    if (json === null) json = JSON.stringify(msg);
    ws.send(json);
    metrics.observeFrame('json', json.length);
  }
}

/** Local broadcast + cross-shard relay for global chat. */
function broadcastGlobal(from: string, text: string, except?: number): void {
  broadcast({ t: 'chat', from, text, channel: 'global' }, except);
  chatBus.publish({ from, text, channel: 'global', origin: shards.localShardId, at: Date.now() });
}

/**
 * SYSTEMS: deliver composed-session output. `event` goes out as protocol v1
 * `{t:'event',kind,payload}` — broadcast, or privately when `recipients` is set
 * (party snapshots, progression, wallet, vendor stock). `chat` becomes a plain
 * `{t:'chat'}` frame to just the recipients inside the 10 m radius.
 */
function deliverSystems(out: IntegratedOut[]): void {
  for (const o of out) {
    if (o.type === 'chat') {
      const msg: ServerMsg = { t: 'chat', from: o.from, text: o.text, channel: o.channel };
      sendToMany(o.recipients, msg);
      continue;
    }
    const msg: ServerMsg = { t: 'event', kind: o.kind, payload: o.payload };
    if (o.recipients) sendToMany(o.recipients, msg);
    else broadcast(msg);
  }
}

/**
 * SYSTEMS: reusable `SessionPlayer` views for the tick so the composed
 * session never allocates in the 20 Hz hot path (one stable object per player,
 * mutated in place; pruned on disconnect).
 */
const sysViews = new Map<number, SessionPlayer>();
const sysViewList: SessionPlayer[] = [];

function collectSystemViews(): SessionPlayer[] {
  sysViewList.length = 0;
  for (const p of sim.players.values()) {
    let v = sysViews.get(p.id);
    if (!v) {
      v = { id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp };
      sysViews.set(p.id, v);
    }
    v.name = p.name;
    v.x = p.x;
    v.y = p.y;
    v.hp = p.hp;
    v.maxHp = p.maxHp;
    sysViewList.push(v);
  }
  return sysViewList;
}

wss.on('connection', (ws) => {
  let pid = -1;
  // OPS: correlation id for this connection; every log
  // line emitted while handling its frames carries it.
  // OPS: the prefix below used to run outside any try/catch, so a throw
  // here (logging, id minting, drain gate) was an uncaughtException = instant
  // silent process death on the first connection. Now it refuses one socket
  // instead of killing the shard. (The fatal handlers above remain as the
  // backstop for throws anywhere else outside a handler.)
  let requestId: string;
  try {
    requestId = nextRequestId();
  } catch {
    try {
      ws.close(1011, 'internal error');
    } catch {
      /* noop */
    }
    return;
  }
  // Drain gate: once SIGTERM lands we refuse new joins with 1013 ("try again
  // later") instead of admitting a player we cannot finish their session for.
  if (!drain.accepting) {
    try {
      opsLog.event('connection-refused', { requestId, reason: 'draining' });
    } catch {
      /* logging must never break the gate */
    }
    try {
      ws.close(1013, 'server draining');
    } catch {
      /* noop */
    }
    return;
  }
  try {
    opsLog.event('connection-open', { requestId });
  } catch {
    /* logging must never break admission */
  }
  /** Set when this hello offered proto 2; consumed at the welcome (PROTO2). */
  let pendingV2: { proto: 1 | 2; reason: string; keyframeEvery: number } | null = null;

  ws.on('message', (raw) => {
    try {
      // ---- PROTO2: negotiate on hello, then run the v1 chain ----------
      // `m` stays the single v1-shaped ClientMsg for every protocol: a decoded
      // P2Input is re-wrapped as `{t:'input',input}`, so the anticheat, NPC and
      // chat pipeline below is shared verbatim instead of duplicated.
      let m: ClientMsg | null = null;
      if (binarySockets.has(ws)) {
        // Upgraded: every frame in both directions is binary from here on.
        const f = sessionOf(ws).decodeClient(raw);
        if (f && f.t === 'input') m = { t: 'input', input: f.input };
        else anticheat.checkMalformed(pid > 0 ? pid : 0, sim.tick, 'binary frame dropped');
        if (!m) return;
      } else if (pid <= 0) {
        // Handshake probe — only before admission, so the v1 input hot path
        // (20 Hz per player) never pays for a probe. Must run BEFORE
        // safeParseClientMsg: a `proto:2` hello is a version mismatch there
        // (bad-proto + close) and a binary P2Hello frame is not JSON at all.
        const sess = sessionOf(ws);
        if (sess.peekHello(raw)) {
          const probe = sess.hello(raw);
          if (probe) {
            // Same shape gate as the v1 branch below, stamped with the v1
            // version: the proto gate itself is `negotiateInbound`.
            // SHARDING: thread the client-stable routing key through
            // so proto:2 hellos sticky-route exactly like v1 ones.
            const shaped = validateHello({
              t: 'hello',
              name: probe.name,
              ...(probe.token !== undefined ? { token: probe.token } : {}),
              ...(probe.nonce !== undefined ? { nonce: probe.nonce } : {}),
              proto: PROTOCOL_VERSION,
            });
            if (!shaped) {
              anticheat.checkMalformed(0, sim.tick, 'invalid hello dropped');
              send(ws, { t: 'event', kind: 'bad-proto', payload: {} });
              ws.close();
              return;
            }
            const decision = negotiateInbound(probe);
            pendingV2 = decision;
            // Declined (PROTO=1 pins v1): the same handshake is admitted as a
            // v1 hello instead of being rejected, so a proto-2 client degrades
            // to JSON instead of being disconnected.
            m = {
              t: 'hello',
              name: probe.name,
              ...(probe.token !== undefined ? { token: probe.token } : {}),
              ...(probe.nonce !== undefined ? { nonce: probe.nonce } : {}),
              proto: PROTOCOL_VERSION,
            };
          }
        }
      }
      // SEC: crash-safe parse — NaN/huge/null-proto fuzz is dropped, never throws.
      if (!m) m = safeParseClientMsg(typeof raw === 'string' ? raw : String(raw));
      if (!m) {
        anticheat.checkMalformed(pid > 0 ? pid : 0, sim.tick, 'unparseable client message dropped');
        return;
      }
      if (m.t === 'hello') {
        // Double-validate hello shape (fuzz: null proto / huge name rejected).
        const hm = validateHello(m);
        if (!hm) {
          anticheat.checkMalformed(0, sim.tick, 'invalid hello dropped');
          send(ws, { t: 'event', kind: 'bad-proto', payload: {} });
          ws.close();
          return;
        }
        if (hm.proto !== PROTOCOL_VERSION) {
          send(ws, { t: 'event', kind: 'bad-proto', payload: {} });
          ws.close();
          return;
        }
        const ident = resolveIdentity(hm.name, hm.token);
        // Sticky cross-shard routing keyed on the CLIENT-stable identity
        // (`nonce ?? token ?? name`): every shard computes the same owner for
        // the same hello, so a redirect-following client lands after at most
        // 1 hop. Never key on `nextId` here — it only advances on admission,
        // so a non-owning shard would evaluate the same id on every hello and
        // redirect forever (before the sticky-routing fix: 12 clients -> 67 hops -> 1 admitted).
        // Single-shard -> always local (no-op).
        const routeKey = helloRouteKey(hm);
        const owner = shards.routePlayer(routeKey);
        if (owner !== shards.localShardId) {
          const target = shards.get(owner);
          send(ws, { t: 'event', kind: 'redirect', payload: { url: target?.host ?? '', shard: owner } });
          auditRedirect({ name: ident.name, shard: owner, reason: 'sticky-route', routeKey: routeKey.slice(0, 64) });
          ws.close();
          return;
        }
        // Overflow: full local shard -> queue position event, then
        // least-loaded redirect. Default cap 500 (MAX_PLAYERS_PER_SHARD).
        // The queue is keyed by the same stable routeKey (not `nextId`, which
        // is shared admit state): distinct clients hold distinct queue slots.
        if (sockets.size >= MAX_PLAYERS_PER_SHARD) {
          const position = matchmaker.join(routeKey, ident.name);
          send(ws, queuePositionEvent(position, MAX_PLAYERS_PER_SHARD));
          auditQueue({ name: ident.name, position, max: MAX_PLAYERS_PER_SHARD, routeKey: routeKey.slice(0, 64) });
          const assigned = matchmaker.assignNext();
          const shard = assigned?.shard ?? shards.leastLoaded();
          if (shard.shardId !== shards.localShardId) {
            send(ws, { t: 'event', kind: 'redirect', payload: { url: shard.host, shard: shard.shardId } });
            auditRedirect({ name: ident.name, shard: shard.shardId, reason: 'overflow', position, routeKey: routeKey.slice(0, 64) });
            ws.close();
            return;
          }
          // Least-loaded is still us (every shard full) -> admit locally.
        }
        pid = nextId++;
        if (hm.token) tokensByPid.set(pid, hm.token);
        const p = sim.addPlayer(pid, ident.name);
        // restore persisted pos/hp if known
        try {
          const saved = db.getPlayer(pid);
          if (saved) {
            p.x = saved.x;
            p.y = saved.y;
            p.hp = saved.hp;
          }
        } catch {
          /* ignore */
        }
        sockets.set(pid, ws);
        ensureGamePlayer(__game, pid, p.name, p.x, p.y); // GAMEPLAY: track quests/inventory/trades
        // SYSTEMS: progression + talent tree + wallet + vendor stock + party row.
        deliverSystems(__systems.addPlayer(pid, p.name, p.x, p.y));
        shards.setLocalPlayers(sockets.size);
        anticheat.seedPos(pid, { x: p.x, y: p.y });
        metrics.addConnection();
        metrics.setPlayers(sockets.size);
        try {
          db.upsertPlayer({ id: pid, name: p.name, x: p.x, y: p.y, hp: p.hp, updated: Date.now() });
        } catch {
          /* ignore */
        }
        const full = fullSnapshot();
        const { visible } = interest.update(pid, { x: p.x, y: p.y }, full);
        // PROTO2: flip to binary here — after admission, so redirect /
        // queue / bad-proto events above were still JSON, and before the
        // welcome, which `send()` then encodes as a P2Welcome frame.
        if (pendingV2 && pendingV2.proto === 2) upgradeSession(ws, pendingV2.keyframeEvery);
        const welcome: ServerMsg = { t: 'welcome', id: pid, tick: sim.tick, snapshot: visible };
        send(ws, welcome);
        auditJoin({ pid, name: p.name, guest: ident.guest });
        // OPS: correlated join event (requestId + the tick id from opsLog).
        opsLog.event('join', { requestId, pid, name: p.name, guest: ident.guest, players: sockets.size });
        broadcastGlobal('server', `${p.name} joined`, pid);
      } else if (m.t === 'input') {
        const p = sim.players.get(pid);
        if (!p) return;
        if (anticheat.isShadowBanned(pid)) {
          metrics.incReject('shadowban');
          return; // shadow-banned: silently drop until kick below fires once
        }
        const nowMs = Date.now();
        // Burst first: counts EVERY input (floods strike here even when the
        // per-gap rate check below would also drop them). Rate second: pure
        // lossy backpressure (drop, no strike — see checkInputRate note).
        if (!anticheat.checkInputBurst(pid, sim.tick, nowMs)) {
          metrics.incReject('burst');
          if (anticheat.shouldKick(pid)) {
            kickPlayer(pid, ws, 'shadowban');
          }
          return; // burst flood rejected (+strike)
        }
        if (!anticheat.checkInputRate(pid, sim.tick, nowMs)) {
          metrics.incReject('input-rate');
          return; // >66Hz dropped (no strike: queueing artifact possible)
        }
        const req = anticheat.moveToVelocity(m.input.move.x, m.input.move.y);
        const checked = anticheat.checkVelocity(pid, sim.tick, req.vx, req.vy);
        if (!checked.ok) metrics.incReject('speed');
        // teleport guard: predicted next pos must not jump (uses current auth pos)
        const dt = Math.max(0, Math.min(0.25, m.input.dt || 1 / TICK_HZ));
        const predicted = { x: p.x + checked.vx * dt, y: p.y + checked.vy * dt };
        if (!anticheat.checkTeleport(pid, sim.tick, { x: p.x, y: p.y }, predicted)) {
          metrics.incReject('teleport');
          if (anticheat.shouldKick(pid)) {
            kickPlayer(pid, ws, 'shadowban');
          }
          return;
        }
        if (!anticheat.checkTeleportBurst(pid, sim.tick, predicted, nowMs)) {
          metrics.incReject('teleport');
          if (anticheat.shouldKick(pid)) {
            kickPlayer(pid, ws, 'shadowban');
          }
          return;
        }
        if (anticheat.shouldKick(pid)) {
          kickPlayer(pid, ws, 'shadowban');
          return;
        }
        sim.setVelocity(pid, checked.vx, checked.vy, m.input.seq);
        if (m.input.attack) {
          // AI-NPC: basic attack chips the nearest NPC/boss within 3u.
          // SYSTEMS: the swing carries the aggregated stat block's damage
          // (the legacy level curve + talents + equipped weapon) instead of the
          // flat 12. Level 1 with no talents is identical, so TTK is unchanged.
          npcs.damageFromPlayer(p.x, p.y, __systems.enabled ? __systems.meleeDamage(pid) : 12, p.id);
          // MELEE: the same swing also reaches world (spawner) mobs. Both
          // populations share one input frame; NPC ids and mob ids live in
          // disjoint namespaces so they never contend for the same target.
          // This is the call that makes onMobKilled fire: without it no world
          // mob ever died, so no mob-die / xp-gain / pickup-spawn was sent and
          // kill quests never advanced.
          // `emitGameEvent` routes mob-die to everyone and the personal reward
          // events (xp-gain / quest-* / levelup / pickup-spawn) to the killer.
          for (const e of playerMeleeAttack(__game, pid, nowMs).events) emitGameEvent(e.kind, e.payload);
        }
        if (m.input.chat) {
          // SYSTEMS: chat commands (`/invite`, `/buy`, `/talent`, ...) skip
          // the 1/sec chat limiter on purpose — they carry their own guards
          // (CMD_RATE_MS, INVITE_COOLDOWN_MS) and /buy must not be throttled.
          if (__systems.enabled && parseSysCommand(m.input.chat)) {
            deliverSystems(applyIntegratedChat(__systems, pid, m.input.chat, 'say', nowMs).out);
          } else if (!__game.chat.trySend(pid, Date.now())) {
            // GAMEPLAY: 1 msg/sec rate limit + profanity mask (was dead code before).
            send(ws, { t: 'event', kind: 'chat-limited', payload: {} });
          } else {
            const clean = sanitizeChat({ from: p.name, text: m.input.chat, channel: 'say' });
            if (clean) {
              // SYSTEMS: `say` is 10 m proximity chat, not a shard broadcast.
              if (__systems.enabled) {
                deliverSystems(__systems.say(pid, clean.text, Date.now()));
                return;
              }
              try {
                db.logChat(clean.from, clean.text, 'say');
              } catch {
                /* ignore */
              }
              broadcast({ t: 'chat', from: clean.from, text: clean.text, channel: 'say' });
            }
          }
        }
      } else if (m.t === 'chat') {
        const p = sim.players.get(pid);
        if (!p) return;
        // SYSTEMS: the composed command grammar owns the whole slash
        // surface when the flag is on; the legacy handler below still serves the
        // SYSTEMS=0 path untouched.
        if (__systems.enabled && parseSysCommand(m.text)) {
          deliverSystems(applyIntegratedChat(__systems, pid, m.text, m.channel, Date.now()).out);
          return;
        }
        // GAMEPLAY: same rate limit + sanitize path as input.chat.
        if (!__game.chat.trySend(pid, Date.now())) {
          send(ws, { t: 'event', kind: 'chat-limited', payload: {} });
          return;
        }
        const clean = sanitizeChat({ from: p.name, text: m.text, channel: m.channel });
        if (!clean) return;
        // AI-NPC: "@maren <words>" talks to the quest-giver (rule-based tree).
        if (clean.text.toLowerCase().startsWith('@maren')) {
          let dlg = dialogues.get(pid);
          if (!dlg) {
            dlg = new QuestGiverDialogue(p.name);
            dialogues.set(pid, dlg);
          }
          const node = dlg.freeform(clean.text.slice(6).trim() || 'hello');
          const opts = node.options.map((o, i) => `${i + 1}. ${o.label}`).join(' ');
          broadcast({ t: 'chat', from: 'Elder Maren', text: `${node.text} ${opts}`, channel: 'say' });
          return;
        }
        // SYSTEMS: `say` only reaches players inside the 10 m radius.
        // `global` / `guild` stay shard- and cross-shard-wide as before.
        if (__systems.enabled && clean.channel === 'say') {
          deliverSystems(__systems.say(pid, clean.text, Date.now()));
          return;
        }
        try {
          db.logChat(clean.from, clean.text, clean.channel);
        } catch {
          /* ignore */
        }
        if (clean.channel === 'global') {
          chatBus.publish({
            from: clean.from,
            text: clean.text,
            channel: 'global',
            origin: shards.localShardId,
            at: Date.now(),
          });
        }
        broadcast({ t: 'chat', from: clean.from, text: clean.text, channel: clean.channel });
      }
    } catch {
      /* malformed JSON ignored */
    }
  });

  ws.on('close', () => {
    // PROTO2: drop the per-connection delta baseline + binary counter.
    releaseSession(ws);
    if (pid > 0) {
      dialogues.delete(pid);
      tokensByPid.delete(pid);
      const p = sim.players.get(pid);
      try {
        if (p) db.upsertPlayer({ id: pid, name: p.name, x: p.x, y: p.y, hp: p.hp, updated: Date.now() });
      } catch {
        /* ignore */
      }
      sim.removePlayer(pid);
      removeGamePlayer(__game, pid); // GAMEPLAY: drop quest/trade state
      // SYSTEMS: leave any party, cancel both invite directions, drop the
      // wallet/inventory/progression rows and any live emote bubble.
      deliverSystems(__systems.removePlayer(pid));
      sysViews.delete(pid);
      clearMeleeCooldown(__game, pid); // MELEE: don't carry a swing timer across a reconnect
      sockets.delete(pid);
      interest.forget(pid);
      anticheat.resetPlayer(pid);
      shards.setLocalPlayers(sockets.size);
      metrics.setPlayers(sockets.size);
      broadcast({ t: 'event', kind: 'despawn', payload: { id: pid } });
    }
  });
});

// Prometheus text exposition + liveness probe (separate port so WS stays untouched).
// GET /metrics -> text/plain exposition; GET /healthz -> {"ok":true,...}.
// WALLS: GET /walls (public, CORS-open for the ?editormode client) and
// admin POST /walls (Bearer ADMIN_TOKEN, persists to data/walls.json).
const metricsServer = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-admin-token',
  };
  if (path === '/walls') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(wallsToDoc(sim.walls)));
      return;
    }
    if (req.method === 'POST') {
      // SEC: rate limit FIRST so brute-force/probe traffic is bounded at
      // 10 req/min/IP even before the token is inspected.
      const ip = (req.socket as { remoteAddress?: string })?.remoteAddress ?? 'unknown';
      if (!checkWallsRateLimit(ip)) {
        auditWallRejected({ reason: 'rate-limited', ip });
        res.writeHead(429, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: false, error: 'rate limited (10/min)' }));
        return;
      }
      // SEC: fail closed in prod when ADMIN_TOKEN is still the dev default.
      if (!isAdminAllowed()) {
        auditWallRejected({ reason: 'prod-default-admin-token', ip });
        res.writeHead(403, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: false, error: 'admin disabled: set ADMIN_TOKEN' }));
        return;
      }
      if (!isAdminRequest(req.headers as Record<string, string | string[] | undefined>, req.url)) {
        auditWallRejected({ reason: 'unauthorized', ip });
        res.writeHead(401, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized (Bearer ADMIN_TOKEN)' }));
        return;
      }
      // SEC: pre-reject absurd content-length before buffering (1MB cap).
      const contentLen = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(contentLen) && contentLen > MAX_WALLS_BODY_BYTES) {
        auditWallRejected({ reason: 'too-large', ip, bytes: contentLen });
        res.writeHead(413, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: false, error: 'walls body too large (max 1MB)' }));
        return;
      }
      let body = '';
      let tooLarge = false;
      req.on('data', (c) => {
        body += String(c);
        if (body.length > MAX_WALLS_BODY_BYTES) {
          tooLarge = true;
          try { req.destroy(); } catch { /* noop */ }
        }
      });
      req.on('end', () => {
        if (tooLarge) {
          auditWallRejected({ reason: 'too-large', ip });
          try {
            res.writeHead(413, { 'content-type': 'application/json', ...cors });
            res.end(JSON.stringify({ ok: false, error: 'walls body too large (max 1MB)' }));
          } catch { /* socket gone */ }
          return;
        }
        try {
          const walls = parseWallsBody(body);
          sim.setWalls(walls);
          const file = saveWallsFile(walls);
          auditWallChange({ count: walls.length, file, ip });
          metrics.setPlayers(sockets.size);
          res.writeHead(200, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: true, count: walls.length, file }));
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          auditWallRejected({ reason: 'invalid-body', ip, status });
          res.writeHead(status, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }));
        }
      });
      return;
    }
    res.writeHead(405, cors);
    res.end('method not allowed');
    return;
  }
  if (path === '/metrics') {
    const body = metrics.render() + perf.render();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(body);
    return;
  }
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Shard load reporting: players + tickMs per ShardNode, full registry.
    const health = shardNode.health(sim.tick);
    // OPS: `draining` lets a load balancer / smoke test distinguish a
    // server that is shutting down cleanly from one that is unhealthy.
    res.end(JSON.stringify({
      ...health,
      players: sockets.size,
      draining: drain.state !== 'running',
      controlPort: CONTROL_PORT,
      shards: shards.list(),
      revokedTokens: revokedTokenCount(),
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
metricsServer.listen(METRICS_PORT, () => {
  console.log(`[server] metrics http://localhost:${METRICS_PORT}/metrics healthz http://localhost:${METRICS_PORT}/healthz`);
});

// Fixed tick: integrate + interest-filtered snapshots @10Hz (every 2nd tick).
// TICK: drift-compensating setTimeout chain (see tick.ts).
// `tickOnce` is one fixed step; the scheduler calls it 1x per wakeup, plus up
// to 2 catch-up steps when briefly behind, else it skips + counts. The 10Hz
// halves (`sim.tick % 2`) stay aligned because every executed step bumps
// `sim.tick` exactly once; perf hooks run once per executed step as before.
const dt = 1 / TICK_HZ;
function tickOnce(): void {
  const t0 = performance.now();
  // OPS: schedule lag / drift gauges + drain tick accounting.
  metrics.observeSchedule(1000 / TICK_HZ);
  opsLog.setTick(sim.tick + 1);
  drain.tickStart();
  let sSim = 0, sGame = 0, sNpc = 0, sSnap = 0, sDb = 0;
  try {
    const a = performance.now();
    sim.step(dt);
    sSim = performance.now() - a;
  // GAMEPLAY: sync positions, tick mobs/quests/trades, mirror mobs as engine
  // entities (`pos`+`mob` components), broadcast `event` payloads only (protocol v1).
  const b = performance.now();
  for (const p of sim.players.values()) setGamePlayerPos(__game, p.id, p.x, p.y);
  for (const e of tickGameplay(__game, Date.now())) {
    if (e.kind === 'mob-spawn') {
      const m = (e.payload ?? {}) as { id: number; name: string; x: number; y: number; hp: number; maxHp: number };
      const eid = sim.world.spawn({ pos: { x: m.x, y: m.y }, mob: { mobId: m.id, name: m.name, hp: m.hp, maxHp: m.maxHp } });
      __mobEntity.set(m.id, eid);
    } else if (e.kind === 'mob-respawn') {
      const m = (e.payload ?? {}) as { id: number; x: number; y: number };
      const eid = __mobEntity.get(m.id);
      if (eid !== undefined && m.x !== undefined) sim.world.set(eid, 'pos', { x: m.x, y: m.y });
    } else if (e.kind === 'mob-die' || e.kind === 'boss-kill') {
      // OPS: kill counter + the trailing 5-minute window for the
      // gameplay gauges (`aetherfall_mobs_killed_5m`).
      metrics.observeMobKill();
    }
    // MELEE: same lane split as the melee path — playerId-bearing events
    // are personal, everything else is world-visible.
    emitGameEvent(e.kind, e.payload);
  }
  // SYSTEMS: the composed per-tick pipeline. Syncs party rows (HP/level/
  // position), expires invites + emote bubbles, and pushes throttled party
  // snapshots. Change-driven, so it is silent on almost every tick. It also
  // mirrors the aggregated stat block's maxHp onto the sim player.
  if (__systems.enabled) {
    deliverSystems(tickIntegrated(__systems, Date.now(), collectSystemViews()));
    for (const p of sim.players.values()) {
      const max = __systems.stats(p.id).maxHp;
      if (p.maxHp !== max) {
        p.maxHp = max;
        if (p.hp > max) p.hp = max;
      }
    }
  }
  sGame = performance.now() - b;
  if (sim.tick % 2 === 0) {
    const c = performance.now();
    // AI-NPC @10Hz (dt=0.1): FSM+BT minions + 2 bosses (SpatialHash+astar).
    // Damage hits sim players (death -> respawn); telegraphs go out as events.
    const views = [...sim.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, hp: p.hp }));
    for (const e of npcs.tick(0.1, views)) {
      if (e.kind === 'damage-player') {
        const p = sim.players.get(e.targetId);
        if (!p || p.hp <= 0) continue;
        p.hp = Math.max(0, p.hp - e.amount);
        if (p.hp <= 0) {
          p.hp = p.maxHp;
          p.x = 50;
          p.y = 50;
          broadcast({ t: 'event', kind: 'respawn', payload: { id: p.id } });
        }
      } else if (e.kind === 'telegraph') {
        broadcast({
          t: 'event',
          kind: 'telegraph',
          payload: { shape: e.shape, x: e.x, y: e.y, r: e.r, ttlMs: e.ttlMs, label: e.label },
        });
      } else {
        // Any other NPC event (e.g. boss-kill) forwards as-is; never assume
        // telegraph-only fields on the widened union.
        broadcast({ t: 'event', kind: e.kind, payload: e });
      }
    }
    sNpc = performance.now() - c;
    const d = performance.now();
    const full = fullSnapshot();
    interestIndex.build(full);
    // Perf: one JSON.stringify per entity (not per viewer), then splice.
    // PROTO2: same idea for binary — quantize the world once per tick and
    // splice per viewer, instead of re-quantizing every entity for every viewer.
    // Both pre-passes are skipped entirely when nobody needs them.
    const v1Viewers = sockets.size - binaryCount;
    const enc0 = performance.now();
    if (v1Viewers > 0) serializeEntities(full);
    if (binaryCount > 0) prequantizeSnapshot(full, quantScratch);
    // EGRESS-PROFILE: sub-stage split of the viewer loop — collect (interest +
    // known-set diff), encode (frame splice / binary encodeView), send (socket
    // write + metrics). Feeds perf.observeSnapSplit (aetherfall_snapshot_split_*)
    // so the egress ceiling driver is attributable on /metrics.
    let splitCollect = 0;
    let splitEncode = performance.now() - enc0;
    let splitSend = 0;
    for (const [id, ws] of sockets) {
      const p = sim.players.get(id);
      if (!p) continue;
      const c0 = performance.now();
      interestIndex.collectIndices(p.x, p.y, id, visibleScratch);
      const { removed } = interest.updateKnownIndices(id, visibleScratch, full);
      splitCollect += performance.now() - c0;
      const e0 = performance.now();
      const sess = binarySockets.has(ws) ? sessions.get(ws) : undefined;
      let frame: string | null = null;
      let bytes: Uint8Array | null = null;
      if (sess) {
        bytes = sess.encodeView(quantScratch, visibleScratch, removed, sim.tick);
      } else {
        frame = snapshotFrame(sim.tick, visibleScratch, removed);
      }
      splitEncode += performance.now() - e0;
      const s0 = performance.now();
      if (bytes) sendBinary(ws, bytes);
      else sendRaw(ws, frame!);
      splitSend += performance.now() - s0;
    }
    // OPS: encode-only cost in microseconds (serialize-once pre-pass +
    // per-viewer splice), kept separate from the whole snapshot stage, which
    // also covers the interest filter and the socket writes.
    metrics.observeSnapshotEncode(splitEncode * 1000);
    perf.observeSnapSplit(splitCollect, splitEncode, splitSend);
    sSnap = performance.now() - d;
    metrics.observeSnapshotStage(sSnap);
    if (sim.tick % (TICK_HZ * 5) === 0) {
      const e0 = performance.now();
      try {
        db.saveSnapshot(sim.tick, JSON.stringify(full));
      } catch {
        /* ignore */
      }
      sDb = performance.now() - e0;
    }
  }
  } catch (err) {
    // Never let one bad tick kill the 20Hz loop; gameplay/npc bugs surface here.
    console.error(`[server] tick ${sim.tick} failed:`, err);
    // OPS: countable + alertable instead of only scrollback.
    metrics.noteError('tick');
    opsLog.error('tick-failed', { tick: sim.tick, err });
  }
  const totalMs = performance.now() - t0;
  drain.tickEnd();
  metrics.observeTick(totalMs);
  metrics.observeSection('sim', sSim);
  metrics.observeSection('gameplay', sGame);
  metrics.observeSection('npc', sNpc);
  metrics.observeSection('snapshot', sSnap);
  metrics.observeSection('db', sDb);
  metrics.observeSection('total', totalMs);
  // OPS: gameplay gauges. Cheap (map sizes + one pass over players) and
  // computed once per tick, never per viewer.
  let alive = 0;
  let hpSum = 0;
  for (const p of sim.players.values()) {
    if (p.hp > 0) alive++;
    hpSum += p.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 0;
  }
  let questsActive = 0;
  for (const gp of __game.players.values()) {
    for (const q of Object.values(gp.quests.progress)) if (!q.done) questsActive++;
  }
  metrics.setGameplay({
    playersAlive: alive,
    mobsAlive: __game.spawner.mobCount(),
    hpRatio: sim.players.size === 0 ? 0 : hpSum / sim.players.size,
    questsActive,
    anticheatStrikes: anticheat.strikeTotal(),
    anticheatStrikesMax: anticheat.maxStrikes(),
  });
  // PERF: cumulative tick histogram + rate-limited slow-tick log (>50ms).
  perf.record(sim.tick, totalMs, { sim: sSim, gameplay: sGame, npc: sNpc, snapshot: sSnap, db: sDb }, sockets.size);
  // Shard load heartbeat for matchmaking + /healthz.
  shardNode.setLoad(sockets.size, totalMs);
  shards.setLocalTickMs(totalMs);
}

// TICK: drift-compensating scheduler. `nextTick = last + 50ms`
// via a setTimeout chain; catch-up is bounded at 2 extra steps, deeper lag is
// skipped and counted (see server/src/tick.ts). The real cadence surfaces via
// the existing `tick_rate_hz` / `tick_rate_ratio` gauges (observeSchedule runs
// once per executed step inside tickOnce) plus the new skip/catch-up counters.
tickScheduler = new TickScheduler(tickOnce, {
  periodMs: 1000 / TICK_HZ,
  maxCatchUp: 2,
  onSkip: (n) => metrics.noteSkipped(n),
  onCatchUp: (n) => metrics.noteCatchUp(n),
});
tickScheduler.start();
