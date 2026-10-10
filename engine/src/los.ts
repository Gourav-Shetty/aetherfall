// @aetherfall/engine — line-of-sight (LoS) helpers for AI vision cones.
//
// Pure, dependency-free, allocation-free in the hot path. Two occluder
// sources are checked (both must be clear for sight):
//   * wall tiles — a `number[][]` grid (non-zero = solid), e.g. the NPC
//     pathing grid or a worldgen chunk. Sampled with a fixed-step raycast.
//   * wall rects — `data/walls.json` rects in world units (server walls).
//     Tested with an exact segment-vs-AABB slab check.
//
// Perf contract (server ticks NPC cones at 10Hz): the grid raycast takes at
// most LOS_MAX_STEPS samples (1u step over the 14u max vision range) and
// both checks early-out on the first occluder found. Range/cone filtering
// must happen BEFORE calling into here (see server/src/ai/vision.ts).

/** World-unit rect in `data/walls.json` coordinates. Structural match for shared WallRect. */
export interface LosRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Raycast resolution (world units per sample). */
export const LOS_STEP = 1.0;
/** Sample cap: covers the 14u max vision range at LOS_STEP. */
export const LOS_MAX_STEPS = 14;

function inRect(x: number, y: number, r: LosRect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * True when the segment (x0,y0)->(x1,y1) touches the rect (inclusive:
 * grazing a corner counts as a hit — conservative, deterministic).
 * Endpoints inside the rect also count (a body inside a wall cannot see out).
 */
export function segmentHitsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: LosRect,
): boolean {
  if (inRect(x0, y0, r) || inRect(x1, y1, r)) return true;
  const minX = r.x;
  const maxX = r.x + r.w;
  const minY = r.y;
  const maxY = r.y + r.h;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-12) {
    if (x0 < minX || x0 > maxX) return false;
  } else {
    let t1 = (minX - x0) / dx;
    let t2 = (maxX - x0) / dx;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-12) {
    if (y0 < minY || y0 > maxY) return false;
  } else {
    let t1 = (minY - y0) / dy;
    let t2 = (maxY - y0) / dy;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

/**
 * True when no wall rect blocks the segment. Empty/null rect sets are clear.
 * Early-outs on the first blocking rect.
 */
export function rectLos(
  walls: LosRect[] | null | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (!walls || walls.length === 0) return true;
  for (let i = 0; i < walls.length; i++) {
    if (segmentHitsRect(x0, y0, x1, y1, walls[i]!)) return false;
  }
  return true;
}

/** Grid cell lookup: non-zero is solid; out-of-bounds reads as solid. */
function cellBlocked(grid: number[][], cx: number, cy: number): boolean {
  const row = grid[cy];
  if (row === undefined) return true;
  const v = row[cx];
  if (v === undefined) return true;
  return v !== 0;
}

/**
 * True when no wall tile blocks the segment. The ray is sampled every
 * LOS_STEP world units, capped at LOS_MAX_STEPS samples (early-out on the
 * first solid tile). Endpoints are included in the samples, so bodies
 * standing on wall tiles are treated as blind.
 *
 * `cell` is world units per grid cell (NPC path grid uses 2).
 */
export function gridLos(
  grid: number[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cell = 2,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) {
    return !cellBlocked(grid, Math.floor(x0 / cell), Math.floor(y0 / cell));
  }
  const steps = Math.min(LOS_MAX_STEPS, Math.max(1, Math.ceil(dist / LOS_STEP)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    if (cellBlocked(grid, Math.floor(x / cell), Math.floor(y / cell))) return false;
  }
  return true;
}

/**
 * Combined sight check: clear only when BOTH the tile grid (when given)
 * and the wall rects (when non-empty) are clear. Callers must filter by
 * range + vision cone first — this is the expensive leg.
 */
export function hasLos(
  grid: number[][] | null | undefined,
  walls: LosRect[] | null | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cell = 2,
): boolean {
  if (grid && !gridLos(grid, x0, y0, x1, y1, cell)) return false;
  if (walls && walls.length > 0 && !rectLos(walls, x0, y0, x1, y1)) return false;
  return true;
}
