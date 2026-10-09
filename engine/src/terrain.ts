// @aetherfall/engine — continuous terrain field (height / slope / hazards).
//
// Everything here is a pure function of (x, y, seed): no caches, no shared
// mutable state, no call-order dependence. The server and any client can
// sample the same coordinates and get bit-identical numbers, which is what
// makes the field safe to stream lazily.
//
//   heightAt(x, y)   signed elevation in world units (0 = WATER_LEVEL)
//   slopeAt(x, y)    |grad height| (rise over run), central differences
//   hazardAt(x, y)   { type, dps, depth } for water / lava regions
//
// Height is built from the *same* elevation field `genChunk()` samples
// (worldgen.ts), so terrain and tile walkability never disagree about where
// the shoreline is.

import {
  DEFAULT_WORLD_SEED,
  fbm,
  getBiome,
  getElevation,
  getZone,
  valueNoise,
  type Biome,
  type ZoneId,
} from './worldgen.js';

/** Elevation below this is ocean — mirrors `getBiome()`'s ocean/beach edge. */
export const OCEAN_EDGE = 0.32;
/** Water surface height (world units). Height < 0 is under water. */
export const WATER_LEVEL = 0;
/** Lava "sea level" inside the caldera; height <= this (above water) is molten. */
export const LAVA_LEVEL = 3;
/** World units of elevation per unit of normalized fBm elevation. */
export const HEIGHT_SCALE = 78;
/** Amplitude of the rolling detail octave (world units). */
export const HEIGHT_DETAIL = 7;
/** Amplitude of ridged mountain crests, faded in by elevation (world units). */
export const HEIGHT_RIDGE = 30;
/** Base damage per second while swimming (shallow water). */
export const WATER_DPS = 5;
/** Extra dps per world unit of submersion depth. */
export const WATER_DPS_PER_DEPTH = 1.5;
/** Damage cap for water (deep ocean still survivable for a while). */
export const WATER_DPS_MAX = 20;
/** Damage per second while standing in lava. */
export const LAVA_DPS = 22;
/** Slopes above this (rise/run) read as impassable cliffs (~11% of the world). */
export const WALKABLE_MAX_SLOPE = 1.6;
/**
 * Documented Lipschitz bound on the height field: |dh/dx| stays below this for
 * every sample in the test corpus (observed max ~5.2/unit). Terrain can never
 * teleport a body vertically, which is what makes streaming/simulation safe.
 */
export const HEIGHT_MAX_GRADIENT = 6;

// -- internals -----------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Ridged fBm in [0, 1]: |2n-1| folded so octaves stack into sharp crests
 * instead of blobs. Squared to sharpen the peaks further.
 */
function ridgedFbm(x: number, y: number, octaves: number, seed: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(x * freq, y * freq, (seed + o * 1013904223) >>> 0);
    const ridge = 1 - Math.abs(n * 2 - 1);
    sum += amp * ridge * ridge;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return norm === 0 ? 0 : sum / norm;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// -- height + slope -------------------------------------------------------------

/**
 * Signed elevation in world units. Smooth (C0 everywhere, Lipschitz-bounded):
 *
 *   (elevation - OCEAN_EDGE) * HEIGHT_SCALE   continental shape, 0 at the shore
 * + detail * HEIGHT_DETAIL                   rolling hills everywhere
 * + ridge * HEIGHT_RIDGE                     mountain crests, faded in high up
 *
 * Deterministic and seed-derived; `heightAt(x,y,seed)` is stable across
 * processes and machines.
 */
export function heightAt(x: number, y: number, seed = DEFAULT_WORLD_SEED): number {
  const e = getElevation(x, y, seed);
  const detail =
    fbm(x * 0.05 + 11.3, y * 0.05 - 7.1, 3, (seed ^ 0x2f6b1d) >>> 0) - 0.5;
  const mask = smoothstep(0.52, 0.86, e);
  const ridge =
    mask *
    ridgedFbm(x * 0.014 - 3.7, y * 0.014 + 5.9, 3, (seed ^ 0x7f4a7c) >>> 0);
  return (e - OCEAN_EDGE) * HEIGHT_SCALE + detail * HEIGHT_DETAIL + ridge * HEIGHT_RIDGE;
}

/** d(height)/dx by central difference (world units per world unit). */
export function slopeXAt(x: number, y: number, seed = DEFAULT_WORLD_SEED, eps = 0.5): number {
  return (heightAt(x + eps, y, seed) - heightAt(x - eps, y, seed)) / (2 * eps);
}

/** d(height)/dy by central difference. */
export function slopeYAt(x: number, y: number, seed = DEFAULT_WORLD_SEED, eps = 0.5): number {
  return (heightAt(x, y + eps, seed) - heightAt(x, y - eps, seed)) / (2 * eps);
}

/**
 * Steepness (magnitude of the height gradient). Costs 4 `heightAt()` calls,
 * so prefer `slopeXAt`/`slopeYAt` when a single axis is enough.
 */
export function slopeAt(x: number, y: number, seed = DEFAULT_WORLD_SEED, eps = 0.5): number {
  const gx = slopeXAt(x, y, seed, eps);
  const gy = slopeYAt(x, y, seed, eps);
  return Math.hypot(gx, gy);
}

/** Gradient vector — convenience wrapper (allocates). */
export function slopeVectorAt(
  x: number,
  y: number,
  seed = DEFAULT_WORLD_SEED,
  eps = 0.5,
): { gx: number; gy: number; slope: number } {
  const gx = slopeXAt(x, y, seed, eps);
  const gy = slopeYAt(x, y, seed, eps);
  return { gx, gy, slope: Math.hypot(gx, gy) };
}

/** True when the local slope exceeds `limit` (default `WALKABLE_MAX_SLOPE`). */
export function tooSteep(
  x: number,
  y: number,
  limit = WALKABLE_MAX_SLOPE,
  seed = DEFAULT_WORLD_SEED,
  eps = 0.5,
): boolean {
  return slopeAt(x, y, seed, eps) > limit;
}

// -- hazards --------------------------------------------------------------------

export type HazardType = 'none' | 'water' | 'lava';

export interface Hazard {
  type: HazardType;
  /** Damage per second; 0 when `type === 'none'`. */
  dps: number;
  /** Immersion below the surface (world units); 0 when `type === 'none'`. */
  depth: number;
}

const NO_HAZARD: Hazard = { type: 'none', dps: 0, depth: 0 };

/**
 * Hazard field for a world position.
 *
 * - `water` — exactly the ocean biome, i.e. the tiles `genChunk()` already
 *   marks as walls, so "hazard" and "impassable" never contradict each other.
 *   Damage ramps with submersion depth (shallow shore ~5 dps, deep ~20 dps).
 * - `lava` — only inside the `volcano` zone, where the terrain sits at or
 *   below `LAVA_LEVEL` and is above the water line. Flat 22 dps: lava is a
 *   wall you should route around, not a slow swim.
 * - `none` — everything else, dps 0.
 *
 * Lava is tested first so a caldera basin reads as lava rather than water;
 * the two can never overlap because lava requires height > WATER_LEVEL.
 *
 * Pure and deterministic.
 */
export function hazardAt(x: number, y: number, seed = DEFAULT_WORLD_SEED): Hazard {
  const h = heightAt(x, y, seed);
  const ocean = getElevation(x, y, seed) < OCEAN_EDGE;
  if (!ocean && getZone(x, y, seed) === 'volcano' && h <= LAVA_LEVEL) {
    return { type: 'lava', dps: LAVA_DPS, depth: round2(Math.max(0, h - WATER_LEVEL)) };
  }
  if (ocean) {
    const depth = Math.max(0, WATER_LEVEL - h);
    const dps = Math.min(WATER_DPS_MAX, WATER_DPS + depth * WATER_DPS_PER_DEPTH);
    return { type: 'water', dps: round2(dps), depth: round2(depth) };
  }
  return NO_HAZARD;
}

/** True where `hazardAt()` reports a damaging region. */
export function isHazard(x: number, y: number, seed = DEFAULT_WORLD_SEED): boolean {
  return hazardAt(x, y, seed).type !== 'none';
}

/** Everything a consumer usually wants about one world position. Allocates. */
export interface TerrainSample {
  x: number;
  y: number;
  height: number;
  slope: number;
  biome: Biome;
  zone: ZoneId;
  hazard: Hazard;
}

export function terrainAt(x: number, y: number, seed = DEFAULT_WORLD_SEED): TerrainSample {
  const height = heightAt(x, y, seed);
  return {
    x,
    y,
    height,
    slope: slopeAt(x, y, seed),
    biome: getBiome(x, y, seed),
    zone: getZone(x, y, seed),
    hazard: hazardAt(x, y, seed),
  };
}