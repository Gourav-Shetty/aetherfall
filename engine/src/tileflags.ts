// @aetherfall/engine — tile flag sampler (walk/block/hazard per position).
//
// Pure functions of (x, y, seed): the same inputs always yield the same flags
// on any machine. Combines the existing zone / biome / hazard field into the
// TileFlags struct defined in worldgen.ts (see tileFlagsFor). No caches, no
// shared state, no wire-format impact.

import {
  DEFAULT_WORLD_SEED,
  getBiome,
  getZone,
  tileFlagsFor,
  type TileFlags,
} from './worldgen.js';
import { hazardAt } from './terrain.js';

/**
 * Flags for a world position: biome + zone context with the terrain block set
 * (water/lava) as walk/block. `block` is exactly `hazardAt() !== 'none'`,
 * so this matches the sim's historical collision block set by construction.
 */
export function tileFlags(x: number, y: number, seed = DEFAULT_WORLD_SEED): TileFlags {
  const biome = getBiome(x, y, seed);
  const zone = getZone(x, y, seed);
  return tileFlagsFor(biome, zone, hazardAt(x, y, seed).type);
}

/** True when terrain blocks movement at (x, y). Convenience wrapper. */
export function tileBlocked(x: number, y: number, seed = DEFAULT_WORLD_SEED): boolean {
  return tileFlags(x, y, seed).block;
}

/** True when terrain allows movement at (x, y). Convenience wrapper. */
export function tileWalkable(x: number, y: number, seed = DEFAULT_WORLD_SEED): boolean {
  return tileFlags(x, y, seed).walk;
}
