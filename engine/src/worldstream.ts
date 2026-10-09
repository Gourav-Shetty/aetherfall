// @aetherfall/engine — WorldStream: infinite deterministic chunk streaming.
//
// The overworld is unbounded, so nothing is stored up front. `WorldStream`
// turns chunk coordinates into `genChunk()` calls on demand, keeps the hot
// set in an LRU cache, and warms the neighbor ring around every miss so a
// player walking forward never waits on the next chunk.
//
//   const stream = new WorldStream({ seed: 1337 });
//   stream.forEachInRadius(x, y, 64, (chunk, cx, cy) => render(chunk, cx, cy));
//
// Determinism: chunks are pure functions of (cx, cy, size, seed), so two
// streams with the same seed produce byte-identical tiles regardless of query
// order, cache state, or which instance asks. Cache hits return the *same*
// object, so consumers can compare by identity if they want to.

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_WORLD_SEED,
  chunkOrigin,
  genChunk,
  genZonedChunk,
  getZone,
  type Chunk,
  type Tile,
  type ZonedChunk,
  type ZoneId,
} from './worldgen.js';

/** Hard cap on resident chunks per stream (spec budget). */
export const DEFAULT_MAX_CHUNKS = 512;

/** Neighbor ring at radius 1, in a fixed (deterministic) order. */
export const NEIGHBOR_RING_1: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export interface WorldStreamOptions {
  /** World seed; identical seeds => identical chunks. Default 1337. */
  seed?: number;
  /** Chunk edge in tiles. Default 32. */
  size?: number;
  /** LRU capacity in chunks. Default 512. */
  maxChunks?: number;
  /**
   * Neighbor ring depth prefetched on a miss: 0 = off, 1 = the 8 adjacent
   * chunks, 2 = the 24 chunks within two rings. Default 1.
   */
  prefetch?: number;
}

export interface StreamStats {
  /** getChunk calls served from cache. */
  hits: number;
  /** getChunk calls that had to generate. */
  misses: number;
  /** Chunks actually produced by genChunk. */
  generated: number;
  /** Chunks dropped by the LRU. */
  evicted: number;
  /** Chunks produced by neighbor prefetch. */
  prefetched: number;
  /** Tiles returned by tileAt/solidAt. */
  tileReads: number;
  /** Resident chunks right now. */
  resident: number;
  /** LRU capacity. */
  maxChunks: number;
}

interface ChunkRecord {
  cx: number;
  cy: number;
  chunk: Chunk;
  /** Populated lazily by getZonedChunk(). */
  zoned: ZonedChunk | null;
  /** Intrusive LRU links: `next` is more recently used. */
  newer: ChunkRecord | null;
  older: ChunkRecord | null;
}

const KEY_BIAS = 1 << 20;
const KEY_STRIDE = 1 << 21;

/**
 * Packed cache key. Numeric for |c| < 2^20 chunks (~33.5M tiles); the absurd
 * tail falls back to a string key so the world stays unbounded.
 */
function cacheKey(cx: number, cy: number): number | string {
  if (cx >= -KEY_BIAS && cx < KEY_BIAS && cy >= -KEY_BIAS && cy < KEY_BIAS) {
    return (cx + KEY_BIAS) * KEY_STRIDE + (cy + KEY_BIAS);
  }
  return `${cx},${cy}`;
}

export class WorldStream {
  private seed: number;
  private edge: number;
  private maxChunks: number;
  private prefetch: number;
  /** key -> record (O(1) lookup). */
  private lru = new Map<number | string, ChunkRecord>();
  /** Most / least recently used records (intrusive list over `lru`). */
  private mru: ChunkRecord | null = null;
  private lruTail: ChunkRecord | null = null;
  private counters = {
    hits: 0,
    misses: 0,
    generated: 0,
    evicted: 0,
    prefetched: 0,
    tileReads: 0,
  };

  constructor(opts: WorldStreamOptions = {}) {
    const size = opts.size ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(size) || size < 1) throw new Error('WorldStream: size must be >= 1');
    const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
    if (!Number.isInteger(maxChunks) || maxChunks < 1) {
      throw new Error('WorldStream: maxChunks must be >= 1');
    }
    const prefetch = opts.prefetch ?? 1;
    if (!Number.isInteger(prefetch) || prefetch < 0) {
      throw new Error('WorldStream: prefetch must be >= 0');
    }
    this.seed = (opts.seed ?? DEFAULT_WORLD_SEED) >>> 0;
    this.edge = size;
    this.maxChunks = maxChunks;
    this.prefetch = prefetch;
  }

  get worldSeed(): number {
    return this.seed;
  }

  get chunkSize(): number {
    return this.edge;
  }

  get capacity(): number {
    return this.maxChunks;
  }

  get prefetchDepth(): number {
    return this.prefetch;
  }

  /** Resident chunks currently in the cache. */
  get size(): number {
    return this.lru.size;
  }

  /** Snapshot of the counters (see `StreamStats`). */
  stats(): StreamStats {
    return { ...this.counters, resident: this.lru.size, maxChunks: this.maxChunks };
  }

  resetStats(): void {
    this.counters = { hits: 0, misses: 0, generated: 0, evicted: 0, prefetched: 0, tileReads: 0 };
  }

  clear(): void {
    this.lru.clear();
    this.mru = null;
    this.lruTail = null;
  }

  /**
   * Resident chunk coords, least-recently-used first (follows the LRU list,
   * not Map insertion order).
   */
  cachedCoords(): Array<{ cx: number; cy: number }> {
    const out: Array<{ cx: number; cy: number }> = [];
    for (let rec = this.lruTail; rec !== null; rec = rec.newer) {
      out.push({ cx: rec.cx, cy: rec.cy });
    }
    return out;
  }

  /** Is this chunk resident right now? */
  has(cx: number, cy: number): boolean {
    return this.lru.has(cacheKey(cx, cy));
  }

  /** Resident chunk without generating (undefined on a miss). */
  peek(cx: number, cy: number): Chunk | undefined {
    return this.lru.get(cacheKey(cx, cy))?.chunk;
  }

  /** Unlink a record from the recency list. */
  private unlink(rec: ChunkRecord): void {
    const newer = rec.newer;
    const older = rec.older;
    if (newer !== null) newer.older = older;
    else this.mru = older;
    if (older !== null) older.newer = newer;
    else this.lruTail = newer;
    rec.newer = null;
    rec.older = null;
  }

  /** Push a record to the most-recently-used end. */
  private linkFront(rec: ChunkRecord): void {
    rec.older = this.mru;
    rec.newer = null;
    if (this.mru !== null) this.mru.newer = rec;
    this.mru = rec;
    if (this.lruTail === null) this.lruTail = rec;
  }

  private insert(rec: ChunkRecord, prefetched: boolean): void {
    this.lru.set(cacheKey(rec.cx, rec.cy), rec);
    this.linkFront(rec);
    this.counters.generated++;
    if (prefetched) this.counters.prefetched++;
    while (this.lru.size > this.maxChunks && this.lruTail !== null) {
      const victim = this.lruTail;
      this.unlink(victim);
      this.lru.delete(cacheKey(victim.cx, victim.cy));
      this.counters.evicted++;
    }
  }

  private generate(cx: number, cy: number, prefetched: boolean): ChunkRecord {
    const rec: ChunkRecord = {
      cx,
      cy,
      chunk: genChunk(cx, cy, this.edge, this.seed),
      zoned: null,
      newer: null,
      older: null,
    };
    this.insert(rec, prefetched);
    return rec;
  }

  /**
   * Warm the rings around (cx, cy). Only missing chunks are generated and
   * nothing cascades (depth 0), so this is a flat, bounded amount of work:
   * 8 chunks for `prefetch: 1`, 24 for `prefetch: 2`.
   */
  private prefetchRing(cx: number, cy: number, depth: number): void {
    if (this.lru.size >= this.maxChunks) return;
    for (let ring = 1; ring <= depth; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (this.lru.has(cacheKey(nx, ny))) continue;
          this.generate(nx, ny, true);
          if (this.lru.size >= this.maxChunks) return;
        }
      }
    }
  }

  private load(cx: number, cy: number): ChunkRecord {
    const ring = this.prefetch;
    const hit = this.lru.get(cacheKey(cx, cy));
    if (hit !== undefined) {
      if (hit !== this.mru) {
        this.unlink(hit);
        this.linkFront(hit);
      }
      this.counters.hits++;
      // Prefetch on access, not just on miss: walking into a chunk that was
      // already resident must still warm the ring beyond it.
      if (ring > 0) this.prefetchRing(cx, cy, ring);
      return hit;
    }
    this.counters.misses++;
    const rec = this.generate(cx, cy, false);
    if (ring > 0) this.prefetchRing(cx, cy, ring);
    return rec;
  }

  /** Chunk (generating + caching on miss). Same object on repeated calls. */
  getChunk(cx: number, cy: number): Chunk {
    return this.load(cx, cy).chunk;
  }

  /** Chunk + zone decoration (genZonedChunk), memoized on the same record. */
  getZonedChunk(cx: number, cy: number): ZonedChunk {
    const rec = this.load(cx, cy);
    if (rec.zoned === null) {
      rec.zoned = genZonedChunk(rec.cx, rec.cy, this.edge, this.seed);
    }
    return rec.zoned;
  }

  /**
   * Tile at a world position (floored to integer tiles). Fast path: cache hit
   * -> one array-of-arrays lookup.
   */
  tileAt(x: number, y: number): Tile {
    this.counters.tileReads++;
    const size = this.edge;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const cx = Math.floor(tx / size);
    const cy = Math.floor(ty / size);
    const rec = this.load(cx, cy);
    return rec.chunk.tiles[ty - cy * size]![tx - cx * size];
  }

  /** True when the tile blocks movement (1 = wall). */
  solidAt(x: number, y: number): boolean {
    return this.tileAt(x, y) === 1;
  }

  /** Zone at integer world coordinates (samples the owning chunk center). */
  zoneAt(x: number, y: number): ZoneId {
    const cx = Math.floor(x / this.edge);
    const cy = Math.floor(y / this.edge);
    return getZone(cx * this.edge + this.edge / 2, cy * this.edge + this.edge / 2, this.seed);
  }

  /** World position of a chunk's (0,0) tile (delegates to `chunkOrigin`). */
  originOf(cx: number, cy: number): { x: number; y: number } {
    return chunkOrigin(cx, cy, this.edge);
  }

  /**
   * Chunk coords whose area intersects the circle (x, y, r) — no generation,
   * deterministic nearest-first ordering (distance, then cy, then cx).
   */
  chunksInRadius(x: number, y: number, r: number): Array<{ cx: number; cy: number }> {
    if (!(r >= 0)) return [];
    const size = this.edge;
    const ccx = Math.floor(x / size);
    const ccy = Math.floor(y / size);
    const span = Math.ceil(r / size) + 1;
    const out: Array<{ cx: number; cy: number; d2: number }> = [];
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const cx = ccx + dx;
        const cy = ccy + dy;
        const { x: ox, y: oy } = chunkOrigin(cx, cy, size);
        // Closest point of the chunk AABB to the query center.
        const nx = Math.max(ox, Math.min(x, ox + size - 1));
        const ny = Math.max(oy, Math.min(y, oy + size - 1));
        const ddx = nx - x;
        const ddy = ny - y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > r * r) continue;
        out.push({ cx, cy, d2 });
      }
    }
    out.sort((a, b) => a.d2 - b.d2 || a.cy - b.cy || a.cx - b.cx);
    return out.map(({ cx, cy }) => ({ cx, cy }));
  }

  /**
   * Generate every chunk intersecting the circle (x, y, r) and hand it to `cb`
   * in the same nearest-first order as `chunksInRadius`. Returns the visit
   * count. Chunks are generated one at a time (each with its own prefetch), so
   * the cache stays bounded no matter how big `r` is.
   */
  forEachInRadius(
    x: number,
    y: number,
    r: number,
    cb: (chunk: Chunk, cx: number, cy: number) => void,
  ): number {
    const coords = this.chunksInRadius(x, y, r);
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i]!;
      cb(this.getChunk(c.cx, c.cy), c.cx, c.cy);
    }
    return coords.length;
  }
}