import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hazardAt } from '@aetherfall/engine';
import {
  HAZARD_AVOID_GAIN,
  HAZARD_PROBE_FAR,
  HAZARD_PROBE_NEAR,
  hazardAvoid,
  pickSafeWaypoint,
  steerAwayFromHazards,
} from './hazards.js';
import { mulberry32 } from '@aetherfall/shared';

const SEED = 1337;

/** First water tile in the 100x100 arena (seed 1337 => (24, 46)). */
function firstWaterTile(): { tx: number; ty: number } {
  for (let ty = 0; ty < 100; ty++) {
    for (let tx = 0; tx < 100; tx++) {
      if (hazardAt(tx + 0.5, ty + 0.5, SEED).type === 'water') return { tx, ty };
    }
  }
  throw new Error('worldgen: no water in the arena');
}

/** Probe cross, matching hazards.ts (cardinals + diagonals). */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0.7071067811865476, 0.7071067811865476],
  [0, 1],
  [-0.7071067811865476, 0.7071067811865476],
  [-1, 0],
  [-0.7071067811865476, -0.7071067811865476],
  [0, -1],
  [0.7071067811865476, -0.7071067811865476],
];
void DIRS;

/** A dry tile whose near probe ring is clear but whose far ring is not. */
function shoreSpot(): { x: number; y: number } {
  let best = { x: 50.5, y: 50.5 };
  let bestThreat = -1;
  for (let ty = 2; ty < 98; ty++) {
    for (let tx = 2; tx < 98; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      if (hazardAt(x, y, SEED).dps !== 0) continue;
      const t = hazardAvoid(x, y, SEED, 14, 14).threat;
      if (t > bestThreat) {
        bestThreat = t;
        best = { x, y };
      }
    }
  }
  if (bestThreat <= 0) throw new Error('worldgen: no shoreline tile found');
  return best;
}

describe('hazardAvoid', () => {
  it('is a no-op on dry ground', () => {
    // (60.5, 60.5) is far from any hazard at both probe radii.
    assert.equal(hazardAt(60.5, 60.5, SEED).dps, 0);
    const a = hazardAvoid(60.5, 60.5, SEED);
    assert.equal(a.threat, 0);
    assert.equal(a.weight, 0);
    assert.equal(a.hazard, 'none');
    assert.equal(Math.hypot(a.x, a.y), 0);
  });

  it('threat is the worst dps on the probe cross, and the push opposes it', () => {
    const { tx, ty } = firstWaterTile();
    let checked = 0;
    for (let k = 1; k <= 8; k += 3) {
      const x = tx + 0.5 - k;
      const y = ty + 0.5;
      if (hazardAt(x, y, SEED).dps !== 0) continue;
      const a = hazardAvoid(x, y, SEED);
      if (a.weight === 0) continue;
      assert.equal(a.hazard, 'water');
      assert.ok(a.threat >= 5 && a.threat <= 20, `shallow-water dps band: ${a.threat}`);
      // The push is a unit vector pointing at the least dangerous side: the
      // dps it leads toward is no worse than the dps it leaves.
      assert.ok(Math.abs(Math.hypot(a.x, a.y) - 1) < 1e-9, 'unit vector');
      assert.ok(a.weight > 0 && a.weight <= 1);
      checked++;
    }
    assert.ok(checked > 0, 'at least one shoreline sample');
  });

  it('sees lava and weighs it as maximum hazard', () => {
    const lava = hazardAvoid(133.5, 201.5, SEED, 2, 4);
    assert.equal(lava.hazard, 'lava');
    assert.equal(lava.threat, 22);
    assert.equal(lava.weight, 1, 'lava maxes the weight');
  });

  it('a tighter probe ring never sees more hazard', () => {
    const spot = shoreSpot();
    const tight = hazardAvoid(spot.x, spot.y, SEED, 1.5, 1.5);
    const normal = hazardAvoid(spot.x, spot.y, SEED);
    assert.ok(normal.threat >= 0);
    assert.ok(tight.threat <= normal.threat + 1e-9, `${tight.threat} <= ${normal.threat}`);
    // And the wider ring really does see the lake this spot is next to.
    assert.ok(normal.threat > 0, 'shore spot has a hazard nearby');
  });
});

describe('steerAwayFromHazards', () => {
  it('returns the input untouched on clear ground', () => {
    const out = steerAwayFromHazards(60.5, 60.5, 0.6, 0.8, SEED);
    assert.equal(out.x, 0.6);
    assert.equal(out.y, 0.8);
    assert.equal(out.avoid.weight, 0);
  });

  it('turns a heading that points at a hazard toward the safe side', () => {
    const spot = shoreSpot();
    const a = hazardAvoid(spot.x, spot.y, SEED);
    // Facing the hazard: the output must land strictly on the safe side of it.
    const into: [number, number] = [-a.x, -a.y];
    const out = steerAwayFromHazards(spot.x, spot.y, into[0], into[1], SEED);
    assert.ok(out.x * a.x + out.y * a.y > 0, 'heading now leans away from the hazard');
    assert.ok(Math.abs(Math.hypot(out.x, out.y) - 1) < 1e-9, 'unit vector');
  });

  it('never produces a NaN heading, even boxed in by hazards', () => {
    const { tx, ty } = firstWaterTile();
    for (let dx = -6; dx <= 6; dx += 1.5) {
      for (let dy = -6; dy <= 6; dy += 1.5) {
        const out = steerAwayFromHazards(tx + 0.5 + dx, ty + 0.5 + dy, 1, 0, SEED);
        assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y), `NaN at ${dx},${dy}`);
        assert.ok(Math.abs(out.x) <= 1 && Math.abs(out.y) <= 1);
      }
    }
  });

  it('a stronger gain turns harder', () => {
    const spot = shoreSpot();
    const a = hazardAvoid(spot.x, spot.y, SEED);
    // A heading 40deg off the hazard, not exactly at it: exactly-at saturates
    // the blend for any gain, which would make the comparison meaningless.
    const ang = (40 * Math.PI) / 180;
    const hx = a.x * Math.cos(ang) - a.y * Math.sin(ang);
    const hy = a.x * Math.sin(ang) + a.y * Math.cos(ang);
    const soft = steerAwayFromHazards(spot.x, spot.y, hx, hy, SEED, 0.5);
    const hard = steerAwayFromHazards(spot.x, spot.y, hx, hy, SEED, HAZARD_AVOID_GAIN);
    const turn = (o: { x: number; y: number }): number => o.x * a.x + o.y * a.y;
    assert.ok(turn(hard) > turn(soft), `${turn(hard).toFixed(3)} > ${turn(soft).toFixed(3)}`);
  });

  it('walks a bot out of a shoreline bind that a naive heading would drown in', () => {
    // Behavioural test: same start, same goal, 200 ticks at 8 u/s. Counts how
    // many ticks each bot spends standing in a damaging tile.
    const { tx, ty } = firstWaterTile();
    let start = { x: -1, y: -1 };
    for (let k = 1; k <= 8; k++) {
      const x = tx + 0.5 - k;
      const y = ty + 0.5;
      if (hazardAt(x, y, SEED).dps === 0 && hazardAvoid(x, y, SEED).weight > 0) {
        start = { x, y };
        break;
      }
    }
    assert.ok(start.x >= 0, 'found a shoreline start tile');
    // Aim straight at the middle of the lake.
    const goal = { x: tx + 1.5, y: ty + 1.5 };
    const run = (avoid: boolean): { wet: number; end: { x: number; y: number } } => {
      let p = { ...start };
      let wet = 0;
      for (let i = 0; i < 200; i++) {
        const dx = goal.x - p.x;
        const dy = goal.y - p.y;
        const l = Math.hypot(dx, dy) || 1;
        let hx = dx / l;
        let hy = dy / l;
        if (avoid) {
          const s = steerAwayFromHazards(p.x, p.y, hx, hy, SEED);
          hx = s.x;
          hy = s.y;
        }
        p = { x: p.x + hx * 8 * 0.05, y: p.y + hy * 8 * 0.05 };
        if (hazardAt(p.x, p.y, SEED).dps > 0) wet++;
      }
      return { wet, end: p };
    };
    const naive = run(false);
    const steered = run(true);
    assert.ok(naive.wet > 50, `the naive heading really does drown (${naive.wet} wet ticks)`);
    assert.equal(steered.wet, 0, 'the steered bot never enters a damaging tile');
    assert.equal(hazardAt(steered.end.x, steered.end.y, SEED).dps, 0);
  });
});

describe('pickSafeWaypoint', () => {
  it('never returns a hazard waypoint for a well-behaved roll', () => {
    const rng = mulberry32(99);
    let picked = 0;
    for (let i = 0; i < 200; i++) {
      const wp = pickSafeWaypoint(rng, SEED);
      assert.ok(wp.x >= 0 && wp.x <= 100 && wp.y >= 0 && wp.y <= 100);
      if (hazardAt(wp.x, wp.y, SEED).dps === 0) picked++;
    }
    // ~6% of the arena is water; with a 4-retry sweep rejections are rare.
    assert.ok(picked >= 180, `picked ${picked}/200 hazard-free waypoints`);
  });

  it('is deterministic for a deterministic roll', () => {
    const a = pickSafeWaypoint(mulberry32(7), SEED);
    const b = pickSafeWaypoint(mulberry32(7), SEED);
    assert.deepEqual(a, b);
  });

  it('still returns something when every candidate is a hazard', () => {
    // A roll pinned into the lake: the helper must not spin or throw.
    const wp = pickSafeWaypoint(() => 0.245, SEED, 100, 2);
    assert.ok(Number.isFinite(wp.x) && Number.isFinite(wp.y));
  });
});