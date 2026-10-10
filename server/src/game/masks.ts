// @aetherfall/gameplay — masks: 8 wearable relics of the Fall, one equip slot.
// Each mask grants exactly ONE perk. Names, perks and numbers are original —
// Hotline Miami's wearable-mask idea and Tibia's vocation idea are the
// inspiration only; no names or text are reused from either game.
//
// Design contract: PURE data + pure helpers (same rules as systems/*).
// No mutation of inputs, no clocks (callers pass `now`), RNG only via an
// injected `rand`. Perk effects reach the game through two existing lanes:
//   - stat aggregation: `maskEquippedItem()` feeds `aggregateStats()` as an
//     `EquippedItem`, and the multiplicative/boolean perks resolve through
//     typed helpers (`maskMeleeMult`, `maskMuffles`, ...) at their
//     consumption site (`GameSession.meleeDamage`, loot rolls, the tick);
//   - event emission: equip/unequip (and the 1/s wall ping) surface as
//     protocol-v1-safe `t:'event'` payloads built by the helpers below.
//
// Masks are NOT in the shared catalog (which pins exactly 15 items) and NOT
// in `LOOT_TABLE` (which the catalog checker requires to resolve in shared).
// Loot drops roll through `rollMaskDrop()` and are appended to the kill
// rewards by `loot.ts` with a *variable* item id, so the checker's
// `itemId: '...'` literal scan never sees them. The vendor stocks them via
// `content.itemDef()` / `GameSession.vendorStock()`.

import type { EquippedItem, StatBlock } from '../systems/progression.js';

// ---------------------------------------------------------------------------
// Defs (8, one perk each)
// ---------------------------------------------------------------------------

/** The single perk a mask grants. One mask -> exactly one of these. */
export type MaskPerk =
  | 'melee-fury' // +15% melee damage
  | 'silent-steps' // silent footsteps (emits no noise events)
  | 'swift-finish' // faster executions: finish reach +1u (no walk-up)
  | 'long-throw' // longer throw range (+4u)
  | 'wall-ping' // see-through-walls ping every 1s while equipped
  | 'extra-loot' // one extra loot roll on kills
  | 'hazard-ward' // -30% hazard damage taken
  | 'talent-boon'; // +1 talent point while equipped

export interface MaskDef {
  id: string;
  name: string;
  /** Original flavour lane: autor | beast | bird | horn | scale. */
  theme: 'autor' | 'beast' | 'bird' | 'horn' | 'scale';
  perk: MaskPerk;
  description: string;
  /** Vendor price (gold). All masks are tradeable. */
  price: number;
  /** Glyph drawn above the avatar (client mask hook). */
  glyph: string;
}

/** 8 original masks of the Fall. Prices sit above weapons (120-200g). */
export const MASKS: MaskDef[] = [
  {
    id: 'seraph-shard', name: 'Seraph Shard', theme: 'autor', perk: 'melee-fury',
    description: 'A splinter of a fallen author-seraph’s visage. It hums for violence: +15% melee damage.',
    price: 150, glyph: '◈',
  },
  {
    id: 'dusk-maw', name: 'Dusk Maw', theme: 'beast', perk: 'silent-steps',
    description: 'The muzzle of a night-hunting maw-beast. Footsteps make no noise events while worn.',
    price: 120, glyph: '◉',
  },
  {
    id: 'gallow-beak', name: 'Gallow Beak', theme: 'bird', perk: 'swift-finish',
    description: 'A carrion-bird’s beak, still impatient. Executions land from farther out: finish reach +1u.',
    price: 130, glyph: '➶',
  },
  {
    id: 'choir-horn', name: 'Choir Horn', theme: 'horn', perk: 'long-throw',
    description: 'A hollowed choir-horn that carries anything it throws: +4u throw range.',
    price: 130, glyph: '❖',
  },
  {
    id: 'vesper-plume', name: 'Vesper Plume', theme: 'bird', perk: 'wall-ping',
    description: 'An evening-plume that beats once a second. Emits a see-through-walls ping every 1s.',
    price: 160, glyph: '◍',
  },
  {
    id: 'tithe-scale', name: 'Tithe Scale', theme: 'scale', perk: 'extra-loot',
    description: 'A tithe-wyrm’s scale, owed a cut of every kill. Grants one extra loot roll.',
    price: 170, glyph: '⬟',
  },
  {
    id: 'cinder-hide', name: 'Cinder Hide', theme: 'beast', perk: 'hazard-ward',
    description: 'Fire-cured hide from a caldera beast. Hazard damage taken is reduced by 30%.',
    price: 140, glyph: '⬢',
  },
  {
    id: 'halo-rind', name: 'Halo Rind', theme: 'autor', perk: 'talent-boon',
    description: 'The rind of a burnt-out halo. It remembers being more: +1 talent point while worn.',
    price: 200, glyph: '✧',
  },
];

export const MASK_IDS: string[] = MASKS.map((m) => m.id);

const MASK_BY_ID = new Map<string, MaskDef>(MASKS.map((m) => [m.id, m]));

export function maskDef(id: string): MaskDef | undefined {
  return MASK_BY_ID.get(id);
}

export function isMaskId(id: string): boolean {
  return MASK_BY_ID.has(id);
}

export function maskPrice(id: string): number {
  return MASK_BY_ID.get(id)?.price ?? 0;
}

// ---------------------------------------------------------------------------
// Perk tuning (single source of truth; docs/WORLD.md mirrors this table)
// ---------------------------------------------------------------------------

/** +15% melee damage while the fury mask is worn. */
export const MASK_MELEE_MULT = 1.15;
/** Finish reach without / with the swift mask (mirrors FINISH_RANGE 2.2). */
export const FINISH_REACH_BASE = 2.2;
export const MASK_FINISH_BONUS = 1.0;
/** Throw range base and mask bonus (units). */
export const THROW_RANGE_BASE = 6;
export const MASK_THROW_BONUS = 4;
/** Wall-ping cadence while the plume is worn (ms). 0 = no ping. */
export const WALL_PING_INTERVAL_MS = 1000;
/** Extra loot rolls granted by the tithe mask. */
export const MASK_EXTRA_ROLLS = 1;
/** Hazard damage multiplier while the ward mask is worn (-30%). */
export const MASK_HAZARD_MULT = 0.7;
/** Talent points granted while the boon mask is worn. */
export const MASK_TALENT_POINTS = 1;

// ---------------------------------------------------------------------------
// Perk resolution (pure; `null` mask = bare face, every perk off)
// ---------------------------------------------------------------------------

type MaskId = string | null | undefined;

function perkOf(maskId: MaskId): MaskPerk | null {
  if (!maskId) return null;
  return MASK_BY_ID.get(maskId)?.perk ?? null;
}

/** Melee damage multiplier for the equipped mask (1 when bare/unknown). */
export function maskMeleeMult(maskId: MaskId): number {
  return perkOf(maskId) === 'melee-fury' ? MASK_MELEE_MULT : 1;
}

/** True when footsteps emit no noise events. */
export function maskMuffles(maskId: MaskId): boolean {
  return perkOf(maskId) === 'silent-steps';
}

/** Finish reach for the equipped mask (units; feeds `canFinishMob`). */
export function finishReach(base: number, maskId: MaskId): number {
  if (!Number.isFinite(base) || base < 0) return FINISH_REACH_BASE;
  return base + (perkOf(maskId) === 'swift-finish' ? MASK_FINISH_BONUS : 0);
}

/** Throw range for the equipped mask (units). */
export function throwRange(base: number, maskId: MaskId): number {
  if (!Number.isFinite(base) || base < 0) return THROW_RANGE_BASE;
  return base + (perkOf(maskId) === 'long-throw' ? MASK_THROW_BONUS : 0);
}

/** Wall-ping cadence for the equipped mask (ms); 0 = no ping. */
export function wallPingIntervalMs(maskId: MaskId): number {
  return perkOf(maskId) === 'wall-ping' ? WALL_PING_INTERVAL_MS : 0;
}

/** True when a wall ping is due (throttles the 1/s cadence). */
export function wallPingDue(lastPingAt: number, now: number, maskId: MaskId): boolean {
  const interval = wallPingIntervalMs(maskId);
  if (interval <= 0) return false;
  if (!Number.isFinite(lastPingAt)) return true;
  return now - lastPingAt >= interval;
}

/** Extra loot rolls for the equipped mask (0 or 1). */
export function extraLootRolls(maskId: MaskId): number {
  return perkOf(maskId) === 'extra-loot' ? MASK_EXTRA_ROLLS : 0;
}

/** Hazard damage taken with the equipped mask applied. */
export function hazardDamageTaken(base: number, maskId: MaskId): number {
  if (!Number.isFinite(base) || base < 0) return 0;
  return perkOf(maskId) === 'hazard-ward' ? base * MASK_HAZARD_MULT : base;
}

/** Talent points granted while the boon mask is worn (0 or 1). */
export function talentBoon(maskId: MaskId): number {
  return perkOf(maskId) === 'talent-boon' ? MASK_TALENT_POINTS : 0;
}

// ---------------------------------------------------------------------------
// Stat aggregation lane (masks ride `aggregateStats` as `EquippedItem`s)
// ---------------------------------------------------------------------------

/**
 * Additive stat contribution of a mask. Mask perks are multiplicative,
 * boolean or cadence-based (see above), so they have no additive stat
 * expression — but every equipped mask still flows through `aggregateStats`
 * as an `EquippedItem`, which keeps the single-slot equip path on the same
 * aggregation pipeline as weapons and talents.
 */
export function statsForMask(_maskId: string): Partial<StatBlock> {
  return {};
}

/** The `EquippedItem` an equipped mask contributes to `aggregateStats`. */
export function maskEquippedItem(maskId: string): EquippedItem {
  return { itemId: maskId, stats: statsForMask(maskId) };
}

// ---------------------------------------------------------------------------
// Drops: bosses 25%, elites (level 6+) 5%, anything else 0%
// ---------------------------------------------------------------------------

/** Boss mask drop chance per boss kill. */
export const MASK_DROP_BOSS = 0.25;
/** Elite mask drop chance per elite kill. */
export const MASK_DROP_ELITE = 0.05;
/** Elites are non-boss mobs at or above this level (caldera-wyrm 6-8, magma-golem 7-8). */
export const ELITE_MIN_LEVEL = 6;

/** True when a non-boss mob of `level` counts as an elite for mask drops. */
export function isEliteLevel(level: number): boolean {
  return Number.isFinite(level) && Math.floor(level) >= ELITE_MIN_LEVEL;
}

/**
 * Roll one mask drop. Pure; caller owns `rand`. Returns a mask id or null.
 * Bosses roll at 25%, elites at 5%, anything else never drops. The pick is
 * uniform across all 8 masks (second `rand` draw only on a hit, so misses
 * cost exactly one draw and normal-kill loot streams stay aligned).
 */
export function rollMaskDrop(
  rand: () => number,
  opts: { boss?: boolean; elite?: boolean } = {},
): string | null {
  const chance = opts.boss === true ? MASK_DROP_BOSS : opts.elite === true ? MASK_DROP_ELITE : 0;
  if (chance <= 0 || rand() >= chance) return null;
  const pick = Math.floor(rand() * MASKS.length) % MASKS.length;
  return MASKS[pick]!.id;
}

// ---------------------------------------------------------------------------
// Event payloads (protocol-v1-safe `t:'event'` kinds, additive)
// ---------------------------------------------------------------------------

export interface MaskEquippedPayload {
  playerId: number;
  maskId: string;
  perk: MaskPerk;
  glyph: string;
  /** The mask this replaced in the single slot, if any. */
  replaced: string | null;
}

export interface MaskUnequippedPayload {
  playerId: number;
  maskId: string;
  perk: MaskPerk;
}

export function maskEquippedEvent(playerId: number, maskId: string, replaced: string | null): { kind: string; payload: MaskEquippedPayload } {
  const def = maskDef(maskId);
  return {
    kind: 'mask-equipped',
    payload: { playerId, maskId, perk: def?.perk ?? 'melee-fury', glyph: def?.glyph ?? '?', replaced },
  };
}

export function maskUnequippedEvent(playerId: number, maskId: string): { kind: string; payload: MaskUnequippedPayload } {
  const def = maskDef(maskId);
  return {
    kind: 'mask-unequipped',
    payload: { playerId, maskId, perk: def?.perk ?? 'melee-fury' },
  };
}
