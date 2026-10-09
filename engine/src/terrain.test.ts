// @aetherfall/engine — terrain field tests (height / slope / hazards).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBiome, getZone, DEFAULT_WORLD_SEED } from './worldgen.js';
import {
  HEIGHT_MAX_GRADIENT,
  LAVA_DPS,
  LAVA_LEVEL,
  OCEAN_EDGE,
  WATER_DPS,
  WATER_DPS_MAX,
  WATER_LEVEL,
  WALKABLE_MAX_SLOPE,
  hazardAt,
  heightAt,
  isHazard,
  slopeAt,
  slopeVectorAt,
  slopeXAt,
  slopeYAt,
  terrainAt,
  tooSteep,
} from './terrain.js';

const SEED = DEFAULT_WORLD_SEED;

/** Deterministic sample grid (no RNG) so failures reproduce exactly. */
function* grid(step: number, radius: number, seed = SEED): Generator<[number, number, number]> {
  for (let x = -radius; x <= radius; x += step) {
    for (let y = -radius; y <= radius; y += step) yield [x, y, seed];
  }
}

describe('terrain height', () => {
  it('heightAt is deterministic, finite and seed-sensitive', () => {
    for (const [x, y, seed] of grid(37, 300)) {
      const h = heightAt(x, y, seed);
      assert.ok(Number.isFinite(h), `non-finite height at ${x},${y}`);
      assert.equal(h, heightAt(x, y, seed));
    }
    assert.notEqual(heightAt(120, 44, SEED), heightAt(120, 44, SEED + 1));
  });

  it('height field is continuous (no jumps between neighbouring samples)', () => {
    let worst = 0;
    for (const [x, y, seed] of grid(7, 420)) {
      const h = heightAt(x, y, seed);
      worst = Math.max(
        worst,
        Math.abs(heightAt(x + 0.5, y, seed) - h),
        Math.abs(heightAt(x, y + 0.5, seed) - h),
      );
    }
    // Half a world unit of travel can never move the surface more than
    // HEIGHT_MAX_GRADIENT / 2.
    assert.ok(
      worst <= HEIGHT_MAX_GRADIENT / 2,
      `height discontinuity: ${worst.toFixed(3)} over 0.5u`,
    );
  });

  it('height field is Lipschitz bounded per world unit', () => {
    let worst = 0;
    for (const [x, y, seed] of grid(11, 420)) {
      worst = Math.max(worst, Math.abs(heightAt(x + 1, y, seed) - heightAt(x, y, seed)));
    }
    assert.ok(worst < HEIGHT_MAX_GRADIENT, `gradient too steep: ${worst.toFixed(3)}/u`);
    assert.ok(worst > 0.2, 'height field looks flat — sanity check failed');
  });

  it('has no seams at chunk borders (incl. negative coordinates)', () => {
    for (const edge of [0, 32, 64, 128, -1, -32, -33, -64]) {
      const jump = Math.abs(heightAt(edge + 1, 17, SEED) - heightAt(edge, 17, SEED));
      assert.ok(jump < HEIGHT_MAX_GRADIENT, `seam at x=${edge}: ${jump.toFixed(3)}`);
      const jumpY = Math.abs(heightAt(23, edge + 1, SEED) - heightAt(23, edge, SEED));
      assert.ok(jumpY < HEIGHT_MAX_GRADIENT, `seam at y=${edge}: ${jumpY.toFixed(3)}`);
    }
  });

  it('orders ocean below land below mountain', () => {
    let ocean: [number, number] | null = null;
    let peak: [number, number] | null = null;
    for (const [x, y, seed] of grid(3, 400)) {
      if (ocean === null && getBiome(x, y, seed) === 'ocean') ocean = [x, y];
      if (peak === null && getBiome(x, y, seed) === 'snow') peak = [x, y];
      if (ocean !== null && peak !== null) break;
    }
    assert.ok(ocean !== null && peak !== null, 'sample points not found');
    const ho = heightAt(ocean[0], ocean[1], SEED);
    const hp = heightAt(peak[0], peak[1], SEED);
    assert.ok(hp - ho > 20, `expected a real relief, got ${(hp - ho).toFixed(2)}`);
  });
});

describe('terrain slope', () => {
  it('slopeAt equals hypot(slopeXAt, slopeYAt) and is non-negative', () => {
    for (const [x, y, seed] of grid(29, 200)) {
      const s = slopeAt(x, y, seed);
      assert.ok(s >= 0);
      assert.ok(
        Math.abs(s - Math.hypot(slopeXAt(x, y, seed), slopeYAt(x, y, seed))) < 1e-9,
      );
      const v = slopeVectorAt(x, y, seed);
      assert.equal(v.gx, slopeXAt(x, y, seed));
      assert.equal(v.gy, slopeYAt(x, y, seed));
      assert.equal(v.slope, s);
    }
  });

  it('slopeAt matches an independent numeric gradient', () => {
    for (const [x, y, seed] of grid(53, 200)) {
      const a = slopeAt(x, y, seed, 0.5);
      const b = slopeAt(x, y, seed, 0.125);
      assert.ok(Math.abs(a - b) / Math.max(0.2, a) < 0.4, `eps mismatch at ${x},${y}: ${a} vs ${b}`);
    }
  });

  it('slope stays inside the documented gradient bound', () => {
    let worst = 0;
    for (const [x, y, seed] of grid(11, 300)) worst = Math.max(worst, slopeAt(x, y, seed));
    assert.ok(worst < HEIGHT_MAX_GRADIENT, `slope ${worst.toFixed(2)} exceeds bound`);
    assert.equal(tooSteep(0, 0, 1e9), false);
  });

  it('marks a minority of the world as too steep to climb', () => {
    let steep = 0;
    let total = 0;
    for (const [x, y, seed] of grid(9, 400)) {
      total++;
      if (tooSteep(x, y, WALKABLE_MAX_SLOPE, seed)) steep++;
    }
    const share = steep / total;
    assert.ok(share > 0.02, `expected some cliffs, got ${(share * 100).toFixed(2)}%`);
    assert.ok(share < 0.4, `too much terrain is cliff: ${(share * 100).toFixed(2)}%`);
  });
});

describe('terrain hazards', () => {
  it('water exists exactly where genChunk blocks movement (ocean biome)', () => {
    let checked = 0;
    for (const [x, y, seed] of grid(6, 400)) {
      const hz = hazardAt(x, y, seed);
      const ocean = getBiome(x, y, seed) === 'ocean';
      if (hz.type === 'water') {
        assert.ok(ocean, `water on land at ${x},${y}`);
      } else if (ocean) {
        assert.fail(`ocean at ${x},${y} is not reported as a water hazard`);
      }
      checked++;
    }
    assert.ok(checked > 10000);
  });

  it('lava is caldera-only and never mixes with water', () => {
    let lava = 0;
    for (const [x, y, seed] of grid(6, 400)) {
      const hz = hazardAt(x, y, seed);
      if (hz.type !== 'lava') continue;
      lava++;
      assert.equal(getZone(x, y, seed), 'volcano', `lava outside the caldera at ${x},${y}`);
      assert.equal(getBiome(x, y, seed) !== 'ocean', true, 'lava on an ocean tile');
      assert.equal(hz.dps, LAVA_DPS);
      assert.ok(hz.depth >= 0);
    }
    assert.ok(lava > 100, `expected lava fields, saw ${lava} samples`);
  });

  it('dps follows the documented bands', () => {
    for (const [x, y, seed] of grid(6, 300)) {
      const hz = hazardAt(x, y, seed);
      if (hz.type === 'none') {
        assert.equal(hz.dps, 0);
        assert.equal(hz.depth, 0);
      } else if (hz.type === 'water') {
        assert.ok(hz.dps >= WATER_DPS && hz.dps <= WATER_DPS_MAX, `water dps ${hz.dps}`);
        assert.ok(hz.depth >= 0);
      } else {
        assert.equal(hz.dps, LAVA_DPS);
      }
      assert.equal(isHazard(x, y, seed), hz.type !== 'none');
    }
  });

  it('water damage grows with depth', () => {
    let shallow: number | null = null;
    let deep: number | null = null;
    let shallowDepth = Infinity;
    let deepDepth = -Infinity;
    for (const [x, y, seed] of grid(3, 400)) {
      const hz = hazardAt(x, y, seed);
      if (hz.type !== 'water') continue;
      if (hz.depth < shallowDepth) {
        shallowDepth = hz.depth;
        shallow = hz.dps;
      }
      if (hz.depth > deepDepth) {
        deepDepth = hz.depth;
        deep = hz.dps;
      }
    }
    assert.ok(shallow !== null && deep !== null && shallowDepth < deepDepth);
    assert.ok((deep as number) > (shallow as number), 'dps did not grow with depth');
  });

  it('is deterministic, seed-sensitive and independent of call order', () => {
    let differs = 0;
    let sampled = 0;
    for (const [x, y, seed] of grid(17, 260)) {
      assert.deepEqual(hazardAt(x, y, seed), hazardAt(x, y, seed));
      sampled++;
      if (JSON.stringify(hazardAt(x, y, seed)) !== JSON.stringify(hazardAt(x, y, seed + 5))) {
        differs++;
      }
    }
    assert.ok(sampled > 500);
    // A different seed must move hazards around, but not everywhere.
    assert.ok(differs > 20, `seed had almost no effect (${differs}/${sampled})`);
    assert.ok(differs < sampled, 'different seeds produced an identical hazard field');
    // Call order must not matter: interleave a fresh probe, then re-check.
    const before = hazardAt(0, 0, SEED);
    hazardAt(999, -999, SEED);
    assert.deepEqual(hazardAt(0, 0, SEED), before);
  });

  it('keeps water and lava bands consistent with the height field', () => {
    for (const [x, y, seed] of grid(13, 300)) {
      const hz = hazardAt(x, y, seed);
      const h = heightAt(x, y, seed);
      if (hz.type === 'lava') {
        assert.ok(h <= LAVA_LEVEL, `lava above LAVA_LEVEL at ${x},${y}`);
      } else if (hz.type === 'water') {
        assert.ok(getBiome(x, y, seed) === 'ocean');
      } else {
        assert.notEqual(getBiome(x, y, seed), 'ocean', `land hazard gap at ${x},${y}`);
        assert.ok(
          getZone(x, y, seed) !== 'volcano' || h > LAVA_LEVEL,
          `lava hazard gap at ${x},${y}`,
        );
      }
    }
  });
});

describe('terrainAt', () => {
  it('bundles the same numbers as the individual probes', () => {
    for (const [x, y, seed] of grid(41, 200)) {
      const s = terrainAt(x, y, seed);
      assert.equal(s.x, x);
      assert.equal(s.y, y);
      assert.equal(s.height, heightAt(x, y, seed));
      assert.equal(s.slope, slopeAt(x, y, seed));
      assert.equal(s.biome, getBiome(x, y, seed));
      assert.equal(s.zone, getZone(x, y, seed));
      assert.deepEqual(s.hazard, hazardAt(x, y, seed));
    }
  });

  it('sampling is cheap enough for per-entity use', () => {
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 10000; i++) acc += heightAt((i % 200) - 100, ((i * 7) % 200) - 100, SEED) > 0 ? 1 : 0;
    const ms = performance.now() - t0;
    console.log(`terrain perf: 10k heightAt=${ms.toFixed(2)}ms (acc=${acc})`);
    assert.ok(ms < 500, `heightAt too slow: ${ms}ms`);
  });
});

describe('terrain constants', () => {
  it('exposes self-consistent tuning values', () => {
    assert.equal(OCEAN_EDGE, 0.32);
    assert.equal(WATER_LEVEL, 0);
    assert.ok(LAVA_LEVEL > WATER_LEVEL, 'lava level must sit above the water line');
    assert.ok(WATER_DPS < WATER_DPS_MAX);
    assert.ok(LAVA_DPS > WATER_DPS_MAX, 'lava must hurt more than deep water');
    assert.ok(WALKABLE_MAX_SLOPE > 0 && WALKABLE_MAX_SLOPE < HEIGHT_MAX_GRADIENT);
  });
});