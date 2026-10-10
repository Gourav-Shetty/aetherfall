// @aetherfall/server — tileFlags parity: every tile matches old collision behavior.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getZone, type ZoneId } from '@aetherfall/engine';
import { TERRAIN_SEED } from './terrain_sys.js';
import { Sim } from './sim.js';

function zoneSamples(zone: ZoneId, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = -260; x <= 260 && out.length < n; x += 5) {
    for (let y = -260; y <= 260 && out.length < n; y += 7) {
      if (getZone(x, y, TERRAIN_SEED) === zone) out.push([x + 0.5, y + 0.5]);
    }
  }
  assert.ok(out.length >= n, `not enough ${zone} samples`);
  return out;
}

describe('sim tileFlags parity', () => {
  for (const zone of ['meadow', 'dungeon', 'volcano'] as const) {
    it(`tileFlags matches terrain collision in ${zone}`, () => {
      const sim = new Sim({ terrain: {} });
      for (const [x, y] of zoneSamples(zone, 150)) {
        const f = sim.tileFlags(x, y);
        // Same block set as the circle probe on the containing tile (r=0).
        assert.equal(f.block, sim.hitsTerrain(x, y, 0), `block mismatch at ${x},${y}`);
        assert.equal(f.block, !f.walk);
        assert.equal(sim.isTileBlocked(x, y), f.block);
        // Metadata rides along.
        assert.equal(f.zone, getZone(x, y, TERRAIN_SEED));
        assert.ok(f.hazard === 'none' || f.hazard === 'water' || f.hazard === 'lava');
      }
    });
  }

  it('walls interplay unchanged (walls + terrain are independent sets)', () => {
    const sim = new Sim({ terrain: {} });
    sim.setWalls([{ x: 10, y: 10, w: 1, h: 1 }]);
    // A wall tile is a wall regardless of terrain flags; terrain flags ignore walls.
    assert.equal(sim.hitsWall(10.5, 10.5), true);
    assert.equal(sim.isFreeSpot(10.5, 10.5), false);
    // Open dry ground stays free.
    let free: [number, number] | null = null;
    for (const [x, y] of zoneSamples('meadow', 150)) {
      if (!sim.hitsWall(x, y) && !sim.hitsTerrain(x, y)) {
        free = [x, y];
        break;
      }
    }
    assert.ok(free !== null);
    assert.equal(sim.isFreeSpot(free![0], free![1]), true);
  });

  it('terrain-off keeps the open arena (no terrain block, flags report none)', () => {
    const sim = new Sim({ terrain: false });
    for (const [x, y] of zoneSamples('meadow', 50)) {
      assert.equal(sim.hitsTerrain(x, y, 0), false);
      assert.equal(sim.tileFlags(x, y).hazard, 'none');
      assert.equal(sim.tileFlags(x, y).block, false);
    }
  });
});
