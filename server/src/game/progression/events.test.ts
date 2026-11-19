// Deterministic world events: seeded, window-queryable, and constant-time to
// ask "what is up right now" without rebuilding a calendar.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOSS_ANCHORS, getZone } from '@aetherfall/engine';
import { isWorldEventKind, isWorldTier } from '@aetherfall/shared';
import {
  EVENT_LANDMARKS,
  ROOST_AWAKENING_DURATION_MS,
  SHARD_SURGE_DURATION_MS,
  SHARD_SURGE_XP_MIN,
  SHARD_SURGE_XP_STEPS,
  SHARD_SURGE_XP_STEP,
  WORLD_EVENT_INTERVAL_MS,
  WorldEventClock,
  activeEventAt,
  eventsInWindow,
  nextEventAfter,
  worldEventAt,
  worldEventSchedule,
} from './events.js';

const SEED = 1337;

describe('world event schedule', () => {
  it('uses the five-minute cadence and fires after a quiet first interval', () => {
    assert.equal(WORLD_EVENT_INTERVAL_MS, 300_000);
    const events = worldEventSchedule(SEED, 0, 12);
    assert.equal(events.length, 12);
    assert.equal(events[0]!.startsAtMs, WORLD_EVENT_INTERVAL_MS);
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i]!.startsAtMs - events[i - 1]!.startsAtMs, WORLD_EVENT_INTERVAL_MS);
    }
  });

  it('is fully seeded: slot lookups agree with the whole schedule', () => {
    const schedule = worldEventSchedule(SEED, 60_000, 12);
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(schedule[i], worldEventAt(SEED, i, 60_000));
      assert.deepEqual(worldEventAt(SEED, i, 60_000), worldEventAt(SEED, i, 60_000));
    }
    assert.notDeepEqual(worldEventSchedule(SEED, 0, 12), worldEventSchedule(SEED + 1, 0, 12));
    assert.equal(new Set(schedule.map((e) => e.id)).size, 12);
    assert.equal(schedule[0]!.startsAtMs, 360_000);
  });

  it('alternates both event families with valid, bounded payloads', () => {
    const events = worldEventSchedule(SEED, 0, 12);
    assert.ok(events.some((e) => e.kind === 'shard-surge'));
    assert.ok(events.some((e) => e.kind === 'roost-awakening'));
    for (const e of events) {
      assert.equal(isWorldEventKind(e.kind), true);
      assert.equal(isWorldTier(e.tier), true);
      assert.equal(e.zone, getZone(e.x, e.y));
      assert.ok(e.x >= 0 && e.x <= 100 && e.y >= 0 && e.y <= 100);
      assert.ok(e.endsAtMs > e.startsAtMs);
      if (e.kind === 'shard-surge') {
        assert.equal(e.endsAtMs - e.startsAtMs, SHARD_SURGE_DURATION_MS);
        assert.equal(e.boss, undefined);
        assert.ok(e.xpMult !== undefined);
        assert.ok(e.xpMult >= SHARD_SURGE_XP_MIN);
        assert.ok(e.xpMult < SHARD_SURGE_XP_MIN + SHARD_SURGE_XP_STEPS * SHARD_SURGE_XP_STEP);
        assert.ok(EVENT_LANDMARKS.some((l) => l.name === e.landmark));
      } else {
        assert.equal(e.endsAtMs - e.startsAtMs, ROOST_AWAKENING_DURATION_MS);
        assert.equal(e.xpMult, undefined);
        assert.ok(BOSS_ANCHORS.some((b) => b.name === e.boss && b.x === e.x && b.y === e.y));
        assert.equal(e.tier, 4, 'a waking roost is always crown-tier');
      }
    }
    for (let i = 0; i < 12; i++) {
      assert.equal(events[i]!.kind, i % 3 === 2 ? 'roost-awakening' : 'shard-surge');
    }
  });

  it('clamps malformed indices/intervals instead of throwing', () => {
    assert.deepEqual(worldEventAt(SEED, -3), worldEventAt(SEED, 0));
    assert.deepEqual(worldEventAt(SEED, NaN), worldEventAt(SEED, 0));
    assert.deepEqual(worldEventAt(SEED, 1, 0, -1), worldEventAt(SEED, 1, 0, WORLD_EVENT_INTERVAL_MS));
    assert.deepEqual(worldEventSchedule(SEED, 0, -2), []);
  });
});

describe('world event queries', () => {
  it('returns only events overlapping a time window', () => {
    assert.deepEqual(eventsInWindow(SEED, 0, WORLD_EVENT_INTERVAL_MS), []);
    const aroundFirst = eventsInWindow(SEED, WORLD_EVENT_INTERVAL_MS - 1000, WORLD_EVENT_INTERVAL_MS + 1000);
    assert.deepEqual(aroundFirst.map((e) => e.index), [0]);
    const spanning = eventsInWindow(SEED, WORLD_EVENT_INTERVAL_MS, 3 * WORLD_EVENT_INTERVAL_MS);
    assert.ok(spanning.length >= 2);
    assert.deepEqual(eventsInWindow(SEED, 500, 400), []);
  });

  it('finds the active event in O(1), including the one just started', () => {
    assert.deepEqual(activeEventAt(SEED, WORLD_EVENT_INTERVAL_MS), worldEventAt(SEED, 0));
    assert.deepEqual(activeEventAt(SEED, WORLD_EVENT_INTERVAL_MS + 60_000), worldEventAt(SEED, 0));
    assert.equal(activeEventAt(SEED, WORLD_EVENT_INTERVAL_MS + SHARD_SURGE_DURATION_MS + 1000), null);
  });

  it('finds the next strictly-future event', () => {
    assert.equal(nextEventAfter(SEED, 0).index, 0);
    assert.equal(nextEventAfter(SEED, WORLD_EVENT_INTERVAL_MS).index, 1);
    assert.equal(nextEventAfter(SEED, WORLD_EVENT_INTERVAL_MS - 1).index, 0);
  });

  it('exposes the same calendar through an immutable clock', () => {
    const clock = new WorldEventClock(SEED);
    assert.deepEqual(clock.at(2), worldEventAt(SEED, 2));
    assert.deepEqual(clock.schedule(3), worldEventSchedule(SEED, 0, 3));
    assert.deepEqual(clock.activeAt(WORLD_EVENT_INTERVAL_MS), worldEventAt(SEED, 0));
    assert.equal(clock.nextAfter(0).index, 0);
    assert.equal(clock.inWindow(0, 1).length, 0);
    // Seed and interval are fixed for the lifetime of the clock.
    assert.equal(clock.seed, SEED);
    assert.equal(clock.intervalMs, WORLD_EVENT_INTERVAL_MS);
  });
});
