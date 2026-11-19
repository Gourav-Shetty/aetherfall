// @aetherfall/shared — wire vocabulary for the world-progression layer.
//
// Pure data types + runtime guards only. The authoritative tables and pure
// functions live in `server/src/game/progression/`; this module exists so the
// client (and tools) can name the same values without importing the server.
// Protocol v1 is untouched: a future agent surfaces these as ordinary
// `{ t: 'event', kind, payload }` messages, never as a new packet type.

/** World difficulty band. 1 is the spawn sanctuary; 4 is a boss crown. */
export type WorldTier = 1 | 2 | 3 | 4;

export const MIN_WORLD_TIER: WorldTier = 1;
export const MAX_WORLD_TIER: WorldTier = 4;

/** Stable, ascending tier ids (also the order used by every tier table). */
export const WORLD_TIER_IDS: readonly WorldTier[] = Object.freeze([1, 2, 3, 4]);

/** The three original fall-of-heaven factions (see the server-side table). */
export type FactionId = 'ashen-vigil' | 'hollow-choir' | 'fault-ledger';

export const FACTION_IDS: readonly FactionId[] = Object.freeze([
  'ashen-vigil',
  'hollow-choir',
  'fault-ledger',
]);

/** The two deterministic world-event families. */
export type WorldEventKind = 'shard-surge' | 'roost-awakening';

export const WORLD_EVENT_KINDS: readonly WorldEventKind[] = Object.freeze([
  'shard-surge',
  'roost-awakening',
]);

/** Scaled mob numbers returned by `tierStats`. */
export type TierStatsView = {
  /** Max HP after tier scaling (integer). */
  hp: number;
  /** Per-hit damage after tier scaling (integer). */
  damage: number;
  /** Kill XP after tier scaling (integer). */
  xp: number;
};

/** What an under-levelled visitor suffers in a high tier. */
export type TierPenaltyView = {
  /** Multiplier applied to INCOMING damage. 1 at tier 1 or when levelled. */
  damageTakenMult: number;
  /** Multiplier applied to XP payouts. 1 at tier 1 or when levelled. */
  xpMult: number;
  /** Levels below the tier's recommended floor (0 when not under-levelled). */
  underLevel: number;
};

/** One of the five named ranks of a faction. */
export type ReputationRankView = {
  /** 0-based index into the faction's five ranks. */
  index: number;
  name: string;
  description: string;
  /** Lifetime reputation required to hold this rank. */
  threshold: number;
};

/** Reputation granted by one kill / quest, keyed by faction. */
export type ReputationAwardView = Record<FactionId, number>;

/** A scheduled world event, safe to JSON-serialise as an event payload. */
export type WorldEventView = {
  id: string;
  /** 0-based slot in the seeded schedule. */
  index: number;
  kind: WorldEventKind;
  /** Zone at the event site (`getZone` result). */
  zone: string;
  x: number;
  y: number;
  tier: WorldTier;
  /** Display name of the landmark / roost where the event fires. */
  landmark: string;
  startsAtMs: number;
  endsAtMs: number;
  /** Shard surges only: XP multiplier granted inside the zone. */
  xpMult?: number;
  /** Roost awakenings only: boss whose roost wakes. */
  boss?: string;
};

// Runtime guards — useful at the payload boundary and for the wire tests.

export function isWorldTier(value: unknown): value is WorldTier {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_WORLD_TIER && value <= MAX_WORLD_TIER;
}

export function isFactionId(value: unknown): value is FactionId {
  return typeof value === 'string' && (FACTION_IDS as readonly string[]).includes(value);
}

export function isWorldEventKind(value: unknown): value is WorldEventKind {
  return typeof value === 'string' && (WORLD_EVENT_KINDS as readonly string[]).includes(value);
}
