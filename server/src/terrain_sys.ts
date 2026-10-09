// @aetherfall/server — terrain integration.
//
// Until now the authoritative sim only knew about `data/walls.json` rects and
// a flat 0..100 arena, while the engine already exposed a full deterministic
// terrain field (engine/src/terrain.ts, engine/src/worldstream.ts,
// engine/src/landmarks.ts). This module is the adapter that makes the sim
// actually consume it:
//
//   (a) collision   — ocean and caldera-lava tiles are solid, so the body
//                     slides along the shoreline instead of walking into it.
//   (b) height      — every player carries the authoritative `heightAt()` of
//                     the tile it stands on (`SimPlayer.z`, echoed in the
//                     snapshot as the optional `z` field).
//   (c) hazards     — `hazardAt().dps` becomes damage-over-time: standing in
//                     the shallows burns 5-6 hp/s, lava 22 hp/s. Lethal DOT
//                     washes the player ashore at the nearest safe anchor.
//   (d) landmarks   — landmark centres and their loot anchors are the
//                     preferred spawn/respawn anchors; the fallbacks are a
//                     deterministic dry-ground spiral.
//
// Perf shape (this is the whole point of the design):
//
//   * Every query is served from a per-chunk terrain layer (three typed
//     arrays: hazard kind, hazard dps, tile height) that is materialised once
//     per streamed chunk, so the steady-state cost is an array index instead
//     of a `hazardAt()` call (~0.30 us -> ~5 ns).
//   * Layers are pinned through the engine `WorldStream`, so residency,
//     eviction and the neighbour prefetch ring stay owned by the engine's LRU
//     (512 chunks) instead of growing a second, competing cache here.
//   * The per-tick hook does zero allocation: no object literals, no Map
//     inserts per tile (recency is refreshed at most once per tick via a
//     stamp), and it never touches the snapshot serializer's hot path beyond
//     one extra number per entity.
//
// `z` is only present on the wire when terrain is enabled (`TERRAIN=off`
// turns the whole thing off), so a deployment that opts out keeps byte
// identical snapshots.

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_WORLD_SEED,
  LAVA_LEVEL,
  LandmarkIndex,
  WATER_LEVEL,
  WorldStream,
  hazardAt,
  heightAt,
  type LootAnchor,
  type Landmark,
} from '@aetherfall/engine';
import { PLAYER_RADIUS } from '@aetherfall/shared';
import type { Sim, SimPlayer } from './sim.js';

/** `hazardAt().type` packed into a byte for cheap per-tile tests. */
export const TERR_NONE = 0;
export const TERR_WATER = 1;
export const TERR_LAVA = 2;

/** World seed the server sim and the client sample (matches tiles.ts). */
export const TERRAIN_SEED = DEFAULT_WORLD_SEED;

export interface TerrainOptions {
  /** World seed. Default 1337. */
  seed?: number;
  /** Chunk edge in tiles. Default 32. */
  chunkSize?: number;
  /** Derived terrain layers cached at once. Default 512 (== stream LRU). */
  maxLayers?: number;
  /** Neighbor prefetch depth handed to the WorldStream. Default 1. */
  prefetch?: number;
  /** Damage-over-time on/off. Default true. */
  damage?: boolean;
  /** Landmark search radius for spawn anchors, world units. Default 112. */
  landmarkRadius?: number;
}

/** One streamed chunk plus its derived terrain layer (tile-granular). */
interface TerrainLayer {
  cx: number;
  cy: number;
  /** hazardAt().type per tile: TERR_NONE / TERR_WATER / TERR_LAVA. */
  kind: Uint8Array;
  /** hazardAt().dps per tile (0 when kind === TERR_NONE). */
  dps: Float64Array;
  /**
   * heightAt() at the tile centre — the authoritative entity z.
   * Float64 so the cached value is bit-identical to the engine's sample (the
   * client's own `heightAt` call must produce the exact same number).
   */
  height: Float64Array;
  /** Recency stamp, refreshed at most once per tick. */
  stamp: number;
}

/** Reusable probe result: `probe()` never allocates. */
export interface TileProbe {
  kind: number;
  dps: number;
  height: number;
}

/** Where a respawn/spawn was placed. */
export interface SpawnAnchor {
  x: number;
  y: number;
  z: number;
  source: 'landmark' | 'loot' | 'dry';
  landmarkId: string;
}

/** A player washed ashore / nudged out of terrain. Drained by the server. */
export interface TerrainEvent {
  id: number;
  x: number;
  y: number;
  z: number;
  kind: 'drown' | 'burn' | 'unstick';
  source: SpawnAnchor['source'];
}

export interface TerrainStats {
  /** Derived layers resident right now. */
  layers: number;
  /** Layer lookups served without a rebuild. */
  layerHits: number;
  /** Layer lookups that had to materialise a chunk layer. */
  layerMisses: number;
  /** Ticks the per-tick hook has run. */
  ticks: number;
  /** hp removed by terrain DOT since construction. */
  dotDamage: number;
  /** Ticks on which at least one player took DOT. */
  dotTicks: number;
  /** Players washed ashore after lethal terrain damage. */
  drowns: number;
  /** Players teleported out of a solid tile (persisted bad pos, spawn in water). */
  unstucks: number;
  stream: ReturnType<WorldStream['stats']>;
}

const DEFAULTS = { chunkSize: DEFAULT_CHUNK_SIZE, maxLayers: 512, prefetch: 1, landmarkRadius: 112 } as const;

/** Fresh zeroed probe (hot path never allocates; callers pass one in). */
function newProbe(): TileProbe {
  return { kind: TERR_NONE, dps: 0, height: 0 };
}

/**
 * Terrain as the sim sees it: a `WorldStream` for chunk residency plus a
 * derived per-chunk layer for O(1) hazard/height/solid queries.
 *
 * Every method is pure w.r.t. cache state — a cold `TerrainField` and a warm
 * one return bit-identical numbers for the same (x, y).
 */
export class TerrainField {
  readonly seed: number;
  readonly chunkSize: number;
  /** Engine chunk stream: LRU (512) + neighbor prefetch owns residency. */
  readonly stream: WorldStream;
  readonly landmarks: LandmarkIndex;
  private readonly maxLayers: number;
  private readonly landmarkRadius: number;
  /** key (`cx,cy`) -> layer, in LRU order (re-inserted on use). */
  private layers = new Map<string, TerrainLayer>();
  private stamp = 0;
  private layerHits = 0;
  private layerMisses = 0;
  /** Scratch probe so `probe()` stays allocation-free on the hot path. */
  readonly scratch: TileProbe = newProbe();

  constructor(opts: TerrainOptions = {}) {
    this.seed = opts.seed ?? TERRAIN_SEED;
    this.chunkSize = opts.chunkSize ?? DEFAULTS.chunkSize;
    this.maxLayers = Math.max(1, opts.maxLayers ?? DEFAULTS.maxLayers);
    this.landmarkRadius = opts.landmarkRadius ?? DEFAULTS.landmarkRadius;
    this.stream = new WorldStream({
      seed: this.seed,
      size: this.chunkSize,
      maxChunks: this.maxLayers,
      prefetch: opts.prefetch ?? DEFAULTS.prefetch,
    });
    this.landmarks = new LandmarkIndex(this.seed, 256);
  }

  /**
   * Start a new tick: bump the recency stamp so layer touches stop reordering
   * the LRU (one Map move per layer per tick instead of one per query).
   */
  beginTick(): void {
    this.stamp++;
  }

  /** Layer lookup + lazy materialisation. Returns null for a bad coord. */
  private layer(cx: number, cy: number): TerrainLayer | null {
    const key = cx + ',' + cy;
    const hit = this.layers.get(key);
    if (hit !== undefined) {
      if (hit.stamp !== this.stamp) {
        this.layers.delete(key);
        this.layers.set(key, hit);
        hit.stamp = this.stamp;
      }
      this.layerHits++;
      return hit;
    }
    this.layerMisses++;
    return this.buildLayer(cx, cy, key);
  }

  private buildLayer(cx: number, cy: number, key: string): TerrainLayer | null {
    const n = this.chunkSize;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    // Pin the engine chunk: this is what keeps the derived layer and the
    // streamed genChunk tiles (and therefore the LRU + prefetch ring)
    // describing the same residency set.
    this.stream.getChunk(cx, cy);
    const kind = new Uint8Array(n * n);
    const dps = new Float64Array(n * n);
    const height = new Float64Array(n * n);
    const ox = cx * n;
    const oy = cy * n;
    for (let ty = 0; ty < n; ty++) {
      const wy = oy + ty + 0.5;
      const row = ty * n;
      for (let tx = 0; tx < n; tx++) {
        const wx = ox + tx + 0.5;
        const hz = hazardAt(wx, wy, this.seed);
        const i = row + tx;
        kind[i] = hz.type === 'water' ? TERR_WATER : hz.type === 'lava' ? TERR_LAVA : TERR_NONE;
        dps[i] = hz.dps;
        // Authoritative entity z: the same sample the client renders as the
        // tile's floor height, so avatar and ground can never disagree.
        height[i] = heightAt(wx, wy, this.seed);
      }
    }
    const layer: TerrainLayer = { cx, cy, kind, dps, height, stamp: this.stamp };
    // Amortised bulk eviction *before* the insert, so the resident set never
    // exceeds the cap even for a single tick (drop the oldest eighth).
    if (this.layers.size >= this.maxLayers) {
      let drop = Math.max(1, this.maxLayers >> 3);
      for (const k of this.layers.keys()) {
        this.layers.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.layers.set(key, layer);
    return layer;
  }

  /** Reusable layer+index cursor, so per-tile reads never allocate. */
  private readonly ref = { layer: null as TerrainLayer | null, i: -1 };

  /** Resolve (tx, ty) to its chunk layer + flat index in one Map lookup. */
  private tileRef(tx: number, ty: number, out = this.ref): { layer: TerrainLayer | null; i: number } {
    const n = this.chunkSize;
    const cx = Math.floor(tx / n);
    const cy = Math.floor(ty / n);
    const layer = this.layer(cx, cy);
    out.layer = layer;
    out.i = layer === null ? -1 : (ty - cy * n) * n + (tx - cx * n);
    return out;
  }

  /** Hazard kind for a tile: TERR_NONE / TERR_WATER / TERR_LAVA. */
  kindAtTile(tx: number, ty: number): number {
    const r = this.tileRef(tx, ty);
    return r.layer === null || r.i < 0 ? TERR_NONE : r.layer.kind[r.i]!;
  }

  /** Terrain height at a tile centre (the entity's authoritative z). */
  heightAtTile(tx: number, ty: number): number {
    const r = this.tileRef(tx, ty);
    return r.layer === null || r.i < 0 ? 0 : r.layer.height[r.i]!;
  }

  /** Damage per second at a tile centre (0 on dry land). */
  dpsAtTile(tx: number, ty: number): number {
    const r = this.tileRef(tx, ty);
    return r.layer === null || r.i < 0 ? 0 : r.layer.dps[r.i]!;
  }

  /** Fill `out` with kind/dps/height for the tile containing (x, y). */
  probe(x: number, y: number, out: TileProbe = this.scratch): TileProbe {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const n = this.chunkSize;
    const cx = Math.floor(tx / n);
    const cy = Math.floor(ty / n);
    const layer = this.layer(cx, cy);
    if (layer === null) {
      out.kind = TERR_NONE;
      out.dps = 0;
      out.height = 0;
      return out;
    }
    const i = (ty - cy * n) * n + (tx - cx * n);
    out.kind = layer.kind[i]!;
    out.dps = layer.dps[i]!;
    out.height = layer.height[i]!;
    return out;
  }

  /** Hazard kind for the tile containing (x, y). */
  kindAt(x: number, y: number): number {
    return this.probe(x, y).kind;
  }

  /** Damage per second for the tile containing (x, y). */
  dpsAt(x: number, y: number): number {
    return this.probe(x, y).dps;
  }

  /** Entity z for a world position (tile-granular). */
  zAt(x: number, y: number): number {
    return this.probe(x, y).height;
  }

  /** Is the tile containing (x, y) solid terrain (water or lava)? */
  solidAt(x: number, y: number): boolean {
    return this.probe(x, y).kind !== TERR_NONE;
  }

  /** Dry, walkable terrain at (x, y)? */
  walkableAt(x: number, y: number): boolean {
    return this.probe(x, y).kind === TERR_NONE;
  }

  /**
   * Solid-terrain test for a body circle. Walks only the (at most) 3x3 tiles
   * the circle can touch, so it is a handful of array reads.
   */
  solidCircle(x: number, y: number, r: number = PLAYER_RADIUS): boolean {
    const x0 = Math.floor(x - r);
    const x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r);
    const y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.kindAtTile(tx, ty) !== TERR_NONE) return true;
      }
    }
    return false;
  }

  /**
   * Move a body against solid terrain, trying the full step first and falling
   * back to one axis at a time so shoreline movement slides instead of
   * sticking. Returns the two deltas to apply (0 = that axis was blocked).
   */
  slide(x: number, y: number, dx: number, dy: number, r: number = PLAYER_RADIUS): { dx: number; dy: number } {
    const nx = x + dx;
    const ny = y + dy;
    if (!this.solidCircle(nx, ny, r)) return { dx, dy };
    const ax = this.solidCircle(nx, y, r) ? 0 : dx;
    const ay = this.solidCircle(x + ax, ny, r) ? 0 : dy;
    return { dx: ax, dy: ay };
  }

  /** Nearest landmark within `r` (memoized cells; null when none). */
  nearestLandmark(x: number, y: number, r = this.landmarkRadius): Landmark | null {
    let best: Landmark | null = null;
    let bestD2 = r * r;
    for (const lm of this.landmarks.near(x, y, r)) {
      const d2 = (lm.x - x) ** 2 + (lm.y - y) ** 2;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = lm;
      }
    }
    return best;
  }

  /** All landmarks within `r` world units (deterministic order). */
  landmarksNear(x: number, y: number, r = this.landmarkRadius): Landmark[] {
    return this.landmarks.near(x, y, r);
  }

  /** Loot anchors within `r` world units (all landmarks in range). */
  lootAnchorsNear(x: number, y: number, r = this.landmarkRadius): LootAnchor[] {
    const out: LootAnchor[] = [];
    for (const lm of this.landmarks.near(x, y, r)) {
      for (const a of lm.loot) {
        if (Math.hypot(a.x - x, a.y - y) <= r) out.push(a);
      }
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /**
   * Best spawn/respawn anchor near (x, y):
   *
   *   1. the current spot, when it is already dry ground (distance 0 wins),
   *   2. a landmark loot anchor inside a landmark's footprint (site-validated
   *      at generation time: never water, never lava, never a cliff face),
   *   3. the landmark centre itself,
   *   4. a dry-ground spiral outwards from (x, y).
   *
   * Candidates are ranked by distance, so a landmark is only used when it is
   * genuinely the nearest safe ground (a wash ashore 2m from the bank must not
   * teleport the player 110m to a ruin).
   */
  spawnAnchor(
    x: number,
    y: number,
    opts: { maxR?: number; bodyR?: number; landmarkRadius?: number } = {},
  ): SpawnAnchor | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const maxR = opts.maxR ?? 16;
    const bodyR = opts.bodyR ?? PLAYER_RADIUS;
    const lmR = opts.landmarkRadius ?? this.landmarkRadius;
    const here = this.probe(x, y, newProbe());
    const hereDry = here.kind === TERR_NONE && !this.solidCircle(x, y, bodyR);
    // Standing exactly on a landmark anchor keeps that provenance, so a shrine
    // spawn still reports which ruin it belongs to.
    const exact = hereDry ? this.anchorAt(x, y, lmR) : null;
    if (exact !== null) return { x, y, z: here.height, ...exact };
    if (hereDry) return { x, y, z: here.height, source: 'dry', landmarkId: '' };
    let best: SpawnAnchor | null = null;
    let bestD2 = Infinity;
    const consider = (ax: number, ay: number, source: SpawnAnchor['source'], id: string): void => {
      const d2 = (ax - x) ** 2 + (ay - y) ** 2;
      if (d2 >= bestD2) return;
      if (this.solidCircle(ax, ay, bodyR)) return;
      bestD2 = d2;
      best = { x: ax, y: ay, z: this.zAt(ax, ay), source, landmarkId: id };
    };
    // Landmarks first (they are rare and memoized), then the dry spiral; both
    // feed the same nearest-candidate comparison.
    for (const lm of this.landmarks.near(x, y, lmR)) {
      if (Math.hypot(lm.x - x, lm.y - y) > lmR) continue;
      for (const a of lm.loot) consider(a.x, a.y, 'loot', lm.id);
      consider(lm.x, lm.y, 'landmark', lm.id);
    }
    for (let r = 0.5; r <= maxR && bestD2 > r * r; r += 0.5) {
      const steps = Math.max(8, Math.ceil(r * 8));
      for (let a = 0; a < steps; a++) {
        const ang = (a / steps) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r;
        const ny = y + Math.sin(ang) * r;
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
        consider(nx, ny, 'dry', '');
        if (bestD2 <= r * r) break;
      }
    }
    return best;
  }

  /** Provenance when (x, y) sits on a landmark loot anchor or centre. */
  private anchorAt(
    x: number,
    y: number,
    lmR: number,
  ): { source: SpawnAnchor['source']; landmarkId: string } | null {
    for (const lm of this.landmarks.near(x, y, lmR)) {
      if (Math.abs(lm.x - x) < 0.5 && Math.abs(lm.y - y) < 0.5) {
        return { source: 'landmark', landmarkId: lm.id };
      }
      for (const a of lm.loot) {
        if (Math.abs(a.x - x) < 0.5 && Math.abs(a.y - y) < 0.5) {
          return { source: 'loot', landmarkId: lm.id };
        }
      }
    }
    return null;
  }

  /** Force-build (and cache) every layer a radius of chunks touches. */
  warmAround(x: number, y: number, radiusChunks: number): number {
    const n = this.chunkSize;
    const cx = Math.floor(x / n);
    const cy = Math.floor(y / n);
    let built = 0;
    for (let dy = -radiusChunks; dy <= radiusChunks; dy++) {
      for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        if (this.layer(cx + dx, cy + dy) !== null) built++;
      }
    }
    return built;
  }

  stats(): TerrainStats {
    return {
      layers: this.layers.size,
      layerHits: this.layerHits,
      layerMisses: this.layerMisses,
      ticks: 0,
      dotDamage: 0,
      dotTicks: 0,
      drowns: 0,
      unstucks: 0,
      stream: this.stream.stats(),
    };
  }
}

/**
 * `TerrainSystem` is the per-sim glue: it owns the field, installs itself as a
 * post-integrate `SimSystemHook` and reports what it did so the server can
 * broadcast respawns / expose metrics.
 *
 * Allocation-free per tick: one probe per player, three numbers written.
 */
export class TerrainSystem {
  readonly field: TerrainField;
  private readonly damage: boolean;
  private readonly landmarkRadius: number;
  private t = 0;
  private dotDamage = 0;
  private dotTicks = 0;
  private drowns = 0;
  private unstucks = 0;
  /** Set by `stepPlayer` when any player took damage this tick. */
  private hitTick = false;
  private queue: TerrainEvent[] = [];

  constructor(opts: TerrainOptions = {}) {
    this.field = new TerrainField(opts);
    this.damage = opts.damage ?? true;
    this.landmarkRadius = opts.landmarkRadius ?? DEFAULTS.landmarkRadius;
  }

  /** Wire the field + hook into a sim. Idempotent per sim. */
  attach(sim: Sim): void {
    sim.setTerrain(this.field);
    sim.registerSystem((s, dt) => this.step(s, dt), false);
  }

  /** Events since the last drain (server broadcasts these as `respawn`). */
  drainEvents(): TerrainEvent[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Number of pending events without clearing them. */
  get pendingEvents(): number {
    return this.queue.length;
  }

  /**
   * Post-integrate terrain pass. Order inside one tick:
   *   1. publish the authoritative z for rendering,
   *   2. apply hazard damage over time.
   *
   * There is deliberately **no** per-tick "teleport out of water" rescue: a
   * body can only end up in water by being pushed there (collision blocks
   * walking in, `findFreeSpawn` blocks spawning in it, persistence restores
   * are handled by `rescue()`), and being knocked into a lake should cost HP
   * until you climb out — not be a free teleport. Lethal damage washes the
   * player ashore at the nearest safe anchor instead.
   */
  step(sim: Sim, dt: number): void {
    const tf = this.field;
    this.t++;
    tf.beginTick();
    this.hitTick = false;
    for (const p of sim.players.values()) this.stepPlayer(p, dt);
    if (this.hitTick) this.dotTicks++;
  }

  /**
   * Put a body that is standing in solid terrain back on dry ground. Used for
   * spawns and for positions restored from persistence; NOT called per tick.
   */
  rescue(p: SimPlayer, maxR = 24): SpawnAnchor | null {
    const tf = this.field;
    if (!tf.solidAt(p.x, p.y)) return null;
    const anchor = tf.spawnAnchor(p.x, p.y, { maxR, landmarkRadius: this.landmarkRadius });
    if (anchor === null) return null;
    this.unstucks++;
    p.x = anchor.x;
    p.y = anchor.y;
    p.vx = 0;
    p.vy = 0;
    p.z = anchor.z;
    this.queue.push({ id: p.id, x: p.x, y: p.y, z: p.z, kind: 'unstick', source: anchor.source });
    return anchor;
  }

  private stepPlayer(p: SimPlayer, dt: number): void {
    const tf = this.field;
    // One probe per player per tick: z, hazard kind and dps all come out of
    // the same cached layer read (this is the whole per-tick budget).
    const s = tf.probe(p.x, p.y);
    // 1. authoritative z for rendering (and for anything that needs "how high
    //    am I", e.g. a future jump/flight check).
    p.z = s.height;
    // 2. damage over time.
    if (!this.damage || p.hp <= 0 || s.kind === TERR_NONE || s.dps <= 0) return;
    const dmg = s.dps * dt;
    this.dotDamage += dmg;
    this.hitTick = true;
    p.hp -= dmg;
    if (p.hp > 0) return;
    // Lethal: wash ashore. Water drowns, lava burns, both end at the nearest
    // safe anchor (landmark > loot anchor > dry spiral) at full HP.
    const source = s.kind === TERR_LAVA ? 'burn' : 'drown';
    p.hp = p.maxHp;
    p.vx = 0;
    p.vy = 0;
    this.drowns++;
    const anchor = tf.spawnAnchor(p.x, p.y, { maxR: 64, landmarkRadius: this.landmarkRadius });
    if (anchor !== null) {
      p.x = anchor.x;
      p.y = anchor.y;
      p.z = anchor.z;
    }
    this.queue.push({ id: p.id, x: p.x, y: p.y, z: p.z, kind: source, source: anchor?.source ?? 'dry' });
  }

  stats(): TerrainStats {
    return {
      ...this.field.stats(),
      ticks: this.t,
      dotDamage: this.dotDamage,
      dotTicks: this.dotTicks,
      drowns: this.drowns,
      unstucks: this.unstucks,
    };
  }
}

/**
 * Should a fresh `Sim` install terrain? Opt out with `TERRAIN=off` (or the
 * `terrain: false` constructor option) — used by the deterministic unit tests
 * that assert the pre-terrain arena exactly.
 */
export function terrainEnabled(opts: TerrainOptions | false | undefined): boolean {
  if (opts === false) return false;
  if (opts === undefined) return (process.env.TERRAIN ?? 'on') !== 'off';
  return true;
}

/** Resolve the constructor option into a TerrainOptions bag (or null). */
export function terrainOptionsFrom(
  opts: TerrainOptions | false | undefined,
): TerrainOptions | null {
  if (opts === false || (opts === undefined && (process.env.TERRAIN ?? 'on') === 'off')) return null;
  return opts ?? {};
}

/** Water / lava surface heights, re-exported for spawn + rendering parity. */
export const TERRAIN_WATER_LEVEL = WATER_LEVEL;
export const TERRAIN_LAVA_LEVEL = LAVA_LEVEL;