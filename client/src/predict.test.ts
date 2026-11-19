import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Predictor } from './predict.js';
import { MAX_SPEED, stepBodyPhysics, type BodyPhysicsState } from '@aetherfall/shared';

describe('Predictor (Venturelli model parity)', () => {
  it('smoothly accelerates over time instead of instant full speed', () => {
    const pr = new Predictor();
    pr.reset(10, 10);
    // At dt = 0.05s (1 tick), velocity ramps up smoothly (net accel ~100.8 u/s^2 -> ~5.04 u/s)
    pr.applyInput(1, 1, 0, 0.05);
    assert.ok(pr.vel.x > 0 && pr.vel.x < MAX_SPEED, `vel.x=${pr.vel.x} (expected smooth ramp-up)`);
    assert.ok(pr.pos.x > 10, 'position moved forward');
    assert.equal(pr.pos.y, 10);
  });

  it('stop distance is not zero when input ceases', () => {
    const pr = new Predictor();
    pr.reset(10, 10);
    // Run for 150ms to reach full speed
    pr.applyInput(1, 1, 0, 0.15);
    assert.ok(Math.abs(pr.vel.x - MAX_SPEED) < 1e-6, 'reached max speed');
    const posAtRelease = pr.pos.x;
    // Release input (moveX = 0, moveY = 0)
    for (let i = 0; i < 10; i++) {
      pr.applyInput(2 + i, 0, 0, 0.05);
    }
    const stopDistance = pr.pos.x - posAtRelease;
    assert.ok(stopDistance > 0.5 && stopDistance < 0.85, `stopDistance=${stopDistance}`);
    assert.equal(pr.vel.x, 0, 'stopped completely');
  });

  it('normalizes diagonal sticks to unit circle budget', () => {
    const pr = new Predictor();
    pr.reset(0, 0);
    // Overlong stick (1, 1) length √2 should normalize
    pr.applyInput(1, 1, 1, 0.15);
    const speed = Math.hypot(pr.vel.x, pr.vel.y);
    assert.ok(speed <= MAX_SPEED + 1e-6, `speed=${speed}`);
  });

  it('reconcile drops acked inputs and re-simulates unacked inputs from server state', () => {
    const pr = new Predictor();
    pr.reset(0, 0);
    pr.applyInput(1, 1, 0, 0.05);
    pr.applyInput(2, 1, 0, 0.05);
    const serverX = 0.126; // hypothetical server pos at seq 1
    const serverVx = 5.04; // server vel at seq 1
    pr.reconcile(serverX, 0, 1, serverVx, 0);
    assert.equal(pr.pending.size, 1);
    assert.ok(pr.pos.x > serverX);
    pr.reconcile(pr.pos.x, 0, 2, pr.vel.x, 0);
    assert.equal(pr.pending.size, 0);
  });

  it('client and server agree on position after a stop-and-go sequence', () => {
    const pr = new Predictor();
    pr.reset(0, 0);

    const serverBody: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
    const dt = 0.05; // 20Hz

    // 10 steps moving (+X), 10 steps stopped, 10 steps moving (+Y), 10 steps stopped
    let seq = 0;
    for (let phase = 0; phase < 4; phase++) {
      const mx = phase === 0 ? 1 : 0;
      const my = phase === 2 ? 1 : 0;
      for (let step = 0; step < 10; step++) {
        seq++;
        // Client prediction
        pr.applyInput(seq, mx, my, dt);
        // Server simulation
        stepBodyPhysics(serverBody, { moveX: mx, moveY: my }, dt, { boundsW: 100, boundsH: 100 });
      }
      // Reconcile at end of each phase
      pr.reconcile(serverBody.x, serverBody.y, seq, serverBody.vx, serverBody.vy);
      assert.ok(Math.abs(pr.pos.x - serverBody.x) < 1e-6, `phase ${phase} X agreement`);
      assert.ok(Math.abs(pr.pos.y - serverBody.y) < 1e-6, `phase ${phase} Y agreement`);
      assert.ok(Math.abs(pr.vel.x - serverBody.vx) < 1e-6, `phase ${phase} Vx agreement`);
      assert.ok(Math.abs(pr.vel.y - serverBody.vy) < 1e-6, `phase ${phase} Vy agreement`);
    }
  });

  it('clamps to the 100x100 arena', () => {
    const pr = new Predictor();
    pr.reset(99, 99);
    pr.applyInput(1, 1, 1, 10);
    assert.ok(pr.pos.x <= 100 && pr.pos.y <= 100);
  });

  it('freezes simulation during hitstop and allows SDI nudge on directional input', () => {
    const pr = new Predictor();
    pr.reset(50, 50);
    const t0 = 1000;
    pr.applyHitstop(100, t0);
    assert.equal(pr.isHitStopped(t0 + 50), true);

    // No input during hitstop: position holds still
    pr.applyInput(1, 0, 0, 0.05, t0 + 20);
    assert.equal(pr.pos.x, 50);
    assert.equal(pr.pos.y, 50);

    // Directional input during hitstop: SDI nudge applies (0.2u)
    pr.applyInput(2, 1, 0, 0.05, t0 + 40);
    assert.ok(Math.abs(pr.pos.x - 50.2) < 1e-6, `SDI nudged pos.x to ${pr.pos.x}`);
    assert.equal(pr.pos.y, 50);

    // After hitstop ends: normal physics resumes
    assert.equal(pr.isHitStopped(t0 + 101), false);
    pr.applyInput(3, 1, 0, 0.05, t0 + 101);
    assert.ok(pr.vel.x > 0, 'normal acceleration resumed');
  });

  it('dash grants invulnerability frames (i-frames)', () => {
    const pr = new Predictor();
    pr.reset(10, 10);
    const t0 = 2000;
    pr.applyDash(1, 0, 14, t0);
    assert.equal(pr.isInvulnerable(t0 + 50), true);
    assert.equal(pr.isInvulnerable(t0 + 199), true);
    assert.equal(pr.isInvulnerable(t0 + 201), false, 'i-frames expire after 200ms');
  });

  it('cancel buffer queues actions during hitstop and resolves upon freeze completion', () => {
    const pr = new Predictor();
    pr.reset(10, 10);
    const t0 = 3000;
    pr.applyHitstop(100, t0);

    pr.queueCancel('attack', t0 + 30);
    // While still in hitstop, pollCancel yields null
    assert.equal(pr.pollCancel(t0 + 50), null);

    // When hitstop lapses, pollCancel resolves the buffered action
    assert.equal(pr.pollCancel(t0 + 105), 'attack');
    // Buffer is now cleared
    assert.equal(pr.pollCancel(t0 + 110), null);
  });
});

