// Explore quests: three families, ONE caller-owned `seen` set.
//
// `tickGameplay` walks a player through the same chunk key in the same tick:
//
//   onExplore(state, p.seenChunks, key);             // trio    'explorer'
//   noteChunkExplored(... roadOnExplore(state, p.seenChunks, key));  // 'road-lookout'
//   chainOnExplore(state, p.seenChunks, key);        // Maren   'chart-the-fall'
//
// Each family used to open with `if (seen.has(chunkKey)) return []`, treating
// the caller's set as its OWN private dedupe ledger. Whichever family ran first
// consumed the key and the rest bailed — so 'explorer' advanced while
// 'road-lookout' and 'chart-the-fall' stayed at zero forever.
//
// That is not cosmetic. 'chart-the-fall' is the prerequisite of 'heart-of-fall',
// so the Elder Maren chain could never be finished and the Ward Blade could
// never be earned; 'road-lookout' is the last rung of the Wayfarer's Road.
//
// The fix: the shared set is a ledger of distinct chunks, so a key is folded in
// idempotently and each family's OWN monotonic progress guard decides whether
// there is anything to award. These tests pin the live interleaving.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuestState,
  onExplore,
  roadOnCollect,
  roadOnExplore,
  roadOnKill,
  type QuestState,
} from './quests.js';
import { chainOnCollect, chainOnExplore, chainOnKill, ensureChainProgress } from './content.js';

/** The exact per-tick family order `tickGameplay` uses, sharing one `seen`. */
function tickExplore(state: QuestState, seen: Set<string>, key: string): void {
  onExplore(state, seen, key);
  chainOnExplore(state, seen, key);
  roadOnExplore(state, seen, key);
}

const count = (state: QuestState, id: string): number => state.progress[id]?.count ?? -1;

describe('explore quests sharing one caller-owned seen set', () => {
  it('every explore family sees the same new chunk (no family starves)', () => {
    const state = createQuestState();
    ensureChainProgress(state);
    // Open every tracker's prerequisite chain the way a real session would.
    chainOnKill(state, 3); // ward-spark
    chainOnCollect(state, 5); // ember-road
    chainOnKill(state, 6); // deep-delvers -> unlocks chart-the-fall
    roadOnKill(state, 1); // road-first-blood
    roadOnCollect(state, 3); // road-pickups
    roadOnKill(state, 3); // road-hunt -> unlocks road-lookout

    const seen = new Set<string>();
    tickExplore(state, seen, '0,0'); // spawn chunk: free, nothing counts
    assert.equal(count(state, 'explorer'), 0, 'spawn chunk must be free');
    assert.equal(count(state, 'road-lookout'), 0, 'spawn chunk must be free');
    assert.equal(count(state, 'chart-the-fall'), 0, 'spawn chunk must be free');

    tickExplore(state, seen, '1,0');
    assert.equal(count(state, 'explorer'), 1, 'trio did not see the new chunk');
    assert.equal(count(state, 'road-lookout'), 1, 'ROAD starved — the shared seen set ate its key');
    assert.equal(count(state, 'chart-the-fall'), 1, 'Maren chain starved — same cause');

    tickExplore(state, seen, '2,0');
    assert.equal(count(state, 'explorer'), 2);
    assert.equal(count(state, 'road-lookout'), 2);
    assert.equal(count(state, 'chart-the-fall'), 2);
  });

  it('the shared set stays a distinct-chunk ledger (revisits award nothing)', () => {
    const state = createQuestState();
    const seen = new Set<string>();
    onExplore(state, seen, '0,0');
    onExplore(state, seen, '1,0');
    assert.equal(count(state, 'explorer'), 1);
    const xpAfterFirst = state.xp;
    // Walking back over old ground must not re-award or re-emit.
    for (const key of ['0,0', '1,0', '0,0', '1,0', '1,0']) {
      assert.deepEqual(onExplore(state, seen, key), [], `revisiting ${key} granted something`);
    }
    assert.equal(count(state, 'explorer'), 1, 'revisit double-counted');
    assert.equal(state.xp, xpAfterFirst, 'revisit re-paid XP');
    assert.equal(seen.size, 2, 'the ledger counted a revisit as a new chunk');
  });

  it('a quest locked when a chunk was entered still banks it once unlocked', () => {
    // The player stands in a fresh chunk while `road-lookout` is still shut.
    const state = createQuestState();
    const seen = new Set<string>();
    onExplore(state, seen, '0,0');
    roadOnExplore(state, seen, '1,0');
    // road-lookout is gated behind road-hunt, which has not happened yet.
    assert.equal(count(state, 'road-lookout'), 0, 'precondition: road step still shut');
    // Now the player finishes road-hunt WITHOUT moving.
    roadOnKill(state, 1);
    roadOnCollect(state, 3);
    roadOnKill(state, 3);
    assert.equal(state.progress['road-hunt']?.done, true);
    // The very next tick in the SAME chunk must bank what was already walked.
    roadOnExplore(state, seen, '1,0');
    assert.equal(count(state, 'road-lookout'), 1, 'the chunk walked while locked was lost forever');
  });
});