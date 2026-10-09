// @aetherfall/gameplay — 2-player trade session state machine with atomic completion.
// States: open -> locked(a,b) -> confirmed(a,b) -> done | cancelled.
// Completion is atomic: both inventories are validated BEFORE any mutation.

import { addItem, canFit, countOf, removeItem, type Inventory, type ItemStack } from './inventory.js';

export type TradeState = 'open' | 'done' | 'cancelled';

export type TradeSession = {
  id: number;
  a: number; // player id
  b: number; // player id
  offers: Record<number, ItemStack[]>; // playerId -> offered stacks
  locked: Record<number, boolean>;
  confirmed: Record<number, boolean>;
  state: TradeState;
  reason?: string;
};

let nextTradeId = 1;

export function _resetTradeIds(): void {
  nextTradeId = 1;
}

export function createTrade(a: number, b: number): TradeSession {
  if (a === b) throw new Error('cannot trade with yourself');
  return {
    id: nextTradeId++,
    a,
    b,
    offers: { [a]: [], [b]: [] },
    locked: { [a]: false, [b]: false },
    confirmed: { [a]: false, [b]: false },
    state: 'open',
  };
}

function partyOf(t: TradeSession, pid: number): boolean {
  return pid === t.a || pid === t.b;
}

function otherOf(t: TradeSession, pid: number): number {
  return pid === t.a ? t.b : t.a;
}

/**
 * Stage an offer. Any change by either party unlocks+unconfirms both sides
 * (standard anti-swap-scam rule). Returns false if not allowed.
 */
export function offerItem(t: TradeSession, pid: number, stack: ItemStack): boolean {
  if (t.state !== 'open') return false;
  if (!partyOf(t, pid)) return false;
  if (stack.count < 1 || stack.itemId.length === 0) return false;
  t.offers[pid].push({ itemId: stack.itemId.slice(0, 64), count: Math.floor(stack.count) });
  t.locked[t.a] = false;
  t.locked[t.b] = false;
  t.confirmed[t.a] = false;
  t.confirmed[t.b] = false;
  return true;
}

export function retractOffer(t: TradeSession, pid: number, index: number): boolean {
  if (t.state !== 'open') return false;
  if (!partyOf(t, pid)) return false;
  const arr = t.offers[pid];
  if (index < 0 || index >= arr.length) return false;
  arr.splice(index, 1);
  t.locked[t.a] = false;
  t.locked[t.b] = false;
  t.confirmed[t.a] = false;
  t.confirmed[t.b] = false;
  return true;
}

export function lockTrade(t: TradeSession, pid: number): boolean {
  if (t.state !== 'open') return false;
  if (!partyOf(t, pid)) return false;
  t.locked[pid] = true;
  return true;
}

/** Confirm requires both parties locked first. */
export function confirmTrade(t: TradeSession, pid: number): boolean {
  if (t.state !== 'open') return false;
  if (!partyOf(t, pid)) return false;
  if (!t.locked[t.a] || !t.locked[t.b]) return false;
  t.confirmed[pid] = true;
  return true;
}

export function cancelTrade(t: TradeSession, reason = 'cancelled'): void {
  if (t.state !== 'open') return;
  t.state = 'cancelled';
  t.reason = reason;
}

export function tradeReady(t: TradeSession): boolean {
  return (
    t.state === 'open' &&
    t.locked[t.a] &&
    t.locked[t.b] &&
    t.confirmed[t.a] &&
    t.confirmed[t.b]
  );
}

export type TradeCompleteResult = { ok: true } | { ok: false; reason: string };

/**
 * Atomically swap offers between inventories.
 * Validation order (no mutation until ALL checks pass):
 *  1. session open + both locked + both confirmed
 *  2. each party actually holds what they offered
 *  3. each party can fit what they will receive (after their own offer is removed)
 * Then mutate. On any failure the session stays 'open' (or caller cancels).
 */
export function tryCompleteTrade(
  t: TradeSession,
  inventories: Map<number, Inventory>,
): TradeCompleteResult {
  if (t.state !== 'open') return { ok: false, reason: 'not-open' };
  if (!tradeReady(t)) return { ok: false, reason: 'not-ready' };
  const invA = inventories.get(t.a);
  const invB = inventories.get(t.b);
  if (!invA || !invB) return { ok: false, reason: 'missing-inventory' };

  const offerA = t.offers[t.a];
  const offerB = t.offers[t.b];

  // 2. holdings check (aggregate per item)
  const need = (offer: ItemStack[], inv: Inventory): string | null => {
    const totals = new Map<string, number>();
    for (const s of offer) totals.set(s.itemId, (totals.get(s.itemId) ?? 0) + s.count);
    for (const [id, n] of totals) if (countOf(inv, id) < n) return id;
    return null;
  };
  const missA = need(offerA, invA);
  if (missA) return { ok: false, reason: `a-missing:${missA}` };
  const missB = need(offerB, invB);
  if (missB) return { ok: false, reason: `b-missing:${missB}` };

  // 3. fit check: simulate removal of own offer, then check incoming fits.
  // Simulate by cloning slot arrays (stacks are small; cheap and safe).
  const simFits = (ownInv: Inventory, ownOffer: ItemStack[], incoming: ItemStack[]): boolean => {
    const sim: Inventory = {
      slots: ownInv.slots.map((s) => (s ? { ...s } : null)),
    };
    for (const s of ownOffer) removeItem(sim, s.itemId, s.count);
    for (const s of incoming) if (!addItem(sim, s.itemId, s.count)) return false;
    return true;
  };
  if (!simFits(invA, offerA, offerB)) return { ok: false, reason: 'a-no-space' };
  if (!simFits(invB, offerB, offerA)) return { ok: false, reason: 'b-no-space' };

  // Mutate (infallible now — both removes validated, both adds fit-checked on sim).
  for (const s of offerA) removeItem(invA, s.itemId, s.count);
  for (const s of offerB) removeItem(invB, s.itemId, s.count);
  // If an add somehow fails (shouldn't), roll back by re-adding removed offers.
  const addedA: ItemStack[] = [];
  for (const s of offerB) {
    if (addItem(invA, s.itemId, s.count)) addedA.push(s);
    else {
      for (const r of addedA) removeItem(invA, r.itemId, r.count);
      for (const r of offerA) addItem(invA, r.itemId, r.count);
      for (const r of offerB) addItem(invB, r.itemId, r.count);
      return { ok: false, reason: 'a-no-space-race' };
    }
  }
  for (const s of offerA) {
    if (!addItem(invB, s.itemId, s.count)) {
      for (const r of addedA) removeItem(invA, r.itemId, r.count);
      for (const r of offerA) addItem(invA, r.itemId, r.count);
      const addedB = offerA.slice(0, offerA.indexOf(s));
      for (const r of addedB) removeItem(invB, r.itemId, r.count);
      for (const r of offerB) addItem(invB, r.itemId, r.count);
      return { ok: false, reason: 'b-no-space-race' };
    }
  }

  t.state = 'done';
  void otherOf(t, t.a); // keep helper referenced for future expiry logic
  return { ok: true };
}
