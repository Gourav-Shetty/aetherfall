// Inventory integrity: every stored stack is a whole number in [1, MAX_STACK].
//
// A fractional `count` (a 2.5-unit pickup, a half-unit trade offer) used to be
// accepted by `addItem`/`tryPickup`, which wrote it straight into a slot. The
// damage is permanent and player-visible:
//
//   * `removeItem(inv, id, 2)` on a {count: 2.5} slot leaves {count: 0.5} —
//     a stack below the minimum of 1 that no later mutation can clean up.
//   * `countOf` then returns 0.5, so `/sell` validation and the collect-quest
//     counters (`onCollect(pickup.count)`) read a half item.
//   * `spaceFor` returns 1979.5 units instead of an integer, and that value is
//     what `canFit`/`addItem` trust.
//
// These tests pin the invariant at the boundary, so any caller (loot rolls,
// trade offers, vendor stock, a future drop system) is covered by one rule.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STACK,
  MAX_SLOTS,
  addItem,
  canFit,
  countOf,
  createInventory,
  makePickup,
  removeItem,
  spaceFor,
  tryPickup,
  type Inventory,
} from './inventory.js';

/** Every slot is null, or a whole count in [1, MAX_STACK]. */
function assertStackIntegrity(inv: Inventory, label: string): void {
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.slots[i];
    if (s === null) continue;
    assert.ok(
      Number.isInteger(s.count),
      `${label}: slot ${i} has a fractional count ${s.count} (item ${s.itemId})`,
    );
    assert.ok(s.count >= 1, `${label}: slot ${i} has count ${s.count} < 1 (item ${s.itemId})`);
    assert.ok(s.count <= MAX_STACK, `${label}: slot ${i} has count ${s.count} > MAX_STACK (item ${s.itemId})`);
  }
}

describe('inventory integrity: whole-number stacks', () => {
  it('addItem refuses a fractional count and leaves the bag untouched', () => {
    const inv = createInventory();
    assert.equal(addItem(inv, 'healing-herb', 2.5), false, 'fractional add accepted');
    assert.equal(countOf(inv, 'healing-herb'), 0, 'fractional add mutated the bag');
    assertStackIntegrity(inv, 'after fractional addItem');
  });

  it('addItem still accepts every legal whole count', () => {
    for (const n of [1, 2, 50, 99, 100, 198, 1980]) {
      const inv = createInventory();
      const capacity = MAX_SLOTS * MAX_STACK;
      const want = Math.min(n, capacity);
      assert.equal(addItem(inv, 'iron-ore', want), true, `addItem(${want}) rejected`);
      assert.equal(countOf(inv, 'iron-ore'), want);
      assertStackIntegrity(inv, `after addItem(${want})`);
    }
  });

  it('tryPickup rejects a fractional-count pickup (reason: invalid)', () => {
    const inv = createInventory();
    const bad = makePickup('healing-herb', 2.5, 0, 0);
    const res = tryPickup(inv, bad, { x: 0, y: 0 });
    assert.deepEqual(res, { ok: false, reason: 'invalid' });
    assert.equal(countOf(inv, 'healing-herb'), 0);
    assertStackIntegrity(inv, 'after fractional tryPickup');
  });

  it('a fractional pickup cannot corrupt a stack down below the minimum', () => {
    // The exact failure the player hit: a half-unit stack, then an integer
    // remove, left a 0.5-count slot that survived forever.
    const inv = createInventory();
    assert.deepEqual(tryPickup(inv, makePickup('healing-herb', 2.5, 0, 0), { x: 0, y: 0 }), {
      ok: false,
      reason: 'invalid',
    });
    // Legitimate 3-unit pickup for contrast: remove 3 -> slot fully cleared.
    assert.equal(tryPickup(inv, makePickup('healing-herb', 3, 0, 0), { x: 0, y: 0 }).ok, true);
    assert.equal(removeItem(inv, 'healing-herb', 3), true);
    assert.equal(countOf(inv, 'healing-herb'), 0);
    assertStackIntegrity(inv, 'after clean remove');
  });

  it('removeItem refuses a fractional count and never splits a stack', () => {
    const inv = createInventory();
    addItem(inv, 'ember-shard', 10);
    assert.equal(removeItem(inv, 'ember-shard', 0.5), false, 'fractional remove accepted');
    assert.equal(countOf(inv, 'ember-shard'), 10, 'fractional remove mutated the bag');
    assertStackIntegrity(inv, 'after fractional removeItem');
  });

  it('countOf / spaceFor stay integers across a whole session of partial stacks', () => {
    const inv = createInventory();
    // Fill partials, drain them one at a time, refill: the classic long session.
    for (let round = 0; round < 200; round++) {
      assert.equal(addItem(inv, 'moss-cap', 7), true);
      assert.ok(Number.isInteger(spaceFor(inv, 'moss-cap')), 'spaceFor went fractional');
      assert.equal(removeItem(inv, 'moss-cap', 3), true);
      assert.equal(removeItem(inv, 'moss-cap', 4), true);
      assert.equal(countOf(inv, 'moss-cap'), 0, `round ${round} leaked items`);
      assertStackIntegrity(inv, `round ${round}`);
    }
  });

  it('canFit agrees with addItem for every whole count up to capacity', () => {
    const inv = createInventory();
    const capacity = MAX_SLOTS * MAX_STACK;
    for (const n of [1, 99, 100, capacity - 1, capacity, capacity + 1]) {
      const probe = createInventory();
      // canFit on an empty bag of the same shape must match what addItem does.
      const predicted = canFit(probe, 'iron-ore', n);
      const actual = addItem(probe, 'iron-ore', n);
      assert.equal(predicted, actual, `canFit(${n})=${predicted} but addItem=${actual}`);
      assertStackIntegrity(probe, `after addItem(${n})`);
    }
  });

  it('MAX_STACK is never exceeded by addItem (the partial-stack overflow case)', () => {
    const inv = createInventory();
    addItem(inv, 'iron-ore', MAX_STACK);
    // A second full stack overflows into the next slot rather than 198 in one.
    assert.equal(addItem(inv, 'iron-ore', MAX_STACK), true);
    assert.equal(inv.slots[0]?.count, MAX_STACK);
    assert.equal(inv.slots[1]?.count, MAX_STACK);
    assertStackIntegrity(inv, 'after two full stacks');
  });
});