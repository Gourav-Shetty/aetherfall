// @aetherfall/engine — spawn anchors: the ONE list of places a player can
// appear in the world.
//
// PLAYABILITY (spawn safety) used to be split across two files that could
// disagree: the spawner kept a hand-written `SPAWN_SAFE_POINTS` list of
// no-mob discs, while the sim placed a joining player with a scattered
// formula (`10 + (id*7)%80`). Player 1 landed at (17,23) — outside every
// declared safe disc — so the whole "no mob pile on login" feature was
// exercised only by tests that spawned at the protected origin and was dead
// in production.
//
// This module is the single source of truth. Both sides read it:
//   * `Sim.addPlayer` picks an anchor when no explicit x/y is passed
//     (server/src/sim.ts), so the join path lands inside a safe disc by
//     construction instead of by luck.
//   * `game/spawner.ts` derives `SPAWN_SAFE_POINTS` from `SPAWN_ANCHORS`, so a
//     new anchor is a safe disc and a safe disc is an anchor — they cannot
//     drift apart again.
//
// Everything here is data + pure functions: no engine state, no seed, no
// side effects. The invariants that keep the table legal (anchor/boss
// clearance, anchor/anchor separation) are asserted in
// `server/src/game/spawn-anchors.test.ts`, which is why the boss and legacy
// minion roosts are mirrored below instead of imported (the engine cannot
// depend on the server; `ai/npc.ts` stays the placement authority).

export type SpawnAnchor = {
  readonly x: number;
  readonly y: number;
  /** Stable label (logs, tests, minimap). Never a gameplay input. */
  readonly name: string;
};

/**
 * Radius (world units) of the no-hostile-spawn disc kept around every anchor.
 * Three systems read it: `spawnChunk` (skips mobs inside), `pruneSpawnSafe`
 * (per-tick backstop) and `spawner-ai` (mob steps / hunts refuse to enter).
 */
export const SPAWN_SAFE_RADIUS = 12;

/**
 * Boss roosts, mirrored from `NPCManager`'s constructor
 * (`server/src/ai/npc.ts`). Spawn anchors are placed against these so a fresh
 * login never lands on (or inside the wake disc of) a boss. Mirrored, not
 * imported: the engine sits below the server in the dependency graph.
 */
export const BOSS_ANCHORS: ReadonlyArray<Readonly<SpawnAnchor>> = Object.freeze([
  Object.freeze({ x: 80, y: 80, name: 'stone-golem' }),
  Object.freeze({ x: 20, y: 80, name: 'void-wisp' }),
  Object.freeze({ x: 86, y: 16, name: 'ember-wyrm' }),
  Object.freeze({ x: 14, y: 86, name: 'crypt-warden' }),
]);

/**
 * The three legacy AI minion patrol anchors (`gloomfang-1..3`,
 * `server/src/ai/npc.ts`). Kept here for the same reason as BOSS_ANCHORS:
 * an anchor centre never sits inside a minion's aggro radius.
 */
export const LEGACY_MINION_ANCHORS: ReadonlyArray<Readonly<SpawnAnchor>> = Object.freeze([
  Object.freeze({ x: 30, y: 30, name: 'gloomfang-1' }),
  Object.freeze({ x: 65, y: 25, name: 'gloomfang-2' }),
  Object.freeze({ x: 50, y: 70, name: 'gloomfang-3' }),
]);

/**
 * Radius that wakes a dormant boss (`BOSS_WAKE_RANGE` in
 * `server/src/ai/npc.ts`) and the legacy minion aggro pull
 * (`AGGRO_RANGE`). Every spawn anchor stays outside both, so standing on one
 * can never wake a boss and never drops a player into a minion's face.
 */
export const BOSS_WAKE_RANGE = 30;

/**
 * The spawn anchors. Rules the table obeys (enforced by tests, not by types):
 *
 *  1. `(0,0)` (world spawn) and `(50,50)` (shrine / death respawn) are here
 *     for compatibility with everything that already hard-codes them.
 *  2. Every anchor is at least `BOSS_WAKE_RANGE` from every boss roost.
 *  3. Anchors are at least `2 * SPAWN_SAFE_RADIUS` apart, so two discs can
 *     never merge into one oversized no-mob region.
 *  4. Every anchor is a free spot on the default terrain field (dry ground,
 *     outside the arena walls) — `Sim.findFreeSpawn` would otherwise nudge a
 *     player off the anchor and out of its own safe disc.
 *  5. Coverage stays modest: the discs together are well under a third of the
 *     100x100 arena, and the boss roosts (plus the two dormant bosses' 30u
 *     wake discs) are deliberately anchor-free.
 */
export const SPAWN_ANCHORS: readonly SpawnAnchor[] = Object.freeze([
  Object.freeze({ x: 0, y: 0, name: 'origin' }),
  Object.freeze({ x: 50, y: 50, name: 'shrine' }),
  Object.freeze({ x: 12, y: 38, name: 'west-meadow' }),
  Object.freeze({ x: 44, y: 14, name: 'south-meadow' }),
  Object.freeze({ x: 88, y: 48, name: 'east-ridge' }),
  Object.freeze({ x: 50, y: 88, name: 'north-ridge' }),
]);

/** World spawn `(0,0)` — the anchor a brand-new world centres on. */
export const ORIGIN_SPAWN: SpawnAnchor = SPAWN_ANCHORS[0]!;

/** Shrine `(50,50)` — where a dead player returns (`Sim.respawnPlayer`). */
export const SHRINE_SPAWN: SpawnAnchor = SPAWN_ANCHORS[1]!;

/** Anchors must stay at least this far apart so two safe discs never merge. */
export const SPAWN_ANCHOR_MIN_SEPARATION = 2 * SPAWN_SAFE_RADIUS;

/**
 * The anchor a player id joins on: round-robin over the table, so a shard
 * spreads its population across every ring instead of stacking everyone on
 * one tile. Deterministic (no RNG) and stable for a given id, which keeps
 * `Sim.addPlayer(pid)` and `ensurePlayer(game, pid, ...)` in agreement.
 *
 * The rotation is 1-based (`(id - 1) % n`) so the FIRST player on a shard —
 * id 1, the one you are almost always testing as — lands on `SPAWN_ANCHORS[0]`,
 * the canonical world spawn. With a 0-based rotation id 1 would land on the
 * shrine, which is the death-respawn point, and quietly make the world spawn
 * unreachable by a fresh account.
 */
export function spawnAnchorFor(playerId: number): SpawnAnchor {
  const n = SPAWN_ANCHORS.length;
  const i = (((Math.abs(Math.trunc(playerId)) - 1) % n) + n) % n;
  return SPAWN_ANCHORS[i]!;
}

/**
 * The anchor whose `axis` coordinate is closest to `value`.
 *
 * A partially-specified spawn (`addPlayer(id, name, x)` with no y) has to fill
 * the missing axis somehow. Filling it from `spawnAnchorFor(id)` picks an
 * anchor chosen by player id, which is unrelated to the coordinate the caller
 * actually asked for — `addPlayer(4, 'half', 12.5)` would land at (12.5, 14),
 * far outside every safe disc, because anchor 4's y happens to be 14 while the
 * nearest anchor to x=12.5 is west-meadow at (12,38). Snapping to the anchor
 * nearest on the GIVEN axis keeps the result inside a safe disc, which is the
 * only reason a half-specified spawn is allowed to exist at all.
 */
export function anchorNearestOn(axis: 'x' | 'y', value: number): SpawnAnchor {
  let best = SPAWN_ANCHORS[0]!;
  let bestD = Infinity;
  for (const a of SPAWN_ANCHORS) {
    const d = Math.abs(a[axis] - value);
    if (d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}

/** True when (x,y) lies inside the no-mob disc of any anchor. */
export function isSpawnAnchorSafeZone(x: number, y: number, radius: number = SPAWN_SAFE_RADIUS): boolean {
  const r2 = radius * radius;
  for (const a of SPAWN_ANCHORS) {
    const dx = x - a.x;
    const dy = y - a.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}