import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChainTracker } from './quests.js';

describe('ChainTracker', () => {
  it('mirrors the 5-quest Elder Maren chain in order', () => {
    const c = new ChainTracker();
    assert.equal(c.quests.length, 5);
    assert.deepEqual(c.quests.map((q) => q.id), [
      'ward-spark', 'ember-road', 'deep-delvers', 'chart-the-fall', 'heart-of-fall',
    ]);
    assert.equal(c.activeIndex(), 0);
    assert.equal(c.isChainDone(), false);
    assert.equal(c.chainProgress(), 0);
  });

  it('applies authoritative quest-progress (absolute counts win)', () => {
    const c = new ChainTracker();
    assert.equal(c.onQuestProgress('ward-spark', 2, 3), true);
    assert.equal(c.questById('ward-spark')!.count, 2);
    // Stale/duplicate event must not regress or double count.
    assert.equal(c.onQuestProgress('ward-spark', 1, 3), false);
    assert.equal(c.questById('ward-spark')!.count, 2);
    assert.equal(c.onQuestProgress('ward-spark', 3, 3), true);
    assert.equal(c.questById('ward-spark')!.count, 3);
  });

  it('ignores unknown quest ids and bad numbers', () => {
    const c = new ChainTracker();
    assert.equal(c.onQuestProgress('slay5', 3, 5), false);
    assert.equal(c.onQuestProgress('ward-spark', NaN, 3), false);
    assert.equal(c.onQuestProgress('ward-spark', 1, 0), false);
    assert.equal(c.questById('ward-spark')!.count, 0);
  });

  it('quest-complete marks done and pins the count to the goal', () => {
    const c = new ChainTracker();
    const q = c.onQuestComplete('ward-spark');
    assert.ok(q);
    assert.equal(q!.done, true);
    assert.equal(q!.count, q!.goal);
    assert.equal(c.activeIndex(), 1, 'advances to the next chain quest');
    // Duplicate completion is a no-op.
    assert.equal(c.onQuestComplete('ward-spark'), null);
    // Out-of-order completion is allowed but does not move the pointer until
    // the earlier quest is done (the server enforces prerequisites anyway).
    c.onQuestComplete('heart-of-fall');
    assert.equal(c.activeIndex(), 1);
  });

  it('onMobDie only advances the active kill quest', () => {
    const c = new ChainTracker();
    assert.equal(c.onMobDie(true), true);
    assert.equal(c.questById('ward-spark')!.count, 1);
    assert.equal(c.onMobDie(false), false, 'other players\' kills do not count');
    assert.equal(c.questById('ward-spark')!.count, 1);
    // Complete ward-spark, then the active quest is a collect quest -> no credit.
    c.onQuestComplete('ward-spark');
    assert.equal(c.onMobDie(true), false);
    assert.equal(c.localKillCount(), 2, 'kill tally still increments');
  });

  it('caps kill progress at the goal', () => {
    const c = new ChainTracker();
    for (let i = 0; i < 10; i++) c.onMobDie(true);
    assert.equal(c.questById('ward-spark')!.count, 3);
    assert.equal(c.onMobDie(true), false, 'already at goal');
  });

  it('serverCountForActive suppresses the local fallback (no double count)', () => {
    const c = new ChainTracker();
    assert.equal(c.onMobDie(true, 1), false);
    assert.equal(c.questById('ward-spark')!.count, 0);
  });

  it('onExploreStep credits explore quests only', () => {
    const c = new ChainTracker();
    assert.equal(c.onExploreStep(), false, 'active quest is a kill quest');
    c.onQuestComplete('ward-spark');
    c.onQuestComplete('ember-road');
    c.onQuestComplete('deep-delvers');
    assert.equal(c.activeIndex(), 3);
    assert.equal(c.onExploreStep(), true);
    assert.equal(c.questById('chart-the-fall')!.count, 1);
    for (let i = 0; i < 9; i++) c.onExploreStep();
    assert.equal(c.questById('chart-the-fall')!.count, 4);
  });

  it('toHud marks the active quest and clamps counts', () => {
    const c = new ChainTracker();
    c.onQuestProgress('ward-spark', 99, 3);
    const hud = c.toHud();
    assert.equal(hud.length, 5);
    assert.match(hud[0]!.title, /^▶ Ward-Spark \(3\/3\)$/);
    assert.equal(hud[0]!.done, false, 'goal reached but not yet completed');
    c.onQuestComplete('ward-spark');
    const hud2 = c.toHud();
    assert.equal(hud2[0]!.done, true);
    assert.match(hud2[1]!.title, /^▶ Ember Road/);
  });

  it('chainProgress reports fractional completion and reaches 1 when done', () => {
    const c = new ChainTracker();
    assert.equal(c.chainProgress(), 0);
    c.onMobDie(true);
    const p = c.chainProgress();
    assert.ok(p > 0 && p < 1, `expected 0<p<1, got ${p}`);
    for (const q of c.quests) c.onQuestComplete(q.id);
    assert.equal(c.isChainDone(), true);
    assert.equal(c.activeIndex(), -1);
    assert.equal(c.chainProgress(), 1);
  });

  it('xp-gain alone never advances a quest', () => {
    const c = new ChainTracker();
    c.onXpGain(50);
    assert.equal(c.questById('ward-spark')!.count, 0);
  });
});