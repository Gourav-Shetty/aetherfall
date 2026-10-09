import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  genChunk,
  genDungeon,
  getBiome,
  getElevation,
  getMoisture,
  valueNoise,
  fbm,
  hash2,
} from './worldgen.js';

describe('worldgen noise', () => {
  it('hash and value noise are deterministic and bounded', () => {
    assert.equal(hash2(3, 7, 42), hash2(3, 7, 42));
    assert.notEqual(hash2(3, 7, 42), hash2(3, 7, 43));
    for (const [x, y] of [
      [0, 0],
      [1.5, -2.25],
      [100, 200],
    ] as Array<[number, number]>) {
      const v = valueNoise(x, y, 9);
      assert.ok(v >= 0 && v <= 1, `noise out of range: ${v}`);
      assert.equal(v, valueNoise(x, y, 9));
    }
  });

  it('fbm stays in [0,1] and varies spatially', () => {
    const a = fbm(0.5, 0.5, 4, 1);
    const b = fbm(9.5, 3.25, 4, 1);
    assert.ok(a >= 0 && a <= 1 && b >= 0 && b <= 1);
    assert.notEqual(a, b);
    assert.equal(a, fbm(0.5, 0.5, 4, 1));
  });

  it('elevation/moisture/biome deterministic per seed', () => {
    assert.equal(getElevation(10, 20, 5), getElevation(10, 20, 5));
    assert.equal(getMoisture(10, 20, 5), getMoisture(10, 20, 5));
    assert.equal(getBiome(10, 20, 5), getBiome(10, 20, 5));
  });

  it('world shows multiple biomes over a large sample', () => {
    const seen = new Set<string>();
    for (let x = -80; x <= 80; x += 8) {
      for (let y = -80; y <= 80; y += 8) seen.add(getBiome(x, y, 1337));
    }
    assert.ok(seen.size >= 3, `expected biome variety, saw: ${[...seen]}`);
  });
});

describe('worldgen chunks', () => {
  it('genChunk deterministic by seed; different seeds differ', () => {
    const a = genChunk(2, -3, 16, 99);
    const b = genChunk(2, -3, 16, 99);
    assert.deepEqual(a, b);
    const c = genChunk(2, -3, 16, 100);
    assert.notDeepEqual(a.tiles, c.tiles);
    const d = genChunk(3, -3, 16, 99);
    assert.notDeepEqual(a.tiles, d.tiles);
  });

  it('chunk shape, border walls, tile domain', () => {
    const ch = genChunk(0, 0, 32, 1337);
    assert.equal(ch.tiles.length, 32);
    assert.equal(ch.tiles[0].length, 32);
    for (let i = 0; i < 32; i++) {
      assert.equal(ch.tiles[0][i], 1);
      assert.equal(ch.tiles[31][i], 1);
      assert.equal(ch.tiles[i][0], 1);
      assert.equal(ch.tiles[i][31], 1);
    }
    for (const row of ch.tiles) for (const t of row) assert.ok(t === 0 || t === 1);
  });

  it('chunk gen is fast (streaming budget)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 25; i++) genChunk(i, 0, 32, 1337);
    const ms = performance.now() - t0;
    console.log(`worldgen perf: 25 chunks=${ms.toFixed(1)}ms`);
    assert.ok(ms < 2000, `chunk gen too slow: ${ms}ms`);
  });
});

describe('worldgen dungeons', () => {
  it('deterministic by seed', () => {
    const a = genDungeon(40, 30, 7);
    const b = genDungeon(40, 30, 7);
    assert.deepEqual(a, b);
  });

  it('rooms do not overlap and stay in bounds', () => {
    const d = genDungeon(48, 32, 1234);
    assert.ok(d.rooms.length >= 1);
    assert.equal(d.tiles.length, 32);
    assert.equal(d.tiles[0].length, 48);
    for (const r of d.rooms) {
      assert.ok(r.x >= 1 && r.y >= 1 && r.x + r.w < 48 && r.y + r.h < 32);
    }
    for (let i = 0; i < d.rooms.length; i++) {
      for (let j = i + 1; j < d.rooms.length; j++) {
        const a = d.rooms[i];
        const b = d.rooms[j];
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.equal(overlap, false, `rooms ${i} and ${j} overlap`);
      }
    }
  });

  it('dungeon is fully connected (all room centers reachable)', () => {
    const d = genDungeon(48, 32, 555);
    const centers = d.rooms.map((r) => [r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)] as [number, number]);
    const seen = new Set<string>();
    const q: Array<[number, number]> = [centers[0]];
    seen.add(`${centers[0][0]},${centers[0][1]}`);
    while (q.length) {
      const [x, y] = q.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const k = `${nx},${ny}`;
        if (nx < 0 || ny < 0 || ny >= d.height || nx >= d.width || seen.has(k)) continue;
        if (d.tiles[ny][nx] !== 0) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    for (const [cx, cy] of centers) {
      assert.ok(seen.has(`${cx},${cy}`), `room center ${cx},${cy} unreachable`);
    }
    // Sanity: some floor was actually carved.
    assert.ok(seen.size > 20);
  });

  it('rejects tiny dungeons', () => {
    assert.throws(() => genDungeon(8, 8, 1), /too small/);
  });
});
