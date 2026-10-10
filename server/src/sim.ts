// @aetherfall/server — deterministic fixed-tick simulation.
// Uses @aetherfall/engine World + SpatialHash. Gameplay systems plug in via hooks.
import { World, SpatialHash } from '@aetherfall/engine';
import { getBiome, getZone, tileFlagsFor, type TileFlags, type TileHazard } from '@aetherfall/engine';
// PLAYABILITY (spawn safety): a joining player with no explicit position lands
// ON a declared spawn anchor (round-robin by player id), which is exactly the
// coordinate list the spawner keeps mob-free — the join path can no longer
// disagree with the safe discs. See engine/src/spawn-anchors.ts.
import { SHRINE_SPAWN, spawnAnchorFor } from '@aetherfall/engine';
import { TERRAIN_SEED } from './terrain_sys.js';
import type { EntitySnapshot } from '@aetherfall/shared';
// WALLS: shared wall schema + slide collision (additive).
import { PLAYER_RADIUS, circleHitsWalls, moveWithSlide, type WallRect } from '@aetherfall/shared';
// TERRAIN: engine terrain field (height / hazard /
// landmarks) consumed by the authoritative sim. Default on; `TERRAIN=off` or
// `{ terrain: false }` restores the pre-terrain flat arena exactly.
import { TerrainSystem, terrainOptionsFrom, type TerrainField, type TerrainOptions } from './terrain_sys.js';

export type SimPlayer = {
  id: number;
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  seq: number;
  /** TERRAIN: `heightAt()` of the tile under the body (0 = sea level). */
  z: number;
  /**
   * PLAYABILITY (spawn protection): ms timestamp until which the player takes
   * no damage (3s from join/respawn). NPC/boss damage lanes check this via
   * isSpawnProtected(); the HUD shows a shield badge while it covers now.
   */
  protectedUntil: number;
};

/** ms of spawn protection granted on join and on shrine respawn. */
export const SPAWN_PROTECTION_MS = 3000;

/** Extension point for gameplay systems (combat, AI, pickups...). Runs pre/post integrate. */
export type SimSystemHook = (sim: Sim, dt: number) => void;

export type SimOptions = {
  /**
   * TERRAIN. `false` disables the terrain field entirely; an options bag
   * enables it with overrides; `undefined` means "auto" (on unless TERRAIN=off).
   */
  terrain?: TerrainOptions | false | undefined;
  /**
   * World bounds the sim clamps bodies to. Defaults to the legacy 100x100
   * arena; the terrain field itself is unbounded, so a bigger box lets a
   * shard serve the caldera (lava) and open ocean.
   */
  bounds?: { w: number; h: number };
  /**
   * TERRAIN: put `z` (terrain elevation) on the wire. **Off by default.**
   *
   * Measured cost of turning it on at 1000 entities: +21.5% snapshot bytes and
   * +43% time in the `snapshotFrame` hot path (perf.ts section `snapshot`) —
   * and it buys nothing, because `heightAt` is a pure function of (x, y, seed)
   * that the client evaluates itself to the exact same Float64. Thin clients
   * that would rather not reimplement the field can opt in with
   * `{ snapshotZ: true }` or `TERRAIN_WIRE_Z=1`.
   */
  snapshotZ?: boolean;
};

export const MAX_SPEED = 8; // units/sec, authoritative
export const ARENA_W = 100;
export const ARENA_H = 100;
const FRICTION = 0.9;

export class Sim {
  world = new World();
  spatial = new SpatialHash();
  players = new Map<number, SimPlayer>();
  /** engine entity id per player id (gameplay systems can attach components) */
  entityByPlayer = new Map<number, number>();
  tick = 0;
  /** Authoritative wall set (empty = open arena). Installed via setWalls(). */
  walls: WallRect[] = [];
  /** TERRAIN: terrain field (null when disabled). See terrain_sys.ts. */
  terrain: TerrainField | null = null;
  /** TERRAIN: owner of `terrain`; also the DOT / spawn-anchor system. */
  terrainSystem: TerrainSystem | null = null;
  /** Clamp box for body movement. `bounds` option, default ARENA_W x ARENA_H. */
  readonly boundsW: number;
  readonly boundsH: number;
  /** TERRAIN: emit `z` in snapshots (see SimOptions.snapshotZ). */
  readonly wireZ: boolean;

  /**
   * Snapshot backing store reuse (perf path). snapshot() returns the same
   * array every call with stable per-player EntitySnapshot objects mutated in
   * place. Safe because all server consumers (interest filter, per-tick JSON
   * serialization, db.saveSnapshot) consume synchronously within the tick and
   * never retain entity references across ticks — only ids are stored.
   */
  private snapBuf: EntitySnapshot[] = [];
  private snapByPlayer = new Map<number, EntitySnapshot>();

  private preSystems: SimSystemHook[] = [];
  private postSystems: SimSystemHook[] = [];

  constructor(opts: SimOptions = {}) {
    this.boundsW = opts.bounds?.w ?? ARENA_W;
    this.boundsH = opts.bounds?.h ?? ARENA_H;
    this.wireZ = opts.snapshotZ ?? (process.env.TERRAIN_WIRE_Z ?? 'off') !== 'off';
    // TERRAIN: never let a terrain construction failure take the shard
    // down — fall back to the flat arena and say so once.
    const terrainOpts = terrainOptionsFrom(opts.terrain);
    if (terrainOpts !== null) {
      try {
        const sys = new TerrainSystem(terrainOpts);
        sys.attach(this);
        this.terrainSystem = sys;
      } catch (err) {
        console.warn('[sim] terrain disabled:', String((err as Error)?.message ?? err));
      }
    }
  }

  /** Register a gameplay extension. pre=true runs before integrate, else after. */
  registerSystem(hook: SimSystemHook, pre = false): void {
    if (pre) this.preSystems.push(hook);
    else this.postSystems.push(hook);
  }

  /**
   * Admit a player. With no explicit x/y they appear on the spawn anchor for
   * their id (`SPAWN_ANCHORS[id % n]`, round-robin) so the live join path lands
   * inside one of the spawner's no-mob discs; an explicit x/y (restore, test,
   * scripted teleport) still wins, per axis, and `findFreeSpawn` still nudges
   * the result out of walls / terrain.
   *
   * This used to be `10 + (id*7)%80` / `10 + (id*13)%80`, a scatter that put
   * player 1 at (17,23) — 28.6u from the only two declared safe points, i.e.
   * outside every spawn-safe disc while all the tests (which spawn at (0,0))
   * still passed.
   */
  addPlayer(id: number, name: string, x?: number, y?: number, nowMs: number = Date.now()): SimPlayer {
    const anchor = spawnAnchorFor(id);
    const px = x ?? anchor.x;
    const py = y ?? anchor.y;
    const spawn = this.findFreeSpawn(px, py);
    // PLAYABILITY: spawn at full HP with 3s of protection (see protectedUntil).
    const p: SimPlayer = { id, name, x: spawn.x, y: spawn.y, vx: 0, vy: 0, hp: 100, maxHp: 100, seq: 0, z: 0, protectedUntil: nowMs + SPAWN_PROTECTION_MS };
    // TERRAIN: publish z before the first snapshot so a client that joins
    // mid-tick never sees a player at sea level standing on a hill.
    if (this.terrain !== null) p.z = this.terrain.zAt(p.x, p.y);
    this.players.set(id, p);
    const eid = this.world.spawn({ pos: { x: p.x, y: p.y }, vel: { x: 0, y: 0 } });
    this.entityByPlayer.set(id, eid);
    this.rebuildSpatial();
    return p;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    const eid = this.entityByPlayer.get(id);
    if (eid !== undefined) this.world.despawn(eid);
    this.entityByPlayer.delete(id);
    this.snapByPlayer.delete(id);
    this.rebuildSpatial();
  }

  setVelocity(id: number, vx: number, vy: number, seq: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.vx = vx;
    p.vy = vy;
    p.seq = seq;
  }

  getPos(id: number): { x: number; y: number } | undefined {
    const p = this.players.get(id);
    return p ? { x: p.x, y: p.y } : undefined;
  }

  /** True while spawn protection still covers `nowMs` (no damage taken). */
  isSpawnProtected(id: number, nowMs: number = Date.now()): boolean {
    const p = this.players.get(id);
    return !!p && (p.protectedUntil ?? 0) > nowMs;
  }

  /** ms of spawn protection left (0 when expired). The HUD badge reads this. */
  spawnProtectionLeft(id: number, nowMs: number = Date.now()): number {
    const p = this.players.get(id);
    if (!p) return 0;
    return Math.max(0, (p.protectedUntil ?? 0) - nowMs);
  }

  /**
   * Authoritative damage entry point that honors spawn protection.
   * Returns false when protected (no HP removed) or the player is unknown.
   */
  damagePlayer(id: number, amount: number, nowMs: number = Date.now()): boolean {
    const p = this.players.get(id);
    if (!p || amount <= 0) return false;
    if ((p.protectedUntil ?? 0) > nowMs) return false;
    p.hp = Math.max(0, p.hp - amount);
    return true;
  }

  /**
   * Respawn at full HP with fresh protection (the shrine anchor by default —
   * `SHRINE_SPAWN` from the shared spawn-anchor table, so the death path lands
   * on a declared safe disc instead of a literal that could drift away from
   * the spawner's list). Server death path calls this instead of mutating
   * hp/pos inline so the protection window can never be forgotten on one of
   * the two paths.
   */
  respawnPlayer(id: number, x = SHRINE_SPAWN.x, y = SHRINE_SPAWN.y, nowMs: number = Date.now()): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    p.hp = p.maxHp;
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    p.protectedUntil = nowMs + SPAWN_PROTECTION_MS;
    const eid = this.entityByPlayer.get(id);
    if (eid !== undefined) {
      this.world.set(eid, 'pos', { x: p.x, y: p.y });
      this.world.set(eid, 'vel', { x: 0, y: 0 });
    }
    this.rebuildSpatial();
    return true;
  }

  /** Install the authoritative wall set (POST /walls + boot load path). */
  setWalls(w: WallRect[]): void {
    this.walls = [...w];
  }

  /** TERRAIN: install (or clear) the terrain field. */
  setTerrain(field: TerrainField | null): void {
    this.terrain = field;
  }

  /** Circle-vs-walls test at the authoritative body radius. */
  hitsWall(x: number, y: number, r: number = PLAYER_RADIUS): boolean {
    return this.walls.length !== 0 && circleHitsWalls(x, y, r, this.walls);
  }

  /**
   * TILE FLAGS (Tibia-inspired walk/block metadata, additive): flags for the
   * tile containing (x, y), derived from the existing zone / biome / hazard
   * field. `block` is exactly the terrain block set the sim collides against
   * (water/lava via the cached terrain layer when enabled, open arena when
   * disabled), with `biome`/`zone` riding along for spawn/decoration context.
   * Server-authoritative derivation only — the wire format is untouched.
   */
  tileFlags(x: number, y: number): TileFlags {
    const tf = this.terrain;
    const seed = tf?.seed ?? TERRAIN_SEED;
    const biome = getBiome(x, y, seed);
    const zone = getZone(x, y, seed);
    let hazard: TileHazard = 'none';
    if (tf !== null) {
      const k = tf.kindAt(x, y);
      hazard = k === 2 ? 'lava' : k === 1 ? 'water' : 'none';
    }
    return tileFlagsFor(biome, zone, hazard);
  }

  /** Point terrain block test through tileFlags (same block set as hitsTerrain). */
  isTileBlocked(x: number, y: number): boolean {
    return this.tileFlags(x, y).block;
  }

  /**
   * TERRAIN: does the body circle overlap solid terrain (ocean or lava)?
   * Cheap: a handful of typed-array reads out of the cached terrain layer.
   * This is the same block set `tileFlags(x, y).block` reports per tile —
   * the circle form needed for body collision (see tileFlags for the point form).
   */
  hitsTerrain(x: number, y: number, r: number = PLAYER_RADIUS): boolean {
    const tf = this.terrain;
    return tf !== null && tf.solidCircle(x, y, r);
  }

  /** TERRAIN: free = not inside an editor wall and not inside terrain. */
  isFreeSpot(x: number, y: number, r: number = PLAYER_RADIUS): boolean {
    if (this.hitsWall(x, y, r)) return false;
    return !this.hitsTerrain(x, y, r);
  }

  /** TERRAIN: authoritative terrain height under a player id. */
  zOf(id: number): number {
    return this.players.get(id)?.z ?? 0;
  }

  /**
   * Nudge a spawn out of walls / terrain (deterministic spiral, falls back to
   * the clamped input, then to a landmark or dry-ground anchor).
   */
  findFreeSpawn(x: number, y: number): { x: number; y: number } {
    const cx = Math.max(0, Math.min(this.boundsW, x));
    const cy = Math.max(0, Math.min(this.boundsH, y));
    if (this.isFreeSpot(cx, cy)) return { x: cx, y: cy };
    for (let r = 0.5; r <= 12; r += 0.5) {
      for (let a = 0; a < 12; a++) {
        const nx = Math.max(0, Math.min(this.boundsW, cx + Math.cos((a / 12) * Math.PI * 2) * r));
        const ny = Math.max(0, Math.min(this.boundsH, cy + Math.sin((a / 12) * Math.PI * 2) * r));
        if (this.isFreeSpot(nx, ny)) return { x: nx, y: ny };
      }
    }
    // TERRAIN: last resort — a landmark / loot anchor / dry tile. The
    // anchor is clamped back into the bounds so the sim invariants hold even
    // when the nearest landmark sits outside the walls.
    const tf = this.terrain;
    if (tf !== null) {
      const anchor = tf.spawnAnchor(cx, cy, { maxR: 24 });
      if (anchor !== null) {
        const ax = Math.max(0, Math.min(this.boundsW, anchor.x));
        const ay = Math.max(0, Math.min(this.boundsH, anchor.y));
        if (this.isFreeSpot(ax, ay)) return { x: ax, y: ay };
      }
    }
    return { x: cx, y: cy };
  }

  /** Deterministic fixed-step integration. No randomness here. */
  step(dt: number): void {
    this.tick++;
    for (const hook of this.preSystems) hook(this, dt);
    // TERRAIN: one branch per tick instead of one call per player.
    const hasTerrain = this.terrain !== null;
    for (const p of this.players.values()) {
      // WALLS: axis-separated slide (X then Y) so diagonal motion
      // along a wall keeps the free axis instead of sticking.
      const moved = moveWithSlide(p.x, p.y, p.vx * dt, p.vy * dt, PLAYER_RADIUS, this.walls);
      let nx = moved.x;
      let ny = moved.y;
      if (hasTerrain) {
        // TERRAIN: second, independent pass against solid terrain. The
        // full step is tried first, then each axis alone, so a body walking
        // into the shoreline keeps sliding along it (1 probe when free,
        // 3 when blocked, zero allocation). Reads the same block set
        // tileFlags() reports, through the hitsTerrain circle helper.
        if (this.hitsTerrain(nx, ny, PLAYER_RADIUS)) {
          // A body that is *already* inside solid terrain (knocked into the
          // lake) must be able to move back out, and a destination test alone
          // would wedge it: every step that reduces the overlap also overlaps
          // the tile it is leaving. Penetration is measured from the current
          // spot, which costs one extra probe only on already-blocked ticks.
          if (!this.hitsTerrain(p.x, p.y, PLAYER_RADIUS)) {
            const ax = this.hitsTerrain(nx, p.y, PLAYER_RADIUS) ? p.x : nx;
            ny = this.hitsTerrain(ax, ny, PLAYER_RADIUS) ? p.y : ny;
            nx = ax;
          }
        }
      }
      p.x = nx;
      p.y = ny;
      if (p.x < 0) p.x = 0;
      else if (p.x > this.boundsW) p.x = this.boundsW;
      if (p.y < 0) p.y = 0;
      else if (p.y > this.boundsH) p.y = this.boundsH;
      p.vx *= FRICTION;
      p.vy *= FRICTION;
      // snap tiny velocities to zero for determinism across platforms
      if (Math.abs(p.vx) < 1e-9) p.vx = 0;
      if (Math.abs(p.vy) < 1e-9) p.vy = 0;
      const eid = this.entityByPlayer.get(p.id);
      if (eid !== undefined) {
        this.world.set(eid, 'pos', { x: p.x, y: p.y });
        this.world.set(eid, 'vel', { x: p.vx, y: p.vy });
      }
    }
    for (const hook of this.postSystems) hook(this, dt);
    this.rebuildSpatial();
  }

  positionsMap(): Map<number, { x: number; y: number }> {
    const m = new Map<number, { x: number; y: number }>();
    for (const p of this.players.values()) m.set(p.id, { x: p.x, y: p.y });
    return m;
  }

  rebuildSpatial(): void {
    this.spatial.rebuild(this.positionsMap());
  }

  snapshot(): EntitySnapshot[] {
    const out = this.snapBuf;
    out.length = 0;
    // Drop cache entries for departed players (join/leave churn only).
    if (this.snapByPlayer.size !== this.players.size) {
      for (const id of [...this.snapByPlayer.keys()]) {
        if (!this.players.has(id)) this.snapByPlayer.delete(id);
      }
    }
    // TERRAIN: `z` is only put on the wire when explicitly opted in, so a
    // default shard emits byte-identical snapshots to earlier builds
    // (JSON.stringify drops the undefined field entirely). The client samples
    // `heightAt` itself by default — see SimOptions.snapshotZ for the numbers.
    const tf = this.terrain;
    const wireZ = this.wireZ && tf !== null;
    for (const p of this.players.values()) {
      let e = this.snapByPlayer.get(p.id);
      if (!e) {
        e = {
          id: p.id,
          kind: 'player',
          p: { x: p.x, y: p.y },
          v: { x: p.vx, y: p.vy },
          hp: p.hp,
          maxHp: p.maxHp,
          name: p.name,
          seq: p.seq,
          z: wireZ ? p.z : undefined,
        };
        this.snapByPlayer.set(p.id, e);
      } else {
        e.p.x = p.x;
        e.p.y = p.y;
        e.v.x = p.vx;
        e.v.y = p.vy;
        e.hp = p.hp;
        e.maxHp = p.maxHp;
        e.name = p.name;
        e.seq = p.seq;
        e.z = wireZ ? p.z : undefined;
      }
      out.push(e);
    }
    return out;
  }
}
