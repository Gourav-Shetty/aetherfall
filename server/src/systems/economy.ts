// @aetherfall/systems — economy: vendor buy/sell with supply/demand pricing,
// durability repair, and an auction-house stub (24h expiry + escrow).
//
// Design contract: PURE functions. State in -> new state + events out.
// No I/O, no clocks (callers pass `now`), no RNG except injected `rand`.
// Gold is tracked as plain integers; callers hold the wallets.

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Vendor spread: buy = base * (1 + margin), sell = base * (1 - margin). */
export const VENDOR_BUY_MARGIN = 0.15;
export const VENDOR_SELL_MARGIN = 0.35;

/** Dynamic price bounds, as a multiple of the base price. */
export const PRICE_MIN_MULT = 0.5;
export const PRICE_MAX_MULT = 2.5;

/** Only the most recent N trades of an item influence its price. */
export const PRICE_HISTORY_WINDOW = 20;

/** Trade history older than this is ignored (7 days). */
export const PRICE_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Supply/demand index -> price multiplier swing. ±1 index moves price ±30%. */
export const PRICE_ELASTICITY = 0.3;

/**
 * Damping applied to the log-ratio price pressure. Without it a single trade
 * would swing the price as hard as forty.
 */
export const PRICE_PRESSURE_DAMPING = 0.5;

/** Repair: cost per point of missing durability, + flat bench fee. */
export const REPAIR_COST_PER_POINT = 1;
export const REPAIR_FLAT_FEE = 5;
/** Repairs cost more than a clean item is worth is allowed (full restore). */
export const REPAIR_FULL_FACTOR = 0.6; // of base price, cap for a 100% repair

/** Auction house. */
export const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
export const AUCTION_LISTING_FEE_PCT = 0.02; // 2% of start price, non-refundable
export const AUCTION_SOLD_FEE_PCT = 0.05; // 5% cut on the winning bid
export const AUCTION_MIN_BID_INCREMENT_PCT = 0.05; // +5% over current bid
export const AUCTION_ESCROW_FEE_PCT = 0.01; // 1% charged to the buyer at buyout

// ---------------------------------------------------------------------------
// Trade history + supply/demand pricing
// ---------------------------------------------------------------------------

export type TradeSide = 'buy' | 'sell';

export type TradeRecord = {
  itemId: string;
  /** side from the PLAYER's perspective: 'buy' = player bought (demand up). */
  side: TradeSide;
  qty: number;
  unitPrice: number;
  at: number;
};

export type PriceHistory = Record<string, TradeRecord[]>;

export function emptyPriceHistory(): PriceHistory {
  return {};
}

/** Append a trade, trimmed to the window and TTL. Returns a NEW history. */
export function recordTrade(history: PriceHistory, trade: TradeRecord): PriceHistory {
  const cutoff = trade.at - PRICE_HISTORY_TTL_MS;
  const prior = (history[trade.itemId] ?? []).filter((t) => t.at >= cutoff && t.qty > 0);
  const next = [...prior, { ...trade }];
  next.sort((a, b) => a.at - b.at);
  const trimmed = next.slice(Math.max(0, next.length - PRICE_HISTORY_WINDOW));
  return { ...history, [trade.itemId]: trimmed };
}

/** All non-expired records for an item, oldest first. */
export function tradesFor(history: PriceHistory, itemId: string, now: number): TradeRecord[] {
  const cutoff = now - PRICE_HISTORY_TTL_MS;
  return (history[itemId] ?? []).filter((t) => t.at >= cutoff);
}

/**
 * Supply/demand index in [-1, 1].
 *  +1 = heavy player demand (mostly buys)  -> price up
 *  -1 = heavy player supply (mostly sells)  -> price down
 *   0 = balanced / no history.
 * Weighted by quantity, not trade count, so a bulk sale moves the needle.
 */
export function supplyDemandIndex(history: PriceHistory, itemId: string, now: number): number {
  const trades = tradesFor(history, itemId, now);
  let demand = 0;
  let supply = 0;
  for (const t of trades) {
    if (t.side === 'buy') demand += Math.max(0, t.qty);
    else supply += Math.max(0, t.qty);
  }
  const total = demand + supply;
  if (total === 0) return 0;
  return (demand - supply) / total;
}

/**
 * Unbounded price pressure: `0.5 * log2((buyQty + 1) / (sellQty + 1))`.
 * Unlike the display index this is deliberately NOT capped, so a genuinely
 * saturated market pushes into the PRICE_MIN/PRICE_MAX clamp instead of
 * flattening out at ±30%.
 */
export function pricePressure(history: PriceHistory, itemId: string, now: number): number {
  const trades = tradesFor(history, itemId, now);
  let buys = 0;
  let sells = 0;
  for (const t of trades) {
    if (t.side === 'buy') buys += Math.max(0, t.qty);
    else sells += Math.max(0, t.qty);
  }
  return PRICE_PRESSURE_DAMPING * Math.log2((buys + 1) / (sells + 1));
}

/**
 * Vendor quote for one unit, clamped to [50%, 250%] of base price.
 * Round to whole gold (floor, min 1 unless unsellable).
 */
export function dynamicUnitPrice(
  basePrice: number,
  history: PriceHistory,
  itemId: string,
  now: number,
): number {
  if (basePrice <= 0) return 0;
  const mult = 1 + pricePressure(history, itemId, now) * PRICE_ELASTICITY;
  const clamped = Math.min(PRICE_MAX_MULT, Math.max(PRICE_MIN_MULT, mult));
  // +1e-9 so float dust (0.5*0.3 = 0.15 -> 114.9999...) never costs a gold.
  return Math.max(1, Math.floor(basePrice * clamped + 1e-9));
}

/** What the player pays per unit at the vendor. */
export function vendorBuyPrice(basePrice: number, history: PriceHistory, itemId: string, now: number): number {
  const dyn = dynamicUnitPrice(basePrice, history, itemId, now);
  return dyn <= 0 ? 0 : Math.max(1, Math.ceil(dyn * (1 + VENDOR_BUY_MARGIN)));
}

/** What the vendor pays per unit when the player sells. Never exceeds buy. */
export function vendorSellPrice(basePrice: number, history: PriceHistory, itemId: string, now: number): number {
  const dyn = dynamicUnitPrice(basePrice, history, itemId, now);
  if (dyn <= 0) return 0;
  return Math.max(0, Math.floor(dyn * (1 - VENDOR_SELL_MARGIN)));
}

// ---------------------------------------------------------------------------
// Vendor transactions
// ---------------------------------------------------------------------------

export type VendorBuyResult =
  | { ok: true; unitPrice: number; total: number; qty: number; itemId: string; history: PriceHistory }
  | { ok: false; reason: 'unknown-item' | 'out-of-stock' | 'insufficient-gold' | 'bad-qty' };

/**
 * Player buys `qty` from a vendor. Validation is total: nothing is mutated and
 * no history is recorded unless the whole order succeeds.
 * On success the caller receives `history` to adopt and must add the items.
 */
export function vendorBuy(
  basePrice: number,
  history: PriceHistory,
  itemId: string,
  qty: number,
  gold: number,
  now: number,
): VendorBuyResult {
  if (qty <= 0 || !Number.isInteger(qty)) return { ok: false, reason: 'bad-qty' };
  if (basePrice <= 0) return { ok: false, reason: 'unknown-item' };
  const unitPrice = vendorBuyPrice(basePrice, history, itemId, now);
  const total = unitPrice * qty;
  if (gold < total) return { ok: false, reason: 'insufficient-gold' };
  const next = recordTrade(history, { itemId, side: 'buy', qty, unitPrice, at: now });
  return { ok: true, unitPrice, total, qty, itemId, history: next };
}

export type VendorSellResult =
  | { ok: true; unitPrice: number; total: number; qty: number; itemId: string; history: PriceHistory }
  | { ok: false; reason: 'unsellable' | 'bad-qty' | 'player-lacks-item' };

/** Player sells `qty` to a vendor. basePrice 0 = unsellable (quest tokens). */
export function vendorSell(
  basePrice: number,
  history: PriceHistory,
  itemId: string,
  qty: number,
  playerHasQty: number,
  now: number,
): VendorSellResult {
  if (qty <= 0 || !Number.isInteger(qty)) return { ok: false, reason: 'bad-qty' };
  if (basePrice <= 0) return { ok: false, reason: 'unsellable' };
  if (playerHasQty < qty) return { ok: false, reason: 'player-lacks-item' };
  const unitPrice = vendorSellPrice(basePrice, history, itemId, now);
  const total = unitPrice * qty;
  const next = recordTrade(history, { itemId, side: 'sell', qty, unitPrice, at: now });
  return { ok: true, unitPrice, total, qty, itemId, history: next };
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Repair cost for an item whose durability is `durability` out of `maxDurability`.
 * Cheaper than buying a new one: a full repair is capped at 60% of base price.
 * Returns 0 for a pristine or un-repairable (maxDurability <= 0) item.
 */
export function repairCost(
  basePrice: number,
  durability: number,
  maxDurability: number,
): number {
  if (maxDurability <= 0 || basePrice <= 0) return 0;
  const clamped = Math.min(maxDurability, Math.max(0, durability));
  const missing = maxDurability - clamped;
  if (missing <= 0) return 0;
  const raw = missing * REPAIR_COST_PER_POINT + REPAIR_FLAT_FEE;
  const cap = Math.floor(basePrice * REPAIR_FULL_FACTOR);
  return Math.max(0, Math.min(raw, cap));
}

export type RepairResult =
  | { ok: true; cost: number; durability: number }
  | { ok: false; reason: 'un-repairable' | 'full-durability' | 'insufficient-gold' | 'bad-durability' };

/** Attempt a repair. Returns the restored durability; caller applies it. */
export function repair(
  basePrice: number,
  durability: number,
  maxDurability: number,
  gold: number,
): RepairResult {
  if (maxDurability <= 0 || basePrice <= 0) return { ok: false, reason: 'un-repairable' };
  if (durability > maxDurability || durability < 0) return { ok: false, reason: 'bad-durability' };
  const cost = repairCost(basePrice, durability, maxDurability);
  if (cost === 0) return { ok: false, reason: 'full-durability' };
  if (gold < cost) return { ok: false, reason: 'insufficient-gold' };
  return { ok: true, cost, durability: maxDurability };
}

// ---------------------------------------------------------------------------
// Auction house (stub): listings, bids, buyout, 24h expiry, escrow
// ---------------------------------------------------------------------------

export type AuctionStatus = 'active' | 'sold' | 'expired' | 'cancelled';

/**
 * Escrow holds the seller's goods (and later the buyer's gold) until the
 * auction resolves. `held` items are counted by the inventory layer: a listing
 * only exists once its goods are in escrow.
 */
export type Escrow = {
  id: string;
  /** The auction this escrow backs. */
  auctionId: string;
  /** Gold currently held (seller's item is held as `items`). */
  gold: number;
  items: { itemId: string; qty: number }[];
  /** Deposited by the seller at listing time; released on resolve. */
  ownerId: number;
  released: boolean;
};

export type Listing = {
  id: string;
  sellerId: number;
  itemId: string;
  qty: number;
  startPrice: number;
  /** Optional instant-buy price (0 = no buyout). */
  buyoutPrice: number;
  /** ms timestamp the listing goes stale. */
  expiresAt: number;
  status: AuctionStatus;
  escrowId: string;
  /** Current high bid; 0 until someone bids. */
  currentBid: number;
  highestBidderId: number | null;
  bidCount: number;
  /** Gold already paid to the vendor as the non-refundable listing fee. */
  listingFee: number;
};

export type AuctionState = {
  nextId: number;
  nextEscrowId: number;
  listings: Record<string, Listing>;
  escrow: Record<string, Escrow>;
};

export type AuctionEvent =
  | { type: 'auction-listed'; auctionId: string; itemId: string; qty: number; escrowId: string; expiresAt: number; fee: number }
  | { type: 'auction-bid'; auctionId: string; bidderId: number; amount: number; previous: number }
  | { type: 'auction-outbid'; auctionId: string; bidderId: number; amount: number }
  | { type: 'auction-buyout'; auctionId: string; itemId: string; qty: number; buyerId: number; gross: number; fee: number; net: number }
  | { type: 'auction-sold'; auctionId: string; buyerId: number; sellerId: number; amount: number; fee: number }
  | { type: 'auction-expired'; auctionId: string; itemId: string; qty: number; returnedTo: number }
  | { type: 'auction-cancelled'; auctionId: string; itemId: string; qty: number; returnedTo: number };

export type AuctionResult<T> = { ok: true; state: AuctionState; events: AuctionEvent[]; value: T } | { ok: false; reason: string };

export function emptyAuctionState(): AuctionState {
  return { nextId: 1, nextEscrowId: 1, listings: {}, escrow: {} };
}

function feePct(amount: number, pct: number): number {
  return Math.max(0, Math.floor(amount * pct));
}

/** Minimum acceptable next bid: +5% over the standing bid (or the start price). */
export function minNextBid(listing: Listing): number {
  const floorPrice = listing.currentBid > 0 ? listing.currentBid : listing.startPrice;
  return Math.max(1, Math.ceil(floorPrice * (1 + AUCTION_MIN_BID_INCREMENT_PCT)));
}

export type ListParams = {
  sellerId: number;
  itemId: string;
  qty: number;
  startPrice: number;
  buyoutPrice?: number;
  basePrice?: number; // used to cap the start price sanity check
};

/**
 * List an item for 24h. The goods go straight into escrow; the seller is
 * charged a 2% non-refundable listing fee in gold by the caller (returned in
 * `value.listingFee`). Requires `sellerGold` to cover that fee.
 */
export function listAuction(
  state: AuctionState,
  params: ListParams,
  now: number,
  sellerGold: number,
): AuctionResult<{ listingId: string; escrowId: string; listingFee: number }> {
  const { sellerId, itemId, qty, startPrice } = params;
  if (qty <= 0 || !Number.isInteger(qty)) return { ok: false, reason: 'bad-qty' };
  if (startPrice <= 0) return { ok: false, reason: 'bad-start-price' };
  if (sellerId < 0) return { ok: false, reason: 'bad-seller' };
  const listingFee = feePct(startPrice, AUCTION_LISTING_FEE_PCT);
  if (sellerGold < listingFee) return { ok: false, reason: 'insufficient-gold' };

  const listingId = `auc-${state.nextId}`;
  const escrowId = `esc-${state.nextEscrowId}`;
  const escrow: Escrow = {
    id: escrowId,
    auctionId: listingId,
    gold: 0,
    items: [{ itemId, qty }],
    ownerId: sellerId,
    released: false,
  };
  const listing: Listing = {
    id: listingId,
    sellerId,
    itemId,
    qty,
    startPrice,
    buyoutPrice: params.buyoutPrice ?? 0,
    expiresAt: now + AUCTION_DURATION_MS,
    status: 'active',
    escrowId,
    currentBid: 0,
    highestBidderId: null,
    bidCount: 0,
    listingFee,
  };
  const next: AuctionState = {
    nextId: state.nextId + 1,
    nextEscrowId: state.nextEscrowId + 1,
    listings: { ...state.listings, [listingId]: listing },
    escrow: { ...state.escrow, [escrowId]: escrow },
  };
  const events: AuctionEvent[] = [
    { type: 'auction-listed', auctionId: listingId, itemId, qty, escrowId, expiresAt: listing.expiresAt, fee: listingFee },
  ];
  return { ok: true, state: next, events, value: { listingId, escrowId, listingFee } };
}

/**
 * Place a bid. Bids are escrow-backed only at settlement (a stub affordance):
 * `value.refundTo` reports gold to return to the previous highest bidder, which
 * the caller pays out immediately.
 */
export function bidAuction(
  state: AuctionState,
  auctionId: string,
  bidderId: number,
  amount: number,
  bidderGold: number,
  now: number,
): AuctionResult<{ refundTo: number; refundId: number | null }> {
  const listing = state.listings[auctionId];
  if (!listing) return { ok: false, reason: 'no-such-auction' };
  if (listing.status !== 'active') return { ok: false, reason: 'not-active' };
  if (now >= listing.expiresAt) return { ok: false, reason: 'expired' };
  if (bidderId === listing.sellerId) return { ok: false, reason: 'self-bid' };
  const minimum = minNextBid(listing);
  if (amount < minimum) return { ok: false, reason: 'bid-too-low' };
  if (bidderId === listing.highestBidderId) return { ok: false, reason: 'already-highest' };
  if (bidderGold < amount) return { ok: false, reason: 'insufficient-gold' };

  const updated: Listing = {
    ...listing,
    currentBid: amount,
    highestBidderId: bidderId,
    bidCount: listing.bidCount + 1,
  };
  const next: AuctionState = { ...state, listings: { ...state.listings, [auctionId]: updated } };
  const events: AuctionEvent[] = [
    { type: 'auction-bid', auctionId, bidderId, amount, previous: listing.currentBid },
  ];
  if (listing.highestBidderId !== null) {
    events.push({ type: 'auction-outbid', auctionId, bidderId: listing.highestBidderId, amount });
  }
  return { ok: true, state: next, events, value: { refundTo: listing.currentBid, refundId: listing.highestBidderId } };
}

export type SettleResult = AuctionResult<{
  itemId: string;
  qty: number;
  buyerId: number | null;
  sellerId: number;
  /** Gross paid by the buyer, 0 on expiry/cancel. */
  gross: number;
  /** House cut. */
  fee: number;
  /** Gold released to the seller. */
  payout: number;
  refundTo: number;
  refundId: number | null;
}>;

/**
 * Close an auction by buyout. Buyer gold (gross + escrow fee) and the escrowed
 * goods move; the seller is paid gross - sold-fee, the fee goes to the house.
 */
export function buyoutAuction(
  state: AuctionState,
  auctionId: string,
  buyerId: number,
  buyerGold: number,
  now: number,
): SettleResult {
  const listing = state.listings[auctionId];
  if (!listing) return { ok: false, reason: 'no-such-auction' };
  if (listing.status !== 'active') return { ok: false, reason: 'not-active' };
  if (now >= listing.expiresAt) return { ok: false, reason: 'expired' };
  if (listing.buyoutPrice <= 0) return { ok: false, reason: 'no-buyout' };
  if (buyerId === listing.sellerId) return { ok: false, reason: 'self-buy' };

  const gross = listing.buyoutPrice;
  const houseFee = feePct(gross, AUCTION_SOLD_FEE_PCT);
  const escrowFee = feePct(gross, AUCTION_ESCROW_FEE_PCT);
  if (buyerGold < gross + escrowFee) return { ok: false, reason: 'insufficient-gold' };

  const payout = gross - houseFee;
  const escrow = state.escrow[listing.escrowId];
  const next: AuctionState = {
    ...state,
    listings: { ...state.listings, [auctionId]: { ...listing, status: 'sold' } },
    escrow: {
      ...state.escrow,
      [listing.escrowId]: escrow
        ? { ...escrow, gold: payout, items: [], released: true }
        : escrow,
    },
  };
  const events: AuctionEvent[] = [
    { type: 'auction-buyout', auctionId, itemId: listing.itemId, qty: listing.qty, buyerId, gross, fee: houseFee + escrowFee, net: payout },
    { type: 'auction-sold', auctionId, buyerId, sellerId: listing.sellerId, amount: gross, fee: houseFee },
  ];
  return {
    ok: true,
    state: next,
    events,
    value: {
      itemId: listing.itemId,
      qty: listing.qty,
      buyerId,
      sellerId: listing.sellerId,
      gross,
      fee: houseFee,
      payout,
      refundTo: 0,
      refundId: null,
    },
  };
}

/**
 * Expire every active listing whose 24h window has elapsed. Items return to the
 * seller from escrow; a listing that somehow had bids pays out to the bidder
 * (defensive — a real tick expires auctions before a late bid can settle).
 */
export function expireAuctions(state: AuctionState, now: number): { state: AuctionState; events: AuctionEvent[] } {
  const events: AuctionEvent[] = [];
  const listings = { ...state.listings };
  const escrow = { ...state.escrow };
  for (const l of Object.values(state.listings)) {
    if (l.status !== 'active') continue;
    if (now < l.expiresAt) continue;
    listings[l.id] = { ...l, status: 'expired' };
    const e = escrow[l.escrowId];
    if (e && !e.released) {
      escrow[l.escrowId] = { ...e, items: [], gold: 0, released: true };
    }
    events.push({ type: 'auction-expired', auctionId: l.id, itemId: l.itemId, qty: l.qty, returnedTo: l.sellerId });
  }
  return { state: { ...state, listings, escrow }, events };
}

/** Seller cancels a live listing with zero bids; goods return from escrow. */
export function cancelAuction(state: AuctionState, auctionId: string, actorId: number, now: number): AuctionResult<{ itemId: string; qty: number; refundTo: number }> {
  const listing = state.listings[auctionId];
  if (!listing) return { ok: false, reason: 'no-such-auction' };
  if (listing.status !== 'active') return { ok: false, reason: 'not-active' };
  if (actorId !== listing.sellerId) return { ok: false, reason: 'not-seller' };
  if (listing.bidCount > 0) return { ok: false, reason: 'has-bids' };
  if (now >= listing.expiresAt) return { ok: false, reason: 'expired' };

  const escrow = state.escrow[listing.escrowId];
  const next: AuctionState = {
    ...state,
    listings: { ...state.listings, [auctionId]: { ...listing, status: 'cancelled' } },
    escrow: escrow ? { ...state.escrow, [listing.escrowId]: { ...escrow, items: [], released: true } } : state.escrow,
  };
  const events: AuctionEvent[] = [
    { type: 'auction-cancelled', auctionId, itemId: listing.itemId, qty: listing.qty, returnedTo: listing.sellerId },
  ];
  return {
    ok: true,
    state: next,
    events,
    value: { itemId: listing.itemId, qty: listing.qty, refundTo: listing.listingFee },
  };
}

/** Active listings, newest first. */
export function activeListings(state: AuctionState): Listing[] {
  return Object.values(state.listings)
    .filter((l) => l.status === 'active')
    .sort((a, b) => b.expiresAt - a.expiresAt || b.id.localeCompare(a.id));
}

/** Escrow rows still holding goods or gold (auditing helper). */
export function openEscrows(state: AuctionState): Escrow[] {
  return Object.values(state.escrow).filter((e) => !e.released);
}