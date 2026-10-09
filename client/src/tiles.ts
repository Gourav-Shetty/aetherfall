// Client-side deterministic tile mirror of engine/src/worldgen.ts genChunk.
// Visual + minimap + editor use only. Server is authoritative (no collision yet),
// so any drift here only affects background art, never gameplay.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CHUNK = 32;
export const TILE_SEED = 1337; // must match engine genChunk default seed
export type Tile = 0 | 1; // 0 walkable, 1 wall

function chunkTiles(cx: number, cy: number): Tile[][] {
  // Identical expression to engine genChunk so chunk output matches exactly.
  const rand = mulberry32((TILE_SEED ^ (cx * 374761393) ^ (cy * 668265263)) >>> 0);
  const tiles: Tile[][] = [];
  for (let y = 0; y < CHUNK; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < CHUNK; x++) {
      const edge = x === 0 || y === 0 || x === CHUNK - 1 || y === CHUNK - 1;
      row.push(edge || rand() < 0.08 ? 1 : 0);
    }
    tiles.push(row);
  }
  return tiles;
}

export class ChunkCache {
  private cache = new Map<string, Tile[][]>();
  tile(wx: number, wy: number): Tile {
    const cx = Math.floor(wx / CHUNK), cy = Math.floor(wy / CHUNK);
    const k = cx + ',' + cy;
    let c = this.cache.get(k);
    if (!c) {
      if (this.cache.size > 64) this.cache.clear();
      c = chunkTiles(cx, cy);
      this.cache.set(k, c);
    }
    const lx = wx - cx * CHUNK, ly = wy - cy * CHUNK;
    if (lx < 0 || ly < 0 || lx >= CHUNK || ly >= CHUNK) return 1;
    return c[ly][lx];
  }
}

/** Smooth 0 (midnight) .. 1 (noon) daylight factor. Shared by both renderers. */
export function daylightFactor(tSec: number, dayLen = 120): number {
  return (Math.sin((tSec / dayLen) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
}
