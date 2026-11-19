// PARTITION reactive world state: completion changes observable server facts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestState } from '../game/quests.js';
import { isStaticChapterDone, staticOnCollect, staticOnExplore, staticOnKill } from './chapter.js';
import {
  PARTITION_BOSS_ROOSTS,
  PARTITION_LANDMARKS,
  bossRoostPhase,
  derivePartitionWorldFlags,
  isLandmarkAccessible,
  withPartitionWorldFlags,
} from './world-state.js';
import { partitionOnCollect, partitionOnExplore, partitionOnKill } from './chapter-two.js';

function finishBothChapters(): ReturnType<typeof createQuestState> {
  const s = createQuestState();
  // STATIC.
  staticOnKill(s, 4);
  staticOnCollect(s, 6);
  staticOnKill(s, 6);
  const seenA = new Set<string>(['0,0']);
  for (const k of ['1,0', '2,0', '3,0', '4,0']) staticOnExplore(s, seenA, k);
  staticOnKill(s, 8);
  assert.equal(isStaticChapterDone(s), true);
  // PARTITION.
  const seenB = new Set<string>(['0,0']);
  for (const k of ['10,0', '11,0', '12,0']) partitionOnExplore(s, seenB, k);
  partitionOnCollect(s, 5);
  partitionOnKill(s, 6);
  const seenC = new Set<string>(['0,0']);
  for (const k of ['13,0', '14,0', '15,0', '16,0']) partitionOnExplore(s, seenC, k);
  partitionOnKill(s, 8);
  return s;
}

describe('PARTITION reactive world facts', () => {
  it('landmark + roost tables are well-formed and anchor-based', () => {
    assert.ok(PARTITION_LANDMARKS.length >= 6);
    assert.equal(new Set(PARTITION_LANDMARKS.map((l) => l.id)).size, PARTITION_LANDMARKS.length);
    const quiet = PARTITION_LANDMARKS.find((l) => l.id === 'quiet-register');
    assert.ok(quiet);
    assert.equal(quiet!.sealedUntil, 'partition');
    assert.deepEqual([quiet!.x, quiet!.y], [50, 50], 'shrine anchor');
    assert.equal(PARTITION_BOSS_ROOSTS.length, 1);
    assert.equal(PARTITION_BOSS_ROOSTS[0]!.id, 'collator-roost');
    assert.equal(PARTITION_BOSS_ROOSTS[0]!.requiresPartition, true);
  });

  it('fresh world: couriers open after STATIC, register/roost stay sealed', () => {
    const fresh = createQuestState();
    const flags = derivePartitionWorldFlags(fresh);
    assert.deepEqual(flags, {
      quietRegisterOpen: false,
      collatorRoost: 'sealed',
      courierRoutesOpen: false,
      ledgerLensStocked: false,
    });
    assert.equal(isLandmarkAccessible(flags, 'quiet-register'), false);
    assert.equal(isLandmarkAccessible(flags, 'ashfall-exchange'), true, 'old landmarks never sealed');
    assert.equal(isLandmarkAccessible(flags, 'nope'), false);
    assert.equal(bossRoostPhase(flags, 'collator-roost'), 'sealed');
    assert.equal(bossRoostPhase(flags, 'nope'), 'sealed');
  });

  it('STATIC done alone opens couriers but not the register/roost', () => {
    const s = createQuestState();
    staticOnKill(s, 4);
    staticOnCollect(s, 6);
    staticOnKill(s, 6);
    const seen = new Set<string>(['0,0']);
    for (const k of ['1,0', '2,0', '3,0', '4,0']) staticOnExplore(s, seen, k);
    staticOnKill(s, 8);
    const flags = derivePartitionWorldFlags(s);
    assert.equal(flags.courierRoutesOpen, true);
    assert.equal(flags.quietRegisterOpen, false);
    assert.equal(flags.collatorRoost, 'sealed');
  });

  it('full completion opens the register, wakes the roost, stocks the lens', () => {
    const flags = derivePartitionWorldFlags(finishBothChapters());
    assert.equal(flags.quietRegisterOpen, true);
    assert.equal(flags.collatorRoost, 'wakeful');
    assert.equal(flags.ledgerLensStocked, true);
    assert.equal(flags.courierRoutesOpen, true);
    assert.equal(isLandmarkAccessible(flags, 'quiet-register'), true);
    assert.equal(bossRoostPhase(flags, 'collator-roost'), 'wakeful');
  });

  it('withPartitionWorldFlags is pure (no mutation of the caller world)', () => {
    const s = finishBothChapters();
    const world = { shard: 1, npcs: ['a'] };
    const before = JSON.stringify(world);
    const view = withPartitionWorldFlags(world, s);
    assert.equal(JSON.stringify(world), before, 'original untouched');
    assert.equal(view.shard, 1);
    assert.equal(view.partition.quietRegisterOpen, true);
    assert.notEqual(view, world);
  });
});
