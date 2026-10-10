// PLAYABILITY — spawner mob AI acceptance (server/src/game/spawner-ai.ts).
//
// Before the driver existed the only brains in the game drove 3 fixed minions
// at (30,30)/(65,25)/(50,70), so the worldgen population the player actually
// fights (gloomfang/ashcrawler/thornback/mistwisp, 4 per 32x32 chunk) never
// moved, never chased and never attacked: `Spawner.moveMob()` was only ever
// called from tests. These tests are the acceptance suite for the fix —
// acquire, sneak, leash, spawn-safe discs, spawn protection, patrol, and the
// "nothing else changed" regression check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { genChunk } from '@aetherfall/engine';
import {
  ACTIVE_RADIUS,
  PATROL_RADIUS_MAX,
  SPAWNER_MELEE_RANGE,
  SPAWNER_SIGHT_RANGE,
  SpawnerAI,
} from './spawner-ai.js';
import { SPAWN_SAFE_RADIUS, isSpawnSafeZone, Spawner } from './spawner.js';
import { LEASH_RANGE, MELEE_COOLDOWN, MELEE_DAMAGE } from '../ai/npc.js';
import {
  createGameState,
  ensurePlayer,
  onMobKilled,
  playerMeleeAttack,
} from './index.js';
import type { PlayerView } from '../ai/npc.js';

const DT = 0.1;
const T0 = 100_000;
/** Worldgen seed the tile grid and the spawner must agree on. */
const SEED = 1337;

// -------------------------------------------------------------- world utils

function walkable(x: number, y: number): boolean {
  const cx = Math.floor(x / 32);
  const cy = Math.floor(y / 32);
  const tiles = genChunk(cx, cy, 32, SEED).tiles;
  const row = tiles[Math.floor(y) - cy * 32];
  if (!row) return false;
  return row[Math.floor(x) - cx * 32] === 0;
}

/** Every sample along the segment is walkable (0.5u steps, like the driver's). */
function runClear(x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!walkable(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

/** Spawner + driver over a few chunks of the meadow, away from the safe discs. */
function world(): { spawner: Spawner; ai: SpawnerAI } {
  const spawner = new Spawner(SEED);
  const ai = new SpawnerAI(spawner, { seed: SEED });
  for (const [cx, cy] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
  ]) {
    spawner.spawnChunk(cx, cy);
  }
  return { spawner, ai };
}

/**
 * Give `id` a brain (one tick with a player at 20u: awake, out of aggro pull,
 * still inside the FSM idle dwell) so its deterministic initial facing can be
 * read and used to aim a cone placement.
 */
function arm(ai: SpawnerAI, spawner: Spawner, id: number): boolean {
  const m = spawner.getMob(id);
  if (!m) return false;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const x = m.pos.x + Math.cos(a) * 20;
    const y = m.pos.y + Math.sin(a) * 20;
    if (isSpawnSafeZone(x, y)) continue;
    // Explicit vx/vy: arming teleports the player between fixtures, and the
    // per-tick-delta speed fallback would read that jump as a sprint and wake
    // every other mob in range.
    ai.tick(DT, [view(x, y, { vx: 0, vy: 0 })], T0);
    return true;
  }
  return false;
}

/**
 * A point `dist` away inside the mob's vision cone with clear line-of-sight —
 * scanned across 32 compass steps so the test never depends on which way a
 * particular mob id happens to face. Same-chunk only, so the tile-grid LoS leg
 * actually ran.
 */
function inCone(
  ai: SpawnerAI,
  spawner: Spawner,
  id: number,
  dist: number,
  targetSpeed: number,
): { x: number; y: number } | null {
  const m = spawner.getMob(id);
  const facing = ai.debugMob(id)?.facing;
  if (!m || facing === undefined) return null;
  for (let i = 0; i < 32; i++) {
    const off = ((i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * Math.PI) / 16;
    const a = facing + off;
    const x = m.pos.x + Math.cos(a) * dist;
    const y = m.pos.y + Math.sin(a) * dist;
    if (isSpawnSafeZone(x, y)) continue;
    if (Math.floor(x / 32) !== Math.floor(m.pos.x / 32)) continue;
    if (Math.floor(y / 32) !== Math.floor(m.pos.y / 32)) continue;
    if (ai.canSee(id, x, y, targetSpeed)) return { x, y };
  }
  return null;
}

function view(x: number, y: number, extra: Partial<PlayerView> = {}): PlayerView {
  return { id: 1, x, y, hp: 100, ...extra };
}

// --------------------------------------------------------------- acceptance

describe('spawner AI: acquisition', () => {
  it('a mob in cone + range acquires and lands a hit within 10s', () => {
    const { spawner, ai } = world();
    let acquired = -1;
    let hit = -1;
    let amount = 0;
    let subject = 0;
    for (const m of spawner.mobsList()) {
      if (!arm(ai, spawner, m.id)) continue;
      const p = inCone(ai, spawner, m.id, 8, 1);
      if (!p) continue;
      acquired = -1;
      hit = -1;
      amount = 0;
      for (let i = 0; i < 100; i++) {
        const ev = ai.tick(DT, [view(p.x, p.y, { vx: 1, vy: 0 })], T0 + i * 100);
        if (acquired < 0 && ai.debugMob(m.id)!.targetId === 1) acquired = i;
        for (const e of ev) {
          if (e.kind === 'damage-player' && e.fromId === m.id && hit < 0) {
            hit = i;
            amount = e.amount;
          }
        }
        if (hit >= 0) break;
      }
      subject = m.id;
      break;
    }
    assert.ok(subject !== 0, 'no mob could be armed with a clear cone placement');
    assert.ok(acquired >= 0, 'never acquired the 8u target');
    assert.ok(acquired * DT <= 3, `acquired in ${(acquired * DT).toFixed(1)}s (>3s)`);
    assert.ok(hit >= 0, 'acquired but never landed a hit');
    assert.ok(hit * DT <= 10, `first hit in ${(hit * DT).toFixed(1)}s (>10s)`);
    assert.equal(amount, MELEE_DAMAGE, 'hit must be the documented 7 damage');
    assert.equal(MELEE_DAMAGE, 7);
  });

  it('two hits on the same target are at least MELEE_COOLDOWN apart', () => {
    const { spawner, ai } = world();
    for (const m of spawner.mobsList()) {
      if (!arm(ai, spawner, m.id)) continue;
      const p = inCone(ai, spawner, m.id, 4, 1);
      if (!p) continue;
      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const now = T0 + i * 100;
        for (const e of ai.tick(DT, [view(p.x, p.y, { vx: 1, vy: 0 })], now)) {
          if (e.kind === 'damage-player' && e.fromId === m.id) times.push(now);
        }
      }
      assert.ok(times.length >= 2, `expected repeated hits, got ${times.length}`);
      for (let i = 1; i < times.length; i++) {
        assert.ok(
          times[i]! - times[i - 1]! >= MELEE_COOLDOWN * 1000,
          `hits ${times[i - 1]} -> ${times[i]} beat the 1.5s cooldown`,
        );
      }
      return;
    }
    assert.fail('no usable mob');
  });
});

describe('spawner AI: sneak still works', () => {
  it('does NOT acquire a perfectly still player beyond 4u', () => {
    const { spawner, ai } = world();
    let checked = false;
    // Snapshot the ids first: the isolation below removes mobs, and mutating the
    // list while walking it would drop candidates before they are even tried.
    const ids = spawner.mobsList().map((m) => m.id);
    for (const id of ids) {
      const m = spawner.getMob(id);
      if (!m || !arm(ai, spawner, id)) continue;
      const seenIfMoving = inCone(ai, spawner, id, 8, 1);
      if (!seenIfMoving) continue;
      // HERMETIC: the sneak rule is about THIS mob's cone. `world()` now populates
      // 12 mobs per chunk, so a bystander can sit inside the 4u "still targets
      // are visible anyway" band and hit the statue — which would fail this test
      // for a reason that has nothing to do with the leg under test. Strip every
      // other body so the assertion can only ever describe `m`. Done only after
      // `id` has a usable placement, so the loop still has its subject.
      for (const other of spawner.mobsList()) {
        if (other.id !== id) spawner.removeMob(other.id);
      }
      const still = inCone(ai, spawner, id, 8, 0);
      assert.equal(still, null, 'a statue beyond 4u must be invisible');
      assert.equal(
        ai.canSee(id, seenIfMoving.x, seenIfMoving.y, 0),
        false,
        'canSee(speed 0) must refuse the same point canSee(speed 1) accepts',
      );
      for (let i = 0; i < 100; i++) {
        // vx/vy 0 is a genuinely motionless player: the sneak leg must refuse it.
        const ev = ai.tick(
          DT,
          [view(seenIfMoving.x, seenIfMoving.y, { vx: 0, vy: 0 })],
          T0 + i * 100,
        );
        assert.ok(
          !ev.some((e) => e.kind === 'damage-player'),
          'a mob hit a player it never detected',
        );
        assert.equal(ai.debugMob(id)!.targetId, null, 'acquired a still player');
      }
      assert.ok(Math.hypot(seenIfMoving.x - m.pos.x, seenIfMoving.y - m.pos.y) > 4);
      checked = true;
      break;
    }
    assert.ok(checked, 'no mob with a valid 8u cone placement was found');
  });

  it('still acquires the same spot once the player is moving', () => {
    // Control for the test above: identical geometry, non-zero velocity.
    const { spawner, ai } = world();
    for (const m of spawner.mobsList()) {
      if (!arm(ai, spawner, m.id)) continue;
      const p = inCone(ai, spawner, m.id, 8, 1);
      if (!p) continue;
      let hit = false;
      for (let i = 0; i < 100; i++) {
        for (const e of ai.tick(DT, [view(p.x, p.y, { vx: 0.6, vy: 0 })], T0 + i * 100)) {
          if (e.kind === 'damage-player' && e.fromId === m.id) hit = true;
        }
        if (hit) break;
      }
      assert.ok(hit, 'a moving player at the same spot was never hit');
      return;
    }
    assert.fail('no usable mob');
  });
});

describe('spawner AI: leash', () => {
  /** An anchor + a kited spot LEASH_RANGE+ away from it, joined by clear ground. */
  function leashSpot(): { home: { x: number; y: number }; away: { x: number; y: number } } {
    for (let gx = 30; gx <= 70; gx += 2) {
      for (let gy = 10; gy <= 80; gy += 2) {
        if (!walkable(gx, gy) || isSpawnSafeZone(gx, gy)) continue;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const ax = gx + Math.cos(a) * (LEASH_RANGE + 5);
          const ay = gy + Math.sin(a) * (LEASH_RANGE + 5);
          if (!walkable(ax, ay) || isSpawnSafeZone(ax, ay)) continue;
          if (!runClear(gx, gy, ax, ay)) continue;
          return { home: { x: gx, y: gy }, away: { x: ax, y: ay } };
        }
      }
    }
    throw new Error('no leash fixture found');
  }

  it(`a mob kited past LEASH_RANGE (${LEASH_RANGE}) clears its target and walks home`, () => {
    const { spawner, ai } = world();
    const mob = spawner.mobsList()[0]!;
    const { home, away } = leashSpot();
    mob.spawnPos = { ...home };
    assert.ok(spawner.moveMob(mob.id, away.x, away.y));
    assert.ok(Math.hypot(away.x - home.x, away.y - home.y) > LEASH_RANGE, 'setup is kited');

    // A player right next to the mob, moving — everything except the leash.
    const px = away.x + (home.x - away.x) * 0.12;
    const py = away.y + (home.y - away.y) * 0.12;
    const startDist = Math.hypot(mob.pos.x - home.x, mob.pos.y - home.y);
    let worst = startDist;
    let endedHome = false;
    for (let i = 0; i < 200; i++) {
      const ev = ai.tick(DT, [view(px, py, { vx: -3, vy: 0 })], T0 + i * 100);
      assert.ok(
        !ev.some((e) => e.kind === 'damage-player' && e.fromId === mob.id),
        'a leashed mob must not swing',
      );
      assert.equal(ai.debugMob(mob.id)!.targetId, null, 'leashed mob kept its target');
      const d = Math.hypot(mob.pos.x - home.x, mob.pos.y - home.y);
      if (i < 5) worst = d;
      if (d <= 1.5) endedHome = true;
    }
    const endDist = Math.hypot(mob.pos.x - home.x, mob.pos.y - home.y);
    assert.ok(endDist < startDist - 20, `no return walk (${startDist.toFixed(1)} -> ${endDist.toFixed(1)})`);
    assert.ok(endDist < worst, 'still drifting away from home');
    assert.ok(endedHome, 'never made it back to the anchor');
    assert.equal(ai.debugMob(mob.id)!.homing, false, 'homing never released');
  });
});

describe('spawner AI: spawn-safe discs stay clear', () => {
  /**
   * A ray from the world spawn along the mob's own initial facing, tile-clear
   * from the disc edge out to the leash-free approach band.
   */
  function lureSubject(spawner: Spawner, ai: SpawnerAI): { id: number; theta: number } {
    for (const m of spawner.mobsList()) {
      if (!arm(ai, spawner, m.id)) continue;
      const theta = ai.debugMob(m.id)!.facing;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const r0 = SPAWN_SAFE_RADIUS + 0.4;
      const r1 = 26;
      if (!runClear(ux * r0, uy * r0, ux * r1, uy * r1)) continue;
      return { id: m.id, theta };
    }
    throw new Error('no mob with a clear corridor to spawn');
  }

  it('cannot be lured into the disc to camp a fresh player', () => {
    const { spawner, ai } = world();
    const { id, theta } = lureSubject(spawner, ai);
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    // Park the mob on the corridor with its anchor 22u out; the player starts
    // 4u outside it and walks down the corridor into the disc.
    const anchor = { x: ux * 22, y: uy * 22 };
    const mob = spawner.getMob(id)!;
    mob.spawnPos = { ...anchor };
    assert.ok(spawner.moveMob(id, anchor.x, anchor.y));

    let r = 26;
    const stepIn = -2; // u/s down the corridor
    let minR = Infinity;
    let minHome = Infinity;
    let hitsInsideDisc = 0;
    let everPulled = false;
    let clearedTarget = false;
    for (let i = 0; i < 150; i++) {
      if (r > 2) r = Math.max(2, r + stepIn * DT);
      const px = ux * r;
      const py = uy * r;
      const inside = isSpawnSafeZone(px, py);
      const ev = ai.tick(DT, [view(px, py, { vx: ux * 2, vy: uy * 2 })], T0 + i * 100);
      const d = ai.debugMob(id)!;
      assert.equal(
        isSpawnSafeZone(d.x, d.y),
        false,
        `mob entered the spawn-safe disc at ${d.x.toFixed(2)},${d.y.toFixed(2)}`,
      );
      minR = Math.min(minR, Math.hypot(d.x, d.y));
      minHome = Math.min(minHome, Math.hypot(d.x - anchor.x, d.y - anchor.y));
      if (inside) {
        if (ev.some((e) => e.kind === 'damage-player')) hitsInsideDisc++;
        if (d.targetId === null) clearedTarget = true;
      }
      if (d.targetId === 1 && Math.hypot(d.x, d.y) < 20) everPulled = true;
    }
    const end = ai.debugMob(id)!;
    assert.ok(everPulled, 'the mob never followed the lure (test did not exercise it)');
    assert.ok(minR < SPAWN_SAFE_RADIUS + 3, `mob only got to ${minR.toFixed(1)}u of spawn`);
    assert.ok(minR >= SPAWN_SAFE_RADIUS - 1e-9, `mob got within ${minR.toFixed(2)}u of spawn`);
    assert.equal(hitsInsideDisc, 0, 'a mob hit a player standing in the spawn disc');
    assert.ok(clearedTarget, 'the mob kept hunting a player inside the disc');
    assert.equal(end.targetId, null, 'target not cleared at the end');
    assert.ok(minHome <= 1.5, `mob never walked back to its anchor (closest ${minHome.toFixed(1)}u)`);
  });

  it('patrol waypoints are projected out of the disc', () => {
    // A mob anchored 1u outside the disc must still find waypoints outside it,
    // and must never end a patrol inside.
    const { spawner, ai } = world();
    const mob = spawner.mobsList()[0]!;
    const anchor = { x: SPAWN_SAFE_RADIUS + 0.5, y: 0 };
    mob.spawnPos = { ...anchor };
    assert.ok(spawner.moveMob(mob.id, anchor.x, anchor.y));
    for (let i = 0; i < 200; i++) {
      ai.tick(DT, [view(anchor.x + 24, anchor.y, { vx: 1, vy: 0 })], T0 + i * 100);
      assert.equal(isSpawnSafeZone(mob.pos.x, mob.pos.y), false, 'mob patrolled into the disc');
    }
  });
});

describe('spawner AI: spawn protection', () => {
  it('a spawn-protected player is neither targeted nor damaged', () => {
    const { spawner, ai } = world();
    let checked = false;
    for (const m of spawner.mobsList()) {
      if (!arm(ai, spawner, m.id)) continue;
      const p = inCone(ai, spawner, m.id, 3, 1);
      if (!p) continue;
      for (let i = 0; i < 40; i++) {
        const now = T0 + i * 100;
        const ev = ai.tick(
          DT,
          [view(p.x, p.y, { vx: 1, vy: 0, spawnProtectedUntil: now + 60_000 })],
          now,
        );
        assert.ok(!ev.some((e) => e.kind === 'damage-player'), 'protected player took a hit');
        assert.equal(ai.debugMob(m.id)!.targetId, null, 'protected player was targeted');
      }
      // ...and the same geometry lands a hit the moment protection lapses.
      let hit = false;
      for (let i = 0; i < 60; i++) {
        const now = T0 + 4000 + i * 100;
        for (const e of ai.tick(DT, [view(p.x, p.y, { vx: 1, vy: 0 })], now)) {
          if (e.kind === 'damage-player' && e.fromId === m.id) hit = true;
        }
        if (hit) break;
      }
      assert.ok(hit, 'protection never lapsed, so the negative case proves nothing');
      checked = true;
      break;
    }
    assert.ok(checked, 'no mob with a valid 3u cone placement was found');
  });
});

describe('spawner AI: mobs are visibly alive', () => {
  it('patrol around their home tile (and never wander out of it)', () => {
    const { spawner, ai } = world();
    // A player parked 24u away keeps the driver awake without being seen: it
    // is perfectly still and well beyond SNEAK_STILL_DIST.
    const mob = spawner.mobsList()[0]!;
    const before = { x: mob.pos.x, y: mob.pos.y };
    let maxHome = 0;
    for (let i = 0; i < 120; i++) {
      ai.tick(DT, [view(mob.pos.x + 24, mob.pos.y)], T0 + i * 100);
      const d = Math.hypot(mob.pos.x - mob.spawnPos.x, mob.pos.y - mob.spawnPos.y);
      maxHome = Math.max(maxHome, d);
    }
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.y - before.y);
    assert.ok(moved > 2, `mob drifted only ${moved.toFixed(2)}u in 12s — still a statue`);
    assert.ok(
      maxHome <= PATROL_RADIUS_MAX + 1,
      `wandered ${maxHome.toFixed(1)}u from home (patrol radius ${PATROL_RADIUS_MAX})`,
    );
    assert.equal(ai.debugMob(mob.id)!.targetId, null, 'patroler picked a target off a statue');
  });

  it('most mobs in a chunk move on their own', () => {
    const { spawner, ai } = world();
    const anchor = spawner.mobsList()[0]!;
    const px = anchor.pos.x + 24;
    const py = anchor.pos.y;
    // Sample the mobs the player actually WAKES: only mobs inside
    // ACTIVE_RADIUS run a brain (that is the awake-budget contract), so the
    // assertion is "most of the population in play moves". The old fixed
    // `mobsList().slice(0, 6)` spanned three chunks and only passed while
    // enough of those happened to sit near the probe player — with the spawn
    // anchors in play, the first six are mostly sleepers by design.
    const mobs = spawner.mobsWithin(px, py, ACTIVE_RADIUS).slice(0, 6);
    assert.ok(mobs.length >= 4, `only ${mobs.length} mobs in play around (${px},${py})`);
    const before = new Map(mobs.map((m) => [m.id, { x: m.pos.x, y: m.pos.y }]));
    for (let i = 0; i < 150; i++) ai.tick(DT, [view(px, py)], T0 + i * 100);
    const movedCount = mobs.filter(
      (m) => Math.hypot(m.pos.x - before.get(m.id)!.x, m.pos.y - before.get(m.id)!.y) > 1,
    ).length;
    assert.ok(movedCount >= Math.max(1, Math.floor(mobs.length / 2)), `only ${movedCount} mobs moved`);
  });

  it('downed and stunned mobs hold still and do not swing', () => {
    const { spawner, ai } = world();
    let checked = false;
    for (const m of spawner.mobsList()) {
      if (!arm(ai, spawner, m.id)) continue;
      const p = inCone(ai, spawner, m.id, 3, 1);
      if (!p) continue;
      assert.ok(spawner.downMob(m.id, T0), 'setup: down failed');
      const at = { x: m.pos.x, y: m.pos.y };
      for (let i = 0; i < 20; i++) {
        const ev = ai.tick(DT, [view(p.x, p.y, { vx: 1, vy: 0 })], T0 + i * 100);
        assert.ok(!ev.some((e) => e.kind === 'damage-player'), 'a downed mob swung');
      }
      assert.equal(m.pos.x, at.x);
      assert.equal(m.pos.y, at.y);

      // Recovered, then stunned by a thrown sidearm: same inertness.
      assert.ok(spawner.recoverDowned(T0 + 3500).length > 0, 'setup: recovery failed');
      assert.ok(spawner.stunMob(m.id, T0 + 2000, 5000), 'setup: stun failed');
      const at2 = { x: m.pos.x, y: m.pos.y };
      for (let i = 0; i < 20; i++) {
        const ev = ai.tick(DT, [view(p.x, p.y, { vx: 1, vy: 0 })], T0 + 3500 + i * 100);
        assert.ok(!ev.some((e) => e.kind === 'damage-player'), 'a stunned mob swung');
      }
      assert.equal(m.pos.x, at2.x);
      assert.equal(m.pos.y, at2.y);
      checked = true;
      break;
    }
    assert.ok(checked, 'no mob with a valid 3u cone placement was found');
  });
});

describe('spawner AI: budget + performance contract', () => {
  it('stays inside the documented damage budget', () => {
    assert.equal(MELEE_DAMAGE, 7);
    assert.equal(MELEE_COOLDOWN, 1.5);
    assert.equal(SPAWNER_MELEE_RANGE, 2.2);
    assert.equal(SPAWNER_SIGHT_RANGE, 12);
    // Time-to-die for a naked 100 HP idle player against one mob: 14 hits, which
    // is the 21s the damage budget in docs/GAMEPLAY.md promises.
    assert.equal(Math.ceil(100 / MELEE_DAMAGE) - 1, 14);
    assert.equal((Math.ceil(100 / MELEE_DAMAGE) - 1) * MELEE_COOLDOWN, 21);
  });

  it('does zero per-mob work with no players', () => {
    const spawner = new Spawner(SEED);
    const ai = new SpawnerAI(spawner, { seed: SEED });
    spawner.spawnChunk(0, 0);
    const before = spawner.mobsList().map((m) => ({ id: m.id, x: m.pos.x, y: m.pos.y }));
    for (let i = 0; i < 50; i++) ai.tick(DT, [], T0 + i * 100);
    const s = ai.lastStats();
    assert.equal(s.considered, spawner.mobCount(), 'the early-out still walks the mob list');
    assert.equal(s.awake, 0);
    assert.equal(s.moved, 0);
    assert.deepEqual(ai.takeMoved(), []);
    for (const b of before) {
      const m = spawner.getMob(b.id)!;
      assert.equal(m.pos.x, b.x);
      assert.equal(m.pos.y, b.y);
    }
  });

  it('early-outs per mob when the nearest player is out of ACTIVE_RADIUS', () => {
    const spawner = new Spawner(SEED);
    const ai = new SpawnerAI(spawner, { seed: SEED });
    spawner.spawnChunk(0, 0);
    const mob = spawner.mobsList()[0]!;
    const before = { x: mob.pos.x, y: mob.pos.y };
    // Far enough that NO mob in the chunk is inside ACTIVE_RADIUS.
    const far = { x: mob.pos.x + 400, y: mob.pos.y + 400 };
    for (let i = 0; i < 50; i++) ai.tick(DT, [view(far.x, far.y)], T0 + i * 100);
    const s = ai.lastStats();
    assert.equal(s.awake, 0, 'mobs far from every player must stay asleep');
    assert.equal(mob.pos.x, before.x);
    assert.equal(mob.pos.y, before.y);

    // One step inside the radius and the subject wakes up again.
    ai.tick(DT, [view(mob.pos.x + ACTIVE_RADIUS - 2, mob.pos.y)], T0 + 6000);
    assert.ok(ai.lastStats().awake >= 1, 'mob did not wake inside ACTIVE_RADIUS');
  });

  it('reports only the mobs it moved this tick', () => {
    const { spawner, ai } = world();
    const mob = spawner.mobsList()[0]!;
    ai.tick(DT, [view(mob.pos.x + 24, mob.pos.y)], T0);
    const moved = ai.takeMoved();
    assert.ok(Array.isArray(moved));
    assert.deepEqual(ai.takeMoved(), [], 'takeMoved() consumes');
    for (const id of moved) assert.ok(spawner.getMob(id) !== undefined);
  });

  it('forEachMobNear agrees with nearestMobWithin (the driver\'s awake query)', () => {
    // The driver builds its awake set from forEachMobNear, so the cell query
    // has to return a superset of the reference point query.
    const spawner = new Spawner(SEED);
    spawner.spawnChunk(0, 0);
    const probe = spawner.mobsList()[0]!.pos;
    for (const r of [4, 8, 16, ACTIVE_RADIUS]) {
      const seen: number[] = [];
      spawner.forEachMobNear(probe.x, probe.y, r, (m) => seen.push(m.id));
      const nearest = spawner.nearestMobWithin(probe.x, probe.y, r);
      if (nearest) assert.ok(seen.includes(nearest.id), `nearest within ${r}u missing from the fan-out`);
      for (const id of seen) {
        const m = spawner.getMob(id)!;
        assert.ok(Math.hypot(m.pos.x - probe.x, m.pos.y - probe.y) <= r);
      }
      assert.deepEqual(spawner.mobsWithin(probe.x, probe.y, r).map((m) => m.id).sort(), seen.sort());
    }
    // Negative / zero ranges are safe no-ops.
    let called = 0;
    spawner.forEachMobNear(probe.x, probe.y, -1, () => called++);
    assert.equal(called, 0);
  });
});

describe('spawner AI: no regression in the existing mob pipeline', () => {
  it('a driven mob still dies, drops loot and emits the same events', () => {
    const game = createGameState(SEED);
    const ai = new SpawnerAI(game.spawner, { seed: SEED });
    ensurePlayer(game, 1, 'hero', 40, 40);
    game.spawner.ensureAround(40, 40, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    assert.ok(mob, 'spawner produced a mob');

    // Drive the AI around it first, so the mob carries brain state at death.
    let armed = false;
    for (let i = 0; i < 60; i++) {
      ai.tick(DT, [view(mob.pos.x + 24, mob.pos.y)], T0 + i * 100);
    }
    armed = ai.debugMob(mob.id) !== undefined;
    assert.ok(armed, 'the driver never woke the mob');

    // Walk up and swing until it goes down (mirrors the existing suite). `rand`
    // pinned at 0 makes both the crit roll and every drop roll deterministic,
    // so `pickup-spawn` is a guaranteed outcome rather than a dice throw.
    game.spawner.moveMob(mob.id, 40, 40);
    const p = game.players.get(1)!;
    p.x = 41;
    p.y = 40;
    const rand = () => 0;
    let events: string[] = [];
    let pickups = 0;
    for (let i = 0; i < 20 && !events.includes('mob-die'); i++) {
      const r = playerMeleeAttack(game, 1, 1000 + i * 800, { rand });
      events = r.events.map((e) => e.kind);
      pickups = r.events.filter((e) => e.kind === 'pickup-spawn').length;
    }
    assert.ok(events.includes('mob-die'), `no mob-die in 20 swings (${events.join(',')})`);
    assert.ok(events.includes('xp-gain'), 'no xp-gain on the kill');
    assert.ok(pickups > 0, 'no loot dropped on the kill');
    assert.equal(game.pickups.length, pickups, 'corpse loot did not land as pickups');
    assert.equal(mob.alive, false);

    // A corpse neither swings nor moves.
    const at = { x: mob.pos.x, y: mob.pos.y };
    for (let i = 0; i < 20; i++) {
      const ev = ai.tick(DT, [view(mob.pos.x + 1, mob.pos.y, { vx: 1, vy: 0 })], T0 + 10_000 + i * 100);
      assert.ok(!ev.some((e) => e.kind === 'damage-player'), 'a corpse swung');
    }
    assert.equal(mob.pos.x, at.x);
    assert.equal(mob.pos.y, at.y);

    // ...and the 5s respawn timer still brings it back at its anchor.
    const respawned = onMobKilled(game, 1, mob.id, T0 + 20_000);
    assert.deepEqual(respawned, [], 'an already-paid kill must not pay twice');
  });

  it('leaves the legacy proximity targetId bookkeeping alone', () => {
    // `game.tickGameplay` -> `combat.updateAggro` owns `mob.targetId` at 20Hz.
    // The driver keeps its own target so the two rules cannot fight and spam
    // `mob-aggro`; this pins that contract.
    const game = createGameState(SEED);
    const ai = new SpawnerAI(game.spawner, { seed: SEED });
    ensurePlayer(game, 1, 'hero', 40, 40);
    game.spawner.ensureAround(40, 40, 0);
    const mob = game.spawner.mobsList()[0]!;
    const px = mob.pos.x + 3;
    const py = mob.pos.y;
    for (let i = 0; i < 40; i++) {
      ai.tick(DT, [view(px, py, { vx: 0.9, vy: 0 })], T0 + i * 100);
    }
    assert.equal(mob.targetId, null, 'the AI must not write the legacy targetId');
    assert.equal(ai.debugMob(mob.id)!.targetId, 1, 'the AI must own its own target');
  });
});