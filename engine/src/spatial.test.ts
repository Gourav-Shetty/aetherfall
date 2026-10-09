import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SpatialHash, chunkOf, INTEREST_RADIUS } from './spatial.js';

describe('spatial dynamic updates', () => {
  it('insert/move/remove/has/get', () => {
    const s = new SpatialHash(8);
    s.insert(1, 0, 0);
    s.insert(2, 100, 100);
    assert.equal(s.size, 2);
    assert.equal(s.has(1), true);
    assert.deepEqual(s.get(1), { x: 0, y: 0 });
    s.move(1, 104, 100); // cross many cells
    assert.deepEqual(s.near(100, 100, 8).sort(), [1, 2]);
    assert.equal(s.remove(1), true);
    assert.equal(s.remove(1), false);
    assert.equal(s.has(1), false);
    assert.deepEqual(s.near(100, 100, 8), [2]);
  });

  it('move within same cell keeps single registration', () => {
    const s = new SpatialHash(8);
    s.insert(1, 1, 1);
    s.move(1, 2, 2);
    assert.deepEqual(s.near(1, 1, 8), [1]);
    s.clear();
    assert.equal(s.size, 0);
    assert.deepEqual(s.near(0, 0, 100), []);
  });

  it('rebuild bulk-loads (back-compat signature)', () => {
    const s = new SpatialHash(8);
    s.rebuild(
      new Map([
        [1, { x: 0, y: 0 }],
        [2, { x: 5, y: 0 }],
      ]),
    );
    assert.equal(s.size, 2);
    assert.deepEqual(s.near(0, 0, 6).sort(), [1, 2]);
  });

  it('rejects invalid cell size', () => {
    assert.throws(() => new SpatialHash(0), /cellSize/);
  });
});

describe('spatial queries', () => {
  it('near filters by exact distance and sorts by distance', () => {
    const s = new SpatialHash(8);
    s.insert(1, 3, 4); // d=5
    s.insert(2, 1, 0); // d=1
    s.insert(3, 6, 0); // d=6, same cell band as others
    assert.deepEqual(s.near(0, 0, 5), [2, 1]);
    assert.deepEqual(s.near(0, 0, 0), []);
    assert.deepEqual(s.near(0, 0, -1), []);
    assert.deepEqual(s.near(0, 0, 100, 1), [2]); // max cap
  });

  it('box query is exact', () => {
    const s = new SpatialHash(8);
    s.insert(1, 1, 1);
    s.insert(2, 20, 20);
    s.insert(3, 5, 5);
    assert.deepEqual(s.box(0, 0, 6, 6).sort(), [1, 3]);
    assert.deepEqual(s.box(10, 10, 5, 5), []); // inverted
  });

  it('10k entities radius query stays fast', () => {
    const s = new SpatialHash(8);
    for (let i = 0; i < 10_000; i++) {
      s.insert(i + 1, (i % 100) * 2, Math.floor(i / 100) * 2);
    }
    const t0 = performance.now();
    const out = s.near(100, 100, 20);
    const ms = performance.now() - t0;
    console.log(`spatial perf: near10k=${ms.toFixed(2)}ms hits=${out.length}`);
    assert.ok(out.length > 0 && out.length < 10_000);
    assert.ok(ms < 500, `radius query too slow: ${ms}ms`);
  });
});

describe('spatial interest / chunk subscriptions', () => {
  it('chunkOf maps world coords to chunks', () => {
    assert.deepEqual(chunkOf(0, 0), { cx: 0, cy: 0 });
    assert.deepEqual(chunkOf(31, 31), { cx: 0, cy: 0 });
    assert.deepEqual(chunkOf(32, -1), { cx: 1, cy: -1 });
  });

  it('subscribedChunks covers the 40m interest radius', () => {
    const s = new SpatialHash(8);
    const chunks = s.subscribedChunks(0, 0, INTEREST_RADIUS, 32);
    // [-40,40] spans chunks -2..1 on each axis => 4x4 = 16 chunks.
    assert.equal(chunks.length, 16);
    const keys = s.subscriptionKeys(0, 0);
    assert.equal(keys.size, 16);
    assert.ok(keys.has('-2,-2') && keys.has('1,1'));
  });

  it('diffSubscriptions reports entered/left', () => {
    const s = new SpatialHash(8);
    const a = s.subscriptionKeys(0, 0, 40, 32);
    const b = s.subscriptionKeys(200, 0, 40, 32);
    assert.ok(a.size > 0 && b.size > 0);
    const d = SpatialHash.diffSubscriptions(a, b);
    // Every entered key is new, every left key is gone.
    for (const k of d.entered) assert.ok(b.has(k) && !a.has(k));
    for (const k of d.left) assert.ok(a.has(k) && !b.has(k));
    // Union accounting: |a| + |entered| == |b| + |left|.
    assert.equal(a.size + d.entered.length, b.size + d.left.length);
    assert.ok(d.entered.length > 0 && d.left.length > 0);
    const same = SpatialHash.diffSubscriptions(a, new Set(a));
    assert.deepEqual(same, { entered: [], left: [] });
  });
});
