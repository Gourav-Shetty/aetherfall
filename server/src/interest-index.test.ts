// @aetherfall/server — chunk-bucket interest index tests (snapshot hot path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InterestIndex, filterInterest, INTEREST_RADIUS } from './interest.js';

type Ent = { id: number; kind: 'player'; p: { x: number; y: number }; v: { x: number; y: number }; hp: number; maxHp: number };
const ent = (id: number, x: number, y: number): Ent => ({ id, kind: 'player', p: { x, y }, v: { x: 0, y: 0 }, hp: 1, maxHp: 1 });
const ids = (a: Ent[]): number[] => a.map((e) => e.id).sort((x, y) => x - y);

/** Deterministic PRNG so a failure is reproducible. */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('collect membership matches filterInterest over random layouts', () => {
  const rnd = mulberry(1337);
  const idx = new InterestIndex(20);
  for (let trial = 0; trial < 60; trial++) {
    const n = 1 + Math.floor(rnd() * 250);
    const ents: Ent[] = [];
    for (let i = 0; i < n; i++) ents.push(ent(i + 1, rnd() * 200 - 100, rnd() * 200 - 100));
    idx.build(ents);
    for (let v = 0; v < 8; v++) {
      const self = ents[Math.floor(rnd() * n)]!;
      const got = idx.collect(self.p.x, self.p.y, self.id, []);
      const want = filterInterest({ x: self.p.x, y: self.p.y, id: self.id }, ents);
      // Membership is identical; order is deliberately not preserved.
      assert.deepEqual(ids(got as never as Ent[]), ids(want as never as Ent[]), `trial ${trial} view ${v}`);
    }
  }
});

test('collectIndices agrees with collect', () => {
  const idx = new InterestIndex(20);
  // (28,28) -> 1568 <= 1600 (just inside). (39,39) -> 3042 and (41,0) -> 1681 (outside).
  const ents = [ent(1, 0, 0), ent(2, 5, 5), ent(3, -30, 12), ent(4, 28, 28), ent(5, 41, 0), ent(6, 39, 39)];
  idx.build(ents);
  const expected = filterInterest({ x: 0, y: 0, id: 1 }, ents as never).map((e) => e.id).sort((a, b) => a - b);
  assert.deepEqual(expected, [1, 2, 3, 4], 'oracle sanity: the fixture straddles the radius');
  assert.deepEqual(idx.collectIndices(0, 0, 1, []).map((i) => ents[i]!.id).sort((a, b) => a - b), expected);
  assert.deepEqual(idx.collect(0, 0, 1, []).map((e) => e.id).sort((a, b) => a - b), expected);
});

test('distance exactly at the radius is visible (inclusive, like filterInterest)', () => {
  const idx = new InterestIndex(20);
  idx.build([ent(1, 0, 0), ent(2, INTEREST_RADIUS, 0), ent(3, INTEREST_RADIUS + 0.001, 0)]);
  assert.deepEqual(idx.collect(0, 0, 1, []).map((e) => e.id).sort((a, b) => a - b), [1, 2]);
});

test('viewer always sees itself, even when it has no neighbours', () => {
  const idx = new InterestIndex(20);
  idx.build([ent(7, 3, -3)]);
  assert.deepEqual(idx.collect(3, -3, 7, []).map((e) => e.id), [7]);
});

test('handles negative coordinates and exact cell edges', () => {
  const idx = new InterestIndex(20);
  const ents: Ent[] = [];
  for (let i = 0; i < 300; i++) ents.push(ent(i + 1, -100 + (i % 20) * 10 - 5, -100 + Math.floor(i / 20) * 10 - 5));
  idx.build(ents);
  for (const [x, y] of [[0, 0], [-100, -100], [-5, -5], [99.99, -99.99], [-60, 40]]) {
    assert.deepEqual(
      idx.collect(x, y, 999999, []).map((e) => e.id).sort((a, b) => a - b),
      filterInterest({ x, y, id: 999999 }, ents as never).map((e) => e.id).sort((a, b) => a - b),
      `viewer (${x},${y})`,
    );
  }
});

test('build() clears stale buckets when entities move or leave', () => {
  const idx = new InterestIndex(20);
  const a = [ent(1, 0, 0), ent(2, 5, 5)];
  idx.build(a);
  assert.deepEqual(idx.collect(0, 0, 1, []).map((e) => e.id).sort((a2, b) => a2 - b), [1, 2]);
  // Mutate in place (as Sim.snapshot() does) and rebuild.
  a[0]!.p.x = 500;
  a[0]!.p.y = 500;
  idx.build(a);
  assert.deepEqual(idx.collect(500, 500, 1, []).map((e) => e.id), [1]);
  // Shrinking set must not leave index 1 addressable.
  idx.build([ent(1, 500, 500)]);
  assert.deepEqual(idx.collect(500, 500, 1, []).map((e) => e.id), [1]);
});

test('rejects a non-positive cell size', () => {
  assert.throws(() => new InterestIndex(0), /cell must be positive/);
  assert.throws(() => new InterestIndex(-1), /cell must be positive/);
});

test('reuses the caller scratch array without allocating a new one', () => {
  const idx = new InterestIndex(20);
  idx.build([ent(1, 0, 0), ent(2, 3, 3)]);
  const scratch: number[] = [];
  const a = idx.collectIndices(0, 0, 1, scratch);
  const b = idx.collectIndices(0, 0, 1, scratch);
  assert.equal(a, scratch);
  assert.equal(b, scratch);
  // Stale entries from the previous viewer must not leak.
  idx.build([ent(1, 0, 0)]);
  assert.deepEqual(idx.collectIndices(0, 0, 1, scratch), [0]);
});
