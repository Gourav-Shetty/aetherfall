// PLAYABILITY strike team — difficulty sanity acceptance.
// TTD >20s for a naked level-1 idle player, single mob hits in 6-14, and the
// player-side TTK table stays 3-5 swings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MELEE_COOLDOWN, MELEE_DAMAGE } from '../ai/npc.js';
import { ATTACK_COOLDOWN_MS, BASE_DMG } from './combat.js';
import { ttkHits, type ZoneId } from './content.js';

describe('difficulty sanity: numbers the strike team guarantees', () => {
  it('a single minion hit lands in 6-14 damage', () => {
    assert.ok(
      MELEE_DAMAGE >= 6 && MELEE_DAMAGE <= 14,
      `minion hit ${MELEE_DAMAGE} outside 6-14`,
    );
  });

  it('naked level-1 idle TTD exceeds 20s vs one minion', () => {
    // First swing lands at t=0, so TTD = (hits-1) * cooldown.
    const hits = Math.ceil(100 / MELEE_DAMAGE);
    const ttd = (hits - 1) * MELEE_COOLDOWN;
    assert.ok(ttd > 20, `TTD ${ttd}s (hits=${hits}, dmg=${MELEE_DAMAGE}, cd=${MELEE_COOLDOWN}s) <= 20s`);
  });

  it('player TTK stays 3-5 swings for same-zone matchups (raw curve)', () => {
    const cases: Array<[ZoneId, number, number]> = [
      ['meadow', 1, 0],
      ['meadow', 2, 2],
      ['dungeon', 3, 5],
      ['dungeon', 4, 6],
      ['volcano', 5, 8],
      ['volcano', 8, 12],
    ];
    for (const [zone, mobLvl, bonus] of cases) {
      const ttk = ttkHits(zone, mobLvl, mobLvl, bonus);
      assert.ok(ttk >= 3 && ttk <= 5, `${zone} lvl${mobLvl}+${bonus}: TTK=${ttk}`);
    }
  });

  it('player base damage + swing rate are untouched (12, 800ms)', () => {
    assert.equal(BASE_DMG, 12);
    assert.equal(ATTACK_COOLDOWN_MS, 800);
  });
});
