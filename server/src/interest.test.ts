import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterInterest, InterestTracker, INTEREST_RADIUS } from './interest.js';
import type { EntitySnapshot } from '@aetherfall/shared';

function ent(id: number, x: number, y: number): EntitySnapshot {
  return { id, kind: 'player', p: { x, y }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100, name: `p${id}` };
}

describe('interest', () => {
  it(`culls beyond ${INTEREST_RADIUS}m but always keeps self`, () => {
    const all = [ent(1, 0, 0), ent(2, 10, 0), ent(3, 100, 0)];
    const vis = filterInterest({ x: 0, y: 0, id: 1 }, all);
    assert.deepEqual(vis.map((e) => e.id).sort(), [1, 2]);
  });

  it('tracker reports removed when entity leaves range', () => {
    const t = new InterestTracker();
    const first = t.update(1, { x: 0, y: 0 }, [ent(1, 0, 0), ent(2, 5, 0)]);
    assert.equal(first.removed.length, 0);
    assert.equal(first.visible.length, 2);
    const second = t.update(1, { x: 0, y: 0 }, [ent(1, 0, 0), ent(2, 90, 0)]);
    assert.deepEqual(second.removed, [2]);
    assert.deepEqual(second.visible.map((e) => e.id), [1]);
  });

  it('despawn notifies affected viewers', () => {
    const t = new InterestTracker();
    t.update(1, { x: 0, y: 0 }, [ent(1, 0, 0), ent(9, 1, 0)]);
    t.update(2, { x: 90, y: 90 }, [ent(2, 90, 90)]);
    const affected = t.despawn(9);
    assert.deepEqual(affected, [1]);
  });
});
