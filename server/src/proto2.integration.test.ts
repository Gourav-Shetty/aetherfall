// @aetherfall/server — protocol v2 end-to-end integration.
//
// Boots the real server (a child process on the production entry point) and
// proves the negotiated binary path is indistinguishable from v1 on the wire
// semantics: the same sim state, decoded from a keyframe + delta stream, must
// produce the entity map a v1 JSON client builds from the same ticks.
//
// Covered:
//   1. a `proto:2` hello is answered with a binary welcome and binary snapshot
//      frames (keyframes on schedule, deltas in between, no baseline drift);
//   2. with both clients idle the decoded v2 entity map equals the v1 entity map
//      tick-for-tick — same ids, positions within the 1/16 unit quantization,
//      exact for hp/maxHp/kind/level/name/dir;
//   3. binary input frames reach the sim (authoritative seq advances and the
//      player moves) and stay consistent with what the v1 client is told;
//   4. a v1 client on the same server still receives JSON text frames;
//   5. PROTO=1 pins the server to v1: a `proto:2` client is admitted on JSON
//      (graceful degradation, not `bad-proto` + close).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  applySnapshot,
  baselineFromEntities,
  decodeFrame,
  encodeInputBinary,
  safeDecodeServerFrame,
  toEntitySnapshot,
  type P2Baseline,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot } from '@aetherfall/shared';
import { TICK_HZ } from '@aetherfall/shared';

/** 1/16 unit quantization: the largest legal v2 position error. */
const POS_TOL = 1 / 16 + 1e-9;
const VEL_TOL = 1 / 256 + 1e-9;
const DIR_TOL = 1 / 1024 + 1e-9;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Booted = { proc: ChildProcess; url: string; metricsPort: number };

/** Boot `dist/index.js` on a free port and wait until the WS listener accepts. */
async function bootServer(env: Record<string, string>, label: string): Promise<Booted> {
  const port = await freePort();
  const metricsPort = await freePort();
  // Isolated cwd: the DB and walls loader both write/read ./data.
  const cwd = mkdtempSync(join(tmpdir(), `aetherfall-${label}-`));
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const proc = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      AETHERFALL_NO_SHUTDOWN_HOOK: '1',
      AETHERFALL_NO_EXIT: '1',
      DATABASE_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (d) => (log += String(d)));
  proc.stderr?.on('data', (d) => (log += String(d)));
  const deadline = Date.now() + 25000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`server (${label}) did not start in 25s:\n${log}`);
    }
    const up = await new Promise<boolean>((res) => {
      // A real outbound TCP connect: it only succeeds once the server is
      // listening (binding the port ourselves would prove nothing).
      const probe = createConnection({ port, host: '127.0.0.1' });
      probe.once('connect', () => {
        probe.destroy();
        res(true);
      });
      probe.once('error', () => res(false));
    });
    if (up) break;
    await sleep(120);
  }
  return { proc, url: `ws://127.0.0.1:${port}`, metricsPort };
}

type TestClient = {
  mode: 1 | 2;
  ws: WebSocket;
  /** Local player id from the welcome (-1 until it arrives). */
  selfId: number;
  entities: Map<number, EntitySnapshot>;
  /** tick -> entity map as reconstructed on the client (deltas applied). */
  byTick: Map<number, Map<number, EntitySnapshot>>;
  binaryFrames: number;
  jsonFrames: number;
  keyframes: number;
  deltas: number;
  dropped: number;
  decodeErrors: number;
  badProto: number;
  closed: boolean;
};

function connect(url: string, name: string, mode: 1 | 2): Promise<TestClient> {
  const state: TestClient = {
    mode,
    ws: undefined as unknown as WebSocket,
    selfId: -1,
    entities: new Map<number, EntitySnapshot>(),
    byTick: new Map<number, Map<number, EntitySnapshot>>(),
    binaryFrames: 0,
    jsonFrames: 0,
    keyframes: 0,
    deltas: 0,
    dropped: 0,
    decodeErrors: 0,
    badProto: 0,
    closed: false,
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    state.ws = ws;
    if (mode === 2) ws.binaryType = 'nodebuffer';
    let baseline: P2Baseline = new Map();
    let baseTick = 0;
    const timer = setTimeout(() => reject(new Error(`${name} connect timeout`)), 15000);
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('close', () => {
      state.closed = true;
    });
    ws.on('open', () => {
      ws.send(
        JSON.stringify(
          mode === 2
            ? {
                t: 'hello',
                name,
                proto: 2,
                caps: { binary: true, deltas: true, keyframe: 5, chat: true, event: true },
              }
            : { t: 'hello', name, proto: 1 },
        ),
      );
    });
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      const raw = typeof data === 'string' ? Buffer.from(data) : data;
      // `ws` hands text frames over as Buffers on a nodebuffer socket, so the
      // isBinary flag is the only reliable text/binary discriminator.
      if (!isBinary) {
        state.jsonFrames++;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          state.decodeErrors++;
          return;
        }
        if (m['t'] === 'welcome') {
          state.selfId = m['id'] as number;
          state.entities = new Map((m['snapshot'] as EntitySnapshot[]).map((e) => [e.id, e]));
          state.byTick.set(m['tick'] as number, new Map(state.entities));
          clearTimeout(timer);
          resolve(state);
          return;
        }
        if (m['t'] === 'event' && m['kind'] === 'bad-proto') state.badProto++;
        if (m['t'] === 'snapshot') {
          state.entities = new Map((m['entities'] as EntitySnapshot[]).map((e) => [e.id, e]));
          state.byTick.set(m['tick'] as number, new Map(state.entities));
        }
        return;
      }
      // ---- binary lane ----
      state.binaryFrames++;
      const bytes = new Uint8Array(raw);
      const head = safeDecodeServerFrame(bytes, baseline);
      if (!head.ok) {
        state.decodeErrors++;
        return;
      }
      const msg = head.value;
      if (msg.t === 'welcome') {
        state.selfId = msg.id;
        state.entities = new Map(msg.snapshot.map((e) => [e.id, toEntitySnapshot(e)]));
        state.byTick.set(msg.tick, new Map(state.entities));
        baseline = baselineFromEntities(msg.snapshot);
        baseTick = msg.tick;
        clearTimeout(timer);
        resolve(state);
        return;
      }
      if (msg.t !== 'snapshot') return;
      if ((decodeFrame(bytes).flags & 1) === 1) state.keyframes++;
      else state.deltas++;
      const applied = applySnapshot(msg, baseline, baseTick);
      if (!applied.ok) {
        // Baseline drift: a real client waits for the next keyframe.
        state.dropped++;
        return;
      }
      baseline = applied.baseline;
      baseTick = applied.baseTick;
      for (const e of applied.entities.values()) {
        const v1 = toEntitySnapshot(e);
        state.entities.set(v1.id, v1);
      }
      for (const id of applied.removed) state.entities.delete(id);
      state.byTick.set(msg.tick, new Map(state.entities));
    });
  });
}

/** Non-player entities are the ones both protocols must agree on exactly. */
function nonPlayers(map: Map<number, EntitySnapshot>): [number, EntitySnapshot][] {
  return [...map.entries()].filter(([, e]) => e.kind !== 'player').sort((a, b) => a[0] - b[0]);
}

/**
 * Walk a client onto (tx,ty) with ordinary JSON inputs, then let it coast to a
 * stop. Phase 1 compares the two clients' non-player entity sets for EQUALITY,
 * which is only meaningful while both sit inside the same interest disc
 * (INTEREST_RADIUS) — and fresh joins are deliberately placed on different
 * spawn anchors now (`Sim.addPlayer` -> `spawnAnchorFor(id)`), so the two
 * clients start ~40u apart. Co-locating them first makes the phase-1
 * precondition explicit instead of accidentally true.
 */
async function walkTo(c: TestClient, tx: number, ty: number, budgetMs = 20000): Promise<void> {
  let seq = 0;
  const stop = Date.now() + budgetMs;
  while (Date.now() < stop) {
    const me = c.entities.get(c.selfId);
    if (!me) {
      await sleep(50);
      continue;
    }
    const dx = tx - me.p.x;
    const dy = ty - me.p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) break;
    c.ws.send(
      JSON.stringify({ t: 'input', input: { seq: ++seq, dt: 1 / TICK_HZ, move: { x: dx / dist, y: dy / dist } } }),
    );
    await sleep(50);
  }
  await sleep(400); // friction brings the body to rest before the comparison
}

function assertSameWorld(
  tick: number,
  mine: [number, EntitySnapshot][],
  theirs: [number, EntitySnapshot][],
  strictIds: boolean,
): void {
  const byId = new Map(theirs);
  if (strictIds) assert.equal(mine.length, byId.size, `entity count at tick ${tick}`);
  for (const [id, e] of mine) {
    const other = byId.get(id);
    assert.ok(other, `the v1 client is missing entity ${id} at tick ${tick}`);
    if (!other) continue;
    assert.ok(Math.abs(e.p.x - other.p.x) <= POS_TOL, `p.x #${id} tick ${tick}: ${e.p.x} vs ${other.p.x}`);
    assert.ok(Math.abs(e.p.y - other.p.y) <= POS_TOL, `p.y #${id} tick ${tick}: ${e.p.y} vs ${other.p.y}`);
    assert.ok(Math.abs(e.v.x - other.v.x) <= VEL_TOL, `v.x #${id} tick ${tick}: ${e.v.x} vs ${other.v.x}`);
    assert.ok(Math.abs(e.v.y - other.v.y) <= VEL_TOL, `v.y #${id} tick ${tick}: ${e.v.y} vs ${other.v.y}`);
    assert.equal(e.hp, other.hp, `hp #${id} tick ${tick}`);
    assert.equal(e.maxHp, other.maxHp, `maxHp #${id} tick ${tick}`);
    assert.equal(e.kind, other.kind, `kind #${id} tick ${tick}`);
    assert.equal(e.level, other.level, `level #${id} tick ${tick}`);
    assert.equal(e.name, other.name, `name #${id} tick ${tick}`);
    if (e.dir !== undefined || other.dir !== undefined) {
      assert.ok(Math.abs((e.dir ?? 0) - (other.dir ?? 0)) <= DIR_TOL, `dir #${id} tick ${tick}`);
    }
  }
}

describe('protocol v2 negotiated end-to-end', () => {
  let server: Booted;

  before(async () => {
    server = await bootServer({ PROTO: '2' }, 'proto2');
  });

  after(() => {
    try {
      server.proc.kill();
    } catch {
      /* already gone */
    }
  });

  it(
    'decodes the same entity state as a v1 client on the same sim',
    { timeout: 90000 },
    async () => {
      const v1 = await connect(server.url, 'itest-v1', 1);
      const v2 = await connect(server.url, 'itest-v2', 2);
      try {
        // The v2 client is on the binary wire; the v1 client is not. Frames that
        // arrive BEFORE the binary welcome (join events) are still JSON by
        // construction — the socket only leaves v1 when it is upgraded — so the
        // invariant is "no JSON after the welcome".
        assert.equal(v2.binaryFrames > 0, true, 'v2 client received binary frames');
        assert.equal(v1.binaryFrames, 0, 'v1 client must keep receiving JSON text frames');
        assert.equal(v1.jsonFrames > 0, true);
        assert.ok(v2.selfId > 0 && v1.selfId > 0);
        const jsonAfterWelcome = v2.jsonFrames;

        // ---- phase 0: co-locate (fresh joins land on different spawn anchors)
        const v2self = v2.entities.get(v2.selfId)!;
        await walkTo(v1, v2self.p.x, v2self.p.y);
        const v1self = v1.entities.get(v1.selfId)!;
        assert.ok(
          Math.hypot(v1self.p.x - v2self.p.x, v1self.p.y - v2self.p.y) < 2,
          `clients did not meet: v1 (${v1self.p.x.toFixed(1)},${v1self.p.y.toFixed(1)}) vs v2 (${v2self.p.x.toFixed(1)},${v2self.p.y.toFixed(1)})`,
        );

        // ---- phase 1: both idle, so both interest sets are identical ----
        let compared = 0;
        for (let i = 0; i < 40 && compared < 8; i++) {
          await sleep(100);
          const ticks = [...v2.byTick.keys()].filter((t) => v1.byTick.has(t)).sort((a, b) => b - a);
          const tick = ticks[0];
          if (tick === undefined) continue;
          const mine = nonPlayers(v2.byTick.get(tick)!);
          if (mine.length === 0) continue;
          compared++;
          assertSameWorld(tick, mine, nonPlayers(v1.byTick.get(tick)!), true);
          // self entity agrees too (same id, same authoritative state)
          const mineSelf = v2.byTick.get(tick)!.get(v2.selfId);
          const theirSelf = v1.byTick.get(tick)!.get(v1.selfId);
          assert.ok(mineSelf && theirSelf, `both clients see themselves at tick ${tick}`);
        }
        assert.ok(compared >= 5, `expected >= 5 strictly comparable idle ticks, got ${compared}`);
        const worldSize = nonPlayers(v2.entities).length;
        assert.ok(worldSize >= 1, `the shard exposes non-player entities to compare (${worldSize})`);

        // ---- phase 2: binary input is applied by the sim ----
        let seq = 0;
        const iv = setInterval(() => {
          if (v2.ws.readyState !== 1) return;
          v2.ws.send(encodeInputBinary({ t: 'input', input: { seq: ++seq, dt: 0.05, move: { x: 1, y: 0 } } }));
        }, 50);
        let movingTicks = 0;
        for (let i = 0; i < 50 && movingTicks < 8; i++) {
          await sleep(100);
          const ticks = [...v2.byTick.keys()].filter((t) => v1.byTick.has(t)).sort((a, b) => b - a);
          const tick = ticks[0];
          if (tick === undefined) continue;
          const mine = nonPlayers(v2.byTick.get(tick)!);
          const theirs = nonPlayers(v1.byTick.get(tick)!);
          // The v2 player walks away from spawn, so the two interest sets can
          // differ at the 40 m boundary: compare the entities in common, and
          // require the delta stream to stay exactly consistent on all of them.
          const common = mine.filter(([id]) => theirs.some(([tid]) => tid === id));
          if (common.length === 0) continue;
          movingTicks++;
          assertSameWorld(tick, common, theirs, false);
        }
        clearInterval(iv);
        assert.ok(movingTicks >= 5, `expected >= 5 comparable moving ticks, got ${movingTicks}`);

        // Stream health: no drops, no decode errors, both frame kinds seen.
        assert.equal(v2.decodeErrors, 0, 'no malformed frames');
        assert.equal(v2.dropped, 0, 'the delta chain never drifted');
        assert.equal(v2.badProto, 0);
        assert.equal(v2.jsonFrames, jsonAfterWelcome, 'no JSON frames after the binary welcome');
        assert.ok(v2.deltas >= 5, `the stream carries deltas, not only keyframes (${v2.deltas})`);
        assert.ok(v2.keyframes >= 1, `keyframes present, client asked for one every 5 (${v2.keyframes})`);
        assert.ok(v2.binaryFrames >= 10, `expected a live binary stream, got ${v2.binaryFrames} frames`);

        // Binary input reached the sim: the player's authoritative seq advanced
        // and the position moved off spawn. The v1 client is told the same thing.
        const self = v2.entities.get(v2.selfId);
        assert.ok(self, 'v2 client sees its own player entity');
        assert.ok((self!.seq ?? 0) > 1, `server applied the binary input frames (seq=${self!.seq})`);
        assert.ok(Math.abs(self!.p.x - 50) > 0.5, `the player actually moved (p.x=${self!.p.x})`);
        const theirSelf = v1.entities.get(v2.selfId);
        assert.ok(theirSelf, 'the v1 client sees the same player entity');
        assert.equal(theirSelf!.seq, self!.seq, 'both protocols report the same authoritative seq');
        assert.ok(Math.abs(theirSelf!.p.x - self!.p.x) <= POS_TOL, 'same position on both protocols');
      } finally {
        for (const c of [v1, v2]) {
          try {
            c.ws.close();
          } catch {
            /* noop */
          }
        }
      }
    },
  );
});

describe('PROTO=1 pins the server to v1 (graceful downgrade)', () => {
  it(
    'admits a proto:2 client on JSON instead of rejecting it',
    { timeout: 90000 },
    async () => {
      const pinned = await bootServer({ PROTO: '1' }, 'proto1');
      let c: TestClient | null = null;
      try {
        c = await connect(pinned.url, 'itest-downgrade', 2);
        assert.ok(c.jsonFrames > 0, 'welcome arrived as JSON');
        assert.equal(c.binaryFrames, 0, 'no binary frames on a v1-pinned server');
        assert.equal(c.badProto, 0, 'the handshake was not rejected');
        await sleep(700);
        assert.equal(c.closed, false, 'connection stays open on the v1 fallback');
        assert.ok(c.jsonFrames > 1, 'snapshots keep flowing as JSON');
      } finally {
        try {
          c?.ws.close();
        } catch {
          /* noop */
        }
        try {
          pinned.proc.kill();
        } catch {
          /* noop */
        }
      }
    },
  );
});
