import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecorderArgs, shouldRecord, driveInput, driveWaypoint } from './recorder.js';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';

describe('replay recorder args', () => {
  it('defaults to localhost:8081 for 30s', () => {
    const a = parseRecorderArgs([], {}, '/tmp/run.ndjson');
    assert.equal(a.server, 'ws://localhost:8081');
    assert.equal(a.duration, 30);
    assert.equal(a.out, '/tmp/run.ndjson');
    assert.equal(a.recordAll, false);
    assert.equal(a.drive, false);
    assert.equal(a.format, 'ndjson');
    assert.equal(a.seed, 1337);
  });

  it('parses --drive, --all, --format bin and --seed', () => {
    const a = parseRecorderArgs(['--drive', '--all', '--format', 'bin', '--seed', '7'], {});
    assert.equal(a.drive, true);
    assert.equal(a.recordAll, true);
    assert.equal(a.format, 'bin');
    assert.equal(a.seed, 7);
  });

  it('falls back to ndjson for an unknown --format', () => {
    assert.equal(parseRecorderArgs(['--format', 'zip'], {}).format, 'ndjson');
  });

  it('supports --flag value and --flag=value forms plus env fallback', () => {
    const a = parseRecorderArgs(['--server', 'ws://x:1', '--duration=5', '--out', 'r.ndjson'], {});
    assert.equal(a.server, 'ws://x:1');
    assert.equal(a.duration, 5);
    assert.equal(a.out, 'r.ndjson');
    const e = parseRecorderArgs([], { SERVER: 'ws://env:2', DURATION: '7' }, 'd.ndjson');
    assert.equal(e.server, 'ws://env:2');
    assert.equal(e.duration, 7);
  });

  it('clamps invalid durations instead of recording forever/never', () => {
    assert.equal(parseRecorderArgs(['--duration', 'abc'], {}, 'o').duration, 30);
    assert.equal(parseRecorderArgs(['--duration', '-3'], {}, 'o').duration, 1);
  });
});

describe('replay shouldRecord filter', () => {
  it('keeps snapshots + welcome, drops chatter unless --all', () => {
    const snap: ServerMsg = { t: 'snapshot', tick: 1, entities: [], removed: [] };
    const welcome: ServerMsg = { t: 'welcome', id: 1, tick: 0, snapshot: [] };
    const chat: ServerMsg = { t: 'chat', from: 'a', text: 'hi', channel: 'say' };
    assert.equal(shouldRecord(snap, false), true);
    assert.equal(shouldRecord(welcome, false), true);
    assert.equal(shouldRecord(chat, false), false);
    assert.equal(shouldRecord(chat, true), true);
  });
});

describe('replay driveInput', () => {
  const self: EntitySnapshot = {
    id: 7, kind: 'player', p: { x: 50, y: 50 }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100,
  };
  const mob = (id: number, x: number, y: number): EntitySnapshot => ({
    id, kind: 'mob', p: { x, y }, v: { x: 0, y: 0 }, hp: 60, maxHp: 60,
  });

  it('emits a unit-length move vector and a monotonic seq', () => {
    const a = driveInput(1, 1337, [self], 7);
    assert.equal(Math.hypot(a.move.x, a.move.y), 1);
    assert.equal(a.seq, 1);
    assert.equal(a.dt, 1 / 20);
    const b = driveInput(2, 1337, [self], 7);
    assert.equal(b.seq, 2);
  });

  it('is deterministic and stateless for a given seed and tick', () => {
    const a = driveInput(37, 1337, [self], 7);
    const b = driveInput(37, 1337, [self], 7);
    assert.deepEqual(a, b);
    const c = driveInput(37, 999, [self], 7);
    assert.notDeepEqual(a.move, c.move);
    // Calling out of order must not change any result (no shared waypoint state).
    driveInput(500, 1337, [self], 7);
    assert.deepEqual(driveInput(37, 1337, [self], 7), a);
  });

  it('driveWaypoint is pure and re-aims every 25 ticks', () => {
    const w = driveWaypoint(1337, 0);
    assert.deepEqual(w, driveWaypoint(1337, 24));
    assert.notDeepEqual(w, driveWaypoint(1337, 25));
    assert.ok(w.x >= 10 && w.x <= 90 && w.y >= 10 && w.y <= 90);
  });

  it('holds still when already standing on the waypoint', () => {
    const w = driveWaypoint(1337, 0);
    const onIt: EntitySnapshot = { ...self, p: { x: w.x, y: w.y } };
    const a = driveInput(0, 1337, [onIt], 7);
    assert.deepEqual(a.move, { x: 0, y: 0 });
  });

  it('attacks only when a mob is within melee reach', () => {
    assert.equal(driveInput(3, 1, [self], 7).attack, false);
    assert.equal(driveInput(3, 1, [self, mob(900001, 51, 50)], 7).attack, true);
    assert.equal(driveInput(3, 1, [self, mob(900001, 70, 70)], 7).attack, false);
  });

  it('survives an empty entity list', () => {
    const a = driveInput(5, 1337, [], 7);
    assert.ok(Number.isFinite(a.move.x) && Number.isFinite(a.move.y));
    assert.equal(a.attack, false);
  });
});
