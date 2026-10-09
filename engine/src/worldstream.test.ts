// @aetherfall/engine — WorldStream tests (determinism, LRU, prefetch, radius).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_WORLD_SEED,
  chunkOrigin,
  genChunk,
  genZonedChunk,
  getZone,
} from './worldgen.js';
import { DEFAULT_MAX_CHUNKS, WorldStream } from './worldstream.js';

const SEED = DEFAULT_WORLD_SEED;
const COORDS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [0, -1],
  [-1, 0],
  [-1, -1],
  [7, -13],
  [-40, 25],
  [512, -512],
];

describe('WorldStream determinism', () => {
  it('two streams with the same seed produce byte-identical chunks', () => {
    const a = new WorldStream({ seed: SEED, prefetch: 0 });
    const b = new WorldStream({ seed: SEED, prefetch: 0 });
    for (const [cx, cy] of COORDS) {
      const ca = a.getChunk(cx, cy);
      const cb = b.getChunk(cx, cy);
      assert.deepEqual(ca, cb);
      assert.equal(ca.cx, cx);
      assert.equal(ca.cy, cy);
      assert.equal(ca.seed, SEED);
      // Must match the stateless generator exactly.
      assert.deepEqual(ca.tiles, genChunk(cx, cy, DEFAULT_CHUNK_SIZE, SEED).tiles);
    }
  });

  it('stream results do not depend on query order or cache state', () => {
    const forward = new WorldStream({ seed: SEED, prefetch: 0 });
    const backward = new WorldStream({ seed: SEED, prefetch: 0 });
    for (const [cx, cy] of COORDS) forward.getChunk(cx, cy);
    for (const [cx, cy] of [...COORDS].reverse()) backward.getChunk(cx, cy);
    for (const [cx, cy] of COORDS) {
      assert.deepEqual(forward.getChunk(cx, cy).tiles, backward.getChunk(cx, cy).tiles);
    }
  });

  it('different seeds produce different worlds', () => {
    const a = new WorldStream({ seed: SEED, prefetch: 0 });
    const b = new WorldStream({ seed: SEED + 1, prefetch: 0 });
    let differs = 0;
    for (const [cx, cy] of COORDS) {
      if (JSON.stringify(a.getChunk(cx, cy).tiles) !== JSON.stringify(b.getChunk(cx, cy).tiles)) {
        differs++;
      }
    }
    assert.equal(differs, COORDS.length);
  });

  it('tileAt agrees with genChunk, including negative chunk coords', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    for (const [cx, cy] of COORDS) {
      const chunk = genChunk(cx, cy, DEFAULT_CHUNK_SIZE, SEED);
      for (let y = 0; y < DEFAULT_CHUNK_SIZE; y++) {
        for (let x = 0; x < DEFAULT_CHUNK_SIZE; x++) {
          const wx = cx * DEFAULT_CHUNK_SIZE + x;
          const wy = cy * DEFAULT_CHUNK_SIZE + y;
          assert.equal(stream.tileAt(wx, wy), chunk.tiles[y]![x], `tile ${wx},${wy}`);
          assert.equal(stream.solidAt(wx, wy), chunk.tiles[y]![x] === 1);
        }
      }
    }
  });

  it('custom chunk sizes keep the coordinate mapping straight', () => {
    const stream = new WorldStream({ seed: SEED, size: 16, prefetch: 0 });
    assert.equal(stream.chunkSize, 16);
    const chunk = stream.getChunk(-2, 3);
    assert.equal(chunk.size, 16);
    assert.deepEqual(chunk.tiles, genChunk(-2, 3, 16, SEED).tiles);
    assert.equal(stream.tileAt(-2 * 16 + 5, 3 * 16 + 5), chunk.tiles[5]![5]);
    assert.deepEqual(stream.originOf(-2, 3), chunkOrigin(-2, 3, 16));
  });

  it('rejects nonsensical options', () => {
    assert.throws(() => new WorldStream({ size: 0 }), /size/);
    assert.throws(() => new WorldStream({ size: 12.5 }), /size/);
    assert.throws(() => new WorldStream({ maxChunks: 0 }), /maxChunks/);
    assert.throws(() => new WorldStream({ prefetch: -1 }), /prefetch/);
  });
});

describe('WorldStream caching', () => {
  it('returns the same object on a hit and counts the hit', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    const first = stream.getChunk(3, -4);
    const second = stream.getChunk(3, -4);
    assert.equal(first, second);
    const s = stream.stats();
    assert.equal(s.misses, 1);
    assert.equal(s.hits, 1);
    assert.equal(s.generated, 1);
    assert.equal(s.resident, 1);
    stream.resetStats();
    assert.equal(stream.stats().hits, 0);
    assert.equal(stream.stats().generated, 0);
  });

  it('peek/has/clear never generate', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    assert.equal(stream.has(2, 2), false);
    assert.equal(stream.peek(2, 2), undefined);
    assert.equal(stream.size, 0);
    stream.getChunk(2, 2);
    assert.equal(stream.has(2, 2), true);
    assert.deepEqual(stream.peek(2, 2), stream.getChunk(2, 2));
    stream.clear();
    assert.equal(stream.size, 0);
    assert.equal(stream.has(2, 2), false);
  });

  it('memoizes zoned chunks on the same cache entry', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    const zoned = stream.getZonedChunk(4, -2);
    assert.equal(stream.getZonedChunk(4, -2), zoned);
    assert.equal(stream.stats().generated, 1);
    assert.deepEqual(zoned.chunk.tiles, genChunk(4, -2, DEFAULT_CHUNK_SIZE, SEED).tiles);
    const direct = genZonedChunk(4, -2, DEFAULT_CHUNK_SIZE, SEED);
    assert.deepEqual(zoned.variants, direct.variants);
    assert.equal(zoned.zone, direct.zone);
    assert.deepEqual(stream.getChunk(4, -2).tiles, zoned.chunk.tiles);
  });

  it('evicts least-recently-used chunks once the cache is full', () => {
    const stream = new WorldStream({ seed: SEED, maxChunks: 8, prefetch: 0 });
    for (let cx = 0; cx < 8; cx++) stream.getChunk(cx, 0);
    assert.equal(stream.size, 8);
    // Touch chunk 0 so it becomes the most recently used, then overflow.
    stream.getChunk(0, 0);
    stream.getChunk(8, 0);
    assert.equal(stream.size, 8);
    assert.equal(stream.has(0, 0), true, 'recently touched chunk was evicted');
    assert.equal(stream.has(1, 0), false, 'least recently used chunk survived');
    assert.equal(stream.has(8, 0), true);
    const s = stream.stats();
    assert.equal(s.evicted, 1);
    assert.equal(s.generated, 9);
  });

  it('never exceeds the cache cap (default 512, explicit caps honoured)', () => {
    assert.equal(new WorldStream().capacity, DEFAULT_MAX_CHUNKS);
    const stream = new WorldStream({ seed: SEED, prefetch: 0, maxChunks: 32 });
    for (let cx = 0; cx < 400; cx++) {
      stream.getChunk(cx, cx % 7);
      assert.ok(stream.size <= 32, `resident ${stream.size} > 32`);
    }
    assert.equal(stream.size, 32);
    assert.equal(stream.stats().evicted, 400 - 32);
  });

  it('cachedCoords lists chunks least-recently-used first', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    stream.getChunk(0, 0);
    stream.getChunk(1, 0);
    stream.getChunk(2, 0);
    assert.deepEqual(stream.cachedCoords(), [
      { cx: 0, cy: 0 },
      { cx: 1, cy: 0 },
      { cx: 2, cy: 0 },
    ]);
    stream.getChunk(0, 0);
    assert.deepEqual(stream.cachedCoords(), [
      { cx: 1, cy: 0 },
      { cx: 2, cy: 0 },
      { cx: 0, cy: 0 },
    ]);
  });

  it('handles negative and huge coordinates without key collisions', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    const pairs: Array<[number, number]> = [
      [1, -1],
      [-1, 1],
      [-1, -1],
      [1, 1],
      [0, 0],
      [-1048575, 1048575],
    ];
    for (const [cx, cy] of pairs) stream.getChunk(cx, cy);
    assert.equal(stream.size, pairs.length);
    for (const [cx, cy] of pairs) {
      assert.deepEqual(stream.getChunk(cx, cy).tiles, genChunk(cx, cy, DEFAULT_CHUNK_SIZE, SEED).tiles);
    }
  });
});

describe('WorldStream prefetch', () => {
  it('warms the 8-neighbor ring on a miss', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 1 });
    stream.getChunk(10, 10);
    assert.equal(stream.size, 9);
    assert.equal(stream.stats().prefetched, 8);
    assert.equal(stream.stats().generated, 9);
    for (const [dx, dy] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ] as const) {
      assert.equal(stream.has(10 + dx, 10 + dy), true, `neighbor ${dx},${dy} missing`);
    }
    // Prefetched chunks are identical to on-demand generation.
    for (const [dx, dy] of [[1, 1], [0, -1]] as const) {
      assert.deepEqual(
        stream.getChunk(10 + dx, 10 + dy).tiles,
        genChunk(10 + dx, 10 + dy, DEFAULT_CHUNK_SIZE, SEED).tiles,
      );
    }
  });

  it('prefetch: 0 generates nothing extra, depth 2 covers both rings', () => {
    const off = new WorldStream({ seed: SEED, prefetch: 0 });
    off.getChunk(0, 0);
    assert.equal(off.size, 1);
    assert.equal(off.stats().prefetched, 0);

    const deep = new WorldStream({ seed: SEED, prefetch: 2 });
    deep.getChunk(0, 0);
    assert.equal(deep.size, 25);
    assert.equal(deep.has(2, 2), true);
    assert.equal(deep.has(3, 0), false);
    assert.equal(deep.stats().prefetched, 24);
  });

  it('prefetch stops at the cache cap instead of thrashing', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 1, maxChunks: 8 });
    stream.getChunk(0, 0);
    assert.equal(stream.size, 8);
    // A ring that does not fit is simply not warmed (no evict/generate churn).
    assert.equal(stream.stats().evicted, 0);
    assert.ok(stream.stats().generated <= 8);
  });

  it('a prefetched chunk still counts as a cache hit later', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 1, maxChunks: 64 });
    stream.getChunk(5, 5);
    assert.equal(stream.stats().generated, 9);
    const before = stream.stats().hits;
    stream.getChunk(6, 5);
    assert.equal(stream.stats().hits, before + 1, 'prefetched chunk was regenerated');
    // The ring around (6,5) is now warmed too: only its 3 new edge chunks.
    assert.equal(stream.stats().generated, 12);
    assert.equal(stream.has(7, 4), true);
    assert.equal(stream.has(7, 6), true);
  });
});

describe('WorldStream radius queries', () => {
  it('chunksInRadius is pure, ordered and generates nothing', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 1 });
    const list = stream.chunksInRadius(40, -20, 70);
    assert.equal(stream.size, 0, 'chunksInRadius generated chunks');
    assert.deepEqual(list, stream.chunksInRadius(40, -20, 70));
    assert.ok(list.length > 4);
    // nearest first: distances are non-decreasing
    let prev = -1;
    for (const { cx, cy } of list) {
      const o = chunkOrigin(cx, cy, DEFAULT_CHUNK_SIZE);
      const nx = Math.max(o.x, Math.min(40, o.x + DEFAULT_CHUNK_SIZE - 1));
      const ny = Math.max(o.y, Math.min(-20, o.y + DEFAULT_CHUNK_SIZE - 1));
      const d = Math.hypot(nx - 40, ny + 20);
      assert.ok(d >= prev - 1e-9, 'chunksInRadius not nearest-first');
      assert.ok(d <= 70 + 1e-9, `chunk ${cx},${cy} beyond radius`);
      prev = d;
    }
    // no duplicates
    assert.equal(new Set(list.map((c) => `${c.cx},${c.cy}`)).size, list.length);
  });

  it('forEachInRadius visits exactly the intersecting chunks', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    const seen: string[] = [];
    const count = stream.forEachInRadius(100, 100, 100, (chunk, cx, cy) => {
      seen.push(`${cx},${cy}`);
      assert.deepEqual(chunk.tiles, genChunk(cx, cy, DEFAULT_CHUNK_SIZE, SEED).tiles);
    });
    const expected = stream.chunksInRadius(100, 100, 100);
    assert.equal(count, expected.length);
    assert.deepEqual(seen, expected.map((c) => `${c.cx},${c.cy}`));
    // deterministic across instances
    const other = new WorldStream({ seed: SEED, prefetch: 0 });
    const seen2: string[] = [];
    other.forEachInRadius(100, 100, 100, (_c, cx, cy) => seen2.push(`${cx},${cy}`));
    assert.deepEqual(seen2, seen);
  });

  it('radius 0 visits only the owning chunk, negatives stay in bounds', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    const seen: string[] = [];
    const count = stream.forEachInRadius(-5, -5, 0, (_c, cx, cy) => seen.push(`${cx},${cy}`));
    assert.equal(count, 1);
    assert.deepEqual(seen, ['-1,-1']);
    assert.equal(stream.forEachInRadius(0, 0, -5, () => assert.fail('never called')), 0);
  });

  it('zoneAt matches getZone at the owning chunk centre', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    for (const [cx, cy] of [[0, 0], [3, -3], [-12, 9]]) {
      const expected = getZone(
        cx * DEFAULT_CHUNK_SIZE + DEFAULT_CHUNK_SIZE / 2,
        cy * DEFAULT_CHUNK_SIZE + DEFAULT_CHUNK_SIZE / 2,
        SEED,
      );
      assert.equal(stream.zoneAt(cx * DEFAULT_CHUNK_SIZE + 4, cy * DEFAULT_CHUNK_SIZE + 4), expected);
    }
  });

  it('a walking session keeps the working set resident', () => {
    // Simulate a player walking east: the current chunk plus its whole
    // neighbor ring must be cached (prefetch), so movement never re-generates
    // ground the player is standing on or about to enter.
    const stream = new WorldStream({ seed: SEED, prefetch: 1, maxChunks: 64 });
    for (let step = 0; step < 40; step++) {
      const x = 200 + step * 8;
      const cx = Math.floor(x / DEFAULT_CHUNK_SIZE);
      stream.getChunk(cx, 4);
      assert.equal(stream.has(cx, 4), true, `current chunk ${cx} not resident`);
      for (let dy = -1; dy <= 1; dy++) {
        assert.equal(stream.has(cx + 1, 4 + dy), true, `chunk ahead of ${cx} missing`);
        assert.equal(stream.has(cx - 1, 4 + dy), true, `chunk behind ${cx} missing`);
      }
      assert.ok(stream.size <= 64, 'cache cap exceeded while walking');
    }
    const s = stream.stats();
    console.log(
      `walk: 40 steps generated=${s.generated} (${s.prefetched} prefetched) resident=${s.resident} evicted=${s.evicted}`,
    );
    assert.ok(s.prefetched > 0);
  });
});

describe('WorldStream perf', () => {
  it('10k tile reads over resident chunks stay inside the streaming budget', () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0 });
    // Deterministic pseudo-random points inside a 7x7 chunk block.
    let state = 12345;
    const rnd = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    for (let cx = -3; cx <= 3; cx++) for (let cy = -3; cy <= 3; cy++) stream.getChunk(cx, cy);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 10000; i++) {
      xs.push(Math.floor(rnd() * 224) - 112);
      ys.push(Math.floor(rnd() * 224) - 112);
    }
    let acc = 0;
    const t0 = performance.now();
    for (let i = 0; i < xs.length; i++) acc += stream.tileAt(xs[i]!, ys[i]!);
    const ms = performance.now() - t0;
    console.log(`stream perf: 10k tileAt=${ms.toFixed(2)}ms (acc=${acc})`);
    assert.ok(ms < 50, `10k cached tile reads too slow: ${ms}ms`);
    const s = stream.stats();
    assert.equal(s.tileReads, 10000);
    assert.ok(s.hits > 9900, `expected a hot cache, got ${s.hits} hits`);
  });

  it('chunk generation stays under 1 ms', () => {
    for (let i = 0; i < 100; i++) genChunk(i, 0, DEFAULT_CHUNK_SIZE, SEED);
    const N = 500;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) genChunk(i, 1, DEFAULT_CHUNK_SIZE, SEED);
    const ms = performance.now() - t0;
    const per = ms / N;
    console.log(`chunk gen: ${per.toFixed(4)}ms per 32x32 chunk`);
    assert.ok(per < 1, `chunk gen over budget: ${per.toFixed(3)}ms`);
  });
});