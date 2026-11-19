// @aetherfall/gameplay — world tiers: the missing progression layer.
//
// Today a level-1 player can walk from the meadow to a boss roost and everything
// hits equally hard. This module adds a *read-only* difficulty axis over the
// existing world without moving a wall, a spawn anchor or a mob:
//
//   * `tierAt(x, y)`                — where in the world a body stands (1..4)
//   * `tierStats(tier, base)`       — how much HP/damage/XP that place pays
//   * `tierPenalty(level, tier)`    — how a under-levelled visitor is softened
//
// Design contract: every export is pure / data-only. No clocks, no RNG, no
// state, no imports from server state modules. The engine owns the spawn
// anchors, the boss roosts and `getZone`; this module reads them and combines
// them. Tier 1 is *exactly* the old balance — callers that have not wired this
// layer yet keep the current behaviour byte for byte.

import {
  BOSS_ANCHORS,
  BOSS_WAKE_RANGE,
  DEFAULT_WORLD_SEED,
  SPAWN_ANCHORS,
  SPAWN_SAFE_RADIUS,
  getZone,
  type ZoneId,
} from '@aetherfall/engine';
import type { TierPenaltyView, TierStatsView, WorldTier } from '@aetherfall/shared';

// ---------------------------------------------------------------------------
// Tier 1 geography
// ---------------------------------------------------------------------------

/** Tier ids are contiguous; everything clamps into this band. */
export function clampTier(tier: number): WorldTier {
  const t = Number.isFinite(tier) ? Math.floor(tier) : 1;
  return Math.min(4, Math.max(1, t)) as WorldTier;
}

/**
 * A tier-1 sanctuary is the union of discs of this radius around each spawn
 * anchor. Twice the 12u no-mob radius means every anchor AND its safe ring
 * stays at the old tier-1 balance, even if the zone under it is a highlands
 * band (the ridge anchors sit in `dungeon` by zone).
 */
export const TIER1_ANCHOR_RADIUS = 2 * SPAWN_SAFE_RADIUS; // 24u

/** Anchor-distance bands. Past the last band the position is tier 4. */
export const TIER2_ANCHOR_RADIUS = 52;
export const TIER3_ANCHOR_RADIUS = 82;

/**
 * Zone floors, applied only OUTSIDE the tier-1 sanctuary. The radial zone map
 * is the coarse gradient; anchor distance is the local correction. A volcano
 * tile can never be tier 1-2, a dungeon tile never tier 1.
 */
export const TIER_ZONE_FLOOR: Readonly<Record<ZoneId, WorldTier>> = Object.freeze({
  meadow: 1,
  dungeon: 2,
  volcano: 3,
});

/** Inside the boss wake disc a site is at least tier 3; inside the crown, 4. */
export const TIER_BOSS_WAKE_RADIUS = BOSS_WAKE_RANGE; // 30u
export const TIER_BOSS_CROWN_RADIUS = 16;

export type NearestPoint = {
  x: number;
  y: number;
  name: string;
  distance: number;
};

function nearest(points: ReadonlyArray<{ x: number; y: number; name: string }>, x: number, y: number): NearestPoint | null {
  let best: NearestPoint | null = null;
  for (const p of points) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (best === null || d < best.distance) best = { x: p.x, y: p.y, name: p.name, distance: d };
  }
  return best;
}

/** Nearest spawn anchor to a world position (copy, not a shared reference). */
export function nearestSpawnAnchor(x: number, y: number): NearestPoint | null {
  return nearest(SPAWN_ANCHORS, x, y);
}

/** Nearest boss roost to a world position (copy, not a shared reference). */
export function nearestBossRoost(x: number, y: number): NearestPoint | null {
  return nearest(BOSS_ANCHORS, x, y);
}

/**
 * The world tier at `(x, y)`. Pure, deterministic and O(10) — six anchors,
 * four roosts, one zone lookup.
 *
 * Rules, in order:
 *   1. Invalid coordinates fall back to the sanctuary (tier 1).
 *   2. Inside `TIER1_ANCHOR_RADIUS` of ANY spawn anchor -> tier 1. This is a
 *      hard floor: it keeps the ridge anchors at tier 1 despite their zone.
 *   3. Otherwise start from anchor distance: <=52 -> 2, <=82 -> 3, else 4.
 *   4. Raise to the zone floor (dungeon >= 2, volcano >= 3).
 *   5. Boss roosts wake the neighbourhood: inside 30u >= 3, inside 16u = 4.
 *
 * Boss roosts are >= 30u from every anchor (engine invariant), so rule 5 can
 * never push a spawn sanctuary above tier 1.
 */
export function tierAt(x: number, y: number, seed = DEFAULT_WORLD_SEED): WorldTier {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 1;
  const anchor = nearestSpawnAnchor(x, y);
  if (anchor === null || anchor.distance <= TIER1_ANCHOR_RADIUS) return 1;

  let tier = 2;
  if (anchor.distance > TIER3_ANCHOR_RADIUS) tier = 4;
  else if (anchor.distance > TIER2_ANCHOR_RADIUS) tier = 3;

  tier = Math.max(tier, TIER_ZONE_FLOOR[getZone(x, y, seed)]);

  const roost = nearestBossRoost(x, y);
  if (roost !== null) {
    if (roost.distance <= TIER_BOSS_CROWN_RADIUS) tier = 4;
    else if (roost.distance < TIER_BOSS_WAKE_RADIUS) tier = Math.max(tier, 3);
  }
  return clampTier(tier);
}

// ---------------------------------------------------------------------------
// Difficulty scaling
// ---------------------------------------------------------------------------

/** The three numbers a caller feeds through the tier curve. */
export type TierStatBase = { hp: number; damage: number; xp: number };

/**
 * Multipliers by tier. Tier 1 is exactly 1 so the documented budget is kept:
 * a meadow minion has 48 HP, hits for 7/1.5s and pays 20 XP at level 1, and a
 * level-1 player still kills it in 4 swings (12 + 3/level, 12 + 0 weapon).
 * Later tiers grow HP fastest (longer fights) and XP faster than damage
 * (the risk is paid back), with hard caps below.
 */
export const TIER_STAT_MULTIPLIERS: Readonly<Record<WorldTier, TierStatBase>> = Object.freeze({
  1: { hp: 1, damage: 1, xp: 1 },
  2: { hp: 1.35, damage: 1.2, xp: 1.3 },
  3: { hp: 1.7, damage: 1.45, xp: 1.7 },
  4: { hp: 2, damage: 1.65, xp: 2.1 },
});

/**
 * Absolute multipliers a caller can never scale past, however big `base` is.
 * They sit at the tier-4 ceiling: a future tier (or a bad caller passing a
 * fractional tier > 4, which clamps down) can never out-scale this curve.
 */
export const TIER_STAT_CAPS: Readonly<TierStatBase> = Object.freeze({ hp: 2, damage: 1.65, xp: 2.1 });

function scaled(base: number, mult: number, cap: number): number {
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.max(1, Math.round(Math.min(base * mult, base * cap)));
}

/**
 * Scale a bundle of mob numbers into a tier. Never mutates `base`; invalid
 * inputs produce 0 rather than NaN so a bad caller cannot poison the wire.
 */
export function tierStats(tier: number, base: TierStatBase): TierStatsView {
  const m = TIER_STAT_MULTIPLIERS[clampTier(tier)];
  return {
    hp: scaled(base.hp, m.hp, TIER_STAT_CAPS.hp),
    damage: scaled(base.damage, m.damage, TIER_STAT_CAPS.damage),
    xp: scaled(base.xp, m.xp, TIER_STAT_CAPS.xp),
  };
}

// ---------------------------------------------------------------------------
// Access gating without walls
// ---------------------------------------------------------------------------

/** Recommended level for each tier (roughly the existing zone level bands). */
export const TIER_LEVEL_FLOOR: Readonly<Record<WorldTier, number>> = Object.freeze({
  1: 1,
  2: 4,
  3: 6,
  4: 8,
});

export const PENALTY_DAMAGE_PER_LEVEL = 0.12;
export const PENALTY_DAMAGE_MAX = 2.5;
export const PENALTY_XP_PER_LEVEL = 0.15;
export const PENALTY_XP_MIN = 0.35;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The "soft wall": a low-level player is never blocked or teleported, but the
 * further below the tier's recommended level they are, the harder they get hit
 * and the less XP they earn. At tier 1, or at/above the floor, both multipliers
 * are exactly 1 — so no existing fight changes.
 */
export function tierPenalty(playerLevel: number, tier: number): TierPenaltyView {
  const t = clampTier(tier);
  const level = Number.isFinite(playerLevel) ? Math.max(1, Math.floor(playerLevel)) : 1;
  const underLevel = Math.max(0, TIER_LEVEL_FLOOR[t] - level);
  return {
    damageTakenMult: round3(Math.min(PENALTY_DAMAGE_MAX, 1 + PENALTY_DAMAGE_PER_LEVEL * underLevel)),
    xpMult: round3(Math.max(PENALTY_XP_MIN, 1 - PENALTY_XP_PER_LEVEL * underLevel)),
    underLevel,
  };
}

/** Apply the incoming-damage half of a penalty (integer, never below 1). */
export function penalizedDamage(amount: number, penalty: TierPenaltyView): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(1, Math.ceil(amount * penalty.damageTakenMult));
}

/** Apply the XP half of a penalty (integer, never negative). */
export function penalizedXp(amount: number, penalty: TierPenaltyView): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(0, Math.floor(amount * penalty.xpMult));
}
