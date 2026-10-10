// @aetherfall/gameplay — thrown sidearms: geometry, weapon lookup and pickup
// radius. A fighter with a weapon in inventory may THROW it: THROW_RANGE
// reach, melee-curve damage plus a THROW_STUN_MS stun, and the weapon lands as
// a world pickup at the throw's landing point (hit or miss). Throwing spends
// the weapon — walking over to pick it back up is part of the cost. Unarmed
// fighters pick things up at UNARMED_PICKUP_RANGE (shorter than the armed
// default), wired through the existing inventory tryPickup radius.
//
// Pure helpers only; the GameState wrapper lives in game/index.ts so this
// module never imports it (no game/ai import cycle).

import { weaponDef } from '../content.js';
import type { Inventory } from '../inventory.js';

import { ARMED_PICKUP_RANGE, THROW_RANGE, UNARMED_PICKUP_RANGE } from '../../systems/combat_ext.js';

/** First weapon stack in the inventory, if any (slot order wins). */
export function firstWeapon(inv: Inventory): { slot: number; itemId: string; count: number } | null {
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.slots[i];
    if (s && s.count > 0 && weaponDef(s.itemId)) return { slot: i, itemId: s.itemId, count: s.count };
  }
  return null;
}

/** True when the inventory holds any throwable weapon. */
export function hasWeapon(inv: Inventory): boolean {
  return firstWeapon(inv) !== null;
}

/**
 * Pickup radius for a fighter: full reach while armed, short reach while
 * unarmed. Callers pass the result straight into inventory.tryPickup.
 */
export function pickupRadiusFor(inv: Inventory): number {
  return hasWeapon(inv) ? ARMED_PICKUP_RANGE : UNARMED_PICKUP_RANGE;
}

/**
 * Landing point of a throw from `from` along `(dx, dy)`, clamped to
 * THROW_RANGE. A zero/NaN direction falls back to +X so the weapon always
 * lands somewhere deterministic (never on the thrower's own tile centre).
 */
export function landingPos(
  from: { x: number; y: number },
  dx: number,
  dy: number,
  range: number = THROW_RANGE,
): { x: number; y: number } {
  const r = range >= 0 && Number.isFinite(range) ? range : THROW_RANGE;
  let nx = dx;
  let ny = dy;
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    nx = 1;
    ny = 0;
  }
  const len = Math.hypot(nx, ny);
  if (!(len > 0)) {
    nx = 1;
    ny = 0;
  } else {
    nx /= len;
    ny /= len;
  }
  return { x: from.x + nx * r, y: from.y + ny * r };
}

/**
 * Is `target` throwable from `from`? Plain range check against THROW_RANGE
 * (walls are the caller's problem, same as melee reach).
 */
export function inThrowRange(
  from: { x: number; y: number },
  target: { x: number; y: number },
  range: number = THROW_RANGE,
): boolean {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  return dx * dx + dy * dy <= range * range;
}
