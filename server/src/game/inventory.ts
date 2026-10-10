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

/**
 * A legal stack count is a WHOLE number of at least 1.
 *
 * The integer check is the load-bearing part. `count >= 1` alone let a
 * fractional `count` (a 2.5-unit pickup, a half-unit trade offer) into a slot,
 * and every later mutation then inherited the fraction: `removeItem(inv, id, 2)`
 * on a `{count: 2.5}` slot leaves `{count: 0.5}` — a stack below the minimum
 * of 1 that nothing can ever clean up. From there `countOf` returns 0.5 (so
 * `/sell` ownership checks and the collect-quest counters read half an item)
 * and `spaceFor` returns a fractional capacity that `addItem` trusts.
 *
 * Every mutation entry point (`addItem`, `removeItem`, `tryPickup`) routes its
 * count through this one predicate so no caller can reintroduce the split.
 * NaN and Infinity are excluded by `Number.isInteger` as well.
 *
 * Note the deliberate asymmetry with {@link isValidStack}: a transfer total
 * (`addItem(inv, id, 1980)`) legitimately spans slots, so it is bounded only by
 * bag capacity. The `MAX_STACK` cap applies to a SINGLE slot, which is what
 * `isValidStack` — and therefore a world pickup — must respect.
 */
function isValidCount(count: number): boolean {
  return Number.isInteger(count) && count >= 1;
}

/**
 * A single stored stack: whole count in [1, MAX_STACK] with an id. This is the
 * gate `tryPickup` runs before a world pickup can enter the bag, so a pickup
 * can never seed the fractional corruption described on {@link isValidCount}.
 */
function isValidStack(s: ItemStack): boolean {
  return isValidCount(s.count) && s.count <= MAX_STACK && s.itemId.length > 0;
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
  // Same whole-number gate as addItem, so the two can never disagree about
  // whether a transfer of `count` is legal (a vendor `/buy` asks canFit first).
  return isValidCount(count) && spaceFor(inv, normId(itemId)) >= count;
}

/**
 * Add items, filling partial stacks first then empty slots.
 * Returns true and mutates on success; returns false with NO mutation if it does not fit.
 */
export function addItem(inv: Inventory, itemId: string, count: number): boolean {
  const id = normId(itemId);
  if (!isValidCount(count) || id.length === 0) return false;
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
  if (!isValidCount(count)) return false;
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
  /**
   * ms timestamp the pickup entered the world (0 = unknown/legacy row).
   *
   * Corpse loot used to live forever: nothing carried an age, so a player who
   * ignored loot — or could not reach it — grew `GameState.pickups` without
   * bound (~0.5 entries per kill, measured) and it was still there an hour
   * later. `prunePickups` ages rows out against this stamp.
   */
  createdAt?: number;
};

/**
 * How long a dropped item stays on the ground before it fades.
 *
 * Long enough that walking back across a field is always rewarded (a thrown
 * sidearm lands up to `THROW_RANGE` + mask away), short enough that an
 * unattended corpse pile cannot accumulate without bound.
 */
export const PICKUP_TTL_MS = 120_000;

let nextPickupId = PICKUP_ID_MIN;

/**
 * Build a world pickup. `createdAt` stamps the ageing clock; callers that
 * cannot supply a clock may omit it (the row then never ages, which is the
 * pre-existing behaviour).
 */
export function makePickup(itemId: string, count: number, x: number, y: number, createdAt?: number): Pickup {
  return {
    id: nextPickupId++,
    kind: 'pickup',
    itemId: normId(itemId),
    count,
    x,
    y,
    ...(Number.isFinite(createdAt) ? { createdAt: createdAt as number } : {}),
  };
}

/** Reset pickup id counter (tests). */
export function _resetPickupIds(): void {
  nextPickupId = PICKUP_ID_MIN;
}

/**
 * Drop every pickup older than `PICKUP_TTL_MS`. Mutates the array in place
 * (it is the live `GameState.pickups`) and returns the ids that expired so the
 * caller can announce them.
 *
 * Rows with no `createdAt` are kept: they came from a caller that supplied no
 * clock, and silently deleting them would lose loot rather than age it out.
 */
export function prunePickups(pickups: Pickup[], now: number, ttlMs: number = PICKUP_TTL_MS): number[] {
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) return [];
  const expired: number[] = [];
  let write = 0;
  for (let read = 0; read < pickups.length; read++) {
    const p = pickups[read]!;
    const age = p.createdAt !== undefined ? now - p.createdAt : Number.NEGATIVE_INFINITY;
    if (age >= ttlMs) expired.push(p.id);
    else pickups[write++] = p;
  }
  pickups.length = write;
  return expired;
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
  // A non-finite position is rejected outright. The range test below cannot do
  // this for us: `Math.hypot` returns NaN for a NaN coordinate, and every
  // comparison against NaN is false, so `d > radius` is false and the drop
  // would be collectable from ANY point on the map — free items, teleport loot.
  if (!Number.isFinite(pickup.x) || !Number.isFinite(pickup.y)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!Number.isFinite(playerPos.x) || !Number.isFinite(playerPos.y)) {
    return { ok: false, reason: 'too-far' };
  }
  const d = Math.hypot(playerPos.x - pickup.x, playerPos.y - pickup.y);
  if (d > radius) return { ok: false, reason: 'too-far' };
  if (!addItem(inv, pickup.itemId, pickup.count)) return { ok: false, reason: 'no-space' };
  return { ok: true };
}
