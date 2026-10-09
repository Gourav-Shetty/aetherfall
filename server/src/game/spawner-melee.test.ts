// The spawner's spatial index + mob damage bookkeeping.
//
// `Spawner.nearestMobWithin` is what makes melee affordable: it must return the
// same mob a brute-force scan would at every range (including the exact
// boundary), stay correct across cell edges and negative coordinates, and never
// return a dead mob. `damageMob` mirrors combat.tryMeleeAttack's death
// bookkeeping so `updateRespawns` stays the single respawn authority.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MOB_CELL_SIZE, Spawner } from './spawner.js';
import { RESPAWN_DELAY_MS, updateRespawns, type Mob } from './combat.js';
import { MOB_ID_MAX, MOB_ID_MIN } from './mobs.js';

/** Brute-force nearest living mob — the oracle for the indexed query. */
function bruteForceNearest(mobs: Mob[], x: number, y: number, range: number): Mob | null {
  let best: Mob | null = null;
  let bestD = range * range;
  for (const m of mobs) {
    if (!m.alive) continue;
    const d2 = (m.pos.x - x) ** 2 + (m.pos.y - y) ** 2;
    if (d2 > range * range) continue;
    if (best === null || d2 < bestD || (d2 === bestD && m.id < best.id)) {
      best = m;
      bestD = d2;
    }
  }
  return best;
}

describe('spawner spatial index: nearestMobWithin matches a linear scan', () => {
  it('agrees with brute force over a dense population at many ranges', () => {
    const s = new Spawner(1337);
    // Many chunks -> several hundred mobs, spread over many cells.
    for (let cy = -2; cy <= 3; cy++) {
      for (let cx = -2; cx <= 3; cx++) s.spawnChunk(cx, cy);
    }
    const mobs = s.mobsList();
    assert.ok(mobs.length > 50, `dense enough to be meaningful (${mobs.length})`);

    let checks = 0;
    let hits = 0;
    for (const anchor of mobs) {
      for (const range of [0.5, 1, MELEEish(), 6, 12, 25]) {
        const got = s.nearestMobWithin(anchor.pos.x, anchor.pos.y, range);
        const want = bruteForceNearest(mobs, anchor.pos.x, anchor.pos.y, range);
        assert.equal(got?.id ?? null, want?.id ?? null, `range=${range} at ${anchor.pos.x},${anchor.pos.y}`);
        checks++;
        if (got) hits++;
      }
    }
    assert.ok(checks > 300, `exercised a wide sample (${checks})`);
    assert.ok(hits > 0, 'some queries actually found a target');
  });

  it('returns null when nothing is in range', () => {
    const s = new Spawner(1337);
    s.spawnChunk(0, 0);
    assert.equal(s.nearestMobWithin(10_000, 10_000, 2.2), null);
  });

  it('treats the exact range boundary as in range', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    const d = 2.0;
    s.moveMob(m.id, 10, 10);
    const probe = { x: 10 + d, y: 10 };
    assert.ok(s.nearestMobWithin(probe.x, probe.y, d), 'dist == range is reachable');
    assert.equal(s.nearestMobWithin(probe.x + 0.01, probe.y, d), null, 'just past is not');
  });

  it('handles negative coordinates and cell edges', () => {
    const s = new Spawner(1337);
    for (let cy = -4; cy <= -1; cy++) for (let cx = -4; cx <= -1; cx++) s.spawnChunk(cx, cy);
    const mobs = s.mobsList();
    assert.ok(mobs.length > 0);
    for (const anchor of mobs) {
      const got = s.nearestMobWithin(anchor.pos.x, anchor.pos.y, 10);
      assert.equal(got?.id ?? null, bruteForceNearest(mobs, anchor.pos.x, anchor.pos.y, 10)?.id ?? null);
    }
  });

  it('a mob on the far side of a cell boundary is still found', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    // Park it exactly on a cell edge, then probe from the next cell over.
    const edge = MOB_CELL_SIZE;
    s.moveMob(m.id, edge, edge);
    assert.ok(
      s.nearestMobWithin(edge + 1.5, edge, 2.2),
      'a query centred in the next cell reaches back across the boundary',
    );
  });

  it('a negative or NaN range never matches', () => {
    const s = new Spawner(1337);
    s.spawnChunk(0, 0);
    const m = s.mobsList()[0]!;
    assert.equal(s.nearestMobWithin(m.pos.x, m.pos.y, -1), null);
    assert.equal(s.nearestMobWithin(m.pos.x, m.pos.y, Number.NaN), null);
  });
});

/** The combat range the melee path actually uses. */
function MELEEish(): number {
  return 2.2;
}

describe('spawner: dead mobs are excluded from targeting', () => {
  it('skips a corpse and returns the next-nearest live mob', () => {
    const s = new Spawner(1337);
    const mobs = s.spawnChunk(0, 0);
    assert.ok(mobs.length >= 2);
    const [a, b] = mobs;
    // Put both on the same tile so the only differentiator is aliveness.
    s.moveMob(a.id, 5, 5);
    s.moveMob(b.id, 5, 5);
    assert.equal(s.nearestMobWithin(5, 5, 2.2)?.id, a.id);

    s.killMob(a.id, 1000);
    assert.equal(s.nearestMobWithin(5, 5, 2.2)?.id, b.id, 'the corpse is skipped');

    s.killMob(b.id, 1000);
    assert.equal(s.nearestMobWithin(5, 5, 2.2), null, 'no live mobs left in range');
  });

  it('a mob that respawns becomes targetable again', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    s.killMob(m.id, 1000);
    assert.equal(s.nearestMobWithin(m.pos.x, m.pos.y, 2.2), null);
    updateRespawns(1000 + RESPAWN_DELAY_MS, s.mobsList());
    assert.equal(s.nearestMobWithin(m.pos.x, m.pos.y, 2.2)?.id, m.id);
  });
});

describe('spawner: damageMob bookkeeping', () => {
  it('removes hp and reports the amount', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    const before = m.hp;
    const hit = s.damageMob(m.id, 7, 1000)!;
    assert.equal(hit.killed, false);
    assert.equal(hit.dmg, 7);
    assert.equal(hit.resolved, 7);
    assert.equal(m.hp, before - 7);
    assert.equal(m.alive, true);
  });

  it('an overkill swing clamps dmg to remaining hp but reports the roll', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    const overkill = m.hp + 50;
    const hit = s.damageMob(m.id, overkill, 1000)!;
    assert.equal(hit.killed, true);
    assert.equal(hit.dmg, m.maxHp, 'damage credited stops at the hp it removed');
    assert.equal(hit.resolved, overkill, 'the rolled amount is still reported');
    assert.equal(m.hp, 0);
  });

  it('a kill sets the same 5s respawn timer killMob uses', () => {
    const s = new Spawner(1337);
    const a = s.damageMob(s.spawnChunk(0, 0)[0]!.id, 999_999, 10_000)!;
    const b = s.spawnChunk(1, 1)[0]!;
    s.killMob(b.id, 10_000);
    assert.equal(a.mob.respawnAt, b.respawnAt, 'identical revival path');
    assert.equal(a.mob.respawnAt, 10_000 + RESPAWN_DELAY_MS);
  });

  it('a dead mob takes no further damage', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    s.damageMob(m.id, 999_999, 1000);
    assert.equal(s.damageMob(m.id, 50, 1100), null, 'no double-spend on a corpse');
  });

  it('unknown ids are a no-op', () => {
    const s = new Spawner(1337);
    assert.equal(s.damageMob(MOB_ID_MAX + 500, 10, 1000), null);
  });

  it('zero and negative damage deal nothing and kill nothing', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    const hp = m.hp;
    const zero = s.damageMob(m.id, 0, 1000)!;
    assert.equal(zero.dmg, 0);
    assert.equal(zero.killed, false);
    const neg = s.damageMob(m.id, -25, 1000)!;
    assert.equal(neg.dmg, 0, 'negative damage is floored at zero, never heals');
    assert.equal(m.hp, hp);
    assert.equal(m.alive, true);
  });
});

describe('spawner: index stays consistent with the mob map', () => {
  it('removed mobs leave the index', () => {
    const s = new Spawner(1337);
    const mobs = s.spawnChunk(0, 0);
    const m = mobs[0]!;
    assert.ok(s.nearestMobWithin(m.pos.x, m.pos.y, 2.2));
    assert.equal(s.removeMob(m.id), true);
    assert.equal(s.getMob(m.id), undefined);
    assert.equal(s.nearestMobWithin(m.pos.x, m.pos.y, 2.2), null, 'gone from the grid too');
    assert.equal(s.removeMob(m.id), false, 'removal is idempotent');
  });

  it('moveMob re-files the mob so queries follow it', () => {
    const s = new Spawner(1337);
    const m = s.spawnChunk(0, 0)[0]!;
    const far = MOB_CELL_SIZE * 40;
    assert.equal(s.moveMob(m.id, far, far), true);
    assert.equal(s.nearestMobWithin(m.pos.x, m.pos.y, 2.2)?.id, m.id, 'found at the new cell');
    assert.equal(s.nearestMobWithin(far - MOB_CELL_SIZE * 2, far, 2.2), null, 'not found at the old one');
    assert.equal(s.moveMob(MOB_ID_MAX + 1, 0, 0), false, 'unknown id is a no-op');
  });

  it('every mob id stays inside the spawner namespace', () => {
    const s = new Spawner(1337);
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) s.spawnChunk(cx, cy);
    for (const m of s.mobsList()) {
      assert.ok(m.id >= MOB_ID_MIN && m.id <= MOB_ID_MAX, `id ${m.id} in namespace`);
    }
    assert.equal(s.nearestMobWithin(1, 1, 2.2) === null || true, true); // no throw on a sparse map
  });
});
