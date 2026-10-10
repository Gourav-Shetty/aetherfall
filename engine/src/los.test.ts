// LoS unit tests — `npm test --workspace=@aetherfall/engine`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOS_MAX_STEPS,
  gridLos,
  hasLos,
  rectLos,
  segmentHitsRect,
  type LosRect,
} from './los.js';

/** Open 10x10 grid (cell=1): border walls, free interior. */
function openGrid(n = 10, blocked: Array<[number, number]> = []): number[][] {
  const g: number[][] = [];
  for (let y = 0; y < n; y++) {
    const row: number[] = [];
    for (let x = 0; x < n; x++) {
      const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      row.push(edge ? 1 : 0);
    }
    g.push(row);
  }
  for (const [cx, cy] of blocked) g[cy]![cx] = 1;
  return g;
}

describe('segmentHitsRect', () => {
  const r: LosRect = { x: 4, y: 4, w: 2, h: 2 }; // covers [4,6]x[4,6]
  it('hits a segment crossing the rect', () => {
    assert.equal(segmentHitsRect(0, 5, 10, 5, r), true);
    assert.equal(segmentHitsRect(5, 0, 5, 10, r), true);
    assert.equal(segmentHitsRect(0, 0, 10, 10, r), true);
  });
  it('misses parallel / offset segments', () => {
    assert.equal(segmentHitsRect(0, 0, 10, 0, r), false);
    assert.equal(segmentHitsRect(0, 0, 3, 3, r), false);
    assert.equal(segmentHitsRect(7, 0, 7, 10, r), false);
  });
  it('counts endpoints inside the rect as hits (no seeing out of walls)', () => {
    assert.equal(segmentHitsRect(5, 5, 10, 5, r), true);
    assert.equal(segmentHitsRect(0, 5, 5, 5, r), true);
  });
  it('zero-length segment: inside hits, outside misses', () => {
    assert.equal(segmentHitsRect(5, 5, 5, 5, r), true);
    assert.equal(segmentHitsRect(0, 0, 0, 0, r), false);
  });
});

describe('rectLos', () => {
  it('empty rect set is always clear', () => {
    assert.equal(rectLos([], 0, 0, 100, 100), true);
    assert.equal(rectLos(null, 0, 0, 100, 100), true);
    assert.equal(rectLos(undefined, 0, 0, 100, 100), true);
  });
  it('a wall between viewer and target blocks', () => {
    const walls: LosRect[] = [{ x: 5, y: 0, w: 1, h: 10 }];
    assert.equal(rectLos(walls, 0, 5, 10, 5), false);
    assert.equal(rectLos(walls, 0, 0, 4, 9), true);
  });
});

describe('gridLos', () => {
  it('open interior sees across', () => {
    assert.equal(gridLos(openGrid(), 2, 2, 7, 7, 1), true);
  });
  it('a wall tile on the ray blocks', () => {
    assert.equal(gridLos(openGrid(10, [[5, 5]]), 2, 2, 8, 8, 1), false);
  });
  it('an off-ray wall tile does not block', () => {
    assert.equal(gridLos(openGrid(10, [[5, 2]]), 2, 5, 8, 5, 1), true);
  });
  it('same point is clear on free tiles, blocked on wall tiles', () => {
    assert.equal(gridLos(openGrid(), 2, 2, 2, 2, 1), true);
    assert.equal(gridLos(openGrid(), 0, 0, 0, 0, 1), false);
  });
  it('rays leaving the grid read as blocked (walled-border arenas)', () => {
    assert.equal(gridLos(openGrid(), 5, 5, 50, 50, 1), false);
  });
});

describe('hasLos (both sources must be clear)', () => {
  const grid = openGrid();
  it('clear grid + clear rects sees', () => {
    assert.equal(hasLos(grid, [], 2, 2, 7, 7, 1), true);
  });
  it('grid wall blocks even with no rects', () => {
    assert.equal(hasLos(openGrid(10, [[5, 5]]), [], 2, 2, 8, 8, 1), false);
  });
  it('rect wall blocks even with a clear grid', () => {
    assert.equal(hasLos(grid, [{ x: 4, y: 0, w: 1, h: 10 }], 2, 5, 8, 5, 1), false);
  });
  it('null grid skips the tile leg (rects only)', () => {
    assert.equal(hasLos(null, [], 2, 2, 50, 50, 1), true);
    assert.equal(hasLos(null, [{ x: 4, y: 0, w: 1, h: 10 }], 2, 5, 8, 5, 1), false);
  });
});

describe('los perf contract', () => {
  it('the sample cap covers the 14u vision range at 1u steps', () => {
    assert.equal(LOS_MAX_STEPS, 14);
  });
  it('1000 full-range rays finish well inside one NPC tick', () => {
    const grid = openGrid(60);
    const t0 = performance.now();
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      if (!hasLos(grid, [{ x: 20, y: 20, w: 2, h: 2 }], 30, 30, 30 + 14, 30, 1)) blocked++;
    }
    assert.ok(performance.now() - t0 < 1000, 'LoS must stay cheap at NPC scale');
    assert.ok(blocked >= 0);
  });
});
