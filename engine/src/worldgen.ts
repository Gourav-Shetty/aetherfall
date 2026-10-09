// @aetherfall/engine — procedural world generation.
//
// - Deterministic value noise + fBm for biomes (pure functions of x, y, seed).
// - genChunk(cx, cy, size, seed): deterministic chunk tiles derived from
//   biome noise + a per-tile hash sprinkle (order-independent, so the same
//   inputs always yield identical tiles on any machine).
// - Dungeon generator: non-overlapping rooms carved into solid rock,
//   connected by L-shaped corridors (fully connected by construction).
// - Tile: 0 walkable, 1 wall (water counts as wall for movement).

import { mulberry32 } from '@aetherfall/shared';
import type { ChunkCoord, Point } from './spatial.js';

export type Tile = 0 | 1; // 0 walkable, 1 wall
export type Chunk = { cx: number; cy: number; size: number; tiles: Tile[][]; seed: number };

export type Biome = 'ocean' | 'beach' | 'plains' | 'forest' | 'desert' | 'mountain' | 'snow';

export interface DungeonRoom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dungeon {
  width: number;
  height: number;
  tiles: Tile[][];
  rooms: DungeonRoom[];
  seed: number;
}

export const DEFAULT_WORLD_SEED = 1337;
/** Default overworld chunk edge in tiles (used by genChunk + WorldStream). */
export const DEFAULT_CHUNK_SIZE = 32;

// -- deterministic hashing + value noise ------------------------------------

/** Integer lattice hash -> [0, 1). Pure function of (ix, iy, seed). */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (ix >>> 0), 374761393);
  h = Math.imul(h ^ (iy >>> 0), 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1]: lattice hashes + smoothstep interpolation. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const ux = smooth(fx);
  const uy = smooth(fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal Brownian motion in ~[0, 1]. */
export function fbm(x: number, y: number, octaves = 4, seed = DEFAULT_WORLD_SEED): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, (seed + o * 1013904223) >>> 0);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return norm === 0 ? 0 : sum / norm;
}

// -- biomes ------------------------------------------------------------------

const ELEV_SCALE = 0.018;
const MOIST_SCALE = 0.023;

export function getElevation(x: number, y: number, seed = DEFAULT_WORLD_SEED): number {
  const base = fbm(x * ELEV_SCALE, y * ELEV_SCALE, 4, seed);
  const detail = valueNoise(x * 0.11, y * 0.11, (seed ^ 0x9e3779b9) >>> 0) * 0.08;
  return Math.min(1, Math.max(0, base * 0.92 + detail));
}

export function getMoisture(x: number, y: number, seed = DEFAULT_WORLD_SEED): number {
  return fbm(
    x * MOIST_SCALE + 137.5,
    y * MOIST_SCALE + 71.3,
    3,
    (seed ^ 0x85ebca6b) >>> 0,
  );
}

export function getBiome(x: number, y: number, seed = DEFAULT_WORLD_SEED): Biome {
  const e = getElevation(x, y, seed);
  const m = getMoisture(x, y, seed);
  if (e < 0.32) return 'ocean';
  if (e < 0.38) return 'beach';
  if (e > 0.82) return 'snow';
  if (e > 0.68) return 'mountain';
  if (m < 0.3) return 'desert';
  if (m > 0.6) return 'forest';
  return 'plains';
}

/** Walkability of a biome tile: ocean counts as wall (needs boat/bridge). */
export function biomeWalkable(biome: Biome): boolean {
  return biome !== 'ocean';
}

// -- overworld chunks ------------------------------------------------------------

/** Chunk coords containing a world position (floor division, negatives ok). */
export function chunkOfWorld(x: number, y: number, size = DEFAULT_CHUNK_SIZE): ChunkCoord {
  return { cx: Math.floor(x / size), cy: Math.floor(y / size) };
}

/** World position of a chunk's (0,0) tile. */
export function chunkOrigin(cx: number, cy: number, size = DEFAULT_CHUNK_SIZE): Point {
  return { x: cx * size, y: cy * size };
}

export function genChunk(cx: number, cy: number, size = 32, seed = DEFAULT_WORLD_SEED): Chunk {
  const tiles: Tile[][] = [];
  for (let y = 0; y < size; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < size; x++) {
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      if (edge) {
        row.push(1);
        continue;
      }
      const wx = cx * size + x;
      const wy = cy * size + y;
      const biome = getBiome(wx, wy, seed);
      if (!biomeWalkable(biome)) {
        row.push(1);
        continue;
      }
      // Biome-flavored obstacle density, sprinkled by order-independent hash.
      const density =
        biome === 'mountain' ? 0.22 : biome === 'forest' ? 0.14 : biome === 'snow' ? 0.1 : 0.06;
      const r = hash2(wx, wy, (seed ^ 0x27d4eb2f) >>> 0);
      row.push(r < density ? 1 : 0);
    }
    tiles.push(row);
  }
  return { cx, cy, size, tiles, seed };
}

// -- zones: meadow / dungeon-highlands / volcano -------------------------------
// Three hand-tuned overworld zones with distinct tile variants, obstacle
// density, and mob levels. Pure functions of (x, y, seed) — deterministic
// on every machine. The instanced `genDungeon()` carver below is zone-agnostic;
// use `genThemedDungeon()` / `dungeonTileKind()` for per-zone dungeon dressing.
export type ZoneId = 'meadow' | 'dungeon' | 'volcano';

export interface ZoneDef {
  id: ZoneId;
  name: string;
  description: string;
  /** Distinct walkable tile variants (decoration / minimap palette). */
  tiles: string[];
  /** Wall tile variants for this zone. */
  wallTiles: string[];
  /** Order-independent obstacle sprinkle density (cf. genChunk). */
  obstacleDensity: number;
  /** Mob level band for spawn tables. */
  levelMin: number;
  levelMax: number;
}

export const ZONE_IDS: ZoneId[] = ['meadow', 'dungeon', 'volcano'];

export const ZONE_DEFS: Record<ZoneId, ZoneDef> = {
  meadow: {
    id: 'meadow',
    name: 'Ember Meadow',
    description: 'Sunlit grass around the gate. Gloomfangs den in the brush.',
    tiles: ['grass', 'flower', 'bush', 'pond-bank'],
    wallTiles: ['bramble', 'water'],
    obstacleDensity: 0.06,
    levelMin: 1,
    levelMax: 2,
  },
  dungeon: {
    id: 'dungeon',
    name: 'Hollow Deep',
    description: 'Blighted highlands above the instanced dungeon rock.',
    tiles: ['stone', 'moss', 'crack', 'pillar-base'],
    wallTiles: ['rubble', 'dark-rock'],
    obstacleDensity: 0.14,
    levelMin: 3,
    levelMax: 5,
  },
  volcano: {
    id: 'volcano',
    name: 'Ashfall Caldera',
    description: 'Basalt and emberfields under the volcano. Bring fire resist.',
    tiles: ['basalt', 'ember', 'ash', 'obsidian-fleck'],
    wallTiles: ['lava', 'obsidian-wall'],
    obstacleDensity: 0.18,
    levelMin: 5,
    levelMax: 8,
  },
};

/**
 * Overworld zone by world position. Radial bands from spawn (0,0) with a
 * noise-jittered border so the transition looks organic but stays
 * deterministic: meadow r<70, dungeon-highlands 70..150, caldera beyond.
 */
export function getZone(x: number, y: number, seed = DEFAULT_WORLD_SEED): ZoneId {
  const r = Math.hypot(x, y);
  const jitter = (valueNoise(x * 0.02, y * 0.02, (seed ^ 0x51ab27) >>> 0) - 0.5) * 30;
  const rj = r + jitter;
  if (rj < 70) return 'meadow';
  if (rj < 150) return 'dungeon';
  return 'volcano';
}

/** Majority zone for a chunk (samples the chunk center in world coords). */
export function zoneForChunk(cx: number, cy: number, size = 32, seed = DEFAULT_WORLD_SEED): ZoneId {
  return getZone(cx * size + size / 2, cy * size + size / 2, seed);
}

export function zoneObstacleDensity(zone: ZoneId): number {
  return ZONE_DEFS[zone].obstacleDensity;
}

/** Distinct decoration tile for a world position inside `zone`. Deterministic. */
export function zoneTileKind(x: number, y: number, zone: ZoneId, seed = DEFAULT_WORLD_SEED): string {
  const def = ZONE_DEFS[zone];
  const r = hash2(x, y, (seed ^ 0x70e4d1) >>> 0);
  const idx = Math.min(def.tiles.length - 1, Math.floor(r * def.tiles.length));
  return def.tiles[idx]!;
}

/** Wall dressing for a world position inside `zone`. Deterministic. */
export function zoneWallKind(x: number, y: number, zone: ZoneId, seed = DEFAULT_WORLD_SEED): string {
  const def = ZONE_DEFS[zone];
  const r = hash2(x, y, (seed ^ 0x1bd3a7) >>> 0);
  const idx = Math.min(def.wallTiles.length - 1, Math.floor(r * def.wallTiles.length));
  return def.wallTiles[idx]!;
}

export interface ZonedChunk {
  chunk: Chunk;
  zone: ZoneId;
  /** Per-tile decoration variant, aligned with chunk.tiles ([y][x]). */
  variants: string[][];
}

/**
 * Chunk walkability (from genChunk) plus per-tile zone decoration.
 * Walkability still comes from biome + hash sprinkle; `zone` + `variants`
 * only affect looks/spawns/loot — movement semantics unchanged.
 */
export function genZonedChunk(
  cx: number,
  cy: number,
  size = 32,
  seed = DEFAULT_WORLD_SEED,
): ZonedChunk {
  const chunk = genChunk(cx, cy, size, seed);
  const zone = zoneForChunk(cx, cy, size, seed);
  const variants: string[][] = [];
  for (let y = 0; y < size; y++) {
    const row: string[] = [];
    for (let x = 0; x < size; x++) {
      const wx = cx * size + x;
      const wy = cy * size + y;
      row.push(chunk.tiles[y]![x] === 1 ? zoneWallKind(wx, wy, zone, seed) : zoneTileKind(wx, wy, zone, seed));
    }
    variants.push(row);
  }
  return { chunk, zone, variants };
}

export interface ThemedDungeon extends Dungeon {
  zone: ZoneId;
  /** Per-tile decoration variant, aligned with tiles ([y][x]). */
  variants: string[][];
}

/** Dungeon floor dressing for a zone (corridors/rooms share the palette). */
export function dungeonTileKind(
  x: number,
  y: number,
  zone: ZoneId,
  seed = DEFAULT_WORLD_SEED,
): string {
  return zoneTileKind(x, y, zone, (seed ^ 0xd967) >>> 0);
}

/** genDungeon() carver plus per-zone tile variants for renderer dressing. */
export function genThemedDungeon(
  width: number,
  height: number,
  seed = DEFAULT_WORLD_SEED,
  zone: ZoneId = 'dungeon',
): ThemedDungeon {
  const d = genDungeon(width, height, seed);
  const variants: string[][] = d.tiles.map((row, y) =>
    row.map((t, x) =>
      t === 1 ? zoneWallKind(x, y, zone, seed) : dungeonTileKind(x, y, zone, seed),
    ),
  );
  return { ...d, zone, variants };
}

// -- dungeons --------------------------------------------------------------------

export function genDungeon(width: number, height: number, seed = DEFAULT_WORLD_SEED): Dungeon {
  if (width < 12 || height < 12) throw new Error('dungeon too small (min 12x12)');
  const rand = mulberry32(seed >>> 0);
  const tiles: Tile[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => 1 as Tile),
  );

  const targetRooms = Math.max(4, Math.floor((width * height) / 220));
  const rooms: DungeonRoom[] = [];
  for (let attempt = 0; attempt < targetRooms * 12 && rooms.length < targetRooms; attempt++) {
    const w = 4 + Math.floor(rand() * Math.min(10, width - 4));
    const h = 4 + Math.floor(rand() * Math.min(8, height - 4));
    const x = 1 + Math.floor(rand() * (width - w - 1));
    const y = 1 + Math.floor(rand() * (height - h - 1));
    let overlap = false;
    for (const r of rooms) {
      if (x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    rooms.push({ x, y, w, h });
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) tiles[yy][xx] = 0;
    }
  }

  // Fallback: guarantee at least one room so the dungeon is never solid rock.
  if (rooms.length === 0) {
    const w = Math.min(8, width - 2);
    const h = Math.min(6, height - 2);
    const x = Math.floor((width - w) / 2);
    const y = Math.floor((height - h) / 2);
    rooms.push({ x, y, w, h });
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) tiles[yy][xx] = 0;
  }

  const center = (r: DungeonRoom): [number, number] => [
    r.x + Math.floor(r.w / 2),
    r.y + Math.floor(r.h / 2),
  ];

  const carveH = (x0: number, x1: number, y: number): void => {
    const [a, b] = x0 <= x1 ? [x0, x1] : [x1, x0];
    for (let x = a; x <= b; x++) {
      if (y >= 1 && y < height - 1 && x >= 1 && x < width - 1) tiles[y][x] = 0;
    }
  };
  const carveV = (y0: number, y1: number, x: number): void => {
    const [a, b] = y0 <= y1 ? [y0, y1] : [y1, y0];
    for (let y = a; y <= b; y++) {
      if (y >= 1 && y < height - 1 && x >= 1 && x < width - 1) tiles[y][x] = 0;
    }
  };

  // Connect rooms in placement order (spanning chain => fully connected).
  // Corridor orientation randomized per link for variety.
  for (let i = 1; i < rooms.length; i++) {
    const [px, py] = center(rooms[i - 1]);
    const [qx, qy] = center(rooms[i]);
    if (rand() < 0.5) {
      carveH(px, qx, py);
      carveV(py, qy, qx);
    } else {
      carveV(py, qy, px);
      carveH(px, qx, qy);
    }
  }

  return { width, height, tiles, rooms, seed };
}
