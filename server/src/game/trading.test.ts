// Trading: state machine + atomic completion.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addItem, createInventory, countOf, type Inventory } from './inventory.js';
import {
  cancelTrade,
  confirmTrade,
  createTrade,
  lockTrade,
  offerItem,
  tradeReady,
  tryCompleteTrade,
  _resetTradeIds,
} from './trading.js';

function stocked(): Map<number, Inventory> {
  _resetTradeIds();
  const invs = new Map<number, Inventory>([
    [1, createInventory()],
    [2, createInventory()],
  ]);
  addItem(invs.get(1)!, 'iron', 10);
  addItem(invs.get(2)!, 'wood', 10);
  return invs;
}

function readyTrade(invs: Map<number, Inventory>, offerA = 5, offerB = 5) {
  const t = createTrade(1, 2);
  assert.equal(offerItem(t, 1, { itemId: 'iron', count: offerA }), true);
  assert.equal(offerItem(t, 2, { itemId: 'wood', count: offerB }), true);
  assert.equal(lockTrade(t, 1), true);
  assert.equal(lockTrade(t, 2), true);
  assert.equal(confirmTrade(t, 1), true);
  assert.equal(confirmTrade(t, 2), true);
  assert.equal(tradeReady(t), true);
  return t;
}

describe('trading state machine', () => {
  it('requires both parties locked before confirm', () => {
    _resetTradeIds();
    const t = createTrade(1, 2);
    offerItem(t, 1, { itemId: 'iron', count: 1 });
    lockTrade(t, 1);
    assert.equal(confirmTrade(t, 1), false);
    lockTrade(t, 2);
    assert.equal(confirmTrade(t, 1), true);
    assert.equal(confirmTrade(t, 2), true);
    assert.equal(tradeReady(t), true);
  });

  it('offer change resets locks (anti-scam)', () => {
    _resetTradeIds();
    const t = createTrade(1, 2);
    offerItem(t, 1, { itemId: 'iron', count: 1 });
    lockTrade(t, 1);
    lockTrade(t, 2);
    offerItem(t, 1, { itemId: 'iron', count: 2 });
    assert.equal(t.locked[1], false);
    assert.equal(t.locked[2], false);
  });

  it('completes happy-path swap atomically', () => {
    const invs = stocked();
    const t = createTrade(1, 2);
    offerItem(t, 1, { itemId: 'iron', count: 5 });
    offerItem(t, 2, { itemId: 'wood', count: 5 });
    lockTrade(t, 1);
    lockTrade(t, 2);
    confirmTrade(t, 1);
    confirmTrade(t, 2);
    const r = tryCompleteTrade(t, invs);
    assert.deepEqual(r, { ok: true });
    assert.equal(t.state, 'done');
    assert.equal(countOf(invs.get(1)!, 'iron'), 5);
    assert.equal(countOf(invs.get(1)!, 'wood'), 5);
    assert.equal(countOf(invs.get(2)!, 'wood'), 5);
    assert.equal(countOf(invs.get(2)!, 'iron'), 5);
  });

  it('aborts without mutation when a party lacks offered items', () => {
    const invs = stocked();
    const t = createTrade(1, 2);
    offerItem(t, 1, { itemId: 'iron', count: 999 }); // more than held
    offerItem(t, 2, { itemId: 'wood', count: 1 });
    lockTrade(t, 1);
    lockTrade(t, 2);
    confirmTrade(t, 1);
    confirmTrade(t, 2);
    const before1 = countOf(invs.get(1)!, 'iron');
    const before2 = countOf(invs.get(2)!, 'wood');
    const r = tryCompleteTrade(t, invs);
    assert.equal(r.ok, false);
    assert.equal(t.state, 'open'); // stays open so players can fix/cancel
    assert.equal(countOf(invs.get(1)!, 'iron'), before1);
    assert.equal(countOf(invs.get(2)!, 'wood'), before2);
  });

  it('aborts without partial mutation when receiver inventory is full', () => {
    _resetTradeIds();
    const invs = new Map<number, Inventory>([
      [1, createInventory()],
      [2, createInventory()],
    ]);
    addItem(invs.get(1)!, 'iron', 10);
    // Fill player 2 with 20 distinct full stacks; iron-receipt needs space.
    for (let i = 0; i < 20; i++) addItem(invs.get(2)!, `junk${i}`, 99);
    const t = createTrade(1, 2);
    // player2 offers nothing back, receives iron -> no space
    offerItem(t, 1, { itemId: 'iron', count: 5 });
    lockTrade(t, 1);
    lockTrade(t, 2);
    confirmTrade(t, 1);
    confirmTrade(t, 2);
    const r = tryCompleteTrade(t, invs);
    assert.equal(r.ok, false);
    assert.equal(countOf(invs.get(1)!, 'iron'), 10); // untouched
    assert.equal(t.state, 'open');
  });

  it('cancel ends session; further ops rejected', () => {
    _resetTradeIds();
    const t = createTrade(1, 2);
    cancelTrade(t);
    assert.equal(t.state, 'cancelled');
    assert.equal(offerItem(t, 1, { itemId: 'x', count: 1 }), false);
    assert.equal(lockTrade(t, 1), false);
  });

  it('readyTrade helper sanity', () => {
    const invs = stocked();
    void invs;
    const t = readyTrade(invs);
    void t;
  });
});
