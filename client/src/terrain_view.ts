// Client-side view of the engine terrain field.
//
// Everything here is *presentation*: the authoritative numbers (entity z,
// hazard dps) come from the server snapshot, but both renderers need to know
// the height, slope and hazard of every ground tile they draw, and the minimap
// needs a cheap hazard/landmark overlay at 4Hz.
//
// The engine field is a pure function of (x, y, seed), so the client can
// reproduce the server's numbers exactly instead of shipping a heightmap:
// `heightAt` sampled at a tile centre is bit-identical to the server's
// `TerrainField` layer value (both are Float64 `heightAt(tileX + 0.5,
// tileY + 0.5)`).
//
// Cost model — the whole point of the grid:
//   * the 100x100 arena grid (kind / dps / height) is built once, lazily,
//     in ~3 ms, and then every tile lookup is an array index;
//   * a per-tile query outside the grid falls back to the engine function;
//   * the minimap overlay is derived from the same grid, so `drawMinimap`
//     never calls into the field.

import {
  DEFAULT_WORLD_SEED,
  LAVA_LEVEL,
  LandmarkIndex,
  WATER_LEVEL,
  hazardAt,
  heightAt,
  type Landmark,
} from '@aetherfall/engine';

/** Water surface height (world units) — mirrors the engine field. */
export const TERRAIN_WATER_LEVEL = WATER_LEVEL;
/** Lava surface height inside the caldera — mirrors the engine field. */
export const TERRAIN_LAVA_LEVEL = LAVA_LEVEL;

/** Hazard kind packed per tile (mirrors server/src/terrain_sys.ts). */
export const TERR_NONE = 0;
export const TERR_WATER = 1;
export const TERR_LAVA = 2;

/**
 * World units -> visual Y. The raw field spans roughly [-11, +43] world units
 * inside the arena; at 1:1 that dwarfs the 30-unit isometric view, so heights
 * are compressed into a ~2.5-unit band. Purely cosmetic — collision, z in the
 * snapshot and DOT all use the unscaled number.
 */
export const TERRAIN_Z_SCALE = 0.05;
/** Visual Y is soft-clamped to +/- this so a single peak cannot break framing. */
export const TERRAIN_Z_CLAMP = 2.4;
/** Visual Y per pixel of vertical offset (canvas fallback uses pixels). */
export const TERRAIN_Z_PX = 9;

/**
 * Compressed visual elevation. A `tanh` soft clamp keeps the mapping smooth,
 * monotonic and bounded by +/- `TERRAIN_Z_CLAMP`, so no single peak can push
 * the isometric camera out of framing and neighbouring tiles never disagree
 * about which is higher. Purely cosmetic — collision, snapshot `z` and DOT all
 * use the unscaled number.
 */
export function zVisual(height: number): number {
  return TERRAIN_Z_CLAMP * Math.tanh((height * TERRAIN_Z_SCALE) / TERRAIN_Z_CLAMP);
}

/** Same mapping, expressed in canvas pixels for the 2D renderer. */
export function zPixels(height: number): number {
  return zVisual(height) * TERRAIN_Z_PX;
}

/** Slopes above this read as cliffs (matches engine WALKABLE_MAX_SLOPE). */
export const TERRAIN_CLIFF_SLOPE = 1.6;

/** Per-tile terrain cache over a rectangular tile range. */
export interface GroundGrid {
  minX: number;
  minY: number;
  w: number;
  h: number;
  kind: Uint8Array;
  dps: Float64Array;
  /** Float64 so a tile matches the server's authoritative `z` exactly. */
  height: Float64Array;
}

/** Landmark subset the minimap needs (no loot anchors: too dense to read). */
export interface LandmarkDot {
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  radius: number;
}

/** Structural view the HUD consumes (keeps hud.ts DOM-only and testable). */
export interface TerrainMapLike {
  /** Hazard kind for a tile: TERR_NONE / TERR_WATER / TERR_LAVA. */
  kindAtTile(tx: number, ty: number): number;
  /** Landmarks within `r` world units of (x, y). */
  landmarksNear(x: number, y: number, r: number): LandmarkDot[];
}

/**
 * Terrain accessor for the client. One instance per page (main.ts owns it and
 * hands it to both renderers + the HUD); the grid behind it is shared so the
 * three consumers cannot disagree about a tile.
 */
export class TerrainView implements TerrainMapLike {
  readonly seed: number;
  readonly landmarks: LandmarkIndex;
  /** Arena tile range covered by the cached grid. */
  readonly minX: number;
  readonly minY: number;
  readonly size: number;
  private cached: GroundGrid | null = null;
  private builds = 0;
  private lastBuildMs = 0;
  private landmarkCache = new Map<string, LandmarkDot[]>();

  constructor(seed = DEFAULT_WORLD_SEED, opts: { minX?: number; minY?: number; size?: number } = {}) {
    this.seed = seed;
    this.minX = opts.minX ?? 0;
    this.minY = opts.minY ?? 0;
    this.size = opts.size ?? 100;
    this.landmarks = new LandmarkIndex(seed, 256);
  }

  // -- raw field (authoritative numbers, uncached) ------------------------------

  /** Continuous elevation at a world position. */
  heightAt(x: number, y: number): number {
    return heightAt(x, y, this.seed);
  }

  /**
   * Gradient magnitude at a world position. Inside the arena this comes from
   * the cached grid for free; outside it falls back to four `heightAt` samples
   * around the tile centre.
   */
  slopeAt(x: number, y: number): number {
    const grid = this.grid();
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (grid !== null && this.index(grid, tx + 1, ty + 1) >= 0 && this.index(grid, tx - 1, ty - 1) >= 0) {
      return this.slopeFromGrid(tx, ty);
    }
    return Math.hypot(
      (this.heightAt(tx + 1.5, ty + 0.5) - this.heightAt(tx - 0.5, ty + 0.5)) / 2,
      (this.heightAt(tx + 0.5, ty + 1.5) - this.heightAt(tx + 0.5, ty - 0.5)) / 2,
    );
  }

  /** Hazard at a world position (engine, uncached). */
  hazardAt(x: number, y: number): { type: 'none' | 'water' | 'lava'; dps: number; depth: number } {
    return hazardAt(x, y, this.seed);
  }

  /**
   * Elevation of the tile containing (x, y) — the same sample the server
   * publishes as `z`, so an avatar and the floor it stands on never differ.
   */
  tileHeightAt(x: number, y: number): number {
    const grid = this.grid();
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const i = this.index(grid, tx, ty);
    if (grid !== null && i >= 0) return grid.height[i]!;
    return heightAt(tx + 0.5, ty + 0.5, this.seed);
  }

  /** Hazard kind for the tile containing (x, y). */
  kindAt(x: number, y: number): number {
    const grid = this.grid();
    const i = this.index(grid, Math.floor(x), Math.floor(y));
    if (grid !== null && i >= 0) return grid.kind[i]!;
    const h = hazardAt(x, y, this.seed);
    return h.type === 'water' ? TERR_WATER : h.type === 'lava' ? TERR_LAVA : TERR_NONE;
  }

  /** Damage per second for the tile containing (x, y). */
  dpsAt(x: number, y: number): number {
    const grid = this.grid();
    const i = this.index(grid, Math.floor(x), Math.floor(y));
    if (grid !== null && i >= 0) return grid.dps[i]!;
    return hazardAt(x, y, this.seed).dps;
  }

  // -- cached arena grid --------------------------------------------------------

  /**
   * Build (once) and return the arena grid. Returns null only if the view was
   * constructed with a non-positive size.
   */
  grid(): GroundGrid | null {
    const hit = this.cached;
    if (hit !== null) return hit;
    const n = this.size;
    if (!(n > 0)) return null;
    const t0 = performance.now();
    const kind = new Uint8Array(n * n);
    const dps = new Float64Array(n * n);
    const height = new Float64Array(n * n);
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const wx = this.minX + tx + 0.5;
        const wy = this.minY + ty + 0.5;
        const hz = hazardAt(wx, wy, this.seed);
        const i = ty * n + tx;
        kind[i] = hz.type === 'water' ? TERR_WATER : hz.type === 'lava' ? TERR_LAVA : TERR_NONE;
        dps[i] = hz.dps;
        height[i] = heightAt(wx, wy, this.seed);
      }
    }
    const grid: GroundGrid = { minX: this.minX, minY: this.minY, w: n, h: n, kind, dps, height };
    this.cached = grid;
    this.builds++;
    this.lastBuildMs = performance.now() - t0;
    return grid;
  }

  private index(grid: GroundGrid | null, tx: number, ty: number): number {
    if (grid === null) return -1;
    const lx = tx - grid.minX;
    const ly = ty - grid.minY;
    if (lx < 0 || ly < 0 || lx >= grid.w || ly >= grid.h) return -1;
    return ly * grid.w + lx;
  }

  /** Hazard kind for a tile (implements TerrainMapLike). */
  kindAtTile(tx: number, ty: number): number {
    const grid = this.grid();
    const i = this.index(grid, tx, ty);
    if (grid !== null && i >= 0) return grid.kind[i]!;
    const h = hazardAt(tx + 0.5, ty + 0.5, this.seed);
    return h.type === 'water' ? TERR_WATER : h.type === 'lava' ? TERR_LAVA : TERR_NONE;
  }

  /** Elevation at a tile centre (visual renderers sample per tile). */
  heightAtTile(tx: number, ty: number): number {
    const grid = this.grid();
    const i = this.index(grid, tx, ty);
    if (grid !== null && i >= 0) return grid.height[i]!;
    return heightAt(tx + 0.5, ty + 0.5, this.seed);
  }

  /**
   * Slope magnitude for a tile, from the cached height grid (central
   * differences over one tile — free, and visually identical to the engine's
   * eps=0.5 sample at this resolution).
   */
  slopeFromGrid(tx: number, ty: number): number {
    const g = this.gradientFromGrid(tx, ty);
    return Math.hypot(g.gx, g.gy);
  }

  /**
   * Per-tile gradient (dh/dx, dh/dy) from the cached height grid. The renderer
   * turns this into a surface normal, so it is allocated per call but only
   * once per tile at build time.
   */
  gradientFromGrid(tx: number, ty: number): { gx: number; gy: number } {
    const grid = this.grid();
    if (grid === null) return { gx: 0, gy: 0 };
    const c = this.index(grid, tx, ty);
    if (c < 0) return { gx: 0, gy: 0 };
    const l = tx > grid.minX ? c - 1 : c;
    const r = tx + 1 < grid.minX + grid.w ? c + 1 : c;
    const u = ty > grid.minY ? c - grid.w : c;
    const d = ty + 1 < grid.minY + grid.h ? c + grid.w : c;
    return {
      gx: (grid.height[r]! - grid.height[l]!) / 2,
      gy: (grid.height[d]! - grid.height[u]!) / 2,
    };
  }

  // -- landmarks ----------------------------------------------------------------

  /** Landmark dots within `r` world units (memoized per rounded cell). */
  landmarksNear(x: number, y: number, r: number): LandmarkDot[] {
    const key = `${Math.floor(x / 64)},${Math.floor(y / 64)},${Math.round(r)}`;
    const hit = this.landmarkCache.get(key);
    if (hit !== undefined) return hit;
    const out = this.landmarks.near(x, y, r).map((lm) => ({
      id: lm.id,
      kind: lm.kind,
      name: lm.name,
      x: lm.x,
      y: lm.y,
      radius: lm.radius,
    }));
    if (this.landmarkCache.size > 256) this.landmarkCache.clear();
    this.landmarkCache.set(key, out);
    return out;
  }

  /** Loot anchors within `r` world units (spawn / loot consumers). */
  lootAnchorsNear(x: number, y: number, r: number): Array<{ id: string; x: number; y: number; tier: number }> {
    const out: Array<{ id: string; x: number; y: number; tier: number }> = [];
    for (const lm of this.landmarks.near(x, y, r)) {
      for (const a of lm.loot) {
        if (Math.hypot(a.x - x, a.y - y) <= r) out.push({ id: a.id, x: a.x, y: a.y, tier: a.tier });
      }
    }
    return out;
  }

  /** Landmarks in chunk coords (what the renderer wants for the visible set). */
  landmarksAroundChunk(cx: number, cy: number, rChunks: number): Landmark[] {
    return this.landmarks.findAroundChunk(cx, cy, rChunks);
  }

  /** Diagnostics for the status bar / tests. */
  stats(): { builds: number; lastBuildMs: number; landmarkCells: number } {
    return { builds: this.builds, lastBuildMs: this.lastBuildMs, landmarkCells: this.landmarks.computedCells };
  }
}

/** True when the kind is one of the damaging regions. */
export function isHazardKind(kind: number): boolean {
  return kind === TERR_WATER || kind === TERR_LAVA;
}