// @aetherfall/engine — landmarks: rare hand-placed-feeling structures.
//
// A landmark is decided per *grid cell* (LANDMARK_CELL world units), never per
// tile, which gives three properties for free:
//
//   - Uniqueness: one candidate per cell, ids derived from the cell -> two
//     scans can never see the same structure twice.
//   - Determinism: `landmarkInCell(gx, gy, seed)` is a pure function, so the
//     server, the client and the tools all agree without syncing anything.
//   - Constant cost per query: `findLandmarks` only evaluates the cells that
//     overlap the requested area.
//
// Placement rejects sites that would be unreachable or unfair (water, lava,
// cliff faces), and each structure carries `loot` anchors for the loot/spawn
// layers to consume.

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_WORLD_SEED,
  ZONE_DEFS,
  getBiome,
  getZone,
  hash2,
  type ZoneId,
} from './worldgen.js';
import {
  WALKABLE_MAX_SLOPE,
  hazardAt,
  slopeAt,
} from './terrain.js';

export type LandmarkKind = 'ruin' | 'obelisk' | 'camp';

export const LANDMARK_KINDS: readonly LandmarkKind[] = ['ruin', 'obelisk', 'camp'];

/** Edge length of a landmark cell in world units. */
export const LANDMARK_CELL = 128;
/** Keep-out margin so a landmark (and its loot) never crosses a cell edge. */
const LANDMARK_MARGIN = 18;
/**
 * Cell fill chance per zone before site validation (~1 landmark per 220 world
 * units once water/lava/cliff sites are rejected). Deliberately rare.
 */
export const LANDMARK_DENSITY: Record<ZoneId, number> = {
  meadow: 0.42,
  dungeon: 0.38,
  volcano: 0.34,
};
/** Cumulative kind weights per zone, in LANDMARK_KINDS-independent order. */
const LANDMARK_KIND_TABLE: Record<ZoneId, ReadonlyArray<readonly [LandmarkKind, number]>> = {
  meadow: [
    ['camp', 0.45],
    ['ruin', 0.8],
    ['obelisk', 1],
  ],
  dungeon: [
    ['ruin', 0.45],
    ['obelisk', 0.75],
    ['camp', 1],
  ],
  volcano: [
    ['obelisk', 0.4],
    ['ruin', 0.75],
    ['camp', 1],
  ],
};
/** Footprint radius in tiles (also the loot scatter radius ceiling). */
export const LANDMARK_RADIUS: Record<LandmarkKind, number> = {
  ruin: 14,
  camp: 9,
  obelisk: 6,
};
/** Display names per kind (index chosen by cell hash). */
export const LANDMARK_NAMES: Record<LandmarkKind, readonly string[]> = {
  ruin: ['Sunken Ruin', 'Ashen Keep', 'Broken Arch', 'Forgotten Court'],
  camp: ['Wanderer Camp', 'Smolder Camp', 'Pilgrim Rest', 'Scout Hollow'],
  obelisk: ['Aether Obelisk', 'Rift Obelisk', 'Ember Obelisk', 'Silent Obelisk'],
};
/** Loot anchors per landmark: [min, max) added to `LANDMARK_MIN_LOOT`. */
export const LANDMARK_LOOT_MIN = 2;
export const LANDMARK_LOOT_SPREAD = 3;

const SALT_PRESENCE = 0x5bf03635;
const SALT_POSITION_X = 0x1b873593;
const SALT_POSITION_Y = 0xcc9e2d51;
const SALT_KIND = 0x27d4eb2f;
const SALT_LOOT = 0x165667b1;
const SALT_NAME = 0xd3a2646c;

export interface LootAnchor {
  /** Globally unique, derived from the landmark id. */
  id: string;
  /** World tile coordinates (integers). */
  x: number;
  y: number;
  /** Loot tier, rolled from the zone mob-level band. */
  tier: number;
}

export interface Landmark {
  /** Stable unique id: `<kind>:<gx>,<gy>`. */
  id: string;
  kind: LandmarkKind;
  /** Center tile (integers). */
  x: number;
  y: number;
  /** Owning landmark grid cell. */
  gx: number;
  gy: number;
  zone: ZoneId;
  /** Footprint radius in tiles. */
  radius: number;
  name: string;
  /** Deterministic loot anchors inside the footprint. */
  loot: LootAnchor[];
  seed: number;
}

export function landmarkId(kind: LandmarkKind, gx: number, gy: number): string {
  return `${kind}:${gx},${gy}`;
}

/** Landmark cell containing a world position. */
export function landmarkCellOf(x: number, y: number): { gx: number; gy: number } {
  return { gx: Math.floor(x / LANDMARK_CELL), gy: Math.floor(y / LANDMARK_CELL) };
}

/** Landmark cell coordinates for a chunk index. */
export function landmarkCellOfChunk(cx: number, cy: number, chunkSize = DEFAULT_CHUNK_SIZE): {
  gx: number;
  gy: number;
} {
  return landmarkCellOf(cx * chunkSize + chunkSize / 2, cy * chunkSize + chunkSize / 2);
}

function pickKind(zone: ZoneId, roll: number): LandmarkKind {
  const table = LANDMARK_KIND_TABLE[zone];
  for (const [kind, cutoff] of table) if (roll < cutoff) return kind;
  return 'camp';
}

function lootAnchorsFor(
  lm: Omit<Landmark, 'loot' | 'name'>,
  seed: number,
): LootAnchor[] {
  const band = ZONE_DEFS[lm.zone];
  const count =
    LANDMARK_LOOT_MIN +
    Math.floor(hash2(lm.gx, lm.gy, (seed ^ SALT_LOOT) >>> 0) * LANDMARK_LOOT_SPREAD);
  const out: LootAnchor[] = [];
  for (let i = 0; i < count; i++) {
    const r0 = hash2(lm.gx * 31 + i, lm.gy * 17 - i, (seed ^ SALT_LOOT) >>> 0);
    const r1 = hash2(lm.gx * 13 - i, lm.gy * 29 + i, (seed ^ SALT_LOOT) >>> 0);
    const r2 = hash2(lm.gx + i * 7, lm.gy - i * 11, (seed ^ SALT_LOOT) >>> 0);
    // Golden-angle fan-out keeps anchors apart without clustering on a ring.
    const angle = i * 2.39996323 + r0 * Math.PI * 2;
    const dist = lm.radius * (0.35 + 0.5 * r1);
    const ax = lm.x + Math.round(Math.cos(angle) * dist);
    const ay = lm.y + Math.round(Math.sin(angle) * dist);
    out.push({
      id: `${lm.id}#${i}`,
      x: ax,
      y: ay,
      tier: band.levelMin + Math.floor(r2 * (band.levelMax - band.levelMin + 1)),
    });
  }
  return out;
}

function nameFor(kind: LandmarkKind, gx: number, gy: number, seed: number): string {
  const names = LANDMARK_NAMES[kind];
  const i = Math.min(names.length - 1, Math.floor(hash2(gx, gy, (seed ^ SALT_NAME) >>> 0) * names.length));
  return names[i]!;
}

/**
 * The (at most one) landmark in grid cell (gx, gy), or null. Pure: the same
 * cell + seed always yields the same landmark, or the same null.
 */
export function landmarkInCell(
  gx: number,
  gy: number,
  seed = DEFAULT_WORLD_SEED,
): Landmark | null {
  // 1. cell center -> jittered site (always >= LANDMARK_MARGIN from the edge)
  const span = LANDMARK_CELL - LANDMARK_MARGIN * 2;
  const x =
    gx * LANDMARK_CELL +
    LANDMARK_MARGIN +
    Math.floor(hash2(gx, gy, (seed ^ SALT_POSITION_X) >>> 0) * span);
  const y =
    gy * LANDMARK_CELL +
    LANDMARK_MARGIN +
    Math.floor(hash2(gx, gy, (seed ^ SALT_POSITION_Y) >>> 0) * span);

  const zone = getZone(x, y, seed);

  // 2. presence roll (rare) — independent of position jitter
  const presence = hash2(gx, gy, (seed ^ SALT_PRESENCE) >>> 0);
  if (presence >= LANDMARK_DENSITY[zone]) return null;

  // 3. site validation: never in water/lava, never on a cliff face
  if (getBiome(x, y, seed) === 'ocean') return null;
  const hazard = hazardAt(x, y, seed);
  if (hazard.type !== 'none') return null;
  if (slopeAt(x, y, seed) > WALKABLE_MAX_SLOPE) return null;

  const kind = pickKind(zone, hash2(gx, gy, (seed ^ SALT_KIND) >>> 0));
  const core: Omit<Landmark, 'loot' | 'name'> = {
    id: landmarkId(kind, gx, gy),
    kind,
    x,
    y,
    gx,
    gy,
    zone,
    radius: LANDMARK_RADIUS[kind],
    seed,
  };
  return { ...core, name: nameFor(kind, gx, gy, seed), loot: lootAnchorsFor(core, seed) };
}

// -- queries ---------------------------------------------------------------------

/** Iterate the landmark cells overlapping a world-space AABB (row-major). */
function forEachCellInBox(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  cb: (gx: number, gy: number) => void,
): void {
  const a = landmarkCellOf(minX, minY);
  const b = landmarkCellOf(maxX, maxY);
  for (let gy = a.gy; gy <= b.gy; gy++) {
    for (let gx = a.gx; gx <= b.gx; gx++) cb(gx, gy);
  }
}

/**
 * Landmarks whose center is within `r` world units of (x, y). Deterministic
 * order (ascending grid cell, then center y/x). Callers get the same array for
 * the same inputs regardless of query history.
 */
export function landmarksInRadius(
  x: number,
  y: number,
  r: number,
  seed = DEFAULT_WORLD_SEED,
): Landmark[] {
  if (!(r > 0)) return [];
  const out: Landmark[] = [];
  forEachCellInBox(x - r, y - r, x + r, y + r, (gx, gy) => {
    const lm = landmarkInCell(gx, gy, seed);
    if (!lm) return;
    if (Math.hypot(lm.x - x, lm.y - y) <= r) out.push(lm);
  });
  out.sort((a, b) => a.gy - b.gy || a.gx - b.gx || a.y - b.y || a.x - b.x);
  return out;
}

/**
 * Chunk-centric landmark query (matches how the server/renderer think about
 * the world): the chunk (cx, cy) center plus `r` chunks of margin.
 *
 * `findLandmarks(0, 0, 4)` covers chunks (-4..4, -4..4) — 81 chunk centers,
 * 640x640 world units.
 */
export function findLandmarks(
  cx: number,
  cy: number,
  r: number,
  opts: { seed?: number; chunkSize?: number } = {},
): Landmark[] {
  const seed = opts.seed ?? DEFAULT_WORLD_SEED;
  const size = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const x = cx * size + size / 2;
  const y = cy * size + size / 2;
  return landmarksInRadius(x, y, r * size, seed);
}

/** Nearest landmark within `maxR` world units, or null. Ties break by id. */
export function nearestLandmark(
  x: number,
  y: number,
  maxR: number,
  seed = DEFAULT_WORLD_SEED,
): Landmark | null {
  const list = landmarksInRadius(x, y, maxR, seed);
  let best: Landmark | null = null;
  let bestD2 = Infinity;
  for (const lm of list) {
    const d2 = (lm.x - x) ** 2 + (lm.y - y) ** 2;
    if (d2 < bestD2 || (d2 === bestD2 && best !== null && lm.id < best.id)) {
      best = lm;
      bestD2 = d2;
    }
  }
  return best;
}

/**
 * Cached wrapper for hot consumers (minimap, quest markers, mob AI):
 * cell results — including the `null` misses — are memoized behind an LRU-ish
 * cap so repeated overlap queries stay free. Cache state never affects the
 * values returned.
 */
export class LandmarkIndex {
  private cache = new Map<string, Landmark | null>();
  private seed: number;
  private limit: number;
  private computed = 0;

  constructor(seed = DEFAULT_WORLD_SEED, maxCells = 256) {
    this.seed = seed;
    this.limit = Math.max(1, maxCells);
  }

  get size(): number {
    return this.cache.size;
  }

  /** Landmark cells actually evaluated since construction/clear(). */
  get computedCells(): number {
    return this.computed;
  }

  private cell(gx: number, gy: number): Landmark | null {
    const key = `${gx},${gy}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const lm = landmarkInCell(gx, gy, this.seed);
    this.computed++;
    if (this.cache.size >= this.limit) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, lm);
    return lm;
  }

  near(x: number, y: number, r: number): Landmark[] {
    if (!(r > 0)) return [];
    const out: Landmark[] = [];
    forEachCellInBox(x - r, y - r, x + r, y + r, (gx, gy) => {
      const lm = this.cell(gx, gy);
      if (!lm) return;
      if (Math.hypot(lm.x - x, lm.y - y) <= r) out.push(lm);
    });
    out.sort((a, b) => a.gy - b.gy || a.gx - b.gx || a.y - b.y || a.x - b.x);
    return out;
  }

  /** Same query as `findLandmarks` (chunk coords), but memoized. */
  findAroundChunk(cx: number, cy: number, r: number, chunkSize = DEFAULT_CHUNK_SIZE): Landmark[] {
    return this.near(cx * chunkSize + chunkSize / 2, cy * chunkSize + chunkSize / 2, r * chunkSize);
  }

  clear(): void {
    this.cache.clear();
    this.computed = 0;
  }
}