// World tiers: geography, scaling and the soft wall. Tier 1 must be the old
// balance; the balance budget is read from the real content tables where it
// matters, never copied into a magic number that can drift.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_ANCHORS, BOSS_ANCHORS, getZone } from '@aetherfall/engine';
import { meleeDamageFor, mobMaxHp, xpForKill } from '../content.js';
import {
  PENALTY_DAMAGE_MAX,
  TIER1_ANCHOR_RADIUS,
  TIER2_ANCHOR_RADIUS,
  TIER3_ANCHOR_RADIUS,
  TIER_STAT_CAPS,
  TIER_ZONE_FLOOR,
  clampTier,
  nearestBossRoost,
  nearestSpawnAnchor,
  penalizedDamage,
  penalizedXp,
  tierAt,
  tierPenalty,
  tierStats,
} from './world_tiers.js';

describe('tierAt geography', () => {
  it('keeps every spawn anchor and its safe ring at tier 1', () => {
    for (const a of SPAWN_ANCHORS) {
      assert.equal(tierAt(a.x, a.y), 1, `${a.name} centre`);
      const r = TIER1_ANCHOR_RADIUS - 1;
      assert.equal(tierAt(a.x + r, a.y), 1, `${a.name} +x edge`);
      assert.equal(tierAt(a.x, a.y - r), 1, `${a.name} -y edge`);
    }
  });

  it('rises outward along an anchor-free ray', () => {
    // Negative quadrant: the nearest anchor is always the origin, and every
    // boss roost is far away, so this isolates the anchor-distance gradient.
    const samples = [0, TIER1_ANCHOR_RADIUS, 40, 60, 90].map((d) => {
      const k = d / Math.SQRT2;
      return tierAt(-k, -k);
    });
    assert.deepEqual(samples, [1, 1, 2, 3, 4]);
    for (let i = 1; i < samples.length; i++) assert.ok(samples[i]! >= samples[i - 1]!);
  });

  it('puts all four boss roosts in the tier-4 crown', () => {
    for (const b of BOSS_ANCHORS) {
      assert.equal(tierAt(b.x, b.y), 4, `${b.name} roost`);
    }
  });

  it('applies zone floors outside the sanctuary', () => {
    assert.equal(TIER_ZONE_FLOOR.meadow, 1);
    assert.equal(TIER_ZONE_FLOOR.dungeon, 2);
    assert.equal(TIER_ZONE_FLOOR.volcano, 3);

    const dungeonSite = { x: 88, y: 78 };
    assert.equal(getZone(dungeonSite.x, dungeonSite.y), 'dungeon');
    assert.ok(tierAt(dungeonSite.x, dungeonSite.y) >= 2);

    const volcanoSite = { x: 200, y: 200 };
    assert.equal(getZone(volcanoSite.x, volcanoSite.y), 'volcano');
    assert.ok(tierAt(volcanoSite.x, volcanoSite.y) >= 3);
  });

  it('finds the same nearest anchor/roost the tier rules use', () => {
    const a = nearestSpawnAnchor(50, 50);
    assert.equal(a?.name, 'shrine');
    assert.equal(a?.distance, 0);
    const b = nearestBossRoost(80, 80);
    assert.equal(b?.name, 'stone-golem');
    assert.equal(b?.distance, 0);
    // Returned copies: mutating them cannot corrupt the frozen engine tables.
    if (a) a.x = -999;
    assert.equal(SPAWN_ANCHORS[1]!.x, 50);
  });

  it('is deterministic and clamps junk into 1..4', () => {
    assert.equal(tierAt(61, 73), tierAt(61, 73));
    assert.equal(tierAt(61, 73, 1337), tierAt(61, 73, 1337));
    assert.equal(tierAt(NaN, 10), 1);
    assert.equal(tierAt(10, Infinity), 1);
    assert.equal(clampTier(-5), 1);
    assert.equal(clampTier(9), 4);
    assert.equal(clampTier(2.8), 2);
  });
});

describe('tierStats scaling', () => {
  it('leaves tier 1 exactly at the documented budget', () => {
    const base = { hp: mobMaxHp('meadow', 1), damage: 7, xp: xpForKill('meadow', 1) };
    assert.deepEqual(base, { hp: 48, damage: 7, xp: 30 });
    assert.deepEqual(tierStats(1, base), base);
    // 12 + 3/lvl player, 48 HP meadow minion -> the same 4-swing TTK.
    assert.equal(Math.ceil(tierStats(1, base).hp / meleeDamageFor(1)), 4);
  });

  it('scales HP, damage and XP upward with the tier', () => {
    const base = { hp: 48, damage: 7, xp: 20 };
    const rows = [1, 2, 3, 4].map((t) => tierStats(t, base));
    for (const key of ['hp', 'damage', 'xp'] as const) {
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i]![key] > rows[i - 1]![key], `${key} must grow from tier ${i} to ${i + 1}`);
      }
    }
    assert.deepEqual(rows[3], { hp: 96, damage: 12, xp: 42 });
  });

  it('caps every multiplier and never emits NaN', () => {
    const huge = { hp: 1000, damage: 1000, xp: 1000 };
    assert.deepEqual(tierStats(4, huge), {
      hp: 1000 * TIER_STAT_CAPS.hp,
      damage: Math.round(1000 * TIER_STAT_CAPS.damage),
      xp: 1000 * TIER_STAT_CAPS.xp,
    });
    assert.deepEqual(tierStats(9, huge), tierStats(4, huge));
    assert.deepEqual(tierStats(0, huge), tierStats(1, huge));
    assert.deepEqual(tierStats(3, { hp: NaN, damage: -4, xp: Infinity }), { hp: 0, damage: 0, xp: 0 });
  });
});

describe('tierPenalty soft wall', () => {
  it('does not touch a levelled player or tier 1', () => {
    for (const level of [1, 8, 60]) assert.deepEqual(tierPenalty(level, 1), { damageTakenMult: 1, xpMult: 1, underLevel: 0 });
    assert.deepEqual(tierPenalty(4, 2), { damageTakenMult: 1, xpMult: 1, underLevel: 0 });
    assert.deepEqual(tierPenalty(8, 4), { damageTakenMult: 1, xpMult: 1, underLevel: 0 });
  });

  it('grows harder the further below the tier floor the player is', () => {
    const lvl7 = tierPenalty(7, 4);
    const lvl4 = tierPenalty(4, 4);
    const lvl1 = tierPenalty(1, 4);
    assert.ok(lvl7.damageTakenMult > 1 && lvl7.xpMult < 1);
    assert.ok(lvl4.damageTakenMult > lvl7.damageTakenMult);
    assert.ok(lvl1.damageTakenMult > lvl4.damageTakenMult);
    assert.ok(lvl1.xpMult < lvl4.xpMult);
    assert.deepEqual(lvl1, { damageTakenMult: 1.84, xpMult: 0.35, underLevel: 7 });
    assert.ok(lvl1.damageTakenMult <= PENALTY_DAMAGE_MAX);
  });

  it('clamps invalid levels instead of granting an exploit', () => {
    assert.deepEqual(tierPenalty(-12, 1), tierPenalty(1, 1));
    assert.deepEqual(tierPenalty(NaN, 4), tierPenalty(1, 4));
    assert.deepEqual(tierPenalty(1, 99), tierPenalty(1, 4));
  });

  it('has integer consumers for damage and XP', () => {
    const safe = tierPenalty(1, 1);
    const doomed = tierPenalty(1, 4);
    assert.equal(penalizedDamage(7, safe), 7);
    assert.equal(penalizedXp(20, safe), 20);
    assert.equal(penalizedDamage(7, doomed), 13); // ceil(7 * 1.84)
    assert.equal(penalizedXp(20, doomed), 7); // floor(20 * 0.35)
    assert.equal(penalizedDamage(-5, doomed), 0);
    assert.equal(penalizedXp(NaN, doomed), 0);
  });
});
