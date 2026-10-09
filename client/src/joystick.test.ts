import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blendMove, normalize } from './joystick.js';

describe('joystick normalize', () => {
  it('scales by the base radius', () => {
    assert.deepEqual(normalize(0, 0, 50), { x: 0, y: 0 });
    assert.deepEqual(normalize(25, 0, 50), { x: 0.5, y: 0 });
    assert.deepEqual(normalize(0, -25, 50), { x: 0, y: -0.5 });
  });

  it('applies a 15% dead zone', () => {
    assert.deepEqual(normalize(7, 0, 50), { x: 0, y: 0 });     // 0.14 -> neutral
    assert.deepEqual(normalize(7.5, 0, 50).x > 0, true);      // 0.15 -> live
  });

  it('clamps to the unit disc on diagonals', () => {
    const v = normalize(100, 100, 50);
    const len = Math.hypot(v.x, v.y);
    assert.ok(Math.abs(len - 1) < 1e-9, `len=${len}`);
    assert.ok(Math.abs(v.x - v.y) < 1e-9, 'diagonal stays symmetric');
  });

  it('is neutral for a zero/invalid base radius', () => {
    assert.deepEqual(normalize(10, 10, 0), { x: 0, y: 0 });
    assert.deepEqual(normalize(10, 10, NaN), { x: 0, y: 0 });
    assert.deepEqual(normalize(NaN, 0, 50), { x: 0, y: 0 });
  });
});

describe('blendMove', () => {
  it('passes through keyboard-only input', () => {
    assert.deepEqual(blendMove(1, 0, 0, 0), { x: 1, y: 0 });
    assert.deepEqual(blendMove(0, 1, 0, 0), { x: 0, y: 1 });
  });

  it('passes through stick-only input', () => {
    assert.deepEqual(blendMove(0, 0, 0.5, -0.25), { x: 0.5, y: -0.25 });
  });

  it('renormalizes keyboard + stick past the unit disc', () => {
    const v = blendMove(1, 1, 1, 0);
    const len = Math.hypot(v.x, v.y);
    assert.ok(Math.abs(len - 1) < 1e-9, `len=${len}`);
  });

  it('sums keyboard + analog input while inside the unit disc', () => {
    assert.deepEqual(blendMove(0.5, 0, 0.25, 0), { x: 0.75, y: 0 });
    assert.deepEqual(blendMove(0, -0.5, 0, 0.25), { x: 0, y: -0.25 });
  });

  it('renormalizes when keyboard + stick push past the unit disc', () => {
    const v = blendMove(1, 0, 0.25, 0);
    assert.equal(v.x, 1);
    assert.equal(v.y, 0);
  });

  it('rejects non-finite input', () => {
    assert.deepEqual(blendMove(NaN, 0, 0, 0), { x: 0, y: 0 });
  });
});