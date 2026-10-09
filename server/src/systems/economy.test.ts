// economy: vendor buy/sell with supply/demand pricing, repair, auctions + escrow.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, WEAPONS, itemDef } from '../game/content.js';
import {
  AUCTION_DURATION_MS,
  AUCTION_ESCROW_FEE_PCT,
  AUCTION_LISTING_FEE_PCT,
  AUCTION_MIN_BID_INCREMENT_PCT,
  AUCTION_SOLD_FEE_PCT,
  PRICE_ELASTICITY,
  PRICE_HISTORY_TTL_MS,
  PRICE_HISTORY_WINDOW,
  PRICE_MAX_MULT,
  PRICE_MIN_MULT,
  REPAIR_FLAT_FEE,
  REPAIR_FULL_FACTOR,
  activeListings,
  bidAuction,
  buyoutAuction,
  cancelAuction,
  dynamicUnitPrice,
  emptyAuctionState,
  emptyPriceHistory,
  expireAuctions,
  listAuction,
  minNextBid,
  openEscrows,
  pricePressure,
  recordTrade,
  repair,
  repairCost,
  supplyDemandIndex,
  tradesFor,
  vendorBuy,
  vendorBuyPrice,
  vendorSell,
  vendorSellPrice,
  type PriceHistory,
} from './economy.js';

const NOW = 1_700_000_000_000;

describe('economy price history', () => {
  it('records trades per item without touching the input', () => {
    const empty = emptyPriceHistory();
    const next = recordTrade(empty, { itemId: 'iron-ore', side: 'buy', qty: 2, unitPrice: 6, at: NOW });
    assert.deepEqual(next['iron-ore'], [{ itemId: 'iron-ore', side: 'buy', qty: 2, unitPrice: 6, at: NOW }]);
    assert.deepEqual(empty, {});
  });

  it('keeps only the newest PRICE_HISTORY_WINDOW trades', () => {
    let h: PriceHistory = {};
    for (let i = 0; i < PRICE_HISTORY_WINDOW + 10; i++) {
      h = recordTrade(h, { itemId: 'iron-ore', side: 'buy', qty: 1, unitPrice: 6, at: NOW + i });
    }
    assert.equal(tradesFor(h, 'iron-ore', NOW + 1000).length, PRICE_HISTORY_WINDOW);
    assert.equal(h['iron-ore']![0]!.at, NOW + 10);
  });

  it('drops trades older than the 7 day TTL', () => {
    const stale = recordTrade(emptyPriceHistory(), { itemId: 'iron-ore', side: 'buy', qty: 1, unitPrice: 6, at: NOW });
    assert.equal(tradesFor(stale, 'iron-ore', NOW + PRICE_HISTORY_TTL_MS - 1).length, 1);
    assert.equal(tradesFor(stale, 'iron-ore', NOW + PRICE_HISTORY_TTL_MS + 1).length, 0);
  });

  it('sorts by timestamp regardless of insertion order', () => {
    let h: PriceHistory = {};
    h = recordTrade(h, { itemId: 'x', side: 'buy', qty: 1, unitPrice: 1, at: NOW + 50 });
    h = recordTrade(h, { itemId: 'x', side: 'sell', qty: 1, unitPrice: 1, at: NOW });
    assert.deepEqual(tradesFor(h, 'x', NOW + 100).map((t) => t.at), [NOW, NOW + 50]);
  });
});

describe('economy supply/demand pricing', () => {
  it('no history = no swing', () => {
    assert.equal(supplyDemandIndex(emptyPriceHistory(), 'iron-ore', NOW), 0);
    assert.equal(dynamicUnitPrice(10, emptyPriceHistory(), 'iron-ore', NOW), 10);
  });

  it('all buys push the index to +1, all sells to -1', () => {
    let buys: PriceHistory = recordTrade(emptyPriceHistory(), { itemId: 'i', side: 'buy', qty: 5, unitPrice: 1, at: NOW });
    assert.equal(supplyDemandIndex(buys, 'i', NOW), 1);
    let sells: PriceHistory = recordTrade(emptyPriceHistory(), { itemId: 'i', side: 'sell', qty: 5, unitPrice: 1, at: NOW });
    assert.equal(supplyDemandIndex(sells, 'i', NOW), -1);
  });

  it('index is quantity-weighted, not count-weighted', () => {
    let h: PriceHistory = recordTrade(emptyPriceHistory(), { itemId: 'i', side: 'buy', qty: 9, unitPrice: 1, at: NOW });
    h = recordTrade(h, { itemId: 'i', side: 'sell', qty: 1, unitPrice: 1, at: NOW + 1 });
    assert.equal(supplyDemandIndex(h, 'i', NOW + 2), 0.8);
  });

  it('demand raises price, supply lowers it (log-ratio pressure)', () => {
    assert.equal(PRICE_ELASTICITY, 0.3);
    // a single 1-qty trade => pressure 0.5 * log2(2/1) = 0.5 => +15%
    const hot: PriceHistory = recordTrade(emptyPriceHistory(), { itemId: 'i', side: 'buy', qty: 1, unitPrice: 1, at: NOW });
    const cold: PriceHistory = recordTrade(emptyPriceHistory(), { itemId: 'i', side: 'sell', qty: 1, unitPrice: 1, at: NOW });
    assert.equal(pricePressure(hot, 'i', NOW), 0.5);
    assert.equal(pricePressure(cold, 'i', NOW), -0.5);
    assert.equal(dynamicUnitPrice(100, hot, 'i', NOW), 115);
    assert.equal(dynamicUnitPrice(100, cold, 'i', NOW), 85);
  });

  it('balanced buy/sell flow leaves the price near base', () => {
    let h: PriceHistory = recordTrade(emptyPriceHistory(), { itemId: 'i', side: 'buy', qty: 50, unitPrice: 1, at: NOW });
    h = recordTrade(h, { itemId: 'i', side: 'sell', qty: 50, unitPrice: 1, at: NOW + 1 });
    assert.equal(pricePressure(h, 'i', NOW + 2), 0);
    assert.equal(dynamicUnitPrice(100, h, 'i', NOW + 2), 100);
  });

  it('price is clamped to [50%, 250%] of base', () => {
    assert.equal(PRICE_MIN_MULT, 0.5);
    assert.equal(PRICE_MAX_MULT, 2.5);
    // saturated demand cannot exceed the ceiling
    let h: PriceHistory = emptyPriceHistory();
    for (let i = 0; i < 40; i++) h = recordTrade(h, { itemId: 'i', side: 'buy', qty: 100, unitPrice: 1, at: NOW + i });
    assert.ok(pricePressure(h, 'i', NOW + 100) > 5, 'pressure is genuinely unbounded');
    assert.equal(dynamicUnitPrice(100, h, 'i', NOW + 100), 250);
    let c: PriceHistory = emptyPriceHistory();
    for (let i = 0; i < 40; i++) c = recordTrade(c, { itemId: 'i', side: 'sell', qty: 100, unitPrice: 1, at: NOW + i });
    assert.equal(dynamicUnitPrice(100, c, 'i', NOW + 100), 50);
  });

  it('unsellable (base 0) items never price', () => {
    assert.equal(dynamicUnitPrice(0, emptyPriceHistory(), 'ward-token', NOW), 0);
    assert.equal(vendorBuyPrice(0, emptyPriceHistory(), 'ward-token', NOW), 0);
    assert.equal(vendorSellPrice(0, emptyPriceHistory(), 'ward-token', NOW), 0);
  });

  it('vendor spread: buy = price+15% (ceil), sell = price-35% (floor)', () => {
    assert.equal(vendorBuyPrice(100, emptyPriceHistory(), 'i', NOW), 115);
    assert.equal(vendorSellPrice(100, emptyPriceHistory(), 'i', NOW), 65);
  });

  it('never sells for more than it buys (no gold duping)', () => {
    let h: PriceHistory = emptyPriceHistory();
    for (const side of ['buy', 'sell'] as const) {
      for (let i = 0; i < 12; i++) h = recordTrade(h, { itemId: 'i', side, qty: 7, unitPrice: 5, at: NOW + i });
      assert.ok(vendorSellPrice(50, h, 'i', NOW + 100) <= vendorBuyPrice(50, h, 'i', NOW + 100));
    }
  });
});

describe('economy vendor buy', () => {
  it('charges unit x qty and records a buy trade', () => {
    const r = vendorBuy(10, emptyPriceHistory(), 'iron-ore', 3, 1000, NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.unitPrice, 12); // ceil(10 * 1.15)
    assert.equal(r.total, 36);
    assert.equal(supplyDemandIndex(r.history, 'iron-ore', NOW), 1);
  });

  it('rejects bad qty, unknown items and insufficient gold without side effects', () => {
    assert.deepEqual(vendorBuy(10, emptyPriceHistory(), 'iron-ore', 0, 999, NOW), { ok: false, reason: 'bad-qty' });
    assert.deepEqual(vendorBuy(10, emptyPriceHistory(), 'iron-ore', 1.5, 999, NOW), { ok: false, reason: 'bad-qty' });
    assert.deepEqual(vendorBuy(0, emptyPriceHistory(), 'ward-token', 1, 999, NOW), { ok: false, reason: 'unknown-item' });
    assert.deepEqual(vendorBuy(10, emptyPriceHistory(), 'iron-ore', 2, 5, NOW), { ok: false, reason: 'insufficient-gold' });
  });

  it('exact gold is accepted', () => {
    const r = vendorBuy(10, emptyPriceHistory(), 'iron-ore', 1, 12, NOW);
    assert.equal(r.ok, true);
  });
});

describe('economy vendor sell', () => {
  it('pays the sell price and records a sell trade', () => {
    const r = vendorSell(10, emptyPriceHistory(), 'iron-ore', 2, 5, NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.unitPrice, 6); // floor(10 * 0.65)
    assert.equal(r.total, 12);
    assert.equal(supplyDemandIndex(r.history, 'iron-ore', NOW), -1);
  });

  it('rejects unsellable items, bad qty and insufficient holdings', () => {
    assert.deepEqual(vendorSell(0, emptyPriceHistory(), 'ward-token', 1, 1, NOW), { ok: false, reason: 'unsellable' });
    assert.deepEqual(vendorSell(5, emptyPriceHistory(), 'iron-ore', 0, 5, NOW), { ok: false, reason: 'bad-qty' });
    assert.deepEqual(vendorSell(5, emptyPriceHistory(), 'iron-ore', 3, 2, NOW), { ok: false, reason: 'player-lacks-item' });
  });

  it('buy then sell of the same item round-trips at a loss (spread sink)', () => {
    let h: PriceHistory = emptyPriceHistory();
    const buy = vendorBuy(10, h, 'iron-ore', 10, 10_000, NOW);
    assert.equal(buy.ok, true);
    if (!buy.ok) return;
    h = buy.history;
    const sell = vendorSell(10, h, 'iron-ore', 10, 10, NOW + 1);
    assert.equal(sell.ok, true);
    if (!sell.ok) return;
    assert.ok(sell.total < buy.total, `${sell.total} < ${buy.total}`);
  });

  it('every content item has a sane base price vs the vendor spread', () => {
    for (const def of [...ITEMS, ...WEAPONS]) {
      const buy = vendorBuyPrice(def.price, emptyPriceHistory(), def.id, NOW);
      const sell = vendorSellPrice(def.price, emptyPriceHistory(), def.id, NOW);
      if (def.price === 0) {
        assert.equal(sell, 0, `${def.id} must be unsellable`);
        continue;
      }
      assert.ok(buy > sell, `${def.id}: buy ${buy} must exceed sell ${sell}`);
      assert.ok(Number.isInteger(buy) && Number.isInteger(sell));
    }
  });
});

describe('economy repair', () => {
  it('cost = missing points + flat fee', () => {
    assert.equal(repairCost(200, 50, 100), 50 + REPAIR_FLAT_FEE);
  });

  it('a full repair never costs more than 60% of base price', () => {
    assert.equal(REPAIR_FULL_FACTOR, 0.6);
    assert.equal(repairCost(100, 0, 100), 60, 'raw 105 clamped to the 60% cap');
    assert.equal(repairCost(200, 1, 100), 104, 'raw 104 is under the 120 cap');
  });

  it('pristine and un-repairable items cost nothing', () => {
    assert.equal(repairCost(200, 100, 100), 0);
    assert.equal(repairCost(0, 0, 100), 0);
    assert.equal(repairCost(200, 0, 0), 0);
  });

  it('clamps out-of-range durability', () => {
    assert.equal(repairCost(100, -50, 100), 60, 'negative durability reads as fully broken');
    assert.equal(repairCost(100, 500, 100), 0, 'over-max durability has nothing to repair');
  });

  it('repair() restores full durability and charges the cost', () => {
    const ok = repair(200, 40, 100, 1000);
    assert.deepEqual(ok, { ok: true, cost: 65, durability: 100 });
  });

  it('repair() rejects with reasons and never mutates', () => {
    assert.deepEqual(repair(0, 10, 100, 1000), { ok: false, reason: 'un-repairable' });
    assert.deepEqual(repair(200, 10, 0, 1000), { ok: false, reason: 'un-repairable' });
    assert.deepEqual(repair(200, 100, 100, 1000), { ok: false, reason: 'full-durability' });
    assert.deepEqual(repair(200, 50, 100, 1), { ok: false, reason: 'insufficient-gold' });
    assert.deepEqual(repair(200, 150, 100, 1000), { ok: false, reason: 'bad-durability' });
  });
});

describe('economy auction house', () => {
  const list = (state = emptyAuctionState(), gold = 10_000) =>
    listAuction(state, { sellerId: 7, itemId: 'deep-halberd', qty: 1, startPrice: 100, buyoutPrice: 250 }, NOW, gold);

  it('listing escrows the goods and expires in 24h', () => {
    const r = list();
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.state.listings['auc-1']!.expiresAt, NOW + AUCTION_DURATION_MS);
    assert.equal(AUCTION_DURATION_MS, 24 * 60 * 60 * 1000);
    const escrow = r.state.escrow[r.value.escrowId]!;
    assert.deepEqual(escrow.items, [{ itemId: 'deep-halberd', qty: 1 }]);
    assert.equal(escrow.released, false);
    assert.equal(escrow.ownerId, 7);
    assert.equal(openEscrows(r.state).length, 1);
    const ev = r.events[0];
    assert.equal(ev?.type, 'auction-listed');
  });

  it('charges a 2% non-refundable listing fee and refuses if too poor', () => {
    const r = list(emptyAuctionState(), 1);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'insufficient-gold');
    assert.equal(AUCTION_LISTING_FEE_PCT, 0.02);
    const ok = list(emptyAuctionState(), 2);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.listingFee, 2);
  });

  it('validates list params', () => {
    const s = emptyAuctionState();
    assert.deepEqual(listAuction(s, { sellerId: 1, itemId: 'x', qty: 0, startPrice: 10 }, NOW, 100), { ok: false, reason: 'bad-qty' });
    assert.deepEqual(listAuction(s, { sellerId: 1, itemId: 'x', qty: 1, startPrice: 0 }, NOW, 100), { ok: false, reason: 'bad-start-price' });
  });

  it('bidding escalates 5% and refunds the previous high bidder', () => {
    const l = list();
    if (!l.ok) return;
    const b1 = bidAuction(l.state, 'auc-1', 21, 105, 10_000, NOW + 1);
    assert.equal(b1.ok, true);
    if (!b1.ok) return;
    assert.equal(b1.value.refundTo, 0);
    const b2 = bidAuction(b1.state, 'auc-1', 22, 120, 10_000, NOW + 2);
    assert.equal(b2.ok, true);
    if (!b2.ok) return;
    assert.equal(b2.value.refundTo, 105);
    assert.equal(b2.value.refundId, 21);
    assert.ok(b2.events.some((e) => e.type === 'auction-outbid' && e.bidderId === 21));
    assert.equal(b2.state.listings['auc-1']!.currentBid, 120);
  });

  it('minNextBid is +5% over the standing bid or the start price', () => {
    const l = list();
    if (!l.ok) return;
    assert.equal(AUCTION_MIN_BID_INCREMENT_PCT, 0.05);
    assert.equal(minNextBid(l.state.listings['auc-1']!), 105);
    const b = bidAuction(l.state, 'auc-1', 21, 105, 10_000, NOW + 1);
    if (!b.ok) return;
    assert.equal(minNextBid(b.state.listings['auc-1']!), 111);
  });

  it('rejects low/duplicate/self/expired bids and poor bidders', () => {
    const l = list();
    if (!l.ok) return;
    assert.deepEqual(bidAuction(l.state, 'auc-1', 21, 104, 10_000, NOW + 1), { ok: false, reason: 'bid-too-low' });
    assert.deepEqual(bidAuction(l.state, 'auc-1', 7, 105, 10_000, NOW + 1), { ok: false, reason: 'self-bid' });
    assert.deepEqual(bidAuction(l.state, 'auc-1', 21, 105, 1, NOW + 1), { ok: false, reason: 'insufficient-gold' });
    assert.deepEqual(bidAuction(l.state, 'auc-1', 21, 105, 10_000, NOW + AUCTION_DURATION_MS), { ok: false, reason: 'expired' });
    assert.deepEqual(bidAuction(l.state, 'nope', 21, 105, 10_000, NOW + 1), { ok: false, reason: 'no-such-auction' });
    const b = bidAuction(l.state, 'auc-1', 21, 105, 10_000, NOW + 1);
    if (!b.ok) return;
    assert.deepEqual(bidAuction(b.state, 'auc-1', 21, 200, 10_000, NOW + 2), { ok: false, reason: 'already-highest' });
  });

  it('buyout pays the seller minus the 5% house cut and moves the goods', () => {
    const l = list();
    if (!l.ok) return;
    const r = buyoutAuction(l.state, 'auc-1', 21, 10_000, NOW + 10);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.gross, 250);
    assert.equal(r.value.fee, Math.floor(250 * AUCTION_SOLD_FEE_PCT)); // 12
    assert.equal(r.value.payout, 250 - 12);
    assert.equal(r.state.listings['auc-1']!.status, 'sold');
    const escrow = r.state.escrow['esc-1']!;
    assert.deepEqual(escrow.items, [], 'goods left escrow');
    assert.equal(escrow.gold, r.value.payout);
    assert.equal(escrow.released, true);
    assert.ok(r.events.some((e) => e.type === 'auction-sold'));
  });

  it('buyout needs gross + escrow fee and rejects self/expired/no-buyout', () => {
    const l = list();
    if (!l.ok) return;
    assert.deepEqual(buyoutAuction(l.state, 'auc-1', 7, 10_000, NOW + 1), { ok: false, reason: 'self-buy' });
    assert.deepEqual(buyoutAuction(l.state, 'auc-1', 21, 250, NOW + 1), { ok: false, reason: 'insufficient-gold' });
    assert.deepEqual(buyoutAuction(l.state, 'auc-1', 21, 10_000, NOW + AUCTION_DURATION_MS), { ok: false, reason: 'expired' });
    const cheap = listAuction(emptyAuctionState(), { sellerId: 7, itemId: 'x', qty: 1, startPrice: 10 }, NOW, 100);
    if (!cheap.ok) return;
    assert.deepEqual(buyoutAuction(cheap.state, 'auc-1', 21, 10_000, NOW + 1), { ok: false, reason: 'no-buyout' });
    assert.equal(AUCTION_ESCROW_FEE_PCT, 0.01);
  });

  it('expireAuctions returns goods at 24h and sweeps the escrow', () => {
    const l = list();
    if (!l.ok) return;
    const early = expireAuctions(l.state, NOW + AUCTION_DURATION_MS - 1);
    assert.equal(early.events.length, 0);
    const late = expireAuctions(l.state, NOW + AUCTION_DURATION_MS);
    assert.equal(late.events.length, 1);
    assert.equal(late.state.listings['auc-1']!.status, 'expired');
    assert.deepEqual(late.events[0], { type: 'auction-expired', auctionId: 'auc-1', itemId: 'deep-halberd', qty: 1, returnedTo: 7 });
    assert.deepEqual(late.state.escrow['esc-1']!.items, []);
    assert.equal(openEscrows(late.state).length, 0);
    assert.equal(activeListings(late.state).length, 0);
  });

  it('the seller may cancel a bid-free listing and get the fee refunded', () => {
    const l = list();
    if (!l.ok) return;
    assert.deepEqual(cancelAuction(l.state, 'auc-1', 21, NOW + 1), { ok: false, reason: 'not-seller' });
    const r = cancelAuction(l.state, 'auc-1', 7, NOW + 1);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.state.listings['auc-1']!.status, 'cancelled');
    assert.equal(r.value.refundTo, 2, 'listing fee returned');
    assert.deepEqual(r.state.escrow['esc-1']!.items, []);
  });

  it('a listing with bids cannot be cancelled', () => {
    const l = list();
    if (!l.ok) return;
    const b = bidAuction(l.state, 'auc-1', 21, 105, 10_000, NOW + 1);
    if (!b.ok) return;
    assert.deepEqual(cancelAuction(b.state, 'auc-1', 7, NOW + 2), { ok: false, reason: 'has-bids' });
  });

  it('activeListings lists only active rows, most urgent first', () => {
    const a = list();
    if (!a.ok) return;
    const b = listAuction(a.state, { sellerId: 8, itemId: 'iron-ore', qty: 4, startPrice: 20 }, NOW, 1000);
    if (!b.ok) return;
    const active = activeListings(b.state);
    assert.equal(active.length, 2);
    assert.equal(active[0]!.itemId, 'iron-ore', 'expires sooner -> first');
    const swept = expireAuctions(b.state, NOW + AUCTION_DURATION_MS);
    assert.equal(activeListings(swept.state).length, 0);
  });

  it('every catalog item can be listed with a price derived from its base', () => {
    for (const def of [...ITEMS, ...WEAPONS]) {
      if (def.price <= 0) continue;
      const r = listAuction(emptyAuctionState(), { sellerId: 1, itemId: def.id, qty: 1, startPrice: def.price }, NOW, 10_000);
      assert.equal(r.ok, true, `${def.id} should list`);
      assert.equal(itemDef(def.id)?.id, def.id);
    }
  });

  it('escrow never double-releases: buyout then expire is a no-op', () => {
    const l = list();
    if (!l.ok) return;
    const sold = buyoutAuction(l.state, 'auc-1', 21, 10_000, NOW + 1);
    if (!sold.ok) return;
    const swept = expireAuctions(sold.state, NOW + AUCTION_DURATION_MS * 2);
    assert.equal(swept.events.length, 0, 'already resolved');
    assert.equal(swept.state.escrow['esc-1']!.gold, sold.value.payout);
  });

  it('listing is deterministic (replay safety)', () => {
    const a = listAuction(emptyAuctionState(), { sellerId: 7, itemId: 'x', qty: 1, startPrice: 100 }, NOW, 1000);
    const b = listAuction(emptyAuctionState(), { sellerId: 7, itemId: 'x', qty: 1, startPrice: 100 }, NOW, 1000);
    if (!a.ok || !b.ok) throw new Error('listing should succeed');
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.events, b.events);
  });
});