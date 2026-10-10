// PLAYABILITY strike team — spawn anchors are ONE table.
//
// Regression background: `game/spawner.ts` kept a two-entry `SPAWN_SAFE_POINTS`
// list of no-mob discs while the live join path (`server/src/index.ts` ->
// `sim.addPlayer(pid, name)`, no coordinates) placed players with a scattered
// `10 + (id*7)%80` formula. Player 1 landed at (17,23) — outside every declared
// disc — so the feature was only ever exercised by tests that spawned at the
// protected origin, and "no mob pile on login" was dead in production.
//
// These tests hold the table itself to the invariants it claims:
//   * the spawner's safe points ARE the anchor table (same array), not a copy;
//   * a player with no coordinates lands ON an anchor (membership, not a literal);
//   * every anchor — not just (0,0) — has a clear 12u disc after tickGameplay;
//   * anchors clear the boss wake ranges and each other's discs;
//   * the discs do not hollow out the world (mob density holds);
//   * the real join path shape (`sim.addPlayer(pid, name)`) is spawn-safe.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSS_ANCHORS,
  BOSS_WAKE_RANGE,
  LEGACY_MINION_ANCHORS,
  ORIGIN_SPAWN,
  SHRINE_SPAWN,
  SPAWN_ANCHORS,
  SPAWN_ANCHOR_MIN_SEPARATION,
  SPAWN_SAFE_RADIUS,
  anchorNearestOn,
  isSpawnAnchorSafeZone,
  spawnAnchorFor,
} from '@aetherfall/engine';
import { Sim } from '../sim.js';
import { createGameState, ensurePlayer, tickGameplay } from './index.js';
import { SPAWN_SAFE_POINTS, isSpawnSafeZone } from './spawner.js';
import { NPCManager, _resetNpcIds } from '../ai/npc.js';

/** Default arena the sim clamps bodies to (sim.ARENA_W/H). */
const ARENA = 100;

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

type Game = ReturnType<typeof createGameState>;

function mobsNear(game: Game, x: number, y: number, r: number) {
  return game.spawner.mobsList().filter((m) => Math.hypot(m.pos.x - x, m.pos.y - y) <= r);
}

/** True when (x,y) is exactly one of the declared anchors (not "near" one). */
function isDeclaredAnchor(x: number, y: number): boolean {
  return SPAWN_ANCHORS.some((a) => a.x === x && a.y === y);
}

/**
 * Spawn a wide ring of chunks around one anchor and let the gameplay tick prune,
 * exactly like a live shard does around a joining player.
 */
function seedWorldAt(game: Game, x: number, y: number): void {
  ensurePlayer(game, 1, 'probe', x, y);
  tickGameplay(game, 1000);
  game.spawner.ensureAround(x, y, 1);
  tickGameplay(game, 2000);
}

describe('spawn anchors: the table both the join path and the safe discs read', () => {
  it('SPAWN_SAFE_POINTS is the anchor table itself (identity, not a second copy)', () => {
    assert.equal(SPAWN_SAFE_RADIUS, 12, 'safe radius behaviour is unchanged');
    assert.equal(SPAWN_SAFE_POINTS, SPAWN_ANCHORS, 'safe points must be derived, never re-typed');
    assert.ok(SPAWN_ANCHORS.length >= 5, `expected a spread table, got ${SPAWN_ANCHORS.length} anchors`);
    assert.ok(SPAWN_ANCHORS.some((a) => a.x === 0 && a.y === 0), 'world spawn (0,0) kept');
    assert.ok(SPAWN_ANCHORS.some((a) => a.x === 50 && a.y === 50), 'shrine (50,50) kept');
    assert.equal(ORIGIN_SPAWN.x, 0);
    assert.equal(ORIGIN_SPAWN.y, 0);
    assert.equal(SHRINE_SPAWN.x, 50);
    assert.equal(SHRINE_SPAWN.y, 50);
  });

  it('a player joining with no explicit position lands ON a declared anchor', () => {
    const sim = new Sim();
    for (let id = 1; id <= 12; id++) {
      const p = sim.addPlayer(id, `bot-${id}`);
      assert.ok(
        isDeclaredAnchor(p.x, p.y),
        `player ${id} joined at (${p.x},${p.y}), which is not a declared anchor`,
      );
      assert.ok(isSpawnSafeZone(p.x, p.y), `player ${id} joined outside every safe disc`);
      assert.ok(isSpawnAnchorSafeZone(p.x, p.y), 'engine + spawner discs disagree');
    }
  });

  it('the anchor round-robin covers the whole table once per lap', () => {
    const used = new Set<number>();
    for (let id = 1; id <= SPAWN_ANCHORS.length; id++) used.add(SPAWN_ANCHORS.indexOf(spawnAnchorFor(id)));
    assert.equal(used.size, SPAWN_ANCHORS.length, 'a full lap must visit every anchor');
    // 1-based rotation: the first player on a shard gets the canonical world
    // spawn, not the shrine (which is the death-respawn point).
    assert.equal(spawnAnchorFor(1), SPAWN_ANCHORS[0], 'player 1 -> world spawn');
    assert.deepEqual(
      [7, 8, 9].map((id) => spawnAnchorFor(id).name),
      [SPAWN_ANCHORS[0].name, SPAWN_ANCHORS[1].name, SPAWN_ANCHORS[2].name],
      'the lap wraps',
    );
  });

  it('an explicit x/y passed to addPlayer is still honoured exactly', () => {
    const sim = new Sim();
    const p = sim.addPlayer(3, 'scripter', 77.5, 33.25);
    assert.equal(p.x, 77.5);
    assert.equal(p.y, 33.25);
    assert.deepEqual(sim.getPos(3), { x: 77.5, y: 33.25 });
    // A partial spawn snaps to the whole anchor nearest on the supplied axis.
    // Borrowing only the missing axis from some anchor is not safe — the
    // anchor nearest on x can still be far from the requested x, putting the
    // player outside every disc.
    const q = sim.addPlayer(4, 'half', 12.5);
    assert.equal(q.x, anchorNearestOn('x', 12.5).x);
    assert.equal(q.y, anchorNearestOn('x', 12.5).y);
    assert.ok(isSpawnSafeZone(q.x, q.y), 'the half-specified spawn is still on the table');
  });

  it('a half-specified spawn is spawn-safe on either axis', () => {
    const sim = new Sim();
    // Sweep the whole world on both axes: no partial spawn may ever produce an
    // unprotected position, whatever coordinate the caller supplies.
    for (let v = 0; v <= 100; v += 2) {
      const onlyX = sim.addPlayer(1000 + v, 'x', v);
      assert.ok(isSpawnSafeZone(onlyX.x, onlyX.y), `addPlayer(x=${v}) -> (${onlyX.x},${onlyX.y}) is unprotected`);
      const onlyY = sim.addPlayer(2000 + v, 'y', undefined, v);
      assert.ok(isSpawnSafeZone(onlyY.x, onlyY.y), `addPlayer(y=${v}) -> (${onlyY.x},${onlyY.y}) is unprotected`);
    }
  });

  it('ensurePlayer with no coordinates resolves the same anchor the sim picked', () => {
    const game = createGameState(1337);
    for (let id = 1; id <= 6; id++) {
      const p = ensurePlayer(game, id, `bot-${id}`);
      assert.ok(isDeclaredAnchor(p.x, p.y), `ensurePlayer defaulted to (${p.x},${p.y})`);
      assert.deepEqual({ x: p.x, y: p.y }, { x: spawnAnchorFor(id).x, y: spawnAnchorFor(id).y });
      assert.deepEqual(p, ensurePlayer(game, id, `bot-${id}`), 'idempotent for the same id');
    }
  });

  it('the coordinate the old scatter formula produced is NOT spawn-safe (the regression)', () => {
    // Old default for player 1: x = 10 + 7 = 17, y = 10 + 13 = 23.
    assert.equal(isSpawnSafeZone(17, 23), false, 'the old join coordinate was never covered');
    assert.ok(!isDeclaredAnchor(17, 23));
    // ...and the new one is, for the same player id.
    const sim = new Sim();
    const p = sim.addPlayer(1, 'bot');
    assert.ok(isDeclaredAnchor(p.x, p.y) && isSpawnSafeZone(p.x, p.y));
  });
});

describe('spawn anchors: every disc is clear, not just the origin', () => {
  it('tickGameplay leaves zero mobs within 12u of EACH anchor', () => {
    for (const a of SPAWN_ANCHORS) {
      const game = createGameState(1337);
      seedWorldAt(game, a.x, a.y);
      const near = mobsNear(game, a.x, a.y, SPAWN_SAFE_RADIUS);
      assert.equal(near.length, 0, `anchor ${a.name} (${a.x},${a.y}) has ${near.length} mob(s) inside 12u`);
      // 15u is the measurement ring: mobs may exist out there, but none may be
      // hunting the player who just landed on the anchor.
      for (const m of mobsNear(game, a.x, a.y, 15)) {
        assert.equal(m.targetId, null, `${m.name} has aggro inside the 15u watch ring of ${a.name}`);
      }
    }
  });

  it('a single spawnChunk never places a mob inside any disc', () => {
    const game = createGameState(1337);
    for (const a of SPAWN_ANCHORS) {
      const fresh = game.spawner.ensureAround(a.x, a.y, 0);
      for (const m of fresh) {
        assert.equal(isSpawnSafeZone(m.pos.x, m.pos.y), false, `${m.name} spawned inside a safe disc`);
      }
    }
  });

  it('the REAL join path (sim.addPlayer(pid, name), no coordinates) is spawn-safe', () => {
    // Exactly the shape of server/src/index.ts: admit, then feed the same
    // coordinates into the gameplay layer and tick the world around them.
    for (let pid = 1; pid <= SPAWN_ANCHORS.length; pid++) {
      const sim = new Sim();
      const p = sim.addPlayer(pid, `bot-${pid}`);
      const game = createGameState(1337);
      seedWorldAt(game, p.x, p.y);
      const near = mobsNear(game, p.x, p.y, SPAWN_SAFE_RADIUS);
      assert.equal(
        near.length,
        0,
        `player ${pid} joined at (${p.x},${p.y}) into ${near.length} mob(s)`,
      );
      assert.ok(isSpawnSafeZone(p.x, p.y));
    }
  });

  it('a persisted player keeps its restored position (anchors govern fresh spawns only)', () => {
    // server/src/index.ts overwrites the sim position from db.getPlayer(pid)
    // right after admission; the anchor table must not fight that.
    const sim = new Sim();
    const p = sim.addPlayer(9, 'returning');
    assert.ok(isDeclaredAnchor(p.x, p.y));
    p.x = 73.5;
    p.y = 61.25;
    p.hp = 42;
    const game = createGameState(1337);
    ensurePlayer(game, 9, 'returning', p.x, p.y);
    assert.deepEqual(game.players.get(9) && { x: game.players.get(9)!.x, y: game.players.get(9)!.y }, {
      x: 73.5,
      y: 61.25,
    });
    assert.equal(sim.getPos(9)!.x, 73.5, 'the restore is authoritative, not the anchor');
  });
});

describe('spawn anchors: table invariants', () => {
  it('no anchor is within boss aggro/wake range of any boss anchor', () => {
    assert.equal(BOSS_WAKE_RANGE, 30, 'mirror of BOSS_WAKE_RANGE in ai/npc.ts');
    assert.equal(BOSS_ANCHORS.length, 4);
    for (const a of SPAWN_ANCHORS) {
      for (const b of BOSS_ANCHORS) {
        const d = dist(a.x, a.y, b.x, b.y);
        assert.ok(
          d >= BOSS_WAKE_RANGE,
          `anchor ${a.name} is ${d.toFixed(1)}u from boss ${b.name} (wake range ${BOSS_WAKE_RANGE})`,
        );
      }
      // ...and never inside a legacy minion's aggro pull either.
      for (const m of LEGACY_MINION_ANCHORS) {
        const d = dist(a.x, a.y, m.x, m.y);
        assert.ok(d >= 14, `anchor ${a.name} is ${d.toFixed(1)}u from minion ${m.name} (aggro 14u)`);
      }
    }
  });

  it('standing on an anchor never wakes a dormant boss', () => {
    // Behavioural half of the same rule: a real NPCManager keeps both lazy
    // bosses dormant while a player idles on each anchor (npcCount would jump
    // from the 3 minions + 2 always-awake fixtures to 7 the moment one woke).
    for (const a of SPAWN_ANCHORS) {
      _resetNpcIds();
      const npcs = new NPCManager();
      const baseline = npcs.npcCount();
      assert.equal(baseline, 5, 'expected 3 legacy minions + 2 arena fixtures');
      for (let i = 0; i < 40; i++) {
        npcs.tick(0.1, [{ id: 1, x: a.x, y: a.y, hp: 100 }], 100_000 + i * 100);
      }
      assert.equal(npcs.npcCount(), baseline, `a boss woke on anchor ${a.name}`);
    }
  });

  it('anchors do not overlap closer than 2 * SPAWN_SAFE_RADIUS', () => {
    assert.equal(SPAWN_ANCHOR_MIN_SEPARATION, 2 * SPAWN_SAFE_RADIUS);
    for (let i = 0; i < SPAWN_ANCHORS.length; i++) {
      for (let j = i + 1; j < SPAWN_ANCHORS.length; j++) {
        const a = SPAWN_ANCHORS[i]!;
        const b = SPAWN_ANCHORS[j]!;
        const d = dist(a.x, a.y, b.x, b.y);
        assert.ok(
          d >= SPAWN_ANCHOR_MIN_SEPARATION,
          `${a.name} and ${b.name} are ${d.toFixed(1)}u apart (< ${SPAWN_ANCHOR_MIN_SEPARATION}u: the discs merge)`,
        );
      }
    }
  });

  it('the discs cover a minority of the arena (no giant no-mob region)', () => {
    let minSep = Infinity;
    for (let i = 0; i < SPAWN_ANCHORS.length; i++) {
      for (let j = i + 1; j < SPAWN_ANCHORS.length; j++) {
        minSep = Math.min(minSep, dist(SPAWN_ANCHORS[i]!.x, SPAWN_ANCHORS[i]!.y, SPAWN_ANCHORS[j]!.x, SPAWN_ANCHORS[j]!.y));
      }
    }
    const area = (SPAWN_ANCHORS.length * Math.PI * SPAWN_SAFE_RADIUS * SPAWN_SAFE_RADIUS) / (ARENA * ARENA);
    assert.ok(area < 0.35, `discs cover ${(area * 100).toFixed(1)}% of the ${ARENA}x${ARENA} arena`);
    assert.ok(minSep >= 1.5 * (2 * SPAWN_SAFE_RADIUS), `closest pair is only ${minSep.toFixed(1)}u apart`);
    // The corners of the arena stay huntable: no disc reaches them.
    for (const [x, y] of [[1, 99], [99, 1], [99, 99]] as const) {
      assert.equal(isSpawnSafeZone(x, y), false, `(${x},${y}) is not huntable`);
    }
  });
});

describe('spawn anchors: the world outside the discs keeps its monsters', () => {
  it('mob density over the whole arena stays close to MOBS_PER_CHUNK', () => {
    const game = createGameState(1337);
    const CHUNKS = 16; // the full 4x4 chunks of the 100x100 arena
    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) game.spawner.spawnChunk(cx, cy);
    }
    const count = game.spawner.mobCount();
    const full = CHUNKS * 4; // MOBS_PER_CHUNK
    assert.ok(count > 0, 'the world is not empty');
    assert.ok(
      count >= full * 0.7,
      `only ${count}/${full} mobs survived the safe discs (>30% of the world hollowed out)`,
    );
    // Every chunk still carries mobs, so the discs did not starve whole regions.
    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) {
        const inChunk = game.spawner
          .mobsWithin(cx * 32 + 16, cy * 32 + 16, 24)
          .filter((m) => Math.floor(m.pos.x / 32) === cx && Math.floor(m.pos.y / 32) === cy);
        assert.ok(inChunk.length > 0, `chunk ${cx},${cy} has no mobs at all`);
      }
    }
  });

  it('mobs outside the discs are untouched by anchor churn (density is stable)', () => {
    // Same world, sampled far from every disc: the safe zones must not have
    // eaten the open field.
    const game = createGameState(1337);
    const probe: ReadonlyArray<readonly [number, number]> = [
      [20, 26], [60, 30], [70, 46], [34, 62], [78, 36],
    ];
    for (const [x, y] of probe) {
      assert.equal(isSpawnSafeZone(x, y), false, `probe (${x},${y}) must be open field`);
    }
    let covered = 0;
    for (const [x, y] of probe) {
      game.spawner.ensureAround(x, y, 0);
      if (game.spawner.mobsWithin(x, y, 24).length > 0) covered++;
    }
    assert.ok(
      covered >= probe.length - 1,
      `only ${covered}/${probe.length} open-field probes had mobs within 24u`,
    );
  });
});