// Quests: kill/collect/explore progress + XP/level rewards.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEST_ROADMAP,
  WAYFARER_ROAD,
  addXp,
  chunkKeyOf,
  createQuestState,
  isRoadComplete,
  nextRoadmapQuestId,
  onCollect,
  onExplore,
  onKill,
  roadActive,
  roadOnCollect,
  roadOnExplore,
  roadOnKill,
  roadQuest,
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

describe("Wayfarer's Road (the onboarding pacing ladder)", () => {
  it('is a strictly gated 4-step ladder with small, reachable thresholds', () => {
    assert.equal(WAYFARER_ROAD.length, 4);
    for (let i = 0; i < WAYFARER_ROAD.length; i++) {
      const q = WAYFARER_ROAD[i]!;
      assert.equal(q.seq, i + 1);
      assert.ok(roadQuest(q.id) === q);
      if (i === 0) assert.equal(q.prerequisite, undefined);
      else assert.equal(q.prerequisite, WAYFARER_ROAD[i - 1]!.id);
    }
    // Every threshold is reachable inside a first session, and the ladder
    // totals enough XP to level a new player on its own.
    for (const q of WAYFARER_ROAD) assert.ok(q.goal <= 3, `${q.id} goal ${q.goal} is too long for the first hour`);
    assert.ok(WAYFARER_ROAD.reduce((a, q) => a + q.rewardXp, 0) >= 100);
  });

  it('gates every step behind its predecessor, and never pays twice', () => {
    const s = createQuestState();
    assert.equal(roadActive(s)!.id, 'road-first-blood');
    // A flood of every kind of progress walks the ladder one rung at a time:
    // the kill step opens the collect step, and nothing jumps the queue.
    const out = [...roadOnKill(s, 25), ...roadOnCollect(s, 25), ...roadOnExplore(s, new Set(['0,0']), '9,9')];
    assert.ok(out.some((e) => e.type === 'complete' && (e as { questId: string }).questId === 'road-first-blood'));
    assert.equal(s.progress['road-pickups']!.done, true, 'the collect step opened once the kill step fell');
    assert.equal(s.progress['road-hunt']!.count, 0, 'step 3 is still shut behind the collect step');
    assert.equal(s.progress['road-lookout']!.count, 0, 'step 4 is still shut');
    // Replaying more of the same never re-pays a step that is already done.
    const xp = s.xp;
    const replay = roadOnKill(s, 25);
    assert.equal(
      replay.filter((e) => e.type === 'complete' && (e as { questId: string }).questId === 'road-first-blood').length,
      0,
      'a finished step must never pay twice',
    );
    assert.equal(s.progress['road-first-blood']!.count, WAYFARER_ROAD[0]!.goal, 'and its count is pinned at the goal');
    assert.ok(s.level > 1 || s.xp > xp, 'the newly-opened step did pay');
    assert.equal(roadActive(s)!.id, 'road-lookout');
  });

  it('completes end to end when the thresholds are met in play order', () => {
    const s = createQuestState();
    const order: string[] = [];
    const record = (evts: ReturnType<typeof roadOnKill>): void => {
      for (const e of evts) if (e.type === 'complete') order.push((e as { questId: string }).questId);
    };
    record(roadOnKill(s, 1));
    record(roadOnCollect(s, 3));
    record(roadOnKill(s, 3));
    const seen = new Set<string>([chunkKeyOf(0, 0)]);
    record(roadOnExplore(s, seen, '1,0'));
    record(roadOnExplore(s, seen, '2,0'));
    assert.deepEqual(order, WAYFARER_ROAD.map((q) => q.id));
    assert.equal(isRoadComplete(s), true);
    assert.equal(roadActive(s), null);
  });

  it('explore counts distinct NEW chunks only (the spawn chunk is free)', () => {
    const s = createQuestState();
    roadOnKill(s, 1);
    roadOnCollect(s, 3);
    roadOnKill(s, 3);
    const p = s.progress['road-lookout']!;
    p.done = false;
    p.count = 0;
    const seen = new Set<string>();
    roadOnExplore(s, seen, '0,0'); // the spawn chunk: no credit
    assert.equal(p.count, 0, 'standing on the spawn chunk charts nothing');
    roadOnExplore(s, seen, '1,0');
    assert.equal(p.count, 1, 'one new chunk beyond spawn');
    assert.deepEqual(roadOnExplore(s, seen, '1,0'), [], 'a repeat visit grants nothing');
    roadOnExplore(s, seen, '2,0');
    assert.equal(p.done, true, 'two new chunks completes the step');
  });
});

describe('quest roadmap (the single play order)', () => {
  it('stages every auto-advancing family exactly once, in order', () => {
    assert.deepEqual(QUEST_ROADMAP.map((s) => s.stage), [1, 2, 3, 4, 5]);
    assert.deepEqual(QUEST_ROADMAP.map((s) => s.track), ['tutorial', 'road', 'trio', 'maren', 'chapter']);
    // The trio is stated in play order (kill -> collect -> explore), not
    // alphabetised: slay5 first is what the tracker leads with.
    assert.deepEqual(QUEST_ROADMAP.find((s) => s.track === 'trio')!.ids, ['slay5', 'gather10', 'explorer']);
  });

  it('nextRoadmapQuestId returns the first unfinished quest, or null', () => {
    const s = createQuestState();
    assert.equal(nextRoadmapQuestId(s), 'road-first-blood', 'the tutorial ids come from the caller');
    for (const q of WAYFARER_ROAD) s.progress[q.id] = { questId: q.id, count: q.goal, done: true, claimed: true };
    assert.equal(nextRoadmapQuestId(s), 'slay5');
    onKill(s, 5);
    assert.equal(nextRoadmapQuestId(s), 'gather10');
    onCollect(s, 10);
    assert.equal(nextRoadmapQuestId(s), 'explorer');
  });

  it('accepts caller-supplied ids for the tracks that live elsewhere', () => {
    const s = createQuestState();
    assert.equal(nextRoadmapQuestId(s, { tutorial: ['tut-a', 'tut-b'] }), 'tut-a');
    assert.equal(nextRoadmapQuestId(s, { tutorial: [] , chapter: ['static-porchlight'] }), 'road-first-blood');
  });
});
