// Chapter Two (PARTITION) walkthrough: STATIC gate -> 5 missions -> twist -> reward.
// Sequential gating is a real predicate over QuestState; no timers anywhere.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestState, type QuestEvent } from '../game/quests.js';
import { isStaticChapterDone, staticOnCollect, staticOnExplore, staticOnKill } from './chapter.js';
import {
  PARTITION_CHAPTER_ID,
  PARTITION_CHAPTER_TITLE,
  PARTITION_MASK_ID,
  PARTITION_MISSION_ORDER,
  PARTITION_MISSIONS,
  PARTITION_PAYOFF,
  PARTITION_PAYOFF_ID,
  PARTITION_TITLE_REWARD,
  claimPartitionPayoff,
  ensurePartitionProgress,
  isChapterTwoUnlocked,
  isPartitionChapterDone,
  isPartitionUnlocked,
  partitionActiveMission,
  partitionChapterProgress,
  partitionMission,
  partitionOnCollect,
  partitionOnExplore,
  partitionOnKill,
  partitionPayoffFor,
} from './chapter-two.js';

/** Complete the real STATIC chain so Chapter Two's gate opens. */
function finishStatic(): ReturnType<typeof createQuestState> {
  const s = createQuestState();
  staticOnKill(s, 4);
  staticOnCollect(s, 6);
  staticOnKill(s, 6);
  const seen = new Set<string>(['0,0']);
  for (const k of ['1,0', '2,0', '3,0', '4,0']) staticOnExplore(s, seen, k);
  staticOnKill(s, 8);
  assert.equal(isStaticChapterDone(s), true);
  return s;
}

function walkPartition(s: ReturnType<typeof createQuestState>): QuestEvent[] {
  const out: QuestEvent[] = [];
  const seen = new Set<string>(['0,0']);
  for (const k of ['1,0', '2,0', '3,0']) out.push(...partitionOnExplore(s, seen, k));
  assert.equal(s.progress['partition-dead-air']!.done, true);
  out.push(...partitionOnCollect(s, 5));
  assert.equal(s.progress['partition-call-log']!.done, true);
  out.push(...partitionOnKill(s, 6));
  assert.equal(s.progress['partition-glass-register']!.done, true);
  const seen2 = new Set<string>(['0,0']);
  for (const k of ['5,0', '6,0', '7,0', '8,0']) out.push(...partitionOnExplore(s, seen2, k));
  assert.equal(s.progress['partition-sunken-archive']!.done, true);
  out.push(...partitionOnKill(s, 8));
  assert.equal(s.progress['partition-custody']!.done, true);
  return out;
}

describe('PARTITION chapter shape', () => {
  it('chapter id/title are set and distinct from STATIC', () => {
    assert.equal(PARTITION_CHAPTER_ID, 'partition');
    assert.equal(PARTITION_CHAPTER_TITLE, 'PARTITION');
    assert.notEqual(PARTITION_CHAPTER_ID, 'static');
  });

  it('5 missions in strict order with mixed acts and unique landmarks', () => {
    assert.equal(PARTITION_MISSIONS.length, 5);
    assert.deepEqual(PARTITION_MISSION_ORDER, [
      'partition-dead-air',
      'partition-call-log',
      'partition-glass-register',
      'partition-sunken-archive',
      'partition-custody',
    ]);
    for (let i = 1; i < PARTITION_MISSIONS.length; i++) {
      assert.equal(PARTITION_MISSIONS[i]!.seq, i + 1);
    }
    const kinds = new Set(PARTITION_MISSIONS.map((m) => m.kind));
    assert.ok(kinds.has('kill') && kinds.has('collect') && kinds.has('explore'));
    // The arc opens and closes at the Ashfall Exchange; the three middle legs
    // are distinct, so 4 distinct landmarks across 5 missions is intentional.
    assert.equal(new Set(PARTITION_MISSIONS.map((m) => m.landmark)).size, 4);
    assert.equal(PARTITION_MISSIONS[0]!.landmark, 'Ashfall Exchange');
    assert.equal(PARTITION_MISSIONS[4]!.landmark, 'Ashfall Exchange');
    for (const m of PARTITION_MISSIONS) {
      assert.ok(m.briefing.length > 0);
      assert.ok(m.landmark.length > 0);
      assert.equal(partitionMission(m.id)?.name, m.name);
    }
  });

  it('seeds progress idempotently without touching other quests', () => {
    const s = createQuestState();
    ensurePartitionProgress(s);
    for (const id of PARTITION_MISSION_ORDER) assert.equal(s.progress[id]!.count, 0);
    assert.ok(s.progress['slay5'], 'base trio intact');
    ensurePartitionProgress(s);
    assert.equal(Object.keys(s.progress).filter((k) => k.startsWith('partition-')).length, 5);
  });
});

describe('PARTITION gating (predicates over quest state)', () => {
  it('STATIC is the hard chapter gate', () => {
    const fresh = createQuestState();
    assert.equal(isChapterTwoUnlocked(fresh), false);
    assert.equal(isPartitionUnlocked('partition-dead-air', fresh), false);
    assert.equal(isPartitionUnlocked('nope', fresh), false);
    const done = finishStatic();
    assert.equal(isChapterTwoUnlocked(done), true);
    assert.equal(isPartitionUnlocked('partition-dead-air', done), true);
    assert.equal(isPartitionUnlocked('partition-call-log', done), false);
    assert.equal(isPartitionUnlocked('partition-custody', done), false);
  });

  it('locked missions accrue nothing while STATIC is unfinished', () => {
    const s = createQuestState();
    const seen = new Set<string>(['0,0']);
    partitionOnKill(s, 50);
    partitionOnCollect(s, 50);
    partitionOnExplore(s, seen, '1,0');
    assert.equal(s.progress['partition-glass-register']!.count, 0);
    assert.equal(s.progress['partition-call-log']!.count, 0);
    assert.equal(s.progress['partition-dead-air']!.count, 0);
    assert.equal(isPartitionChapterDone(s), false);
  });

  it('predecessor done unlocks exactly the next mission', () => {
    const s = finishStatic();
    const seen = new Set<string>(['0,0']);
    assert.equal(isPartitionUnlocked('partition-call-log', s), false);
    for (const k of ['1,0', '2,0', '3,0']) partitionOnExplore(s, seen, k);
    assert.equal(isPartitionUnlocked('partition-call-log', s), true);
    assert.equal(isPartitionUnlocked('partition-glass-register', s), false);
    partitionOnCollect(s, 5);
    assert.equal(isPartitionUnlocked('partition-glass-register', s), true);
    assert.equal(isPartitionUnlocked('partition-sunken-archive', s), false);
  });

  it('active pointer walks the order; repeats never double-count explore', () => {
    const s = finishStatic();
    assert.equal(partitionActiveMission(s)!.id, 'partition-dead-air');
    assert.equal(partitionChapterProgress(s), 0);
    const seen = new Set<string>(['0,0']);
    for (const k of ['1,0', '2,0']) partitionOnExplore(s, seen, k);
    assert.equal(s.progress['partition-dead-air']!.count, 2);
    partitionOnExplore(s, seen, '1,0');
    assert.equal(s.progress['partition-dead-air']!.count, 2, 'repeat chunk is idempotent');
    partitionOnExplore(s, seen, '3,0');
    assert.equal(partitionActiveMission(s)!.id, 'partition-call-log');
  });
});

describe('PARTITION full walkthrough (STATIC -> 5 missions -> twist -> reward)', () => {
  it('completes all 5 with quest-progress + quest-complete events', () => {
    const s = finishStatic();
    const evts = walkPartition(s);
    assert.equal(isPartitionChapterDone(s), true);
    assert.equal(partitionActiveMission(s), null);
    assert.equal(partitionChapterProgress(s), 1);
    const types = evts.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'complete').length, 5);
    assert.ok(types.includes('progress'));
    assert.ok(types.includes('levelup'), 'chapter XP levels the walker');
  });

  it('XP follows the 60/90/120/160/240 curve', () => {
    assert.deepEqual(PARTITION_MISSIONS.map((m) => m.rewardXp), [60, 90, 120, 160, 240]);
  });

  it('partial progress yields a fractional chapter bar', () => {
    const s = finishStatic();
    partitionOnCollect(s, 50);
    assert.equal(partitionChapterProgress(s), 0, 'collect mission is gated behind explore');
    const seen = new Set<string>(['0,0']);
    partitionOnExplore(s, seen, '1,0');
    const p = partitionChapterProgress(s);
    assert.ok(p > 0 && p < 1);
  });

  it('payoff is unique and only previewable when done', () => {
    const s = finishStatic();
    assert.equal(partitionPayoffFor(s), null);
    walkPartition(s);
    assert.deepEqual(partitionPayoffFor(s), { ...PARTITION_PAYOFF });
    assert.equal(PARTITION_PAYOFF.title, PARTITION_TITLE_REWARD);
    assert.equal(PARTITION_PAYOFF.maskId, PARTITION_MASK_ID);
    assert.equal(PARTITION_TITLE_REWARD, 'Warden of the Quiet');
  });

  it('no duplicate XP or payoff on re-fed completion events', () => {
    const s = finishStatic();
    walkPartition(s);
    const xpAfter = s.xp;
    const levelAfter = s.level;
    // Re-feeding every trigger after completion produces no events at all.
    const again = [
      ...partitionOnKill(s, 100),
      ...partitionOnCollect(s, 100),
      ...partitionOnExplore(s, new Set(['0,0', 'x']), '1,0'),
    ];
    assert.deepEqual(again, []);
    assert.equal(s.xp, xpAfter, 'XP is one-shot');
    assert.equal(s.level, levelAfter, 'level is one-shot');
    // The title/mask latch is one-shot too.
    const first = claimPartitionPayoff(s);
    const second = claimPartitionPayoff(s);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(s.progress[PARTITION_PAYOFF_ID]!.claimed, true);
  });

  it('payoff cannot be claimed before the chapter ends', () => {
    const s = finishStatic();
    assert.equal(claimPartitionPayoff(s), null);
    assert.equal(s.progress[PARTITION_PAYOFF_ID], undefined, 'no latch entry before completion');
  });
});
