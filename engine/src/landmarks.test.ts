// @aetherfall/engine — landmark tests (determinism, rarity, uniqueness, loot).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORLD_SEED, ZONE_DEFS, getZone, type ZoneId } from './worldgen.js';
import { WALKABLE_MAX_SLOPE, hazardAt, slopeAt } from './terrain.js';
import {
  LANDMARK_CELL,
  LANDMARK_DENSITY,
  LANDMARK_KINDS,
  LANDMARK_LOOT_MIN,
  LANDMARK_LOOT_SPREAD,
  LANDMARK_NAMES,
  LANDMARK_RADIUS,
  LandmarkIndex,
  findLandmarks,
  landmarkCellOf,
  landmarkCellOfChunk,
  landmarkId,
  landmarkInCell,
  landmarksInRadius,
  nearestLandmark,
} from './landmarks.js';

const SEED = DEFAULT_WORLD_SEED;
const R = 40; // scan radius in cells (80x80 = 6400 cells)

function scanCells(seed = SEED) {
  const out: Array<NonNullable<ReturnType<typeof landmarkInCell>>> = [];
  for (let gy = -R; gy < R; gy++) {
    for (let gx = -R; gx < R; gx++) {
      const lm = landmarkInCell(gx, gy, seed);
      if (lm !== null) out.push(lm);
    }
  }
  return out;
}

describe('landmark cells', () => {
  it('landmarkInCell is a pure function of (cell, seed)', () => {
    for (let i = 0; i < 400; i++) {
      const gx = (i * 37) % 200 - 100;
      const gy = (i * 53) % 200 - 100;
      const a = landmarkInCell(gx, gy, SEED);
      const b = landmarkInCell(gx, gy, SEED);
      assert.deepEqual(a, b);
    }
  });

  it('every landmark belongs to exactly one cell and has a unique id', () => {
    const lms = scanCells();
    assert.ok(lms.length > 500, `expected a populated corpus, saw ${lms.length}`);
    const ids = new Set<string>();
    const cells = new Set<string>();
    for (const lm of lms) {
      assert.equal(landmarkCellOf(lm.x, lm.y).gx, lm.gx);
      assert.equal(landmarkCellOf(lm.x, lm.y).gy, lm.gy);
      assert.equal(lm.id, landmarkId(lm.kind, lm.gx, lm.gy));
      assert.ok(!ids.has(lm.id), `duplicate landmark id ${lm.id}`);
      ids.add(lm.id);
      const cellKey = `${lm.gx},${lm.gy}`;
      assert.ok(!cells.has(cellKey), `two landmarks in cell ${cellKey}`);
      cells.add(cellKey);
    }
    assert.equal(cells.size, lms.length);
  });

  it('landmarks stay rare (cell fill rate is a minority of cells)', () => {
    const total = (2 * R) * (2 * R);
    const lms = scanCells();
    const density = lms.length / total;
    assert.ok(density > 0.15, `too sparse: ${(density * 100).toFixed(1)}% of cells`);
    assert.ok(density < 0.45, `too dense: ${(density * 100).toFixed(1)}% of cells`);
    // Rare in world units: average spacing well beyond a screen.
    const spacing = LANDMARK_CELL / Math.sqrt(density);
    assert.ok(spacing > 170, `average spacing ${spacing.toFixed(0)}u is not "rare"`);
  });

  it('never places a landmark in water, lava or on a cliff', () => {
    for (const lm of scanCells()) {
      assert.equal(hazardAt(lm.x, lm.y, SEED).type, 'none', `hazardous site ${lm.id}`);
      assert.ok(
        slopeAt(lm.x, lm.y, SEED) <= WALKABLE_MAX_SLOPE,
        `cliff site ${lm.id} slope=${slopeAt(lm.x, lm.y, SEED)}`,
      );
      assert.equal(getZone(lm.x, lm.y, SEED), lm.zone);
    }
  });

  it('uses all three kinds and zone-appropriate tables', () => {
    const lms = scanCells();
    const kinds = new Set(lms.map((l) => l.kind));
    for (const kind of LANDMARK_KINDS) assert.ok(kinds.has(kind as never), `missing kind ${kind}`);
    assert.deepEqual([...kinds].sort(), [...LANDMARK_KINDS].sort());
    for (const lm of lms) {
      assert.ok(LANDMARK_KINDS.includes(lm.kind));
      assert.ok((LANDMARK_NAMES[lm.kind] as readonly string[]).includes(lm.name));
      assert.equal(lm.radius, LANDMARK_RADIUS[lm.kind]);
    }
    // Meadow should be camp-heavy, caldera obelisk-heavy.
    const meadow = lms.filter((l) => l.zone === 'meadow');
    if (meadow.length > 20) {
      const camps = meadow.filter((l) => l.kind === 'camp').length / meadow.length;
      assert.ok(camps > 0.25, `meadow camp share ${camps.toFixed(2)} too low`);
    }
    const caldera = lms.filter((l) => l.zone === 'volcano');
    if (caldera.length > 20) {
      const obelisks = caldera.filter((l) => l.kind === 'obelisk').length / caldera.length;
      assert.ok(obelisks > 0.2, `caldera obelisk share ${obelisks.toFixed(2)} too low`);
    }
  });

  it('different seeds lay out different landmarks', () => {
    const a = scanCells(SEED).map((l) => l.id).join('|');
    const b = scanCells(SEED + 1).map((l) => l.id).join('|');
    assert.notEqual(a, b);
    // ...but every seed still produces a usable world.
    assert.ok(b.length > 100);
  });

  it('honours the per-zone density table', () => {
    for (const zone of Object.keys(LANDMARK_DENSITY) as ZoneId[]) {
      const d = LANDMARK_DENSITY[zone];
      assert.ok(d > 0 && d < 0.5, `implausible density for ${zone}: ${d}`);
      assert.ok(ZONE_DEFS[zone] !== undefined);
    }
  });
});

describe('landmark loot anchors', () => {
  it('anchors are unique, inside the footprint and tier-legal', () => {
    const lms = scanCells();
    const anchorIds = new Set<string>();
    let anchorTotal = 0;
    for (const lm of lms) {
      assert.ok(
        lm.loot.length >= LANDMARK_LOOT_MIN &&
          lm.loot.length < LANDMARK_LOOT_MIN + LANDMARK_LOOT_SPREAD,
        `${lm.id} has ${lm.loot.length} anchors`,
      );
      for (const a of lm.loot) {
        assert.ok(!anchorIds.has(a.id), `duplicate loot id ${a.id}`);
        anchorIds.add(a.id);
        assert.equal(a.id, `${lm.id}#${lm.loot.indexOf(a)}`);
        assert.ok(Number.isInteger(a.x) && Number.isInteger(a.y));
        assert.ok(
          Math.hypot(a.x - lm.x, a.y - lm.y) <= lm.radius,
          `anchor ${a.id} escaped the footprint`,
        );
        const band = ZONE_DEFS[lm.zone];
        assert.ok(a.tier >= band.levelMin && a.tier <= band.levelMax, `tier ${a.tier} out of band`);
      }
      anchorTotal += lm.loot.length;
    }
    assert.ok(anchorTotal > lms.length, 'expected multiple anchors per landmark');
  });

  it('anchors do not stack on the landmark centre', () => {
    let stacked = 0;
    for (const lm of scanCells()) {
      for (const a of lm.loot) if (a.x === lm.x && a.y === lm.y) stacked++;
    }
    assert.equal(stacked, 0);
  });
});

describe('findLandmarks', () => {
  it('is deterministic and seed-sensitive', () => {
    const a = findLandmarks(3, -2, 6, { seed: SEED });
    const b = findLandmarks(3, -2, 6, { seed: SEED });
    assert.deepEqual(a, b);
    assert.notDeepEqual(
      findLandmarks(3, -2, 6, { seed: SEED }).map((l) => l.id),
      findLandmarks(3, -2, 6, { seed: SEED + 3 }).map((l) => l.id),
    );
  });

  it('honours the chunk-space radius and returns unique ids', () => {
    for (const r of [1, 3, 6, 12]) {
      const list = findLandmarks(11, -7, r, { seed: SEED });
      const center = { x: 11 * 32 + 16, y: -7 * 32 + 16 };
      const ids = new Set<string>();
      for (const lm of list) {
        assert.ok(
          Math.hypot(lm.x - center.x, lm.y - center.y) <= r * 32,
          `${lm.id} outside r=${r}`,
        );
        assert.ok(!ids.has(lm.id));
        ids.add(lm.id);
      }
      // sorted deterministically by cell
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        assert.ok(prev.gy < cur.gy || (prev.gy === cur.gy && prev.gx <= cur.gx), 'unsorted');
      }
    }
  });

  it('supports a custom chunk size', () => {
    const a = findLandmarks(0, 0, 4, { seed: SEED, chunkSize: 64 });
    const center = { x: 32, y: 32 };
    for (const lm of a) assert.ok(Math.hypot(lm.x - center.x, lm.y - center.y) <= 4 * 64);
  });

  it('degenerate radii return nothing and never throw', () => {
    assert.deepEqual(findLandmarks(0, 0, 0, { seed: SEED }), []);
    assert.deepEqual(findLandmarks(0, 0, -3, { seed: SEED }), []);
    assert.deepEqual(landmarksInRadius(0, 0, 0, SEED), []);
    assert.deepEqual(landmarksInRadius(0, 0, Number.NaN, SEED), []);
  });

  it('overlapping scans return identical records for shared landmarks', () => {
    const scans = [
      findLandmarks(-5, -5, 5, { seed: SEED }),
      findLandmarks(5, -5, 5, { seed: SEED }),
      findLandmarks(-5, 5, 5, { seed: SEED }),
      findLandmarks(5, 5, 5, { seed: SEED }),
      findLandmarks(0, 0, 12, { seed: SEED }),
    ];
    // Every scan is internally unique...
    for (const scan of scans) {
      const ids = new Set(scan.map((l) => l.id));
      assert.equal(ids.size, scan.length, 'duplicate inside one scan');
    }
    // ...and a landmark seen by two scans is byte-identical in both.
    const byId = new Map<string, unknown>();
    for (const scan of scans) {
      for (const lm of scan) {
        const key = `${lm.id}|${lm.loot.map((a) => a.id).join(',')}`;
        const prev = byId.get(key);
        if (prev === undefined) byId.set(key, lm);
        else assert.deepEqual(prev, lm, `${lm.id} differs between scans`);
      }
    }
  });

  it('a scan is complete: no in-range landmark is missed', () => {
    // Brute force every landmark cell whose center could fall inside the scan
    // and compare against findLandmarks() output.
    const r = 12 * 32;
    const center = { x: 16, y: 16 };
    const found = new Set(findLandmarks(0, 0, 12, { seed: SEED }).map((l) => l.id));
    const lo = landmarkCellOf(center.x - r, center.y - r);
    const hi = landmarkCellOf(center.x + r, center.y + r);
    let expected = 0;
    for (let gy = lo.gy; gy <= hi.gy; gy++) {
      for (let gx = lo.gx; gx <= hi.gx; gx++) {
        const lm = landmarkInCell(gx, gy, SEED);
        if (lm === null) continue;
        if (Math.hypot(lm.x - center.x, lm.y - center.y) > r) continue;
        expected++;
        assert.ok(found.has(lm.id), `${lm.id} in range but missing from the scan`);
      }
    }
    assert.equal(found.size, expected);
    assert.ok(expected > 3, `sample too small (${expected})`);
  });

  it('landmarkCellOfChunk matches the chunk convention', () => {
    assert.deepEqual(landmarkCellOfChunk(0, 0, 32), landmarkCellOf(16, 16));
    assert.deepEqual(landmarkCellOfChunk(-1, -1, 32), landmarkCellOf(-16, -16));
    assert.deepEqual(landmarkCellOf(-5, 9), { gx: -1, gy: 0 });
  });

  it('nearestLandmark returns the closest hit inside maxR', () => {
    const near = nearestLandmark(500, -500, 900, SEED);
    if (near !== null) {
      const d = Math.hypot(near.x - 500, near.y + 500);
      assert.ok(d <= 900);
      const all = landmarksInRadius(500, -500, 900, SEED);
      for (const lm of all) {
        assert.ok(Math.hypot(lm.x - 500, lm.y + 500) >= d - 1e-9);
      }
    }
    assert.equal(nearestLandmark(0, 0, 1, SEED), null);
  });
});

describe('LandmarkIndex', () => {
  it('matches the pure query and memoizes cells', () => {
    const idx = new LandmarkIndex(SEED, 64);
    const pure = findLandmarks(2, 1, 5, { seed: SEED });
    const cached = idx.findAroundChunk(2, 1, 5);
    assert.deepEqual(cached.map((l) => l.id), pure.map((l) => l.id));
    const after = idx.computedCells;
    idx.findAroundChunk(2, 1, 5);
    assert.equal(idx.computedCells, after, 'cached query recomputed cells');
    idx.clear();
    assert.equal(idx.size, 0);
    assert.equal(idx.computedCells, 0);
  });

  it('bounds its cell cache and stays correct after eviction', () => {
    const idx = new LandmarkIndex(SEED, 32);
    const pure = findLandmarks(40, -40, 14, { seed: SEED });
    assert.deepEqual(idx.findAroundChunk(40, -40, 14).map((l) => l.id), pure.map((l) => l.id));
    assert.ok(idx.size <= 32, `cache grew to ${idx.size}`);
    assert.deepEqual(
      idx.findAroundChunk(40, -40, 14).map((l) => l.id),
      pure.map((l) => l.id),
    );
  });
});

describe('landmark perf', () => {
  it('findLandmarks is cheap enough to run per request', () => {
    const t0 = performance.now();
    let found = 0;
    for (let i = 0; i < 2000; i++) found += findLandmarks(i % 60, i % 41, 6, { seed: SEED }).length;
    const ms = performance.now() - t0;
    console.log(`landmark perf: 2000 findLandmarks=${ms.toFixed(1)}ms (found=${found})`);
    assert.ok(ms < 750, `findLandmarks too slow: ${ms}ms`);
  });
});