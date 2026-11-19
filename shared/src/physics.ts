// @aetherfall/shared — Venturelli's movement & physics model.
//
// Pure, deterministic, frame-rate independent (time-based dt).
// Venturelli's model order:
//   1. accel -> velocity
//   2. friction -> velocity
//   3. clamp -> maxSpeed
//
// Impact rule: instant acceleration for dash / jump / knockback.
// Jump: vertical impulse + downward vertical accel (gravity) + vertical friction (drag).
// Combat: knockback impulse on hit taken and recoil impulse on hit dealt.

import type { Vec2 } from './index.js';

/** Authoritative maximum ground speed (units/sec). */
export const MAX_SPEED = 8;

/**
 * Ground acceleration (units/s^2).
 * Tuned so 0 -> full speed (8 u/s) is ~80ms.
 * Net accel = GROUND_ACCEL - GROUND_FRICTION = 140 - 39.2 = 100.8 units/s^2.
 * Time to 8 u/s = 8 / 100.8 = 0.079365s (~79.4ms ≈ 80ms).
 */
export const GROUND_ACCEL = 140;

/**
 * Ground friction (units/s^2).
 * Deceleration opposing motion.
 * Exactly 28% of GROUND_ACCEL (39.2 / 140 = 0.28).
 * Stop distance from 8 u/s = v^2 / (2 * friction) = 64 / 78.4 ≈ 0.816 units.
 * Stop time from 8 u/s = 8 / 39.2 ≈ 204ms.
 */
export const GROUND_FRICTION = 39.2;

/**
 * Jump mechanics: vertical impulse (units/s), gravity (units/s^2), and air drag (units/s^2).
 */
export const JUMP_IMPULSE = 6.0;
export const VERTICAL_GRAVITY = 20.0;
export const VERTICAL_FRICTION = 2.0;

/**
 * Instant impact impulses (the impact rule).
 * KNOCKBACK_IMPULSE: 11.88 u/s impulse on hit taken -> travels v^2 / (2 * 39.2) ≈ 1.8 units,
 * exactly matching the existing KNOCKBACK_UNITS = 1.8 in combat_ext.
 * HIT_RECOIL_IMPULSE: 3.0 u/s micro-recoil on hit dealt -> travels ~0.11 units for tactile punch.
 * DASH_IMPULSE: instant 14 u/s dash impulse.
 */
export const KNOCKBACK_IMPULSE = 11.88;
export const HIT_RECOIL_IMPULSE = 3.0;
export const DASH_IMPULSE = 14.0;

export interface BodyPhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z?: number;
  vz?: number;
  groundZ?: number;
}

export interface MovementInput {
  moveX: number;
  moveY: number;
}

export interface PhysicsStepOptions {
  maxSpeed?: number;
  accel?: number;
  friction?: number;
  boundsW?: number;
  boundsH?: number;
}

/**
 * Step body physics over dt seconds using Venturelli's model.
 * Frame-rate independent: time-based dt decouples physics from tick rate.
 */
export function stepBodyPhysics(
  body: BodyPhysicsState,
  input: MovementInput,
  dt: number,
  opts: PhysicsStepOptions = {},
): void {
  if (dt <= 0) return;
  const maxSpeed = opts.maxSpeed ?? MAX_SPEED;
  const accel = opts.accel ?? GROUND_ACCEL;
  const friction = opts.friction ?? GROUND_FRICTION;

  // 1. Accel -> velocity
  const cx = Math.max(-1, Math.min(1, input.moveX));
  const cy = Math.max(-1, Math.min(1, input.moveY));
  const inputMag = Math.hypot(cx, cy);

  if (inputMag > 0) {
    const dirX = inputMag > 1 ? cx / inputMag : cx;
    const dirY = inputMag > 1 ? cy / inputMag : cy;
    body.vx += dirX * accel * dt;
    body.vy += dirY * accel * dt;
  }

  // 2. Friction -> velocity
  const speed = Math.hypot(body.vx, body.vy);
  if (speed > 0) {
    const newSpeed = Math.max(0, speed - friction * dt);
    const scale = newSpeed / speed;
    body.vx *= scale;
    body.vy *= scale;
  }

  // 3. Clamp
  // Normal movement input clamps to maxSpeed. Impulses above maxSpeed are
  // bled off by friction until they drop back to maxSpeed.
  const currSpeed = Math.hypot(body.vx, body.vy);
  if (inputMag > 0 && currSpeed > maxSpeed) {
    body.vx = (body.vx / currSpeed) * maxSpeed;
    body.vy = (body.vy / currSpeed) * maxSpeed;
  }

  // Snap tiny velocities to 0 for determinism
  if (Math.abs(body.vx) < 1e-6) body.vx = 0;
  if (Math.abs(body.vy) < 1e-6) body.vy = 0;

  // 4. Vertical Jump & Gravity (if z/vz are tracked)
  if (body.vz !== undefined || body.z !== undefined) {
    let vz = body.vz ?? 0;
    const z = body.z ?? 0;
    const groundZ = body.groundZ ?? 0;

    // Downward vertical acceleration (gravity)
    vz -= VERTICAL_GRAVITY * dt;

    // Vertical air friction / drag
    if (Math.abs(vz) > 0) {
      const vDir = Math.sign(vz);
      const vMag = Math.max(0, Math.abs(vz) - VERTICAL_FRICTION * dt);
      vz = vDir * vMag;
    }

    let newZ = z + vz * dt;
    if (newZ <= groundZ) {
      newZ = groundZ;
      vz = 0;
    }
    body.z = newZ;
    body.vz = vz;
  }

  // 5. Position displacement
  body.x += body.vx * dt;
  body.y += body.vy * dt;

  // 6. Arena Bounds Clamp
  if (opts.boundsW !== undefined) {
    body.x = Math.max(0, Math.min(opts.boundsW, body.x));
  }
  if (opts.boundsH !== undefined) {
    body.y = Math.max(0, Math.min(opts.boundsH, body.y));
  }
}

/**
 * The impact rule: instant acceleration for dash / jump / knockback.
 * Directly applies an impulse vector without gradual ramp-up.
 */
export function applyImpulse(
  body: BodyPhysicsState,
  impulseX: number,
  impulseY: number,
  impulseZ?: number,
): void {
  body.vx += impulseX;
  body.vy += impulseY;
  if (impulseZ !== undefined) {
    body.vz = (body.vz ?? 0) + impulseZ;
  }
}

/**
 * Apply combat knockback:
 * - Hit taken on target: knockback impulse away from attacker.
 * - Hit dealt on attacker: recoil micro-impulse away from target.
 */
export function applyCombatKnockback(
  target: BodyPhysicsState,
  attacker: BodyPhysicsState,
  impulseMagnitude: number = KNOCKBACK_IMPULSE,
  recoilMagnitude: number = HIT_RECOIL_IMPULSE,
): { targetImpulse: Vec2; attackerRecoil: Vec2 } {
  let dx = target.x - attacker.x;
  let dy = target.y - attacker.y;
  let len = Math.hypot(dx, dy);
  if (len === 0 || !Number.isFinite(len)) {
    dx = 1;
    dy = 0;
    len = 1;
  }
  const nx = dx / len;
  const ny = dy / len;

  // Hit taken on target: knockback away from attacker
  const targetImpulse = { x: nx * impulseMagnitude, y: ny * impulseMagnitude };
  applyImpulse(target, targetImpulse.x, targetImpulse.y);

  // Hit dealt on attacker: recoil impulse in opposite direction
  const attackerRecoil = { x: -nx * recoilMagnitude, y: -ny * recoilMagnitude };
  applyImpulse(attacker, attackerRecoil.x, attackerRecoil.y);

  return { targetImpulse, attackerRecoil };
}
