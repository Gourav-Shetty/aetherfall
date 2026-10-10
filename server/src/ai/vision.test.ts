// Vision cone tests — `npm test --workspace=@aetherfall/server`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getZone } from '@aetherfall/engine';
import {
  MOVE_SPEED_EPS,
  NOISE_RADIUS,
  SNEAK_STILL_DIST,
  VISION_RANGE,
  VISION_RANGE_DUNGEON,
  angleDiff,
  canDetect,
  canTrack,
  faceToward,
  inVisionCone,
  visionRangeAt,
} from './vision.js';

const DEG = Math.PI / 180;

describe('inVisionCone', () => {
  it('sees straight ahead, not behind', () => {
    assert.equal(inVisionCone(0, 0, 0, 10, 0), true);
    assert.equal(inVisionCone(0, 0, 0, -10, 0), false);
    assert.equal(inVisionCone(0, 0, 0, 0, 10), false);
  });
  it('cone edges are inclusive (exactly +-45deg counts)', () => {
    const r = 10;
    assert.equal(inVisionCone(0, 0, 0, r * Math.cos(45 * DEG), r * Math.sin(45 * DEG)), true);
    assert.equal(inVisionCone(0, 0, 0, r * Math.cos(-45 * DEG), r * Math.sin(-45 * DEG)), true);
    assert.equal(inVisionCone(0, 0, 0, r * Math.cos(46 * DEG), r * Math.sin(46 * DEG)), false);
    assert.equal(inVisionCone(0, 0, 0, r * Math.cos(-46 * DEG), r * Math.sin(-46 * DEG)), false);
  });
  it('range edge is inclusive, beyond is out', () => {
    assert.equal(inVisionCone(0, 0, 0, VISION_RANGE, 0), true);
    assert.equal(inVisionCone(0, 0, 0, VISION_RANGE + 0.1, 0), false);
    assert.equal(inVisionCone(0, 0, 0, VISION_RANGE_DUNGEON, 0, VISION_RANGE_DUNGEON), true);
    assert.equal(inVisionCone(0, 0, 0, VISION_RANGE_DUNGEON + 0.1, 0, VISION_RANGE_DUNGEON), false);
  });
  it('a target on top of the viewer is seen regardless of facing', () => {
    assert.equal(inVisionCone(5, 5, Math.PI, 5, 5), true);
  });
  it('facing follows atan2 convention (0 = +X)', () => {
    assert.equal(faceToward(0, 0, 1, 0), 0);
    assert.ok(Math.abs(faceToward(0, 0, 0, 1) - Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(angleDiff(0, Math.PI)) <= Math.PI);
  });
});

describe('visionRangeAt', () => {
  it('open ground reads 14u, dungeon/volcano rock reads 12u', () => {
    // (30,30) sits deep in the meadow for every seed jitter (r~42 < 70-15).
    assert.equal(getZone(30, 30), 'meadow');
    assert.equal(visionRangeAt(30, 30), 14);
    // (50,70) sits in the dungeon band (r~86, jitter at most +-15).
    assert.equal(getZone(50, 70), 'dungeon');
    assert.equal(visionRangeAt(50, 70), 12);
  });
  it('range always matches the zone rule (meadow 14, else 12)', () => {
    const pts: Array<[number, number]> = [
      [10, 10], [30, 30], [50, 70], [80, 80], [5, 90], [95, 5], [99, 99],
    ];
    // find one volcano sample so the 12u branch is covered there too
    let volcano: [number, number] | null = null;
    for (let x = 60; x <= 100 && !volcano; x += 5) {
      for (let y = 60; y <= 100 && !volcano; y += 5) {
        if (getZone(x, y) === 'volcano') volcano = [x, y];
      }
    }
    if (volcano) pts.push(volcano);
    for (const [x, y] of pts) {
      const zone = getZone(x, y);
      assert.equal(visionRangeAt(x, y), zone === 'meadow' ? 14 : 12, `at ${x},${y} (${zone})`);
    }
  });
});

describe('canDetect (acquisition: cone + LoS + moving-or-close)', () => {
  const cone = { nx: 0, ny: 0, facing: 0 };
  it('moving target in the cone is seen', () => {
    assert.equal(canDetect({ ...cone, tx: 10, ty: 0, targetSpeed: 3 }), true);
  });
  it('still target beyond 4u is unseen (sneak works)', () => {
    assert.equal(canDetect({ ...cone, tx: 10, ty: 0, targetSpeed: 0 }), false);
    assert.equal(canDetect({ ...cone, tx: SNEAK_STILL_DIST + 0.1, ty: 0, targetSpeed: 0 }), false);
    // first sighting defaults to still when no speed is supplied
    assert.equal(canDetect({ ...cone, tx: 10, ty: 0 }), false);
  });
  it('still target at/inside 4u is seen anyway', () => {
    assert.equal(canDetect({ ...cone, tx: SNEAK_STILL_DIST, ty: 0, targetSpeed: 0 }), true);
    assert.equal(canDetect({ ...cone, tx: 2, ty: 0, targetSpeed: 0 }), true);
  });
  it('cone still applies to moving targets (no eyes in the back of the head)', () => {
    assert.equal(canDetect({ ...cone, tx: -8, ty: 0, targetSpeed: 8 }), false);
  });
  it('wall rects block sight even for sprinting targets', () => {
    const walls = [{ x: 4, y: -5, w: 1, h: 10 }];
    assert.equal(canDetect({ ...cone, tx: 10, ty: 0, targetSpeed: 5, walls }), false);
    assert.equal(canDetect({ ...cone, tx: 2, ty: 0, targetSpeed: 5, walls }), true);
  });
  it('wall tiles block sight (grid leg)', () => {
    const grid: number[][] = Array.from({ length: 20 }, () => new Array(20).fill(0));
    grid[3]![10] = 1; // wall tile on the (0,0)->(12,4) ray, off the (0,0)->(10,8) ray
    assert.equal(canDetect({ ...cone, tx: 12, ty: 4, targetSpeed: 5, grid, cell: 1 }), false);
    assert.equal(canDetect({ ...cone, tx: 10, ty: 8, targetSpeed: 5, grid, cell: 1 }), true);
  });
  it('speed threshold: below eps reads as still', () => {
    assert.equal(canDetect({ ...cone, tx: 10, ty: 0, targetSpeed: MOVE_SPEED_EPS - 0.01 }), false);
    assert.equal(canDetect({ ...cone, tx: 10, ty: 0, targetSpeed: MOVE_SPEED_EPS }), true);
  });
});

describe('canTrack (ALERT: no movement leg)', () => {
  it('a frozen target in the open stays tracked', () => {
    assert.equal(canTrack({ nx: 0, ny: 0, facing: 0, tx: 10, ty: 0, targetSpeed: 0 }), true);
  });
  it('cone and LoS still gate tracking', () => {
    assert.equal(canTrack({ nx: 0, ny: 0, facing: 0, tx: -10, ty: 0, targetSpeed: 0 }), false);
    assert.equal(
      canTrack({ nx: 0, ny: 0, facing: 0, tx: 10, ty: 0, targetSpeed: 0, walls: [{ x: 4, y: -5, w: 1, h: 10 }] }),
      false,
    );
  });
});

describe('noise radius', () => {
  it('is 18u', () => {
    assert.equal(NOISE_RADIUS, 18);
  });
});
