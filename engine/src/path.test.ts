import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { astar, octile, BinaryHeap, hasLineOfSight, smoothPath } from './path.js';

function openGrid(w: number, h: number): number[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => 0));
}

function pathLength(p: Array<[number, number]>): number {
  let d = 0;
  for (let i = 1; i < p.length; i++) {
    d += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  }
  return d;
}

describe('astar basics', () => {
  it('same start/target returns single cell', () => {
    assert.deepEqual(astar(openGrid(5, 5), 2, 2, 2, 2), [[2, 2]]);
  });

  it('finds a path on open ground with diagonal shortcut', () => {
    const p = astar(openGrid(10, 10), 0, 0, 3, 3);
    assert.ok(p.length > 0);
    assert.deepEqual(p[0], [0, 0]);
    assert.deepEqual(p[p.length - 1], [3, 3]);
    // Smoothed diagonal on open ground collapses to endpoints.
    assert.deepEqual(p, [
      [0, 0],
      [3, 3],
    ]);
  });

  it('4-dir mode matches Manhattan length', () => {
    const p = astar(openGrid(10, 10), 0, 0, 3, 3, { diagonal: false, smooth: false });
    assert.equal(p.length, 7); // 6 steps + start
    assert.equal(pathLength(p), 6);
  });

  it('routes around a wall through the gap', () => {
    const g = openGrid(7, 7);
    for (let y = 0; y < 6; y++) g[y][3] = 1; // vertical wall with gap at y=6
    const p = astar(g, 0, 0, 6, 0, { smooth: false });
    assert.ok(p.length > 0);
    assert.ok(p.some(([x, y]) => y === 6), 'path must use the gap row');
    for (const [x, y] of p) assert.notEqual(g[y][x], 1);
  });

  it('returns [] when unreachable or endpoints blocked', () => {
    const g = openGrid(5, 5);
    for (let x = 0; x < 5; x++) g[2][x] = 1; // full wall
    assert.deepEqual(astar(g, 0, 0, 4, 4), []);
    const g2 = openGrid(5, 5);
    g2[0][0] = 1;
    assert.deepEqual(astar(g2, 0, 0, 4, 4), []);
    g2[0][0] = 0;
    g2[4][4] = 1;
    assert.deepEqual(astar(g2, 0, 0, 4, 4), []);
    assert.deepEqual(astar([], 0, 0, 1, 1), []);
  });

  it('never cuts corners', () => {
    // Diagonal (0,0)->(1,1) blocked by walls at (1,0) and (0,1).
    const g = openGrid(3, 3);
    g[0][1] = 1;
    g[1][0] = 1;
    const p = astar(g, 0, 0, 2, 2, { smooth: false });
    // Start is boxed in diagonally; A* must not step through the corner.
    for (let i = 1; i < p.length; i++) {
      const dx = Math.abs(p[i][0] - p[i - 1][0]);
      const dy = Math.abs(p[i][1] - p[i - 1][1]);
      if (dx === 1 && dy === 1) {
        const [px, py] = p[i - 1];
        assert.equal(g[py][px + (p[i][0] - px)], 0);
        assert.equal(g[py + (p[i][1] - py)][px], 0);
      }
    }
  });

  it('diagonal path is shorter than 4-dir path', () => {
    const g = openGrid(20, 20);
    const d = pathLength(astar(g, 0, 0, 9, 9, { smooth: false }));
    const m = pathLength(astar(g, 0, 0, 9, 9, { diagonal: false, smooth: false }));
    assert.ok(d < m, `diag ${d} should beat manhattan ${m}`);
    assert.ok(Math.abs(d - 9 * Math.SQRT2) < 1e-9);
  });

  it('smoothing shortens without entering walls', () => {
    const g = openGrid(10, 10);
    g[4][4] = 1;
    g[4][5] = 1;
    g[5][4] = 1;
    const raw = astar(g, 0, 0, 9, 9, { smooth: false });
    const sm = smoothPath(g, raw);
    assert.ok(sm.length <= raw.length);
    for (let i = 1; i < sm.length; i++) {
      assert.ok(hasLineOfSight(g, sm[i - 1][0], sm[i - 1][1], sm[i][0], sm[i][1]));
    }
  });

  it('large grid solves quickly', () => {
    const g = openGrid(100, 100);
    for (let x = 10; x < 90; x++) {
      if (x !== 50) g[50][x] = 1;
    }
    const t0 = performance.now();
    const p = astar(g, 0, 0, 99, 99);
    const ms = performance.now() - t0;
    console.log(`astar perf: 100x100=${ms.toFixed(1)}ms waypoints=${p.length}`);
    assert.ok(p.length > 0);
    assert.ok(ms < 2000, `astar too slow: ${ms}ms`);
  });
});

describe('astar helpers', () => {
  it('octile matches known values', () => {
    assert.equal(octile(0, 0, 3, 0), 3);
    assert.ok(Math.abs(octile(0, 0, 1, 1) - Math.SQRT2) < 1e-9);
    assert.equal(octile(5, 5, 5, 5), 0);
  });

  it('binary heap pops in ascending order', () => {
    const h = new BinaryHeap<string>();
    assert.equal(h.isEmpty(), true);
    h.push(3, 'c');
    h.push(1, 'a');
    h.push(2, 'b');
    assert.equal(h.size, 3);
    assert.equal(h.pop(), 'a');
    assert.equal(h.pop(), 'b');
    assert.equal(h.pop(), 'c');
    assert.equal(h.pop(), undefined);
  });
});
