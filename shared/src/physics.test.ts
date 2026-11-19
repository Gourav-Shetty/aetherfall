import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND_ACCEL,
  GROUND_FRICTION,
  MAX_SPEED,
  JUMP_IMPULSE,
  KNOCKBACK_IMPULSE,
  HIT_RECOIL_IMPULSE,
  stepBodyPhysics,
  applyImpulse,
  applyCombatKnockback,
  type BodyPhysicsState,
} from './physics.js';

describe('Venturelli movement & physics foundation', () => {
  it('friction is tuned to approximately 28% of ground accel', () => {
    const ratio = GROUND_FRICTION / GROUND_ACCEL;
    assert.ok(Math.abs(ratio - 0.28) < 0.005, `ratio=${ratio}`);
  });

  it('ground accel reaches full speed (8 u/s) from rest in ~80ms', () => {
    const body: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
    const dt = 0.001; // 1ms precision
    let t = 0;
    while (body.vx < MAX_SPEED * 0.99 && t < 0.2) {
      stepBodyPhysics(body, { moveX: 1, moveY: 0 }, dt);
      t += dt;
    }
    const ms = t * 1000;
    // Expected: ~79.4ms ≈ 80ms
    assert.ok(ms >= 75 && ms <= 85, `time to full speed was ${ms.toFixed(1)}ms (expected ~80ms)`);
  });

  it('produces a smooth acceleration curve without spikes or discrete jumps', () => {
    const body: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
    const dt = 0.005;
    let prevVx = 0;
    for (let i = 0; i < 20; i++) {
      stepBodyPhysics(body, { moveX: 1, moveY: 0 }, dt);
      assert.ok(body.vx >= prevVx, 'velocity is monotonically increasing');
      // Accel per step should be consistent with net accel
      if (body.vx < MAX_SPEED) {
        const stepAccel = (body.vx - prevVx) / dt;
        assert.ok(stepAccel > 90 && stepAccel < 110, `step accel=${stepAccel}`);
      }
      prevVx = body.vx;
    }
  });

  it('stop distance is not zero and decelerates with friction to a clean rest', () => {
    const body: BodyPhysicsState = { x: 0, y: 0, vx: MAX_SPEED, vy: 0 };
    const dt = 0.005;
    const startX = body.x;
    let t = 0;
    while (Math.hypot(body.vx, body.vy) > 0 && t < 1.0) {
      stepBodyPhysics(body, { moveX: 0, moveY: 0 }, dt);
      t += dt;
    }
    const stopDistance = body.x - startX;
    // Theoretical stop distance: 8^2 / (2 * 39.2) = 64 / 78.4 ≈ 0.8163 units
    assert.ok(stopDistance > 0.75 && stopDistance < 0.85, `stop distance=${stopDistance.toFixed(3)}u`);
    assert.equal(body.vx, 0, 'velocity came to complete rest');
  });

  it('is frame-rate independent: integrates identically across dt=16ms vs dt=50ms', () => {
    const run = (dt: number, totalTime: number) => {
      const b: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
      const steps = Math.round(totalTime / dt);
      for (let i = 0; i < steps; i++) {
        // Move for 100ms, then stop for 300ms
        const move = i * dt < 0.1 ? 1 : 0;
        stepBodyPhysics(b, { moveX: move, moveY: 0 }, dt);
      }
      return b;
    };
    const at60hz = run(1 / 60, 0.4);
    const at20hz = run(1 / 20, 0.4);
    assert.ok(Math.abs(at60hz.x - at20hz.x) < 0.05, `diff=${Math.abs(at60hz.x - at20hz.x)}`);
  });

  it('impact rule: instant acceleration for impulse immediately updates velocity', () => {
    const body: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
    applyImpulse(body, 10, 0);
    assert.equal(body.vx, 10, 'velocity instantly modified without ramp-up');
  });

  it('knockback impulse on hit taken yields ~1.8 units displacement', () => {
    const body: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
    applyImpulse(body, KNOCKBACK_IMPULSE, 0);
    const dt = 0.005;
    let t = 0;
    while (body.vx > 0 && t < 1.0) {
      stepBodyPhysics(body, { moveX: 0, moveY: 0 }, dt);
      t += dt;
    }
    // Theoretical: 11.88^2 / (2 * 39.2) = 1.800 units
    assert.ok(body.x > 1.70 && body.x < 1.90, `knockback distance=${body.x.toFixed(3)}u (expected ~1.8u)`);
  });

  it('combat knockback applies impulse to target and recoil to attacker', () => {
    const attacker: BodyPhysicsState = { x: 10, y: 10, vx: 0, vy: 0 };
    const target: BodyPhysicsState = { x: 12, y: 10, vx: 0, vy: 0 };

    const { targetImpulse, attackerRecoil } = applyCombatKnockback(target, attacker);
    assert.ok(targetImpulse.x > 0, 'target pushed away from attacker (+X)');
    assert.ok(attackerRecoil.x < 0, 'attacker receives recoil pushback (-X)');
    assert.equal(target.vx, KNOCKBACK_IMPULSE);
    assert.equal(attacker.vx, -HIT_RECOIL_IMPULSE);
  });

  it('jump has its own vertical gravity and air friction vectors', () => {
    const body: BodyPhysicsState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: JUMP_IMPULSE };
    const dt = 0.01;
    let peakZ = 0;
    let t = 0;
    while (t < 0.8) {
      stepBodyPhysics(body, { moveX: 0, moveY: 0 }, dt);
      if ((body.z ?? 0) > peakZ) peakZ = body.z ?? 0;
      t += dt;
    }
    assert.ok(peakZ > 0.6 && peakZ < 1.2, `jump peak=${peakZ.toFixed(2)}u`);
    assert.equal(body.z, 0, 'jump landed cleanly back at ground (z=0)');
    assert.equal(body.vz, 0, 'vertical velocity stopped on landing');
  });
});
