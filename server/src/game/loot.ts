// @aetherfall/gameplay — loot: drop tables + pickup spawn, wired to combat onKill.
// Flow: combat.tryMeleeAttack() reports killed=true -> caller invokes
// applyKillRewards() (quest kill hook + kill XP + drop rolls) -> pickupsForLoot()
// scatters makePickup()s at the corpse. Protocol-safe: callers broadcast the
// returned events as `t:'event'` payloads (no new ServerMsg variants).

import type { ZoneId } from '@aetherfall/engine';
import { makePickup, type ItemStack, type Pickup } from './inventory.js';
import { addXp, onKill, type QuestEvent, type QuestState } from './quests.js';
import { bossZoneFor, chainOnKill, xpForBossKill, xpForKill, type BossName } from './content.js';

export interface DropEntry {
  itemId: string;
  /** Per-kill roll chance in [0, 1]. */
  chance: number;
  min: number;
  max: number;
}

/** Per-mob drop table. Zone tables act as fallback (key `zone:<id>`). */
export const LOOT_TABLE: Record<string, DropEntry[]> = {
  gloomfang: [
    { itemId: 'gloom-fang', chance: 0.65, min: 1, max: 2 },
    { itemId: 'ember-shard', chance: 0.25, min: 1, max: 1 },
    { itemId: 'healing-herb', chance: 0.12, min: 1, max: 1 },
  ],
  mistwisp: [
    { itemId: 'mana-mote', chance: 0.6, min: 1, max: 2 },
    { itemId: 'healing-herb', chance: 0.1, min: 1, max: 1 },
  ],
  thornback: [
    { itemId: 'gloom-fang', chance: 0.4, min: 1, max: 1 },
    { itemId: 'moss-cap', chance: 0.45, min: 1, max: 2 },
    { itemId: 'iron-ore', chance: 0.2, min: 1, max: 1 },
  ],
  'meadow-sprite': [
    { itemId: 'healing-herb', chance: 0.5, min: 1, max: 2 },
    { itemId: 'ember-shard', chance: 0.3, min: 1, max: 1 },
  ],
  ashcrawler: [
    { itemId: 'iron-ore', chance: 0.5, min: 1, max: 2 },
    { itemId: 'moss-cap', chance: 0.35, min: 1, max: 1 },
    { itemId: 'minor-potion', chance: 0.12, min: 1, max: 1 },
  ],
  'hollow-knight': [
    { itemId: 'iron-ore', chance: 0.55, min: 1, max: 2 },
    { itemId: 'ember-axe', chance: 0.04, min: 1, max: 1 },
    { itemId: 'ward-token', chance: 0.1, min: 1, max: 1 },
  ],
  'cinder-imp': [
    { itemId: 'ash-coal', chance: 0.6, min: 1, max: 2 },
    { itemId: 'ember-shard', chance: 0.35, min: 1, max: 2 },
  ],
  'caldera-wyrm': [
    { itemId: 'obsidian-chip', chance: 0.55, min: 1, max: 2 },
    { itemId: 'ash-coal', chance: 0.4, min: 1, max: 2 },
    { itemId: 'deep-halberd', chance: 0.03, min: 1, max: 1 },
  ],
  'void-wisp': [
    { itemId: 'mana-mote', chance: 0.65, min: 1, max: 3 },
    { itemId: 'obsidian-chip', chance: 0.25, min: 1, max: 1 },
  ],
  'magma-golem': [
    { itemId: 'obsidian-chip', chance: 0.7, min: 1, max: 3 },
    { itemId: 'caldera-greatsword', chance: 0.05, min: 1, max: 1 },
    { itemId: 'minor-potion', chance: 0.2, min: 1, max: 1 },
  ],
  // Boss tables: guaranteed material shower + a rare progression weapon
  // (Warden 5% deep-halberd, Wyrm 10% caldera-greatsword). XP is fixed
  // (BOSS_KILL_XP) via applyBossKillRewards, not via these rolls.
  'ember-wyrm': [
    { itemId: 'obsidian-chip', chance: 1.0, min: 2, max: 3 },
    { itemId: 'ash-coal', chance: 0.5, min: 1, max: 2 },
    { itemId: 'caldera-greatsword', chance: 0.1, min: 1, max: 1 },
  ],
  'crypt-warden': [
    { itemId: 'iron-ore', chance: 1.0, min: 1, max: 2 },
    { itemId: 'minor-potion', chance: 0.3, min: 1, max: 1 },
    { itemId: 'deep-halberd', chance: 0.05, min: 1, max: 1 },
  ],
  // Zone fallbacks (used when a mob has no named table).
  'zone:meadow': [{ itemId: 'ember-shard', chance: 0.2, min: 1, max: 1 }],
  'zone:dungeon': [{ itemId: 'moss-cap', chance: 0.25, min: 1, max: 1 }],
  'zone:volcano': [{ itemId: 'ash-coal', chance: 0.3, min: 1, max: 1 }],
};

export function dropsFor(mobName: string, zone: ZoneId): DropEntry[] {
  return LOOT_TABLE[mobName] ?? LOOT_TABLE[`zone:${zone}`] ?? [];
}

/** Roll one kill's drops. Pure; caller owns `rand` (default Math.random). */
export function rollLootForKill(
  mobName: string,
  zone: ZoneId,
  _level: number,
  rand: () => number = Math.random,
): ItemStack[] {
  void _level; // reserved: level-scaled rarities (drop count scales via min/max today)
  const out: ItemStack[] = [];
  for (const d of dropsFor(mobName, zone)) {
    if (rand() < d.chance) {
      const span = d.max - d.min + 1;
      const count = d.min + Math.floor(rand() * span);
      const same = out.find((s) => s.itemId === d.itemId);
      if (same) same.count += count;
      else out.push({ itemId: d.itemId, count });
    }
  }
  return out;
}

/** Scatter pickups around the corpse (deterministic ring when `rand` is seeded). */
export function pickupsForLoot(
  drops: ItemStack[],
  x: number,
  y: number,
  rand: () => number = Math.random,
): Pickup[] {
  return drops.map((d, i) => {
    const angle = rand() * Math.PI * 2 + (i * Math.PI * 2) / Math.max(1, drops.length);
    const r = 0.6 + rand() * 0.8;
    return makePickup(d.itemId, d.count, x + Math.cos(angle) * r, y + Math.sin(angle) * r);
  });
}

export interface KillRewards {
  questEvents: QuestEvent[];
  xp: number;
  drops: ItemStack[];
  pickups: Pickup[];
}

/**
 * Combat onKill wiring: advance base-trio + chain 'kill' quests, grant
 * zone-scaled kill XP (level*100 thresholds via addXp), roll drops + corpse
 * pickups. Call AFTER tryMeleeAttack() returns { ok:true, killed:true }.
 */
export function applyKillRewards(
  state: QuestState,
  mobName: string,
  zone: ZoneId,
  mobLevel: number,
  x: number,
  y: number,
  rand: () => number = Math.random,
): KillRewards {
  const questEvents: QuestEvent[] = [...onKill(state, 1), ...chainOnKill(state, 1)];
  const xp = xpForKill(zone, mobLevel);
  questEvents.push(...addXp(state, xp));
  const drops = rollLootForKill(mobName, zone, mobLevel, rand);
  const pickups = pickupsForLoot(drops, x, y, rand);
  return { questEvents, xp, drops, pickups };
}

// ---------------------------------------------------------------------------
// Boss kills (Ember Wyrm + Crypt Warden)
// ---------------------------------------------------------------------------

/** Boss level per name (informational: rollLootForKill reserves level scaling). */
export const BOSS_LEVEL: Record<BossName, number> = {
  'ember-wyrm': 8,
  'crypt-warden': 5,
};

/**
 * Achievement event for a boss kill. Broadcast by callers as a
 * protocol-v1-safe `t:'event'` with kind `'boss-kill'`.
 */
export interface BossAchievement {
  type: 'boss-kill';
  boss: BossName;
  xp: number;
}

export interface BossKillRewards extends KillRewards {
  boss: BossName;
  achievement: BossAchievement;
}

/**
 * Boss onKill wiring: bosses count for base-trio + chain 'kill' quests, grant
 * fixed BOSS_KILL_XP (200) via addXp, roll the boss drop table -> corpse
 * pickups, and attach a `boss-kill` achievement event.
 */
export function applyBossKillRewards(
  state: QuestState,
  boss: BossName,
  x: number,
  y: number,
  rand: () => number = Math.random,
): BossKillRewards {
  const questEvents: QuestEvent[] = [...onKill(state, 1), ...chainOnKill(state, 1)];
  const xp = xpForBossKill();
  questEvents.push(...addXp(state, xp));
  const drops = rollLootForKill(boss, bossZoneFor(boss), BOSS_LEVEL[boss], rand);
  const pickups = pickupsForLoot(drops, x, y, rand);
  return { questEvents, xp, drops, pickups, boss, achievement: { type: 'boss-kill', boss, xp } };
}
