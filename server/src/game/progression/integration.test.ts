// Executable documentation for the future tick-loop call site: compose the
// pure pieces exactly as game/index.ts and index.ts will, and prove that the
// tier-1 path is a no-op while the high-tier path is the intended soft wall.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOSS_ANCHORS } from '@aetherfall/engine';
import { mobMaxHp, xpForKill } from '../content.js';
import { worldEventAt } from './events.js';
import {
  awardFor,
  createReputation,
  grantReputation,
} from './reputation.js';
import {
  penalizedDamage,
  penalizedXp,
  tierAt,
  tierPenalty,
  tierStats,
} from './world_tiers.js';

describe('composed world-progression pipeline', () => {
  it('pays the old, full reward for a tier-1 kill at the spawn', () => {
    const tier = tierAt(0, 0);
    const base = { hp: mobMaxHp('meadow', 1), damage: 7, xp: xpForKill('meadow', 1) };
    const stats = tierStats(tier, base);
    const penalty = tierPenalty(1, tier);

    assert.equal(tier, 1);
    assert.deepEqual(stats, base);
    assert.deepEqual(penalty, { damageTakenMult: 1, xpMult: 1, underLevel: 0 });
    assert.equal(penalizedXp(stats.xp, penalty), 30);
    assert.equal(penalizedDamage(stats.damage, penalty), 7);

    const { state } = grantReputation(createReputation(), awardFor(tier, 'kill'));
    assert.equal(state.balance['ashen-vigil'], 2);
    assert.equal(state.earned['ashen-vigil'], 2);
  });

  it('softens an under-levelled visitor at a boss crown without blocking them', () => {
    const roost = BOSS_ANCHORS[3]!;
    const tier = tierAt(roost.x, roost.y);
    const stats = tierStats(tier, { hp: 194, damage: 12, xp: 95 });
    const penalty = tierPenalty(1, tier);

    assert.equal(tier, 4);
    assert.ok(penalty.underLevel > 0);
    assert.ok(penalizedXp(stats.xp, penalty) < stats.xp, 'less XP for the over-reacher');
    assert.ok(penalizedDamage(stats.damage, penalty) > stats.damage, 'but they can still take the hit');
    assert.ok(awardFor(tier, 'kill')['ashen-vigil'] > awardFor(1, 'kill')['ashen-vigil']);
  });

  it('folds a shard-surge multiplier on top without changing the schedule', () => {
    const event = worldEventAt(1337, 0);
    assert.equal(event.kind, 'shard-surge');
    const baseXp = 40;
    const boosted = Math.floor(baseXp * (event.xpMult ?? 1));
    assert.ok(boosted > baseXp);
    assert.deepEqual(worldEventAt(1337, 0), event);
  });
});
