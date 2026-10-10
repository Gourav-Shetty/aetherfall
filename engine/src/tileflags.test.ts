// @aetherfall/engine — tile flag parity tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORLD_SEED,
  biomeWalkable,
  getBiome,
  getZone,
  tileFlagsFor,
  type ZoneId,
} from './worldgen.js';
import { hazardAt } from './terrain.js';
import { tileBlocked, tileFlags, tileWalkable } from './tileflags.js';

const SEED = DEFAULT_WORLD_SEED;

function zoneSamples(zone: ZoneId, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // Deterministic sweep; jittered borders mean we filter by actual zone.
  for (let x = -260; x <= 260 && out.length < n; x += 5) {
    for (let y = -260; y <= 260 && out.length < n; y += 7) {
      if (getZone(x, y, SEED) === zone) out.push([x, y]);
    }
  }
  assert.ok(out.length >= n, `not enough ${zone} samples (got ${out.length})`);
  return out;
}

describe('tileFlags parity (matches old collision behavior)', () => {
  for (const zone of ['meadow', 'dungeon', 'volcano'] as const) {
    it(`every tile in ${zone} matches hazard/biome block set`, () => {
      for (const [x, y] of zoneSamples(zone, 250)) {
        const f = tileFlags(x, y, SEED);
        const hz = hazardAt(x, y, SEED);
        const biome = getBiome(x, y, SEED);
        // The flag struct carries the same inputs it was derived from.
        assert.equal(f.hazard, hz.type);
        assert.equal(f.biome, biome);
        assert.equal(f.zone, getZone(x, y, SEED));
        // walk/block consistency.
        assert.equal(f.block, !f.walk);
        // Old collision block set: hazard water/lava blocks; ocean biome is
        // exactly the water set (pinned by terrain tests), so both framings agree.
        const oldBlock = hz.type !== 'none';
        const oldBlockViaBiome = !biomeWalkable(biome) || hz.type !== 'none';
        assert.equal(f.block, oldBlock, `block mismatch at ${x},${y}`);
        assert.equal(f.block, oldBlockViaBiome, `biome-block mismatch at ${x},${y}`);
        assert.equal(tileBlocked(x, y, SEED), oldBlock);
        assert.equal(tileWalkable(x, y, SEED), !oldBlock);
      }
    });
  }

  it('tileFlagsFor is the pure combiner (block === hazard present)', () => {
    assert.deepEqual(tileFlagsFor('plains', 'meadow', 'none'), {
      walk: true, block: false, hazard: 'none', biome: 'plains', zone: 'meadow',
    });
    assert.deepEqual(tileFlagsFor('ocean', 'meadow', 'water'), {
      walk: false, block: true, hazard: 'water', biome: 'ocean', zone: 'meadow',
    });
    assert.deepEqual(tileFlagsFor('plains', 'volcano', 'lava'), {
      walk: false, block: true, hazard: 'lava', biome: 'plains', zone: 'volcano',
    });
  });

  it('deterministic per position and seed-sensitive', () => {
    assert.deepEqual(tileFlags(12.5, -7.5, SEED), tileFlags(12.5, -7.5, SEED));
    const a = JSON.stringify(tileFlags(10, 10, SEED));
    const b = JSON.stringify(tileFlags(10, 10, SEED + 1));
    assert.ok(typeof a === 'string' && a.length > 0);
    // Different seeds move the field somewhere (not necessarily at this tile).
    let differs = 0;
    for (let i = 0; i < 50; i++) {
      if (JSON.stringify(tileFlags(i * 13, i * 7, SEED)) !== JSON.stringify(tileFlags(i * 13, i * 7, SEED + 5))) differs++;
    }
    assert.ok(differs > 0, 'seed had no effect on any sample');
  });
});
