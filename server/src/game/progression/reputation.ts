// @aetherfall/gameplay — faction reputation: the second progression axis.
//
// Three ORIGINAL factions of the Fall, five named ranks each, one concrete
// perk apiece. Reputation is a lifetime number (it decides rank) and a
// spendable balance (it buys the single perk). Everything here is pure data +
// pure functions: no clocks, no RNG, no mutation of the state passed in.
//
// Text, names, thresholds and perks are written for AETHERFALL; nothing is
// lifted from another game's faction system.

import type { FactionId, ReputationAwardView, ReputationRankView } from '@aetherfall/shared';
import { clampTier } from './world_tiers.js';

// ---------------------------------------------------------------------------
// Faction definitions
// ---------------------------------------------------------------------------

export type FactionRankDef = {
  name: string;
  description: string;
  /** Lifetime reputation needed to hold this rank. */
  threshold: number;
};

export type FactionPerkDef = {
  id: string;
  name: string;
  description: string;
  /** Spendable reputation charged when the perk is bought. */
  cost: number;
  /** Minimum rank index (0-based) required before it can be bought. */
  rankRequired: number;
};

export type FactionDef = {
  id: FactionId;
  name: string;
  creed: string;
  ranks: readonly FactionRankDef[];
  perk: FactionPerkDef;
};

export const FACTIONS: readonly FactionDef[] = Object.freeze([
  Object.freeze({
    id: 'ashen-vigil' as FactionId,
    name: 'The Ashen Vigil',
    creed: 'They kept the last watch when the sky tore open and never left their posts.',
    ranks: Object.freeze([
      { name: 'Cinder Sentry', description: 'A fresh pair of eyes on the broken road.', threshold: 0 },
      { name: 'Ember Warden', description: 'Trusted to hold a stretch of the watch alone.', threshold: 50 },
      { name: 'Dawnvow Knight', description: 'Sworn to stand until the next light, whatever comes.', threshold: 150 },
      { name: 'Last-Light Captain', description: 'Commands the watchfires when the lanterns gutter.', threshold: 350 },
      { name: 'Vigil of the Fall', description: 'The road remembers where this one stood.', threshold: 750 },
    ]),
    perk: Object.freeze({
      id: 'vigil-oath',
      name: 'Oath of the Last Watch',
      description: 'The Vigil mends your body between watches: +25 maximum HP.',
      cost: 120,
      rankRequired: 2,
    }),
  }),
  Object.freeze({
    id: 'hollow-choir' as FactionId,
    name: 'The Hollow Choir',
    creed: 'They sing the names of the fallen so the missing are not forgotten into silence.',
    ranks: Object.freeze([
      { name: 'Muted Mourner', description: 'Lends a voice to the quiet ones.', threshold: 0 },
      { name: 'Vesper Cantor', description: 'Keeps the evening verse when no one else will.', threshold: 45 },
      { name: 'Requiem Bearer', description: 'Carries a name from the ash back to the roll.', threshold: 135 },
      { name: 'Dirge Archivist', description: 'Writes down what the choir refuses to lose.', threshold: 315 },
      { name: 'Voice of the Unfallen', description: 'The roll is kept because this one kept singing.', threshold: 675 },
    ]),
    perk: Object.freeze({
      id: 'one-name-kept',
      name: 'One Name Kept',
      description: 'Every deed is remembered a little longer: +8% XP from all sources.',
      cost: 150,
      rankRequired: 2,
    }),
  }),
  Object.freeze({
    id: 'fault-ledger' as FactionId,
    name: 'The Fault Ledger',
    creed: 'They chart the cracks heaven left and put a price on every shard that falls through.',
    ranks: Object.freeze([
      { name: 'Soot Clerk', description: 'Copies the first line of every new crack.', threshold: 0 },
      { name: 'Shard Runner', description: 'Carries the measurements before the ink dries.', threshold: 60 },
      { name: 'Rift Surveyor', description: 'Reads a fault line the way others read a road.', threshold: 180 },
      { name: 'Breach Factor', description: 'Names the price of a wound in the world.', threshold: 400 },
      { name: 'Keeper of the Ledger', description: 'The final column balances because of this one.', threshold: 850 },
    ]),
    perk: Object.freeze({
      id: 'wayfinders-bargain',
      name: "Wayfinder's Bargain",
      description: 'A marked page in the ledger: 10% off every vendor price.',
      cost: 180,
      rankRequired: 2,
    }),
  }),
]);

const FACTION_BY_ID = new Map<FactionId, FactionDef>(FACTIONS.map((f) => [f.id, f]));

export function isFactionId(value: unknown): value is FactionId {
  return typeof value === 'string' && FACTION_BY_ID.has(value as FactionId);
}

export function factionDef(id: FactionId | string): FactionDef | undefined {
  return FACTION_BY_ID.get(id as FactionId);
}

function defFor(id: FactionId | string): FactionDef {
  return FACTION_BY_ID.get(id as FactionId) ?? FACTIONS[0]!;
}

export const RANK_COUNT = 5;
/** Lifetime/balance ceiling: keeps the numbers wire-sized and farm-proof. */
export const MAX_REPUTATION = 100_000;

function clampRep(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return MAX_REPUTATION; // Infinity saturates at the cap
  return Math.min(MAX_REPUTATION, Math.floor(value));
}

// ---------------------------------------------------------------------------
// Rank lookup (from lifetime reputation)
// ---------------------------------------------------------------------------

/** 0-based index of the rank held at `earned` lifetime reputation. */
export function rankIndexFor(id: FactionId | string, earned: number): number {
  const ranks = defFor(id).ranks;
  const e = clampRep(earned);
  let index = 0;
  for (let i = 0; i < ranks.length; i++) {
    if (e >= ranks[i]!.threshold) index = i;
  }
  return index;
}

/** The named rank currently held, with its index and threshold attached. */
export function rankFor(id: FactionId | string, earned: number): ReputationRankView {
  const ranks = defFor(id).ranks;
  const index = rankIndexFor(id, earned);
  const rank = ranks[index]!;
  return { index, name: rank.name, description: rank.description, threshold: rank.threshold };
}

/** True when `earned` already clears the named rank index (0..4). */
export function hasRank(id: FactionId | string, earned: number, rankIndex: number): boolean {
  const idx = Number.isFinite(rankIndex) ? Math.min(RANK_COUNT - 1, Math.max(0, Math.floor(rankIndex))) : 0;
  return rankIndexFor(id, earned) >= idx;
}

/** Where someone is inside their current rank and how far the next one is. */
export function rankProgress(id: FactionId | string, earned: number): {
  rank: ReputationRankView;
  next: ReputationRankView | null;
  intoRank: number;
  toNext: number;
} {
  const ranks = defFor(id).ranks;
  const index = rankIndexFor(id, earned);
  const e = clampRep(earned);
  const nextIndex = index + 1 < ranks.length ? index + 1 : -1;
  const next = nextIndex < 0 ? null : {
    index: nextIndex,
    name: ranks[nextIndex]!.name,
    description: ranks[nextIndex]!.description,
    threshold: ranks[nextIndex]!.threshold,
  };
  return {
    rank: rankFor(id, e),
    next,
    intoRank: e - ranks[index]!.threshold,
    toNext: next === null ? 0 : Math.max(0, next.threshold - e),
  };
}

// ---------------------------------------------------------------------------
// Earning
// ---------------------------------------------------------------------------

/** Base reputation per tier for a kill; quests pay the `QUEST_MULTIPLIER`. */
export const REP_BASE_BY_TIER: Readonly<Record<1 | 2 | 3 | 4, number>> = Object.freeze({
  1: 2,
  2: 4,
  3: 7,
  4: 11,
});
export const QUEST_REP_MULTIPLIER = 2.5;

/** How each faction values the deed. The vigil guards, the choir remembers,
 *  the ledger maps — so the same kill never pays all three equally. */
export const FACTION_REP_WEIGHT: Readonly<Record<'kill' | 'quest', Readonly<Record<FactionId, number>>>> = Object.freeze({
  kill: Object.freeze({ 'ashen-vigil': 1, 'hollow-choir': 0.5, 'fault-ledger': 0.75 }),
  quest: Object.freeze({ 'ashen-vigil': 0.6, 'hollow-choir': 1.2, 'fault-ledger': 0.8 }),
});

export type ReputationSource = 'kill' | 'quest';

/** Reputation from one tier-appropriate kill or quest, per faction. */
export function awardFor(tier: number, source: ReputationSource): ReputationAwardView {
  const t = clampTier(tier);
  const base = REP_BASE_BY_TIER[t] * (source === 'quest' ? QUEST_REP_MULTIPLIER : 1);
  const weights = FACTION_REP_WEIGHT[source];
  const award = {} as ReputationAwardView;
  for (const f of FACTIONS) award[f.id] = Math.max(1, Math.round(base * weights[f.id]));
  return award;
}

// ---------------------------------------------------------------------------
// Spendable state
// ---------------------------------------------------------------------------

export type ReputationState = {
  /** Lifetime totals — these decide rank and can never be spent down. */
  earned: Record<FactionId, number>;
  /** Unspent reputation — spent on the faction's single perk. */
  balance: Record<FactionId, number>;
  /** Factions whose perk has been bought (each can be bought once). */
  perks: FactionId[];
};

export function createReputation(): ReputationState {
  return {
    earned: { 'ashen-vigil': 0, 'hollow-choir': 0, 'fault-ledger': 0 },
    balance: { 'ashen-vigil': 0, 'hollow-choir': 0, 'fault-ledger': 0 },
    perks: [],
  };
}

export type ReputationEvent =
  | { type: 'rep-gained'; faction: FactionId; amount: number; earned: number; balance: number }
  | { type: 'rank-up'; faction: FactionId; rankIndex: number; rankName: string }
  | { type: 'perk-bought'; faction: FactionId; perkId: string };

function copyReputation(state: ReputationState): ReputationState {
  return {
    earned: { ...state.earned },
    balance: { ...state.balance },
    perks: [...state.perks],
  };
}

/** Credit an award. Pure: returns a new state plus rank-up events. */
export function grantReputation(state: ReputationState, award: ReputationAwardView): {
  state: ReputationState;
  events: ReputationEvent[];
} {
  const next = copyReputation(state);
  const events: ReputationEvent[] = [];
  for (const f of FACTIONS) {
    const raw = award[f.id];
    const amount = clampRep(raw ?? 0);
    if (amount === 0) continue;
    const before = rankIndexFor(f.id, next.earned[f.id]);
    next.earned[f.id] = clampRep(next.earned[f.id] + amount);
    next.balance[f.id] = clampRep(next.balance[f.id] + amount);
    events.push({
      type: 'rep-gained',
      faction: f.id,
      amount,
      earned: next.earned[f.id],
      balance: next.balance[f.id],
    });
    const after = rankIndexFor(f.id, next.earned[f.id]);
    if (after > before) {
      events.push({ type: 'rank-up', faction: f.id, rankIndex: after, rankName: f.ranks[after]!.name });
    }
  }
  return { state: next, events };
}

export function hasPerk(state: ReputationState, factionId: FactionId): boolean {
  return state.perks.includes(factionId);
}

/** Why a perk purchase would fail, or null when it would succeed. */
export function perkBlocker(state: ReputationState, factionId: FactionId): 'unknown' | 'owned' | 'rank' | 'balance' | null {
  const def = factionDef(factionId);
  if (!def) return 'unknown';
  if (hasPerk(state, factionId)) return 'owned';
  if (!hasRank(factionId, state.earned[factionId], def.perk.rankRequired)) return 'rank';
  if (state.balance[factionId] < def.perk.cost) return 'balance';
  return null;
}

export function canBuyPerk(state: ReputationState, factionId: FactionId): boolean {
  return perkBlocker(state, factionId) === null;
}

/** Buy the faction's one perk. Pure: balance is charged exactly once. */
export function buyPerk(state: ReputationState, factionId: FactionId): {
  ok: true;
  state: ReputationState;
  event: ReputationEvent;
} | { ok: false; reason: 'unknown' | 'owned' | 'rank' | 'balance' } {
  const reason = perkBlocker(state, factionId);
  if (reason !== null) {
    return { ok: false, reason: reason === 'unknown' ? 'unknown' : reason };
  }
  const def = factionDef(factionId)!;
  const next = copyReputation(state);
  next.balance[factionId] -= def.perk.cost;
  next.perks.push(factionId);
  return {
    ok: true,
    state: next,
    event: { type: 'perk-bought', faction: factionId, perkId: def.perk.id },
  };
}
