import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Predictor, PRED_SPEED } from './predict.js';

describe('Predictor', () => {
  it('integrates axis-aligned input at server speed', () => {
    const pr = new Predictor();
    pr.reset(10, 10);
    pr.applyInput(1, 1, 0, 0.05);
    assert.ok(Math.abs(pr.pos.x - (10 + PRED_SPEED * 0.05)) < 1e-9);
    assert.equal(pr.pos.y, 10);
  });

  it('normalizes diagonal sticks to the server budget (no 8√2 mispredict)', () => {
    const pr = new Predictor();
    pr.reset(0, 0);
    pr.applyInput(1, 1, 1, 1);
    const moved = Math.hypot(pr.pos.x, pr.pos.y);
    assert.ok(Math.abs(moved - PRED_SPEED) < 1e-9, `moved=${moved}`);
  });

  it('reconcile drops acked inputs and re-simulates the rest', () => {
    const pr = new Predictor();
    pr.reset(0, 0);
    pr.applyInput(1, 1, 0, 1); // +8x
    pr.applyInput(2, 1, 0, 1); // +8x
    pr.reconcile(8, 0, 1); // server saw seq 1 at x=8
    assert.ok(Math.abs(pr.pos.x - 16) < 1e-9, `x=${pr.pos.x}`);
    assert.equal(pr.pending.size, 1);
    pr.reconcile(16, 0, 2);
    assert.equal(pr.pending.size, 0);
  });

  it('clamps to the 100x100 arena', () => {
    const pr = new Predictor();
    pr.reset(99, 99);
    pr.applyInput(1, 1, 1, 10);
    assert.ok(pr.pos.x <= 100 && pr.pos.y <= 100);
  });
});
