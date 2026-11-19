// Wire vocabulary for world progression: stable ids, guards and view shapes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTION_IDS,
  MAX_WORLD_TIER,
  MIN_WORLD_TIER,
  WORLD_EVENT_KINDS,
  WORLD_TIER_IDS,
  isFactionId,
  isWorldEventKind,
  isWorldTier,
  type WorldEventView,
} from './world_tiers.js';

describe('shared world-tier vocabulary', () => {
  it('exposes four contiguous tiers', () => {
    assert.equal(MIN_WORLD_TIER, 1);
    assert.equal(MAX_WORLD_TIER, 4);
    assert.deepEqual([...WORLD_TIER_IDS], [1, 2, 3, 4]);
    assert.equal(new Set(WORLD_TIER_IDS).size, 4);
  });

  it('exposes three unique factions and two unique event kinds', () => {
    assert.equal(FACTION_IDS.length, 3);
    assert.equal(new Set(FACTION_IDS).size, 3);
    assert.deepEqual([...WORLD_EVENT_KINDS], ['shard-surge', 'roost-awakening']);
  });

  it('guards reject junk instead of coercing it', () => {
    assert.equal(isWorldTier(1), true);
    assert.equal(isWorldTier(4), true);
    assert.equal(isWorldTier(0), false);
    assert.equal(isWorldTier(5), false);
    assert.equal(isWorldTier(2.5), false);
    assert.equal(isWorldTier('2'), false);
    assert.equal(isWorldTier(NaN), false);

    for (const id of FACTION_IDS) assert.equal(isFactionId(id), true);
    assert.equal(isFactionId('third-faction'), false);
    assert.equal(isFactionId(7), false);

    for (const kind of WORLD_EVENT_KINDS) assert.equal(isWorldEventKind(kind), true);
    assert.equal(isWorldEventKind('meteor'), false);
  });

  it('describes a JSON-safe world event payload', () => {
    const event: WorldEventView = {
      id: 'wf-1-0',
      index: 0,
      kind: 'shard-surge',
      zone: 'meadow',
      x: 24,
      y: 28,
      tier: 1,
      landmark: 'Brazen Porch',
      startsAtMs: 300_000,
      endsAtMs: 480_000,
      xpMult: 1.75,
    };
    assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
    assert.equal(isWorldEventKind(event.kind), true);
    assert.equal(isWorldTier(event.tier), true);
  });
});
