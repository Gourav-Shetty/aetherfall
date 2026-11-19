// @aetherfall/shared — combat_specs: per-weapon reach, timing, hitstop, hitsparks and cancel window.
// Pure functions and typed profiles derived from the catalog. Protocol-safe.

export type Vec2 = { x: number; y: number };

export const HITSTOP_DEFAULT_MS = 100;
export const DASH_IFRAME_MS = 200;
export const SDI_NUDGE_DIST = 0.2;

export interface WeaponCombatProfile {
  id: string;
  name: string;
  reach: number;       // units
  arcDeg: number;      // degrees
  arcRad: number;      // radians
  windupMs: number;    // ms before active hit
  recoveryMs: number;  // ms after active hit before recovery ends
  cooldownMs: number;  // total cadence in ms (windup + recovery)
  damageBonus: number; // bonus attack stat
  hitstopMs: number;   // hitstop duration on connect (ms)
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export const WEAPON_PROFILES: Readonly<Record<string, WeaponCombatProfile>> = {
  unarmed: {
    id: 'unarmed',
    name: 'Unarmed (Fists)',
    reach: 1.4,
    arcDeg: 60,
    arcRad: degToRad(60),
    windupMs: 80,
    recoveryMs: 280,
    cooldownMs: 360,
    damageBonus: 0,
    hitstopMs: 90,
  },
  'wisp-touched-dagger': {
    id: 'wisp-touched-dagger',
    name: 'Wisp-Touched Dagger',
    reach: 1.6,
    arcDeg: 120,
    arcRad: degToRad(120),
    windupMs: 110,
    recoveryMs: 370,
    cooldownMs: 480,
    damageBonus: 4,
    hitstopMs: 90,
  },
  'ward-blade': {
    id: 'ward-blade',
    name: 'Ward Blade',
    reach: 2.2,
    arcDeg: 90,
    arcRad: degToRad(90),
    windupMs: 160,
    recoveryMs: 490,
    cooldownMs: 650,
    damageBonus: 6,
    hitstopMs: 100,
  },
  'ember-axe': {
    id: 'ember-axe',
    name: 'Ember Axe',
    reach: 2.0,
    arcDeg: 100,
    arcRad: degToRad(100),
    windupMs: 250,
    recoveryMs: 550,
    cooldownMs: 800,
    damageBonus: 8,
    hitstopMs: 110,
  },
  'deep-halberd': {
    id: 'deep-halberd',
    name: 'Deep Halberd',
    reach: 3.2,
    arcDeg: 45,
    arcRad: degToRad(45),
    windupMs: 320,
    recoveryMs: 630,
    cooldownMs: 950,
    damageBonus: 10,
    hitstopMs: 120,
  },
  'caldera-greatsword': {
    id: 'caldera-greatsword',
    name: 'Caldera Greatsword',
    reach: 2.8,
    arcDeg: 150,
    arcRad: degToRad(150),
    windupMs: 420,
    recoveryMs: 730,
    cooldownMs: 1150,
    damageBonus: 12,
    hitstopMs: 130,
  },
};

/** Get the combat profile for a weapon id; falls back to unarmed. */
export function getWeaponProfile(weaponId?: string | null): WeaponCombatProfile {
  if (!weaponId) return WEAPON_PROFILES['unarmed']!;
  return WEAPON_PROFILES[weaponId] ?? WEAPON_PROFILES['unarmed']!;
}

export interface ContactPoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
  dist: number;
}

/**
 * True point of contact between attacker and target.
 * Computes the exact surface contact on the target's bounding circle facing the attacker.
 */
export function computeContactPoint(
  attackerPos: { x: number; y: number },
  targetPos: { x: number; y: number },
  targetRadius = 0.4,
): ContactPoint {
  const dx = targetPos.x - attackerPos.x;
  const dy = targetPos.y - attackerPos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-4) {
    return { x: targetPos.x, y: targetPos.y, nx: 1, ny: 0, dist: 0 };
  }
  const ux = dx / dist;
  const uy = dy / dist;
  // Contact point sits on the target boundary towards the attacker
  const contactDist = Math.max(0, dist - targetRadius);
  return {
    x: attackerPos.x + ux * contactDist,
    y: attackerPos.y + uy * contactDist,
    nx: -ux,
    ny: -uy,
    dist,
  };
}

/** Check if target is within weapon reach. */
export function inWeaponRange(
  attackerPos: { x: number; y: number },
  targetPos: { x: number; y: number },
  weapon: WeaponCombatProfile,
): boolean {
  const dx = targetPos.x - attackerPos.x;
  const dy = targetPos.y - attackerPos.y;
  return dx * dx + dy * dy <= weapon.reach * weapon.reach + 1e-6;
}

/**
 * Check if target is within both reach distance and directional arc cone.
 * If facingDir is zero length, checks range only.
 */
export function inWeaponCone(
  origin: { x: number; y: number },
  facingDir: { x: number; y: number },
  targetPos: { x: number; y: number },
  weapon: WeaponCombatProfile,
): boolean {
  const dx = targetPos.x - origin.x;
  const dy = targetPos.y - origin.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > weapon.reach * weapon.reach + 1e-6) return false;

  const fMag = Math.hypot(facingDir.x, facingDir.y);
  const tMag = Math.sqrt(d2);
  if (fMag < 1e-4 || tMag < 1e-4) return true;

  // Dot product to test angle
  const dot = (facingDir.x * dx + facingDir.y * dy) / (fMag * tMag);
  const clampedDot = Math.max(-1, Math.min(1, dot));
  const angle = Math.acos(clampedDot);
  return angle <= weapon.arcRad / 2 + 1e-4;
}

/**
 * Cancel buffer for Street Fighter II style input queuing during hitstop.
 * When hitstop is active, inputs are buffered and resolve instantly when the freeze ends.
 */
export class HitstopCancelBuffer<T = string> {
  private buffered: { action: T; at: number } | null = null;
  private maxTtlMs = 300;

  constructor(maxTtlMs = 300) {
    this.maxTtlMs = maxTtlMs;
  }

  /** Queue an action during hitstop freeze. */
  queue(action: T, nowMs: number): void {
    this.buffered = { action, at: nowMs };
  }

  /**
   * Consume buffered action when hitstop has ended.
   * Returns null if still hitstopped, buffer is empty, or input has timed out.
   */
  consume(isHitStopped: boolean, nowMs: number): T | null {
    if (isHitStopped || !this.buffered) return null;
    if (nowMs - this.buffered.at > this.maxTtlMs) {
      this.buffered = null;
      return null;
    }
    const act = this.buffered.action;
    this.buffered = null;
    return act;
  }

  peek(): T | null {
    return this.buffered ? this.buffered.action : null;
  }

  hasQueued(): boolean {
    return this.buffered !== null;
  }

  clear(): void {
    this.buffered = null;
  }
}
