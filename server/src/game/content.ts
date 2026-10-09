// @aetherfall/gameplay — world content: zones, mobs, items, weapons, quests.
// Single source of truth for worldgen spawn tables, loot/XP curves, and the
// 5-quest Elder Maren chain. Protocol-safe: plain data + pure helpers only.
// Balance target: TTK 3-5 melee hits vs a same-level player (see docs/WORLD.md).

import type { ZoneId } from '@aetherfall/engine';
import { getZone as engineGetZone } from '@aetherfall/engine';
import { addXp, type QuestEvent, type QuestProgress, type QuestState } from './quests.js';

export type { ZoneId };
export { engineGetZone as getZone };

// ---------------------------------------------------------------------------
// XP curve (canonical threshold lives in quests.ts: level-up at level * 100 XP)
// ---------------------------------------------------------------------------

export { xpForNextLevel } from './quests.js';

/** Zone bonus added to every mob-kill XP payout. */
export const ZONE_XP_BONUS: Record<ZoneId, number> = {
  meadow: 0,
  dungeon: 10,
  volcano: 25,
};

/** XP for killing a mob: 20 + 10/level + zone bonus. */
export function xpForKill(zone: ZoneId, mobLevel: number): number {
  return 20 + mobLevel * 10 + ZONE_XP_BONUS[zone];
}

// ---------------------------------------------------------------------------
// Mob HP scaling by zone (TTK 3-5 hits)
// ---------------------------------------------------------------------------
// Player melee damage (combat.ts): 12 + (level-1)*3 + weapon bonus.
// Expected weapon bonus by zone: meadow +0..2, dungeon +4..6, volcano +8..12.
// mobMaxHp is tuned so hits-to-kill lands on ~4 (see docs/WORLD.md table):

export const ZONE_HP: Record<ZoneId, { base: number; perLevel: number }> = {
  meadow: { base: 36, perLevel: 12 }, // lvl1=48 (4.0 hits @12dmg), lvl2=60 (4.0 @15)
  dungeon: { base: 40, perLevel: 16 }, // lvl3=88 (4.0 @22 w/+4), lvl4=104 (~3.9 @27 w/+6)
  volcano: { base: 50, perLevel: 18 }, // lvl5=140 (~4.4 @32 w/+8), lvl8=194 (~4.4 @44 w/+12)
};

/** Zone-scaled mob max HP. Increases with both zone tier and mob level. */
export function mobMaxHp(zone: ZoneId, level: number): number {
  const { base, perLevel } = ZONE_HP[zone];
  return base + Math.max(1, level) * perLevel;
}

/** Melee damage mirror of combat.damageFor (kept local so content stays dependency-free). */
export function meleeDamageFor(playerLevel: number, weaponBonus = 0): number {
  return 12 + (Math.max(1, playerLevel) - 1) * 3 + weaponBonus;
}

/** Expected hits-to-kill for a same-zone matchup (fractional, ceil for TTK). */
export function hitsToKill(
  zone: ZoneId,
  mobLevel: number,
  playerLevel = mobLevel,
  weaponBonus = 0,
): number {
  const dmg = meleeDamageFor(playerLevel, weaponBonus);
  return mobMaxHp(zone, mobLevel) / Math.max(1, dmg);
}

/** Integer TTK (swings) for a matchup. Balance target: 3-5. */
export function ttkHits(
  zone: ZoneId,
  mobLevel: number,
  playerLevel = mobLevel,
  weaponBonus = 0,
): number {
  return Math.max(1, Math.ceil(hitsToKill(zone, mobLevel, playerLevel, weaponBonus)));
}

/** Typical weapon bonus assumed per zone for balance math. */
export const ZONE_EXPECTED_BONUS: Record<ZoneId, number> = {
  meadow: 0,
  dungeon: 5,
  volcano: 10,
};

// ---------------------------------------------------------------------------
// Mob spawn tables (weights sum per zone; deterministic rolls via seeded RNG)
// ---------------------------------------------------------------------------

export interface MobSpawnEntry {
  name: string;
  levelMin: number;
  levelMax: number;
  weight: number;
}

export const MOB_SPAWN_TABLE: Record<ZoneId, MobSpawnEntry[]> = {
  meadow: [
    { name: 'gloomfang', levelMin: 1, levelMax: 2, weight: 40 },
    { name: 'mistwisp', levelMin: 1, levelMax: 2, weight: 25 },
    { name: 'thornback', levelMin: 1, levelMax: 2, weight: 20 },
    { name: 'meadow-sprite', levelMin: 1, levelMax: 1, weight: 15 },
  ],
  dungeon: [
    { name: 'ashcrawler', levelMin: 3, levelMax: 4, weight: 30 },
    { name: 'thornback', levelMin: 3, levelMax: 5, weight: 25 },
    { name: 'hollow-knight', levelMin: 3, levelMax: 5, weight: 25 },
    { name: 'gloomfang', levelMin: 3, levelMax: 4, weight: 20 },
  ],
  volcano: [
    { name: 'cinder-imp', levelMin: 5, levelMax: 7, weight: 30 },
    { name: 'ashcrawler', levelMin: 5, levelMax: 8, weight: 25 },
    { name: 'caldera-wyrm', levelMin: 6, levelMax: 8, weight: 20 },
    { name: 'void-wisp', levelMin: 5, levelMax: 8, weight: 15 },
    { name: 'magma-golem', levelMin: 7, levelMax: 8, weight: 10 },
  ],
};

export function spawnTableForZone(zone: ZoneId): MobSpawnEntry[] {
  return MOB_SPAWN_TABLE[zone];
}

/** Weighted mob pick + uniform level roll. Pure; caller owns `rand`. */
export function rollSpawnForZone(
  rand: () => number,
  zone: ZoneId,
): { name: string; level: number } {
  const table = MOB_SPAWN_TABLE[zone];
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = rand() * total;
  let entry = table[0]!;
  for (const e of table) {
    r -= e.weight;
    if (r < 0) {
      entry = e;
      break;
    }
  }
  const span = entry.levelMax - entry.levelMin + 1;
  const level = entry.levelMin + Math.floor(rand() * span);
  return { name: entry.name, level };
}

// ---------------------------------------------------------------------------
// Items (10) + weapons (5 with stats)
// ---------------------------------------------------------------------------

export type ItemKind = 'consumable' | 'material' | 'quest' | 'weapon';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  description: string;
  /** Vendor price (gold). 0 = unsellable quest token. */
  price: number;
  /** HP restored on use (consumables). */
  heal?: number;
}

/** 10 stackable world items (materials, consumables, quest tokens). */
export const ITEMS: ItemDef[] = [
  { id: 'ember-shard', name: 'Ember Shard', kind: 'material', description: 'Warm glass from the ward-stones. Quest & crafting stock.', price: 5 },
  { id: 'gloom-fang', name: 'Gloom Fang', kind: 'material', description: 'Trophy tooth. Proof of meadow culls.', price: 4 },
  { id: 'moss-cap', name: 'Moss Cap', kind: 'material', description: 'Deep-highland fungus, alchemists pay well.', price: 6 },
  { id: 'healing-herb', name: 'Healing Herb', kind: 'consumable', description: 'Chewy meadow greens. Restores 25 HP.', price: 8, heal: 25 },
  { id: 'minor-potion', name: 'Minor Potion', kind: 'consumable', description: 'Maren\'s brew. Restores 50 HP.', price: 15, heal: 50 },
  { id: 'mana-mote', name: 'Mana Mote', kind: 'material', description: 'Wisp residue. Faintly humming.', price: 7 },
  { id: 'iron-ore', name: 'Iron Ore', kind: 'material', description: 'Highland pickings for the smith.', price: 6 },
  { id: 'ash-coal', name: 'Ash Coal', kind: 'material', description: 'Caldera fuel. Burns blue-white.', price: 9 },
  { id: 'obsidian-chip', name: 'Obsidian Chip', kind: 'material', description: 'Volcano glass. Sharp enough to shave with.', price: 12 },
  { id: 'ward-token', name: 'Ward Token', kind: 'quest', description: 'Elder Maren\'s mark. Merchants trade fair with its bearer.', price: 0 },
];

export interface WeaponDef extends ItemDef {
  kind: 'weapon';
  /** Flat melee damage bonus (adds to combat.damageFor). */
  damage: number;
  /** Minimum player level to wield. */
  levelReq: number;
  /** Zone where it drops / is earned. */
  zone: ZoneId;
}

/** 5 weapons, damage-bonus progression +4 .. +12. */
export const WEAPONS: WeaponDef[] = [
  { id: 'wisp-touched-dagger', name: 'Wisp-Touched Dagger', kind: 'weapon', description: 'Fast, faintly glowing. Starter sidearm.', price: 20, damage: 4, levelReq: 1, zone: 'meadow' },
  { id: 'ward-blade', name: 'Ward Blade', kind: 'weapon', description: 'Maren\'s armory blade. Reward for lighting the ward-stones.', price: 40, damage: 6, levelReq: 1, zone: 'meadow' },
  { id: 'ember-axe', name: 'Ember Axe', kind: 'weapon', description: 'Highland steel with a coal-red edge.', price: 80, damage: 8, levelReq: 3, zone: 'dungeon' },
  { id: 'deep-halberd', name: 'Deep Halberd', kind: 'weapon', description: 'Hollow-knight polearm, reforged for hands.', price: 120, damage: 10, levelReq: 4, zone: 'dungeon' },
  { id: 'caldera-greatsword', name: 'Caldera Greatsword', kind: 'weapon', description: 'Obsidian-edged slab from the volcano heart.', price: 200, damage: 12, levelReq: 5, zone: 'volcano' },
];

export function itemDef(id: string): ItemDef | WeaponDef | undefined {
  return WEAPONS.find((w) => w.id === id) ?? ITEMS.find((i) => i.id === id);
}

export function weaponDef(id: string): WeaponDef | undefined {
  return WEAPONS.find((w) => w.id === id);
}

/** All droppable/lootable ids (items + weapons). */
export const ALL_ITEM_IDS: string[] = [...ITEMS.map((i) => i.id), ...WEAPONS.map((w) => w.id)];

// ---------------------------------------------------------------------------
// Quest chain (5, linear) with Elder Maren dialogue hooks
// ---------------------------------------------------------------------------

export type ChainQuestKind = 'kill' | 'collect' | 'explore';

export interface ChainQuest {
  id: string;
  name: string;
  kind: ChainQuestKind;
  goal: number;
  rewardXp: number;
  rewardItem?: string;
  /** Elder Maren dialogue node that offers this quest (see ai/dialogue.ts). */
  dialogueNode: string;
  /** Previous quest id that must be done first (undefined = chain start). */
  prerequisite?: string;
  zone: ZoneId;
  briefing: string;
}

export const QUEST_CHAIN: ChainQuest[] = [
  {
    id: 'ward-spark',
    name: 'Ward-Spark',
    kind: 'kill',
    goal: 3,
    rewardXp: 40,
    dialogueNode: 'quest_offer',
    zone: 'meadow',
    briefing: 'Rekindle the road: drive off 3 meadow gloomfangs for Elder Maren.',
  },
  {
    id: 'ember-road',
    name: 'Ember Road',
    kind: 'collect',
    goal: 5,
    rewardXp: 60,
    dialogueNode: 'ember_road',
    prerequisite: 'ward-spark',
    zone: 'meadow',
    briefing: 'Gather 5 ember-shards along the old road.',
  },
  {
    id: 'deep-delvers',
    name: 'Deep Delvers',
    kind: 'kill',
    goal: 6,
    rewardXp: 90,
    dialogueNode: 'deep_delvers',
    prerequisite: 'ember-road',
    zone: 'dungeon',
    briefing: 'Cull 6 Hollow Deep delvers (ashcrawlers, thornbacks, hollow-knights).',
  },
  {
    id: 'chart-the-fall',
    name: 'Chart the Fall',
    kind: 'explore',
    goal: 4,
    rewardXp: 120,
    dialogueNode: 'chart_fall',
    prerequisite: 'deep-delvers',
    zone: 'dungeon',
    briefing: 'Chart 4 new chunks beyond the highlands.',
  },
  {
    id: 'heart-of-fall',
    name: 'Heart of the Fall',
    kind: 'kill',
    goal: 8,
    rewardXp: 200,
    rewardItem: 'ward-blade',
    dialogueNode: 'heart_fall',
    prerequisite: 'chart-the-fall',
    zone: 'volcano',
    briefing: 'Face the Ashfall Caldera: fell 8 volcano horrors. Maren promises the Ward Blade.',
  },
];

/** Quest id -> Elder Maren dialogue node (dialogue hook map). */
export const QUEST_DIALOGUE: Record<string, string> = Object.fromEntries(
  QUEST_CHAIN.map((q) => [q.id, q.dialogueNode]),
);

export function chainQuest(id: string): ChainQuest | undefined {
  return QUEST_CHAIN.find((q) => q.id === id);
}

/** True when `questId`'s prerequisite (if any) is done. Chain start is always open. */
export function isQuestUnlocked(
  questId: string,
  isDone: (id: string) => boolean,
): boolean {
  const q = chainQuest(questId);
  if (!q) return false;
  if (!q.prerequisite) return true;
  return isDone(q.prerequisite);
}

// ---------------------------------------------------------------------------
// Chain progress (prerequisite-gated; base trio in quests.ts is untouched)
// ---------------------------------------------------------------------------
// Chain quests live in the same QuestState.progress map (keyed by quest id)
// but advance ONLY via the chain* helpers below, which respect prerequisite
// order: a quest accrues progress solely while unlocked (all prereqs done)
// and not yet done. Completion auto-grants rewardXp via addXp (level*100
// thresholds with carry-over, shared with the base trio).

/** Seed chain progress entries (idempotent; keeps base-trio entries intact). */
export function ensureChainProgress(state: QuestState): void {
  for (const q of QUEST_CHAIN) {
    if (!state.progress[q.id]) {
      state.progress[q.id] = { questId: q.id, count: 0, done: false, claimed: false };
    }
  }
}

function chainBump(state: QuestState, questId: string, by: number): QuestEvent[] {
  const q = chainQuest(questId);
  if (!q || by <= 0) return [];
  ensureChainProgress(state);
  const p: QuestProgress | undefined = state.progress[questId];
  if (!p || p.done) return [];
  if (q.prerequisite && !state.progress[q.prerequisite]?.done) return [];
  p.count = Math.min(q.goal, p.count + by);
  const out: QuestEvent[] = [{ type: 'progress', questId, count: p.count, goal: q.goal }];
  if (p.count >= q.goal) {
    p.done = true;
    out.push({ type: 'complete', questId, rewardXp: q.rewardXp });
    out.push(...addXp(state, q.rewardXp));
  }
  return out;
}

/** Advance unlocked chain 'kill' quests (call alongside quests.onKill). */
export function chainOnKill(state: QuestState, kills = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const q of QUEST_CHAIN) if (q.kind === 'kill') out.push(...chainBump(state, q.id, kills));
  return out;
}

/** Advance unlocked chain 'collect' quests (call alongside quests.onCollect). */
export function chainOnCollect(state: QuestState, count = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const q of QUEST_CHAIN) if (q.kind === 'collect') out.push(...chainBump(state, q.id, count));
  return out;
}

/**
 * Advance unlocked chain 'explore' quests for distinct new chunks.
 * Mirrors quests.onExplore semantics: caller-owned `seen` set, spawn chunk free.
 */
export function chainOnExplore(state: QuestState, seen: Set<string>, chunkKey: string): QuestEvent[] {
  if (seen.has(chunkKey)) return [];
  seen.add(chunkKey);
  ensureChainProgress(state);
  const out: QuestEvent[] = [];
  for (const q of QUEST_CHAIN) {
    if (q.kind !== 'explore') continue;
    if (q.prerequisite && !state.progress[q.prerequisite]?.done) continue;
    const p = state.progress[q.id];
    if (!p || p.done) continue;
    const target = Math.min(q.goal, Math.max(0, seen.size - 1));
    if (target > p.count) out.push(...chainBump(state, q.id, target - p.count));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boss kills: Ember Wyrm (volcano) + Crypt Warden (dungeon)
// ---------------------------------------------------------------------------
// Fixed 200 XP per boss kill (well above any single mob payout) plus a
// `boss-kill` achievement event (see loot.applyBossKillRewards). Boss HP is
// tuned for a 60-90s duo: raw duo DPS = players * dmg / swing, discounted by
// ~50% uptime for dodging telegraphs, plus Warden shield/add overhead.

export type BossName = 'ember-wyrm' | 'crypt-warden';

/** Fixed XP for any boss kill. */
export const BOSS_KILL_XP = 200;

export function xpForBossKill(): number {
  return BOSS_KILL_XP;
}

/** Home zone per boss (drives fallback loot + balance matchup). */
export const BOSS_ZONE: Record<BossName, ZoneId> = {
  'ember-wyrm': 'volcano',
  'crypt-warden': 'dungeon',
};

export function bossZoneFor(boss: BossName): ZoneId {
  return BOSS_ZONE[boss];
}

/** Melee swing period (mirrors combat.ATTACK_COOLDOWN_MS; kept local, see above). */
export const MELEE_SWING_SEC = 0.8;

/**
 * Estimated duo TTK (seconds) vs a boss: raw duo DPS discounted by `uptime`
 * (fraction of time actually swinging; default 0.5 for telegraph dodging).
 * Balance target: 60-90s. E.g. Wyrm 3200 HP @ lvl7/+10 = 64s;
 * Warden 2200 HP @ lvl4/+6 = 65s + ~12s shields + add cleanup.
 */
export function bossDuoTtkSec(
  maxHp: number,
  playerLevel: number,
  weaponBonus: number,
  players = 2,
  uptime = 0.5,
): number {
  const dps = (players * meleeDamageFor(playerLevel, weaponBonus)) / MELEE_SWING_SEC;
  return maxHp / Math.max(1e-9, dps * uptime);
}
