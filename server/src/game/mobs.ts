// @aetherfall/gameplay — unified mob entity-id namespaces + snapshot merge.
//
// Two mob systems exist for different jobs; both publish `kind:'mob'` snapshots:
//   * Spawner (game/spawner.ts) — deterministic, event-based world mobs spawned
//     from engine worldgen tiles. Ids in [MOB_ID_MIN, MOB_ID_MAX].
//   * NPCManager (ai/npc.ts) — snapshot-based brains: 3 FSM+BT minions + 2 bosses
//     ticked at 10Hz. Ids in [NPC_ID_MIN, NPC_ID_MAX].
// Players own small ids [1, NPC_ID_MIN); pickups live at >= PICKUP_ID_MIN.
// Ranges are disjoint by construction; unifiedMobSnapshot() merges both sources
// and throws in dev/tests if a collision is ever detected.

import type { EntitySnapshot } from '@aetherfall/shared';
import type { Mob } from './combat.js';
import type { Spawner } from './spawner.js';
import type { NPCManager } from '../ai/npc.js';

/** Player ids: server assigns 1,2,3... — must stay below NPC range. */
export const PLAYER_ID_MAX = 899_999;

/** AI brains (minions + golem/wisp bosses). */
export const NPC_ID_MIN = 900_000;
export const NPC_ID_MAX = 999_999;

/** Deterministic world mobs (chunkIdBase() output). */
export const MOB_ID_MIN = 1_000_000;
export const MOB_ID_MAX = 1_999_999;

/** World pickup entities (inventory.ts). */
export const PICKUP_ID_MIN = 2_000_000;

export function isPlayerId(id: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= PLAYER_ID_MAX;
}

export function isNpcId(id: number): boolean {
  return Number.isInteger(id) && id >= NPC_ID_MIN && id <= NPC_ID_MAX;
}

export function isSpawnerMobId(id: number): boolean {
  return Number.isInteger(id) && id >= MOB_ID_MIN && id <= MOB_ID_MAX;
}

export function isPickupId(id: number): boolean {
  return Number.isInteger(id) && id >= PICKUP_ID_MIN;
}

/** Convert one spawner mob to its protocol snapshot form. Dead mobs awaiting respawn are hidden. */
export function spawnerMobSnapshot(m: Mob): EntitySnapshot | null {
  if (!m.alive) return null;
  return {
    id: m.id,
    kind: 'mob',
    p: { x: m.pos.x, y: m.pos.y },
    v: { x: 0, y: 0 },
    hp: m.hp,
    maxHp: m.maxHp,
    name: m.name,
    level: m.level,
  };
}

/** All visible spawner mobs as snapshots. */
export function spawnerSnapshot(spawner: Spawner): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  for (const m of spawner.mobsList()) {
    const s = spawnerMobSnapshot(m);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Merge spawner mobs + AI NPCs/bosses into one `kind:'mob'` list.
 * Throws on id collision (namespace bug) so tests/CI catch regressions.
 */
export function unifiedMobSnapshot(spawner: Spawner, npcs: NPCManager): EntitySnapshot[] {
  const out = spawnerSnapshot(spawner);
  const seen = new Set<number>(out.map((e) => e.id));
  for (const e of npcs.snapshot()) {
    if (seen.has(e.id)) {
      throw new Error(`[mobs] entity id collision: ${e.id} (${e.name ?? 'npc'}) already present`);
    }
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Assert a full snapshot has unique ids across players+mobs+pickups. Returns count. */
export function assertUniqueSnapshotIds(entities: EntitySnapshot[]): number {
  const seen = new Set<number>();
  for (const e of entities) {
    if (seen.has(e.id)) throw new Error(`[mobs] duplicate snapshot id: ${e.id}`);
    seen.add(e.id);
  }
  return seen.size;
}
