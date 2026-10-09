// Headless tests for the client's view of the engine terrain field.
//
// These pin the two contracts the renderers depend on:
//   1. the client's grid reproduces the engine's `heightAt` / `hazardAt`
//      bit-for-bit, so an avatar never floats above or sinks into a hill;
//   2. the grid is built once (no per-frame field sampling) and degrades to
//      the engine functions outside the arena.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERR_LAVA,
  TERR_NONE,
  TERR_WATER,
  TERRAIN_Z_CLAMP,
  isHazardKind,
  zPixels,
  zVisual,
  TerrainView,
} from './terrain_view.js';
import { hazardAt, heightAt, landmarkInCell } from '@aetherfall/engine';

const SEED = 1337;
const tv = new TerrainView(SEED);

describe('zVisual', () => {
  it('is monotonic and passes the water line through the origin', () => {
    assert.equal(zVisual(0), 0);
    let prev = -Infinity;
    for (let h = -40; h <= 60; h += 1.5) {
      const z = zVisual(h);
      assert.ok(z >= prev, `not monotonic at h=${h}`);
      prev = z;
    }
  });

  it('soft-clamps so one peak cannot break the isometric framing', () => {
    assert.ok(zVisual(1000) <= TERRAIN_Z_CLAMP, `${zVisual(1000)}`);
    assert.ok(zVisual(-1000) >= -TERRAIN_Z_CLAMP, `${zVisual(-1000)}`);
    // Inside the arena the whole range stays well inside the clamp.
    assert.ok(Math.abs(zVisual(43)) < TERRAIN_Z_CLAMP);
    assert.ok(Math.abs(zVisual(-11)) < TERRAIN_Z_CLAMP);
  });

  it('scales to pixels for the canvas fallback', () => {
    assert.equal(zPixels(0), 0);
    assert.ok(zPixels(10) > 0);
  });
});

describe('TerrainView grid', () => {
  it('matches the engine hazard/height samples exactly', () => {
    const grid = tv.grid();
    assert.ok(grid);
    let water = 0;
    let land = 0;
    for (let ty = 0; ty < 100; ty += 3) {
      for (let tx = 0; tx < 100; tx += 3) {
        const hz = hazardAt(tx + 0.5, ty + 0.5, SEED);
        const want = hz.type === 'water' ? TERR_WATER : hz.type === 'lava' ? TERR_LAVA : TERR_NONE;
        assert.equal(tv.kindAtTile(tx, ty), want, `kind at ${tx},${ty}`);
        assert.equal(tv.heightAtTile(tx, ty), heightAt(tx + 0.5, ty + 0.5, SEED));
        assert.equal(tv.dpsAt(tx + 0.5, ty + 0.5), hz.dps);
        if (want === TERR_WATER) water++;
        else land++;
      }
    }
    // The arena really does contain both water and dry ground (that is what
    // makes the shoreline visible in the first place).
    assert.ok(water > 20, `water samples=${water}`);
    assert.ok(land > 1000, `land samples=${land}`);
  });

  it('builds once and then serves array reads', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) tv.kindAtTile(10 + i, 10 + i);
    const stats = tv.stats();
    assert.equal(stats.builds, 1, 'grid built exactly once');
    assert.ok(stats.lastBuildMs >= 0);
    assert.ok(performance.now() - t0 < 50, 'repeated lookups are not rebuilding');
  });

  it('falls back to the engine outside the arena', () => {
    assert.equal(tv.heightAtTile(-40, -40), heightAt(-39.5, -39.5, SEED));
    // Far outside the grid every kind resolves from hazardAt, not the cache.
    for (const [tx, ty] of [[500, -500], [-260, 130], [900, 900]] as const) {
      const hz = hazardAt(tx + 0.5, ty + 0.5, SEED);
      const want = hz.type === 'water' ? TERR_WATER : hz.type === 'lava' ? TERR_LAVA : TERR_NONE;
      assert.equal(tv.kindAtTile(tx, ty), want, `kind at ${tx},${ty}`);
    }
    const lava = tv.kindAtTile(133, 201);
    assert.equal(lava, TERR_LAVA, 'caldera lava outside the grid still resolves');
  });

  it('position queries agree with tile queries', () => {
    for (const [x, y] of [[24.5, 46.5], [50.3, 50.9], [0.1, 0.1]] as const) {
      assert.equal(tv.kindAt(x, y), tv.kindAtTile(Math.floor(x), Math.floor(y)));
      assert.equal(tv.tileHeightAt(x, y), tv.heightAtTile(Math.floor(x), Math.floor(y)));
    }
  });

  it('slope/gradient come from the grid and agree with the magnitude', () => {
    for (const [tx, ty] of [[10, 10], [24, 46], [77, 31]] as const) {
      const g = tv.gradientFromGrid(tx, ty);
      assert.ok(Math.abs(tv.slopeFromGrid(tx, ty) - Math.hypot(g.gx, g.gy)) < 1e-12);
      assert.ok(tv.slopeAt(tx + 0.5, ty + 0.5) >= 0);
    }
    // The shoreline is where the gradient is steepest in this seed.
    assert.ok(tv.slopeAt(24.5, 46.5) > 0.2, `shoreline slope=${tv.slopeAt(24.5, 46.5)}`);
  });
});

describe('TerrainView landmarks', () => {
  it('returns nothing inside the 100x100 arena at seed 1337 (measured)', () => {
    // One landmark per 128u cell at ~26% fill => the arena holds ~0.6 expected.
    // This pins the fact so the minimap overlay is documented, not assumed.
    assert.equal(landmarkInCell(0, 0, SEED), null);
    assert.deepEqual(tv.landmarksNear(50, 50, 100), []);
  });

  it('finds the ruin outside the arena and memoizes the query', () => {
    const a = tv.landmarksNear(-56, 22, 64);
    assert.equal(a.length, 1);
    assert.equal(a[0]!.id, 'ruin:-1,0');
    assert.equal(a[0]!.kind, 'ruin');
    assert.deepEqual(tv.landmarksNear(-56, 22, 64), a);
  });

  it('exposes loot anchors within a radius', () => {
    const loot = tv.lootAnchorsNear(-56, 22, 64);
    assert.ok(loot.length >= 2);
    for (const l of loot) {
      assert.ok(Math.hypot(l.x + 56, l.y - 22) <= 64);
      assert.ok(l.tier >= 1);
    }
    assert.deepEqual(tv.lootAnchorsNear(-56, 22, 1), []);
  });
});

describe('hazard kinds', () => {
  it('isHazardKind excludes dry land', () => {
    assert.equal(isHazardKind(TERR_NONE), false);
    assert.equal(isHazardKind(TERR_WATER), true);
    assert.equal(isHazardKind(TERR_LAVA), true);
  });
});