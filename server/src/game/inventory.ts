// @aetherfall/gameplay — inventory: 20 slots, stackable items, pickup entities.
// `kind:'pickup'` matches shared EntitySnapshot kind union (protocol v1 safe).

export const MAX_SLOTS = 20;
export const MAX_STACK = 99;

export type ItemStack = { itemId: string; count: number };

export type Inventory = {
  slots: (ItemStack | null)[];
};

export function createInventory(): Inventory {
  return { slots: Array.from({ length: MAX_SLOTS }, () => null) };
}

function normId(id: string): string {
  return id.slice(0, 64);
}

function isValidStack(s: ItemStack): boolean {
  return s.count >= 1 && s.count <= MAX_STACK && s.itemId.length > 0;
}

/** Total count of an item across all slots. */
export function countOf(inv: Inventory, itemId: string): number {
  let n = 0;
  for (const s of inv.slots) if (s && s.itemId === itemId) n += s.count;
  return n;
}

/** Free space (in units) available for itemId given stacking. */
export function spaceFor(inv: Inventory, itemId: string): number {
  let n = 0;
  for (const s of inv.slots) {
    if (s === null) n += MAX_STACK;
    else if (s.itemId === itemId) n += MAX_STACK - s.count;
  }
  return n;
}

export function canFit(inv: Inventory, itemId: string, count: number): boolean {
  return count > 0 && spaceFor(inv, normId(itemId)) >= count;
}

/**
 * Add items, filling partial stacks first then empty slots.
 * Returns true and mutates on success; returns false with NO mutation if it does not fit.
 */
export function addItem(inv: Inventory, itemId: string, count: number): boolean {
  const id = normId(itemId);
  if (count <= 0 || id.length === 0) return false;
  if (!canFit(inv, id, count)) return false;
  let rest = count;
  for (const s of inv.slots) {
    if (rest <= 0) break;
    if (s && s.itemId === id && s.count < MAX_STACK) {
      const take = Math.min(rest, MAX_STACK - s.count);
      s.count += take;
      rest -= take;
    }
  }
  for (let i = 0; i < inv.slots.length && rest > 0; i++) {
    if (inv.slots[i] === null) {
      const take = Math.min(rest, MAX_STACK);
      inv.slots[i] = { itemId: id, count: take };
      rest -= take;
    }
  }
  return rest === 0;
}

/**
 * Remove count items. Returns true and mutates on success;
 * returns false with NO mutation if the player lacks enough.
 */
export function removeItem(inv: Inventory, itemId: string, count: number): boolean {
  const id = normId(itemId);
  if (count <= 0) return false;
  if (countOf(inv, id) < count) return false;
  let rest = count;
  for (let i = 0; i < inv.slots.length && rest > 0; i++) {
    const s = inv.slots[i];
    if (s && s.itemId === id) {
      const take = Math.min(rest, s.count);
      s.count -= take;
      rest -= take;
      if (s.count <= 0) inv.slots[i] = null;
    }
  }
  return rest === 0;
}

// --- world pickups (EntitySnapshot kind:'pickup') ---

import { PICKUP_ID_MIN } from './mobs.js';

export type Pickup = {
  id: number;
  kind: 'pickup';
  itemId: string;
  count: number;
  x: number;
  y: number;
};

let nextPickupId = PICKUP_ID_MIN;

export function makePickup(itemId: string, count: number, x: number, y: number): Pickup {
  return { id: nextPickupId++, kind: 'pickup', itemId: normId(itemId), count, x, y };
}

/** Reset pickup id counter (tests). */
export function _resetPickupIds(): void {
  nextPickupId = PICKUP_ID_MIN;
}

/**
 * Pick up: requires player within `radius` of the pickup and inventory space.
 * On success mutates inv and returns {ok:true}; otherwise {ok:false,reason}.
 */
export function tryPickup(
  inv: Inventory,
  pickup: Pickup,
  playerPos: { x: number; y: number },
  radius = 2.5,
): { ok: true } | { ok: false; reason: 'too-far' | 'no-space' | 'invalid' } {
  if (!isValidStack({ itemId: pickup.itemId, count: pickup.count })) {
    return { ok: false, reason: 'invalid' };
  }
  const d = Math.hypot(playerPos.x - pickup.x, playerPos.y - pickup.y);
  if (d > radius) return { ok: false, reason: 'too-far' };
  if (!addItem(inv, pickup.itemId, pickup.count)) return { ok: false, reason: 'no-space' };
  return { ok: true };
}
