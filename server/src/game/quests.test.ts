// Quests: kill/collect/explore progress + XP/level rewards.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addXp,
  chunkKeyOf,
  createQuestState,
  onCollect,
  onExplore,
  onKill,
} from './quests.js';

describe('quests', () => {
  it('slay5 completes after 5 kills and grants XP', () => {
    const s = createQuestState();
    let evts = onKill(s, 3);
    assert.equal(s.progress['slay5']!.count, 3);
    assert.equal(s.progress['slay5']!.done, false);
    evts = onKill(s, 2);
    assert.equal(s.progress['slay5']!.count, 5);
    assert.equal(s.progress['slay5']!.done, true);
    assert.ok(evts.some((e) => e.type === 'complete' && (e as { questId: string }).questId === 'slay5'));
    assert.equal(s.xp, 60); // reward, no levelup yet (needs 100)
    assert.equal(s.level, 1);
  });

  it('gather10 completes after 10 pickups', () => {
    const s = createQuestState();
    onCollect(s, 9);
    assert.equal(s.progress['gather10']!.done, false);
    onCollect(s, 1);
    assert.equal(s.progress['gather10']!.count, 10);
    assert.equal(s.progress['gather10']!.done, true);
  });

  it('explorer counts distinct new chunks beyond spawn', () => {
    const s = createQuestState();
    const seen = new Set<string>();
    onExplore(s, seen, chunkKeyOf(0, 0)); // spawn chunk: no progress
    assert.equal(s.progress['explorer']!.count, 0);
    onExplore(s, seen, chunkKeyOf(0, 0)); // repeat: ignored
    assert.equal(s.progress['explorer']!.count, 0);
    onExplore(s, seen, chunkKeyOf(40, 0));
    onExplore(s, seen, chunkKeyOf(80, 0));
    assert.equal(s.progress['explorer']!.count, 2);
    onExplore(s, seen, chunkKeyOf(120, 0));
    assert.equal(s.progress['explorer']!.done, true);
  });

  it('XP thresholds level up (level*100)', () => {
    const s = createQuestState();
    const evts = addXp(s, 100);
    assert.equal(s.level, 2);
    assert.equal(s.xp, 0);
    assert.ok(evts.some((e) => e.type === 'levelup' && (e as { level: number }).level === 2));
    // level 2 needs 200 more
    addXp(s, 199);
    assert.equal(s.level, 2);
    addXp(s, 1);
    assert.equal(s.level, 3);
  });

  it('quest XP can chain into levelup', () => {
    const s = createQuestState();
    onCollect(s, 10); // +80 xp
    assert.equal(s.level, 1);
    onKill(s, 5); // +60 xp -> 140 total -> level 2 with 40 carry
    assert.equal(s.level, 2);
    assert.equal(s.xp, 40);
  });
});
