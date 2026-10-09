// @aetherfall/systems — progression: XP curve, talent points, the 3-branch skill
// tree (might / guile / will, 5 nodes each), respec cost, and stat aggregation
// from base + talents + equipped items.
//
// Design contract: PURE functions. State in -> new state + events out.
// No mutation of inputs, no clocks (callers pass `now`), no RNG.

import type { ItemDef, WeaponDef } from '../game/content.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const MAX_LEVEL = 60;

/** XP needed to go from `level` to `level+1`: 50 * L * (L+1). */
export function xpToNextLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return 50 * l * (l + 1);
}

/** Total XP accumulated from level 1 to `level` (for dashboards/tests). */
export function cumulativeXpForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  let total = 0;
  for (let i = 1; i < l; i++) total += xpToNextLevel(i);
  return total;
}

/** Talent points granted by reaching `level` (1/level + bonus every 5th). */
export function talentPointsForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return l + Math.floor(l / 5);
}

/**
 * Respec price: `100 * level^2` gold, x1.5 per repeat respec in the same session.
 * Quadratic keeps it flat early (100 at level 1) and meaningful at the cap
 * (360,000 at level 60) without ever exploding into 5-digit exponents.
 */
export const RESPEC_BASE_GOLD = 100;
export const RESPEC_REPEAT_MULT = 1.5;

export function respecCost(level: number, respecCount = 0): number {
  const l = Math.max(1, Math.floor(level));
  const c = Math.max(0, Math.floor(respecCount));
  return Math.ceil(RESPEC_BASE_GOLD * l * l * Math.pow(RESPEC_REPEAT_MULT, c));
}

/** Stat floor/ceiling clamps applied after aggregation. */
export const STAT_MIN = 0;
export const STAT_MAX = 999;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export type StatBlock = {
  /** Primary attributes. */
  might: number;
  guile: number;
  will: number;
  /** Derived pools. */
  maxHp: number;
  maxMp: number;
  /** Combat. */
  attackPower: number;
  spellPower: number;
  critChance: number;
  critMultiplier: number;
  attackSpeed: number;
  moveSpeed: number;
  blockChance: number;
  blockReduction: number;
  /** Sustain. */
  hpRegen: number;
  mpRegen: number;
};

export const STAT_KEYS: (keyof StatBlock)[] = [
  'might',
  'guile',
  'will',
  'maxHp',
  'maxMp',
  'attackPower',
  'spellPower',
  'critChance',
  'critMultiplier',
  'attackSpeed',
  'moveSpeed',
  'blockChance',
  'blockReduction',
  'hpRegen',
  'mpRegen',
];

/** Level-1 naked character. */
export const BASE_STATS: StatBlock = {
  might: 10,
  guile: 10,
  will: 10,
  maxHp: 100,
  maxMp: 50,
  attackPower: 0,
  spellPower: 0,
  critChance: 0.05,
  critMultiplier: 1.5,
  attackSpeed: 1,
  moveSpeed: 4,
  blockChance: 0,
  blockReduction: 0,
  hpRegen: 1,
  mpRegen: 1,
};

/** Per-level growth (added on every level-up, before items/talents). */
export const PER_LEVEL_STATS: StatBlock = {
  might: 2,
  guile: 2,
  will: 2,
  maxHp: 12,
  maxMp: 6,
  attackPower: 1,
  spellPower: 1,
  critChance: 0,
  critMultiplier: 0,
  attackSpeed: 0,
  moveSpeed: 0,
  blockChance: 0,
  blockReduction: 0,
  hpRegen: 0.1,
  mpRegen: 0.1,
};

export function emptyStatBlock(): StatBlock {
  return Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as unknown as StatBlock;
}

/** Add two stat blocks. Fractional stats are preserved; negatives allowed. */
export function addStats(a: StatBlock, b: Partial<StatBlock>): StatBlock {
  const out = emptyStatBlock();
  for (const k of STAT_KEYS) {
    out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

/** Scale a stat block (for percentage effects). */
export function scaleStats(a: StatBlock, factor: number): StatBlock {
  const out = emptyStatBlock();
  for (const k of STAT_KEYS) out[k] = (a[k] ?? 0) * factor;
  return out;
}

function clampStat(key: keyof StatBlock, value: number): number {
  const v = Number.isFinite(value) ? value : 0;
  return Math.min(STAT_MAX, Math.max(STAT_MIN, v));
}

/** Round for wire safety: keeps 4 decimals on fractional stats, ints on HP/MP. */
export function roundStats(a: StatBlock): StatBlock {
  const out = emptyStatBlock();
  for (const k of STAT_KEYS) {
    const v = a[k] ?? 0;
    out[k] = k === 'maxHp' || k === 'maxMp' || k === 'attackPower' || k === 'spellPower' || k === 'hpRegen' || k === 'mpRegen'
      ? Math.round(v)
      : Math.round(v * 10000) / 10000;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skill tree: 3 branches x 5 tiers
// ---------------------------------------------------------------------------

export type Branch = 'might' | 'guile' | 'will';

export const BRANCHES: Branch[] = ['might', 'guile', 'will'];

export type SkillNode = {
  id: string;
  branch: Branch;
  /** 1..5, the tier in the branch. */
  tier: number;
  name: string;
  description: string;
  /** Max ranks purchasable in this node. */
  maxRank: number;
  /** Talent points cost per rank (usually 1). */
  costPerRank: number;
  /** Prerequisite node ids — all must be at `requireRank` first. */
  requires: { nodeId: string; rank: number }[];
  /** Per-rank stat effects. */
  perRank: Partial<StatBlock>;
};

/** 15 nodes: 5 tiers per branch, each tier gated on the one before it. */
export const SKILL_TREE: SkillNode[] = [
  // --- MIGHT (tank / bruiser) ---
  { id: 'might-1', branch: 'might', tier: 1, name: 'Braced Stance', description: 'Steady the feet. +2 might, +10 max HP.', maxRank: 3, costPerRank: 1, requires: [], perRank: { might: 2, maxHp: 10 } },
  { id: 'might-2', branch: 'might', tier: 2, name: 'Iron Skin', description: 'Hide like plate. +8 max HP, +0.2 hp regen.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'might-1', rank: 1 }], perRank: { maxHp: 8, hpRegen: 0.2 } },
  { id: 'might-3', branch: 'might', tier: 3, name: 'Shield Wall', description: 'Raise the guard. +5% block chance.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'might-2', rank: 1 }], perRank: { blockChance: 0.05 } },
  { id: 'might-4', branch: 'might', tier: 4, name: 'Bonebreaker', description: 'Crushing blow. +3 attack power.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'might-3', rank: 2 }], perRank: { attackPower: 3 } },
  { id: 'might-5', branch: 'might', tier: 5, name: 'Aegis Ascendant', description: 'Untouchable. +10% block reduction, +15 max HP.', maxRank: 1, costPerRank: 2, requires: [{ nodeId: 'might-4', rank: 2 }], perRank: { blockReduction: 0.1, maxHp: 15 } },

  // --- GUILE (rogue / scout) ---
  { id: 'guile-1', branch: 'guile', tier: 1, name: 'Light Step', description: 'Move like smoke. +2 guile, +0.1 move speed.', maxRank: 3, costPerRank: 1, requires: [], perRank: { guile: 2, moveSpeed: 0.1 } },
  { id: 'guile-2', branch: 'guile', tier: 2, name: 'Keen Eye', description: 'Spot the gap. +2% crit chance.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'guile-1', rank: 1 }], perRank: { critChance: 0.02 } },
  { id: 'guile-3', branch: 'guile', tier: 3, name: 'Duelist', description: 'Relentless. +3% attack speed, +2 attack power.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'guile-2', rank: 1 }], perRank: { attackSpeed: 0.03, attackPower: 2 } },
  { id: 'guile-4', branch: 'guile', tier: 4, name: 'Executioner', description: 'Finish the wounded. +0.15 crit multiplier.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'guile-3', rank: 2 }], perRank: { critMultiplier: 0.15 } },
  { id: 'guile-5', branch: 'guile', tier: 5, name: 'Ghostblade', description: 'Vanish and strike. +6% crit chance, +0.2 move speed.', maxRank: 1, costPerRank: 2, requires: [{ nodeId: 'guile-4', rank: 2 }], perRank: { critChance: 0.06, moveSpeed: 0.2 } },

  // --- WILL (caster / healer) ---
  { id: 'will-1', branch: 'will', tier: 1, name: 'Inner Light', description: 'Steady the mind. +2 will, +10 max MP.', maxRank: 3, costPerRank: 1, requires: [], perRank: { will: 2, maxMp: 10 } },
  { id: 'will-2', branch: 'will', tier: 2, name: 'Deep Well', description: 'Tireless reservoir. +8 max MP, +0.2 mp regen.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'will-1', rank: 1 }], perRank: { maxMp: 8, mpRegen: 0.2 } },
  { id: 'will-3', branch: 'will', tier: 3, name: 'Warded Mind', description: 'Bend the spell. +3 spell power.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'will-2', rank: 1 }], perRank: { spellPower: 3 } },
  { id: 'will-4', branch: 'will', tier: 4, name: 'Sustenance', description: 'Knit flesh. +2 hp regen, +10 max HP.', maxRank: 3, costPerRank: 1, requires: [{ nodeId: 'will-3', rank: 2 }], perRank: { hpRegen: 2, maxHp: 10 } },
  { id: 'will-5', branch: 'will', tier: 5, name: 'Archon', description: 'Ascendant focus. +8 spell power, +0.5 mp regen.', maxRank: 1, costPerRank: 2, requires: [{ nodeId: 'will-4', rank: 2 }], perRank: { spellPower: 8, mpRegen: 0.5 } },
];

const NODE_BY_ID = new Map<string, SkillNode>(SKILL_TREE.map((n) => [n.id, n]));

export function skillNode(id: string): SkillNode | undefined {
  return NODE_BY_ID.get(id);
}

export function nodesInBranch(branch: Branch): SkillNode[] {
  return SKILL_TREE.filter((n) => n.branch === branch).sort((a, b) => a.tier - b.tier);
}

/**
 * Structural test helper: every node's prerequisites must exist and sit in the
 * same branch at a strictly lower tier. Used by the test suite.
 */
export function validateSkillTree(): string[] {
  const errors: string[] = [];
  for (const n of SKILL_TREE) {
    if (n.tier < 1 || n.tier > 5) errors.push(`${n.id}: bad tier ${n.tier}`);
    if (!BRANCHES.includes(n.branch)) errors.push(`${n.id}: bad branch ${n.branch}`);
    for (const req of n.requires) {
      const r = NODE_BY_ID.get(req.nodeId);
      if (!r) {
        errors.push(`${n.id}: missing prereq ${req.nodeId}`);
        continue;
      }
      if (r.branch !== n.branch) errors.push(`${n.id}: prereq ${req.nodeId} is cross-branch`);
      if (r.tier >= n.tier) errors.push(`${n.id}: prereq ${req.nodeId} tier ${r.tier} >= ${n.tier}`);
      if (req.rank < 1 || req.rank > r.maxRank) errors.push(`${n.id}: prereq rank ${req.rank} out of range`);
    }
  }
  for (const b of BRANCHES) {
    const ns = nodesInBranch(b);
    if (ns.length !== 5) errors.push(`branch ${b}: expected 5 nodes, got ${ns.length}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Progression state
// ---------------------------------------------------------------------------

export type ProgressionState = {
  level: number;
  xp: number; // xp toward the NEXT level
  talentPoints: number;
  /** nodeId -> purchased rank. */
  talents: Record<string, number>;
  /** Total points ever spent (refunded in full on respec). */
  spentPoints: number;
  /** Number of respecs performed (escalates the price). */
  respecCount: number;
};

export function createProgression(level = 1): ProgressionState {
  const l = Math.max(1, Math.floor(level));
  return { level: l, xp: 0, talentPoints: talentPointsForLevel(l), talents: {}, spentPoints: 0, respecCount: 0 };
}

export type ProgressionEvent =
  | { type: 'xp-gained'; amount: number; level: number; xp: number; needed: number }
  | { type: 'level-up'; level: number; talentPointsGained: number }
  | { type: 'talent-learned'; nodeId: string; rank: number; branch: Branch; remainingPoints: number }
  | { type: 'respec'; cost: number; refundedPoints: number; clearedNodes: string[] };

/**
 * Grant XP and roll over level-ups. Multi-level XP grants are supported; each
 * level-up hands out `talentPointsForLevel(l) - talentPointsForLevel(l-1)` points
 * (1, plus a bonus at every 5th level). Capped at MAX_LEVEL.
 */
export function addXp(state: ProgressionState, amount: number): { state: ProgressionState; events: ProgressionEvent[] } {
  if (amount <= 0) return { state, events: [] };
  const events: ProgressionEvent[] = [];
  let next: ProgressionState = { ...state, talents: { ...state.talents } };
  next.xp += Math.floor(amount);
  events.push({ type: 'xp-gained', amount: Math.floor(amount), level: next.level, xp: next.xp, needed: xpToNextLevel(next.level) });
  while (next.level < MAX_LEVEL && next.xp >= xpToNextLevel(next.level)) {
    next.xp -= xpToNextLevel(next.level);
    next.level += 1;
    const gained = talentPointsForLevel(next.level) - talentPointsForLevel(next.level - 1);
    next.talentPoints += gained;
    events.push({ type: 'level-up', level: next.level, talentPointsGained: gained });
  }
  if (next.level >= MAX_LEVEL) next.xp = Math.min(next.xp, xpToNextLevel(MAX_LEVEL));
  return { state: next, events };
}

export type LearnResult =
  | { ok: true; state: ProgressionState; events: ProgressionEvent[] }
  | { ok: false; reason: 'unknown-node' | 'maxed' | 'no-points' | 'prereq'; detail?: string };

/**
 * Spend points on one rank of a node. Validates: node exists, rank < maxRank,
 * all prerequisites met at the required rank, and enough points for the cost.
 */
export function learnNode(state: ProgressionState, nodeId: string): LearnResult {
  const node = NODE_BY_ID.get(nodeId);
  if (!node) return { ok: false, reason: 'unknown-node' };
  const rank = state.talents[nodeId] ?? 0;
  if (rank >= node.maxRank) return { ok: false, reason: 'maxed' };
  for (const req of node.requires) {
    if ((state.talents[req.nodeId] ?? 0) < req.rank) {
      return { ok: false, reason: 'prereq', detail: `${req.nodeId} rank ${req.rank}` };
    }
  }
  if (state.talentPoints < node.costPerRank) return { ok: false, reason: 'no-points' };
  const next: ProgressionState = {
    ...state,
    talents: { ...state.talents, [nodeId]: rank + 1 },
    talentPoints: state.talentPoints - node.costPerRank,
    spentPoints: state.spentPoints + node.costPerRank,
  };
  const events: ProgressionEvent[] = [
    { type: 'talent-learned', nodeId, rank: rank + 1, branch: node.branch, remainingPoints: next.talentPoints },
  ];
  return { ok: true, state: next, events };
}

/**
 * Wipe all talents. Costs `respecCost(level, respecCount)` gold (charged by the
 * caller) and refunds every spent point.
 */
export function respec(state: ProgressionState, gold: number): LearnResult {
  const cost = respecCost(state.level, state.respecCount);
  if (state.spentPoints === 0) return { ok: false, reason: 'maxed', detail: 'no-talents' };
  if (gold < cost) return { ok: false, reason: 'no-points', detail: `cost ${cost}` };
  const clearedNodes = Object.keys(state.talents).filter((k) => (state.talents[k] ?? 0) > 0);
  const next: ProgressionState = {
    ...state,
    talents: {},
    talentPoints: state.talentPoints + state.spentPoints,
    spentPoints: 0,
    respecCount: state.respecCount + 1,
  };
  const events: ProgressionEvent[] = [
    { type: 'respec', cost, refundedPoints: state.spentPoints, clearedNodes },
  ];
  return { ok: true, state: next, events };
}

// ---------------------------------------------------------------------------
// Item stat extraction + aggregation
// ---------------------------------------------------------------------------

/**
 * Items contribute stats through this shape — either pre-extracted
 * `stats`, or derived from a content `ItemDef`/`WeaponDef` (weapons get
 * `attackPower` from `damage`; `heal` items get no passive stat).
 */
export type EquippedItem = {
  itemId: string;
  stats?: Partial<StatBlock>;
};

/** Derive a stat block contribution from a content item definition. */
export function statsForItem(def: ItemDef | WeaponDef): Partial<StatBlock> {
  if ((def as WeaponDef).damage !== undefined) {
    return { attackPower: (def as WeaponDef).damage };
  }
  return {};
}

/**
 * Aggregate the FINAL stat block for a character:
 *   base + per-level * (level-1) + talents + items
 * then clamped + rounded. `items` may carry explicit `stats` (armor, rings)
 * and/or a content def-derived contribution.
 */
export function aggregateStats(
  level: number,
  talents: Record<string, number>,
  items: EquippedItem[] = [],
  base: StatBlock = BASE_STATS,
): StatBlock {
  const l = Math.max(1, Math.floor(level));
  let total = addStats(base, scaleStats(PER_LEVEL_STATS, l - 1));

  // talents
  for (const [nodeId, rank] of Object.entries(talents)) {
    const r = Math.max(0, Math.floor(rank));
    if (r === 0) continue;
    const node = NODE_BY_ID.get(nodeId);
    if (!node) continue;
    total = addStats(total, scaleStats({ ...emptyStatBlock(), ...node.perRank }, r));
  }

  // items
  for (const item of items) {
    if (item.stats) total = addStats(total, item.stats);
  }

  // clamp + round for the wire
  const out = emptyStatBlock();
  for (const k of STAT_KEYS) out[k] = roundStats({ ...out, [k]: clampStat(k, total[k]) })[k];
  return out;
}

// ---------------------------------------------------------------------------
// Item catalog helper (used by integration/tests to price a full loadout)
// ---------------------------------------------------------------------------

/** Quick power score for sorting/display; not used in combat math. */
export function powerScore(stats: StatBlock): number {
  return Math.round(stats.attackPower * 3 + stats.spellPower * 3 + stats.maxHp * 0.5 + stats.maxMp * 0.2);
}