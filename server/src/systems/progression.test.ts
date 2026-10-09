// progression: XP curve, talent points, the 3x5 skill tree, respec, stat aggregation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, weaponDef } from '../game/content.js';
import {
  BASE_STATS,
  BRANCHES,
  MAX_LEVEL,
  PER_LEVEL_STATS,
  RESPEC_BASE_GOLD,
  SKILL_TREE,
  STAT_KEYS,
  addStats,
  addXp,
  aggregateStats,
  createProgression,
  cumulativeXpForLevel,
  emptyStatBlock,
  learnNode,
  nodesInBranch,
  powerScore,
  respec,
  respecCost,
  scaleStats,
  skillNode,
  statsForItem,
  talentPointsForLevel,
  validateSkillTree,
  xpToNextLevel,
  type ProgressionState,
} from './progression.js';

describe('progression XP curve', () => {
  it('is 50 * L * (L+1) and strictly increasing', () => {
    assert.equal(xpToNextLevel(1), 100);
    assert.equal(xpToNextLevel(2), 300);
    assert.equal(xpToNextLevel(5), 1500);
    assert.equal(xpToNextLevel(60), 50 * 60 * 61);
    for (let l = 1; l < MAX_LEVEL; l++) assert.ok(xpToNextLevel(l + 1) > xpToNextLevel(l));
  });

  it('clamps nonsense levels to level 1 behaviour', () => {
    assert.equal(xpToNextLevel(0), 100);
    assert.equal(xpToNextLevel(-5), 100);
    assert.equal(xpToNextLevel(3.9), xpToNextLevel(3));
  });

  it('cumulative XP is the sum of the thresholds', () => {
    assert.equal(cumulativeXpForLevel(1), 0);
    assert.equal(cumulativeXpForLevel(2), 100);
    assert.equal(cumulativeXpForLevel(3), 400);
    let manual = 0;
    for (let l = 1; l < 10; l++) manual += xpToNextLevel(l);
    assert.equal(cumulativeXpForLevel(10), manual);
  });

  it('XP grants level up and hands out talent points', () => {
    const start = createProgression(1);
    const r = addXp(start, xpToNextLevel(1));
    assert.equal(r.state.level, 2);
    assert.equal(r.state.xp, 0);
    const levelUp = r.events.find((e) => e.type === 'level-up');
    assert.equal(levelUp?.type === 'level-up' && levelUp.level, 2);
    assert.equal(levelUp?.type === 'level-up' && levelUp.talentPointsGained, 1);
    assert.equal(r.state.talentPoints, start.talentPoints + 1);
  });

  it('carries surplus XP across levels', () => {
    const r = addXp(createProgression(1), xpToNextLevel(1) + 50);
    assert.equal(r.state.level, 2);
    assert.equal(r.state.xp, 50);
  });

  it('handles multi-level gains in one call', () => {
    const r = addXp(createProgression(1), xpToNextLevel(1) + xpToNextLevel(2) + 1);
    assert.equal(r.state.level, 3);
    assert.equal(r.state.xp, 1);
    assert.equal(r.events.filter((e) => e.type === 'level-up').length, 2);
  });

  it('stops at MAX_LEVEL', () => {
    const r = addXp(createProgression(MAX_LEVEL - 1), 10_000_000);
    assert.equal(r.state.level, MAX_LEVEL);
    assert.ok(r.state.xp <= xpToNextLevel(MAX_LEVEL));
  });

  it('ignores non-positive XP and never mutates the input', () => {
    const s = createProgression(1);
    assert.equal(addXp(s, 0).state, s);
    assert.equal(addXp(s, -100).state, s);
    assert.equal(s.level, 1);
    assert.equal(s.xp, 0);
  });
});

describe('progression talent points', () => {
  it('one point per level plus a bonus every 5th', () => {
    assert.equal(talentPointsForLevel(1), 1);
    assert.equal(talentPointsForLevel(4), 4);
    assert.equal(talentPointsForLevel(5), 6); // 5 + 1 bonus
    assert.equal(talentPointsForLevel(10), 12);
    assert.equal(talentPointsForLevel(0), 1);
  });

  it('a fresh character holds exactly talentPointsForLevel(level)', () => {
    assert.equal(createProgression(1).talentPoints, 1);
    assert.equal(createProgression(7).talentPoints, 8);
  });

  it('spending points reduces the pool and tracks spentPoints', () => {
    let s = createProgression(5);
    const before = s.talentPoints;
    const r = learnNode(s, 'might-1');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.state.talentPoints, before - 1);
    assert.equal(r.state.spentPoints, 1);
    assert.equal(s.talentPoints, before, 'input untouched');
  });

  it('refuses to overspend', () => {
    // burn the level-1 point first, then try to spend a second
    const first = learnNode(createProgression(1), 'might-1');
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const broke = first.state;
    assert.equal(broke.talentPoints, 0);
    const r = learnNode(broke, 'guile-1');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'no-points');
  });
});

describe('progression skill tree', () => {
  it('has 3 branches with 5 nodes each', () => {
    assert.deepEqual([...BRANCHES], ['might', 'guile', 'will']);
    assert.equal(SKILL_TREE.length, 15);
    for (const b of BRANCHES) assert.equal(nodesInBranch(b).length, 5);
  });

  it('is structurally valid (prereqs exist, same branch, lower tier)', () => {
    assert.deepEqual(validateSkillTree(), []);
  });

  it('node ids, names and costs are well formed', () => {
    const seen = new Set<string>();
    for (const n of SKILL_TREE) {
      assert.equal(seen.has(n.id), false, `${n.id} duplicated`);
      seen.add(n.id);
      assert.ok(n.name.length > 0 && n.description.length > 0);
      assert.ok(n.costPerRank >= 1);
      assert.ok(n.maxRank >= 1);
      assert.ok(n.perRank && Object.keys(n.perRank).length > 0, `${n.id} has no effect`);
      for (const k of Object.keys(n.perRank)) {
        assert.ok(STAT_KEYS.includes(k as (typeof STAT_KEYS)[number]), `${n.id} touches unknown stat ${k}`);
      }
    }
  });

  it('tiers 1..5 appear exactly once per branch', () => {
    for (const b of BRANCHES) {
      const tiers = nodesInBranch(b).map((n) => n.tier);
      assert.deepEqual(tiers, [1, 2, 3, 4, 5]);
    }
  });

  it('skillNode resolves every id and rejects unknown ones', () => {
    for (const n of SKILL_TREE) assert.equal(skillNode(n.id)?.id, n.id);
    assert.equal(skillNode('nonexistent'), undefined);
  });

  it('prerequisites gate learning', () => {
    const s = createProgression(20);
    const gated = learnNode(s, 'might-3');
    assert.equal(gated.ok, false);
    if (gated.ok) return;
    assert.equal(gated.reason, 'prereq');
    assert.equal(gated.detail, 'might-2 rank 1');

    let cur: ProgressionState = s;
    for (const id of ['might-1', 'might-2']) {
      const r = learnNode(cur, id);
      assert.equal(r.ok, true, id);
      if (!r.ok) return;
      cur = r.state;
    }
    const now = learnNode(cur, 'might-3');
    assert.equal(now.ok, true);
  });

  it('ranks cap at maxRank and tier-5 nodes cost 2 points', () => {
    let s = createProgression(60);
    const cap = learnNode(s, 'might-1'); // maxRank 3, cost 1
    if (!cap.ok) return;
    s = cap.state;
    s = { ...s };
    for (let i = 0; i < 5; i++) {
      const r = learnNode(s, 'might-1');
      if (r.ok) s = r.state;
    }
    assert.equal(s.talents['might-1'], 3);
    const over = learnNode(s, 'might-1');
    assert.equal(over.ok, false);
    if (over.ok) return;
    assert.equal(over.reason, 'maxed');

    let apex = createProgression(60);
    // tier 5 needs tier 4 at rank 2, and tier 4 needs tier 3 at rank 2
    for (const id of ['might-1', 'might-2', 'might-3', 'might-3', 'might-4', 'might-4']) {
      const r = learnNode(apex, id);
      assert.equal(r.ok, true, id);
      if (!r.ok) return;
      apex = r.state;
    }
    const pointsBefore = apex.talentPoints;
    const apexRes = learnNode(apex, 'might-5');
    assert.equal(apexRes.ok, true);
    if (!apexRes.ok) return;
    assert.equal(apexRes.state.talentPoints, pointsBefore - 2, 'apex node costs 2');
  });

  it('a full branch can be maxed from scratch at level 60', () => {
    let s = createProgression(60);
    const order = ['might-1', 'might-2', 'might-3', 'might-4', 'might-5'];
    for (let pass = 0; pass < 3; pass++) {
      for (const id of order) {
        const r = learnNode(s, id);
        if (r.ok) s = r.state;
      }
    }
    assert.equal(s.talents['might-1'], 3);
    assert.equal(s.talents['might-5'], 1);
    assert.equal(s.talentPoints >= 0, true);
  });

  it('rejects unknown nodes', () => {
    const r = learnNode(createProgression(60), 'dragon-breath');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'unknown-node');
  });

  it('learn events carry branch + remaining points', () => {
    const r = learnNode(createProgression(5), 'guile-1');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const ev = r.events[0];
    assert.equal(ev?.type, 'talent-learned');
    if (ev?.type === 'talent-learned') {
      assert.equal(ev.branch, 'guile');
      assert.equal(ev.rank, 1);
    }
  });
});

describe('progression respec', () => {
  it('cost starts at 100 and escalates with level and repeats', () => {
    assert.equal(RESPEC_BASE_GOLD, 100);
    assert.equal(respecCost(1), 100);
    assert.equal(respecCost(1, 0), 100);
    assert.equal(respecCost(10), 10_000);
    assert.equal(respecCost(60), 360_000, 'stays sane at the level cap');
    assert.ok(respecCost(10) > respecCost(5));
    assert.ok(respecCost(10, 1) > respecCost(10, 0));
    for (let l = 1; l < MAX_LEVEL; l++) assert.ok(respecCost(l + 1) > respecCost(l));
  });

  it('refunds every spent point in full', () => {
    let s = createProgression(10);
    const a = learnNode(s, 'might-1');
    if (!a.ok) return;
    s = a.state;
    const b = learnNode(s, 'guile-1');
    if (!b.ok) return;
    s = b.state;
    const spent = s.spentPoints;
    const pointsBefore = s.talentPoints;
    const cost = respecCost(s.level, s.respecCount);
    const r = respec(s, cost);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.state.talents['might-1'], undefined);
    assert.equal(r.state.talentPoints, pointsBefore + spent);
    assert.equal(r.state.spentPoints, 0);
    assert.equal(r.state.respecCount, 1);
    const ev = r.events[0];
    assert.equal(ev?.type === 'respec' && ev.refundedPoints, spent);
  });

  it('rejects when the gold is short and when there is nothing to respec', () => {
    const s = createProgression(10);
    const empty = respec(s, 10_000);
    assert.equal(empty.ok, false);
    const learned = learnNode(s, 'might-1');
    if (!learned.ok) return;
    const poor = respec(learned.state, 1);
    assert.equal(poor.ok, false);
    if (poor.ok) return;
    assert.equal(poor.reason, 'no-points');
  });
});

describe('progression stat aggregation', () => {
  it('level 1 naked = BASE_STATS', () => {
    const s = aggregateStats(1, {});
    assert.deepEqual(s, { ...BASE_STATS });
  });

  it('adds per-level growth for every level past 1', () => {
    const s = aggregateStats(10, {});
    assert.equal(s.maxHp, BASE_STATS.maxHp + PER_LEVEL_STATS.maxHp * 9);
    assert.equal(s.might, BASE_STATS.might + PER_LEVEL_STATS.might * 9);
  });

  it('talents stack per rank', () => {
    const node = skillNode('might-1')!;
    const one = aggregateStats(1, { 'might-1': 1 });
    const three = aggregateStats(1, { 'might-1': 3 });
    assert.equal(one.might, BASE_STATS.might + node.perRank.might!);
    assert.equal(three.might, BASE_STATS.might + node.perRank.might! * 3);
    assert.equal(three.maxHp, BASE_STATS.maxHp + node.perRank.maxHp! * 3);
  });

  it('ignores unknown or zero-rank talent ids', () => {
    assert.deepEqual(aggregateStats(5, { 'not-a-node': 9 }), aggregateStats(5, { 'might-1': 0 }));
  });

  it('item stats add on top of base + talents', () => {
    const items = [{ itemId: 'ring', stats: { maxHp: 25, might: 4 } }];
    const s = aggregateStats(1, { 'might-1': 1 }, items);
    assert.equal(s.maxHp, BASE_STATS.maxHp + 10 + 25);
    assert.equal(s.might, BASE_STATS.might + 2 + 4);
  });

  it('weapon damage maps to attack power', () => {
    const sword = WEAPONS[WEAPONS.length - 1]!;
    const stats = statsForItem(sword);
    assert.equal(stats.attackPower, sword.damage);
    assert.equal(weaponDef(sword.id)?.damage, sword.damage);
    const withSword = aggregateStats(1, {}, [{ itemId: sword.id, stats: statsForItem(sword) }]);
    assert.equal(withSword.attackPower, BASE_STATS.attackPower + sword.damage);
  });

  it('non-weapon items contribute nothing passively', () => {
    assert.deepEqual(statsForItem({ id: 'x', name: 'X', kind: 'material', description: '', price: 5 }), {});
  });

  it('clamps negative stats to zero and never emits NaN', () => {
    const s = aggregateStats(1, {}, [{ itemId: 'cursed', stats: { maxHp: -5000 } }]);
    assert.equal(s.maxHp, 0);
    for (const k of STAT_KEYS) assert.ok(Number.isFinite(s[k]), `${k} is not finite`);
  });

  it('a fully invested build beats a naked one', () => {
    const build = aggregateStats(60, {
      'might-1': 3, 'might-2': 3, 'might-3': 3, 'might-4': 3, 'might-5': 1,
      'guile-1': 3, 'guile-2': 3, 'guile-3': 3, 'guile-4': 3, 'guile-5': 1,
    }, [{ itemId: 'sword', stats: { attackPower: 12 } }]);
    const naked = aggregateStats(1, {});
    assert.ok(powerScore(build) > powerScore(naked));
    assert.ok(build.critChance > naked.critChance);
    assert.ok(build.blockChance > naked.blockChance);
  });

  it('stat helpers are consistent', () => {
    const zero = emptyStatBlock();
    assert.deepEqual(Object.keys(zero).sort(), [...STAT_KEYS].sort());
    for (const k of STAT_KEYS) assert.equal(zero[k], 0);
    const doubled = scaleStats({ ...BASE_STATS }, 2);
    assert.equal(doubled.maxHp, BASE_STATS.maxHp * 2);
    const summed = addStats(BASE_STATS, { maxHp: 5 });
    assert.equal(summed.maxHp, BASE_STATS.maxHp + 5);
    assert.equal(summed.might, BASE_STATS.might);
  });

  it('crit chance stays inside [0,1] for any legal build', () => {
    const maxed: Record<string, number> = {};
    for (const n of SKILL_TREE) maxed[n.id] = n.maxRank;
    const s = aggregateStats(MAX_LEVEL, maxed);
    assert.ok(s.critChance > 0 && s.critChance <= 1, `critChance=${s.critChance}`);
    assert.ok(s.blockChance > 0 && s.blockChance <= 1, `blockChance=${s.blockChance}`);
    assert.ok(s.blockReduction > 0 && s.blockReduction <= 1, `blockReduction=${s.blockReduction}`);
  });
});