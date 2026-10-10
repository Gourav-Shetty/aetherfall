// AETHERFALL AI — vision cones (Hotline Miami-style enemy sight).
//
// Each NPC has a facing (radians, 0 = +X) and a 90-degree cone
// (VISION_HALF_ANGLE = 45 degrees each side). Detection of a target needs
// ALL THREE legs (cheap legs first, LoS last — see engine/src/los.ts):
//   1. inside the cone AND within range (14u, 12u in dungeon/volcano zones),
//   2. line-of-sight clear (tile grid AND walls.json rects — both checked),
//   3. target moving (speed >= MOVE_SPEED_EPS) OR close (<= SNEAK_STILL_DIST).
//      Still targets beyond 4u are unseen, so sneaking works.
//
// Once ALERT (chase/attack/search) the movement leg is dropped: a spotted
// target is tracked by cone+LoS+range only (see canTrack). Standing still
// mid-chase does not shake a pursuer — you have to break cone/LoS/range.

import { getZone, gridLos, rectLos, type LosRect } from '@aetherfall/engine';

/** Half-angle of the vision cone (full cone = 90 degrees). */
export const VISION_HALF_ANGLE = Math.PI / 4;
/** Sight range in the open (meadow). */
export const VISION_RANGE = 14;
/** Sight range where the rock closes in (dungeon highlands + volcano). */
export const VISION_RANGE_DUNGEON = 12;
/** Still targets at or inside this distance are seen anyway (no sneak). */
export const SNEAK_STILL_DIST = 4;
/** Attacks/gunshots heard inside this radius (see NPCManager.notifyNoise). */
export const NOISE_RADIUS = 18;
/** Below this speed (u/s) a target counts as still. */
export const MOVE_SPEED_EPS = 0.5;

/**
 * Sight range for an NPC standing at (x, y). Dungeon/volcano zones read
 * 12u, everywhere else 14u. `seed` is the world seed (default world).
 */
export function visionRangeAt(x: number, y: number, seed?: number): number {
  const zone = seed === undefined ? getZone(x, y) : getZone(x, y, seed);
  return zone === 'dungeon' || zone === 'volcano' ? VISION_RANGE_DUNGEON : VISION_RANGE;
}

/** Smallest signed angle from a to b, in [-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Facing (radians, 0 = +X) from (fx, fy) toward (tx, ty). */
export function faceToward(fx: number, fy: number, tx: number, ty: number): number {
  return Math.atan2(ty - fy, tx - fx);
}

/**
 * Cone + range test. Edges are inclusive: exactly on the 45-degree edge or
 * exactly at range counts as inside. A target on top of the viewer is seen.
 */
export function inVisionCone(
  nx: number,
  ny: number,
  facing: number,
  tx: number,
  ty: number,
  range: number = VISION_RANGE,
): boolean {
  const dx = tx - nx;
  const dy = ty - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-9) return true;
  if (d2 > range * range) return false;
  const ang = Math.atan2(dy, dx);
  return Math.abs(angleDiff(facing, ang)) <= VISION_HALF_ANGLE + 1e-9;
}

export interface SightQuery {
  nx: number;
  ny: number;
  facing: number;
  tx: number;
  ty: number;
  range?: number;
  /** Tile grid for the LoS leg (NPC path grid); null skips it. */
  grid?: number[][] | null;
  /** walls.json rects for the LoS leg; empty skips it. */
  walls?: LosRect[] | null;
  /** World units per grid cell (NPC grid uses 2). */
  cell?: number;
  /** Target speed in u/s (per-tick deltas or caller velocity). */
  targetSpeed?: number;
}

function rangeOf(q: SightQuery): number {
  return q.range ?? VISION_RANGE;
}

/**
 * Full detection: cone + range, then the moving-or-close leg, then LoS.
 * Use for ACQUISITION (idle/patrol/suspicious) — still, distant targets
 * stay unseen so sneaking works.
 */
export function canDetect(q: SightQuery): boolean {
  const range = rangeOf(q);
  if (!inVisionCone(q.nx, q.ny, q.facing, q.tx, q.ty, range)) return false;
  const dist = Math.hypot(q.tx - q.nx, q.ty - q.ny);
  // No speed supplied reads as still (fail closed: sneak works by default).
  const speed = q.targetSpeed ?? 0;
  if (dist > SNEAK_STILL_DIST && speed < MOVE_SPEED_EPS) return false;
  if (q.grid && !gridLos(q.grid, q.nx, q.ny, q.tx, q.ty, q.cell ?? 2)) return false;
  if (q.walls && q.walls.length > 0 && !rectLos(q.walls, q.nx, q.ny, q.tx, q.ty)) return false;
  return true;
}

/**
 * Tracking check for ALERT states (chase/attack/search): cone + range + LoS
 * only, no movement leg. Once spotted, freezing in place does not break
 * contact — the target must leave the cone, break LoS, or outrun the leash.
 */
export function canTrack(q: SightQuery): boolean {
  const range = rangeOf(q);
  if (!inVisionCone(q.nx, q.ny, q.facing, q.tx, q.ty, range)) return false;
  if (q.grid && !gridLos(q.grid, q.nx, q.ny, q.tx, q.ty, q.cell ?? 2)) return false;
  if (q.walls && q.walls.length > 0 && !rectLos(q.walls, q.nx, q.ny, q.tx, q.ty)) return false;
  return true;
}
