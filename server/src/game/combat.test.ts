// Combat: damage, cooldown, range, death/respawn, aggro.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACK_COOLDOWN_MS,
  BASE_DMG,
  MELEE_RANGE,
  RESPAWN_DELAY_MS,
  damageFor,
  inMeleeRange,
  makeFighter,
  makeMob,
  tryMeleeAttack,
  updateAggro,
  updateRespawns,
} from './combat.js';

describe('combat melee', () => {
  it('deals base damage in range', () => {
    const a = makeFighter(1, 0, 0);
    const b = makeFighter(2, 1, 0);
    const r = tryMeleeAttack(1000, a, b);
    assert.equal(r.ok, true);
    assert.equal((r as { dmg: number }).dmg, damageFor(1));
    assert.equal(b.hp, b.maxHp - BASE_DMG);
  });

  it('rejects out-of-range swings', () => {
    const a = makeFighter(1, 0, 0);
    const b = makeFighter(2, MELEE_RANGE + 1, 0);
    const r = tryMeleeAttack(1000, a, b);
    assert.deepEqual(r, { ok: false, reason: 'out-of-range' });
    assert.equal(b.hp, b.maxHp);
  });

  it('enforces attack cooldown', () => {
    const a = makeFighter(1, 0, 0);
    const b = makeFighter(2, 1, 0);
    assert.equal(tryMeleeAttack(1000, a, b).ok, true);
    const r2 = tryMeleeAttack(1000 + ATTACK_COOLDOWN_MS - 1, a, b);
    assert.deepEqual(r2, { ok: false, reason: 'cooldown' });
    assert.equal(tryMeleeAttack(1000 + ATTACK_COOLDOWN_MS, a, b).ok, true);
  });

  it('kills and respawns after 5s at spawn pos', () => {
    const a = makeFighter(1, 0, 0, 99); // huge damage
    const m = makeMob(7, 1, 0);
    let now = 5000;
    let killed = false;
    for (let i = 0; i < 50 && !killed; i++, now += ATTACK_COOLDOWN_MS) {
      const r = tryMeleeAttack(now, a, m);
      if (r.ok && r.killed) killed = true;
    }
    assert.equal(killed, true);
    assert.equal(m.alive, false);
    // too early: no respawn
    assert.deepEqual(updateRespawns(now, [m]), []);
    // after delay: respawn with full hp at spawn
    const ids = updateRespawns(now + RESPAWN_DELAY_MS, [m]);
    assert.deepEqual(ids, [7]);
    assert.equal(m.alive, true);
    assert.equal(m.hp, m.maxHp);
    assert.deepEqual(m.pos, m.spawnPos);
  });

  it('aggro acquires nearest in range, drops beyond deaggro', () => {
    const m = makeMob(1, 0, 0);
    const near = makeFighter(10, 5, 0);
    const far = makeFighter(11, 100, 0);
    assert.deepEqual(updateAggro([m], [near, far]), [1]);
    assert.equal(m.targetId, 10);
    // move far away -> drop
    near.pos = { x: 100, y: 100 };
    assert.deepEqual(updateAggro([m], [near, far]), [1]);
    assert.equal(m.targetId, null);
  });
});
