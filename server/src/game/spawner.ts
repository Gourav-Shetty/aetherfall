// @aetherfall/gameplay — deterministic mob spawner driven by engine worldgen.
// Uses genChunk() walkable tiles + seeded RNG so every server computes identical spawns.
// Names/levels come from content.ts per-zone spawn tables; HP from content.mobMaxHp
// (zone-scaled for 3-5-hit TTK). Zone of a mob = getZone() at its world position.

// PLAYABILITY (spawn safety): the safe discs are DERIVED from the engine's
// spawn-anchor table, which is the same list `Sim.addPlayer` places a joining
// player on. One list, one radius — a spawn coordinate can never drift away
// from the discs that are supposed to protect it (see engine/src/spawn-anchors.ts).
import {
  SPAWN_ANCHORS,
  SPAWN_SAFE_RADIUS as ANCHOR_SAFE_RADIUS,
  genChunk,
  getZone,
} from '@aetherfall/engine';
import { mulberry32 } from '@aetherfall/shared';
import { RESPAWN_DELAY_MS, makeMob, type Mob } from './combat.js';
import {
  DOWNED_DURATION_MS,
  DOWNED_RECOVER_FRAC,
  THROW_STUN_MS,
} from '../systems/combat_ext.js';
import { mobMaxHp, rollSpawnForZone } from './content.js';
import { MOB_ID_MAX, MOB_ID_MIN, isSpawnerMobId } from './mobs.js';

export const MOBS_PER_CHUNK = 4;
export const MOB_NAMES = ['gloomfang', 'ashcrawler', 'thornback', 'mistwisp'] as const;

/**
 * PLAYABILITY (spawn safety): no hostile spawns within this radius of any
 * spawn anchor. The radius and the anchor list both come from the engine's
 * spawn-anchor table (`engine/src/spawn-anchors.ts`) — the world spawn `(0,0)`,
 * the shrine respawn `(50,50)` and the outlying rings are all covered, so a
 * fresh bot is never boxed in on arrival and the list cannot drift away from
 * the coordinates `Sim.addPlayer` actually uses.
 */
export const SPAWN_SAFE_RADIUS = ANCHOR_SAFE_RADIUS;
/**
 * Safe discs, derived from the shared anchors (identity, not a second copy):
 * every anchor is a disc centre and vice versa.
 */
export const SPAWN_SAFE_POINTS: ReadonlyArray<{ x: number; y: number }> = SPAWN_ANCHORS;

/** True when (x,y) lies inside a spawn-safe disc (no hostile spawns allowed). */
export function isSpawnSafeZone(
  x: number,
  y: number,
  radius: number = SPAWN_SAFE_RADIUS,
  points: ReadonlyArray<{ x: number; y: number }> = SPAWN_SAFE_POINTS,
): boolean {
  for (const p of points) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy <= radius * radius) return true;
  }
  return false;
}

/**
 * Spatial-index cell size in world units. Player melee reaches MELEE_RANGE
 * (2.2) and aggro pulls at AGGRO_RANGE (12); 8 keeps the candidate fan-out at
 * <=9 cells for a melee query while holding ~2 mobs per cell at MOBS_PER_CHUNK
 * per 32x32 chunk. The index is written once at spawn and patched on remove or
 * move (`moveMob`, now driven every tick by the AI in `game/spawner-ai.ts`) —
 * still no per-tick rebuild.
 */
export const MOB_CELL_SIZE = 8;

export type SpawnOptions = {
  seed?: number;
  chunkSize?: number;
  mobsPerChunk?: number;
  mobLevel?: number;
  idStart?: number;
};

/** Deterministic spawns for one chunk: walkable interior tiles only. */
export function spawnMobsForChunk(cx: number, cy: number, opts: SpawnOptions = {}): Mob[] {
  const seed = opts.seed ?? 1337;
  const size = opts.chunkSize ?? 32;
  const n = opts.mobsPerChunk ?? MOBS_PER_CHUNK;
  const chunk = genChunk(cx, cy, size, seed);
  const rand = mulberry32((seed ^ (cx * 374761393) ^ (cy * 668265263)) >>> 0);

  // Collect walkable tiles away from the solid border.
  const open: { x: number; y: number }[] = [];
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      if (chunk.tiles[y]![x] === 0) open.push({ x, y });
    }
  }
  const mobs: Mob[] = [];
  const base = opts.idStart ?? chunkIdBase(cx, cy);
  for (let i = 0; i < n && open.length > 0; i++) {
    const pick = Math.floor(rand() * open.length);
    const tile = open.splice(pick, 1)[0]!;
    const wx = cx * size + tile.x;
    const wy = cy * size + tile.y;
    if (opts.mobLevel !== undefined) {
      // Explicit override (tests / scripted encounters): legacy name pool.
      const name = MOB_NAMES[Math.floor(rand() * MOB_NAMES.length)]!;
      mobs.push(makeMob(base + i, wx, wy, name, Math.max(1, opts.mobLevel)));
      continue;
    }
    // Zone table roll: name + level band, then zone-scaled HP (3-5-hit TTK).
    const zone = getZone(wx, wy, seed);
    const rolled = rollSpawnForZone(rand, zone);
    const m = makeMob(base + i, wx, wy, rolled.name, rolled.level);
    const zonedHp = mobMaxHp(zone, rolled.level);
    m.maxHp = zonedHp;
    m.hp = zonedHp;
    mobs.push(m);
  }
  return mobs;
}

export type MobHit = {
  mob: Mob;
  /** HP actually removed (clamped at the mob's remaining hp). */
  dmg: number;
  /** Damage the swing resolved to, before the hp floor clamped it. */
  resolved: number;
  killed: boolean;
  /** True when this hit was a finisher on a downed mob. */
  finished?: boolean;
};

/** Stable per-chunk id base so mob ids don't collide across chunks.
 * Output always lands in [MOB_ID_MIN, MOB_ID_MAX] (see game/mobs.ts namespaces). */
export function chunkIdBase(cx: number, cy: number): number {
  const h = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
  return MOB_ID_MIN + (h % (MOB_ID_MAX - MOB_ID_MIN + 1));
}

export class Spawner {
  private mobs = new Map<number, Mob>();
  private spawnedChunks = new Set<string>();
  /** cell key -> mobs in that cell (spatial index for melee targeting). */
  private cells = new Map<string, Mob[]>();
  /** mob id -> cell key it currently lives in (inverse index, for O(1) moves). */
  private cellOf = new Map<number, string>();
  constructor(
    private seed = 1337,
    private chunkSize = 32,
  ) {}

  mobCount(): number {
    return this.mobs.size;
  }

  mobsList(): Mob[] {
    return [...this.mobs.values()];
  }

  /**
   * Allocation-free iteration in spawn order. The AI driver
   * (`game/spawner-ai.ts`) runs at 10Hz over every live mob, and
   * `mobsList()` would allocate a fresh array on each of those ticks.
   */
  forEachMob(fn: (m: Mob) => void): void {
    for (const m of this.mobs.values()) fn(m);
  }

  getMob(id: number): Mob | undefined {
    return this.mobs.get(id);
  }

  hasChunk(cx: number, cy: number): boolean {
    return this.spawnedChunks.has(`${cx},${cy}`);
  }

  // --------------------------------------------------------- spatial index

  private static cellKey(x: number, y: number): string {
    return `${Math.floor(x / MOB_CELL_SIZE)},${Math.floor(y / MOB_CELL_SIZE)}`;
  }

  private index(m: Mob): void {
    const key = Spawner.cellKey(m.pos.x, m.pos.y);
    this.cellOf.set(m.id, key);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(m);
    else this.cells.set(key, [m]);
  }

  private unindex(m: Mob): void {
    const key = this.cellOf.get(m.id);
    if (key === undefined) return;
    this.cellOf.delete(m.id);
    const bucket = this.cells.get(key);
    if (!bucket) return;
    const i = bucket.findIndex((o) => o.id === m.id);
    if (i >= 0) bucket.splice(i, 1);
    if (bucket.length === 0) this.cells.delete(key);
  }

  /** Re-file a mob whose position changed (knockback/forced move). */
  moveMob(id: number, x: number, y: number): boolean {
    const m = this.mobs.get(id);
    if (!m) return false;
    const key = Spawner.cellKey(x, y);
    if (this.cellOf.get(id) === key) {
      m.pos = { x, y };
      return true;
    }
    this.unindex(m);
    m.pos = { x, y };
    this.index(m);
    return true;
  }

  /**
   * Nearest living mob within `range` of (x,y), or null. Grid-bucketed: touches
   * only the cells the range circle overlaps, so it stays O(cells) with hundreds
   * of live mobs. Ties resolve to the lower mob id (deterministic).
   */
  nearestMobWithin(x: number, y: number, range: number): Mob | null {
    if (!(range >= 0)) return null;
    const r2 = range * range;
    const c0 = Math.floor((x - range) / MOB_CELL_SIZE);
    const c1 = Math.floor((x + range) / MOB_CELL_SIZE);
    const r0 = Math.floor((y - range) / MOB_CELL_SIZE);
    const r1 = Math.floor((y + range) / MOB_CELL_SIZE);
    let best: Mob | null = null;
    let bestD2 = r2;
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const m of bucket) {
          if (!m.alive) continue;
          const dx = m.pos.x - x;
          const dy = m.pos.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (best === null || d2 < bestD2 || (d2 === bestD2 && m.id < best.id)) {
            best = m;
            bestD2 = d2;
          }
        }
      }
    }
    return best;
  }

  /**
   * Nearest DOWNED mob within `range` of (x,y) at `now`, or null.
   * The melee finish path checks this FIRST so a downed target is never
   * shadowed by a nearer healthy mob sharing the tile region — without this
   * the killer can punch a fresh mob while its downed victim recovers (3s)
   * and stands back up, which reads as "swings do nothing".
   */
  nearestDownedWithin(x: number, y: number, range: number, now: number): Mob | null {
    if (!(range >= 0)) return null;
    const r2 = range * range;
    const c0 = Math.floor((x - range) / MOB_CELL_SIZE);
    const c1 = Math.floor((x + range) / MOB_CELL_SIZE);
    const r0 = Math.floor((y - range) / MOB_CELL_SIZE);
    const r1 = Math.floor((y + range) / MOB_CELL_SIZE);
    let best: Mob | null = null;
    let bestD2 = r2;
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const m of bucket) {
          if (!m.alive) continue;
          if ((m.downedUntil ?? 0) <= now) continue;
          const dx = m.pos.x - x;
          const dy = m.pos.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (best === null || d2 < bestD2 || (d2 === bestD2 && m.id < best.id)) {
            best = m;
            bestD2 = d2;
          }
        }
      }
    }
    return best;
  }

  /**
   * Every indexed mob whose position is within `range` of (x,y), dead ones
   * included (callers that care filter on `alive`). Same grid-bucketed fan-out
   * as nearestMobWithin, but it walks from the query point instead of the whole
   * map: the AI driver uses it every tick to find the handful of mobs a player
   * could actually be fighting.
   */
  forEachMobNear(x: number, y: number, range: number, fn: (m: Mob) => void): void {
    if (!(range >= 0)) return;
    const r2 = range * range;
    const c0 = Math.floor((x - range) / MOB_CELL_SIZE);
    const c1 = Math.floor((x + range) / MOB_CELL_SIZE);
    const r0 = Math.floor((y - range) / MOB_CELL_SIZE);
    const r1 = Math.floor((y + range) / MOB_CELL_SIZE);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const m of bucket) {
          const dx = m.pos.x - x;
          const dy = m.pos.y - y;
          if (dx * dx + dy * dy > r2) continue;
          fn(m);
        }
      }
    }
  }

  /** Array form of `forEachMobNear` (convenience for callers outside hot loops). */
  mobsWithin(x: number, y: number, range: number): Mob[] {
    const out: Mob[] = [];
    this.forEachMobNear(x, y, range, (m) => out.push(m));
    return out;
  }

  /**
   * Spawn one chunk (idempotent). Returns newly spawned mobs.
   * Hash bases can theoretically collide across distant chunks, so ids already
   * taken are bumped forward (staying inside the spawner namespace).
   *
   * PLAYABILITY: mobs that would land inside a spawn-safe disc are skipped
   * (never indexed), so the area around (0,0)/(50,50) stays clear by
   * construction. Deterministic: the same chunk always yields the same kept
   * set. */
  spawnChunk(cx: number, cy: number, mobLevel?: number): Mob[] {
    const key = `${cx},${cy}`;
    if (this.spawnedChunks.has(key)) return [];
    this.spawnedChunks.add(key);
    const mobs = spawnMobsForChunk(cx, cy, {
      seed: this.seed,
      chunkSize: this.chunkSize,
      mobLevel,
    });
    const kept: Mob[] = [];
    for (const m of mobs) {
      if (isSpawnSafeZone(m.pos.x, m.pos.y)) continue;
      while (this.mobs.has(m.id)) {
        // Linear probe inside [MOB_ID_MIN, MOB_ID_MAX]; wraps safely.
        m.id = m.id >= MOB_ID_MAX ? MOB_ID_MIN : m.id + 1;
      }
      if (!isSpawnerMobId(m.id)) {
        throw new Error(`[spawner] mob id out of namespace: ${m.id}`);
      }
      this.mobs.set(m.id, m);
      this.index(m);
      kept.push(m);
    }
    return kept;
  }

  /** Ensure the chunk containing (x,y) plus neighbors are spawned. Returns new mobs. */
  ensureAround(x: number, y: number, radius = 0, mobLevel?: number): Mob[] {
    const ccx = Math.floor(x / this.chunkSize);
    const ccy = Math.floor(y / this.chunkSize);
    const out: Mob[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        out.push(...this.spawnChunk(ccx + dx, ccy + dy, mobLevel));
      }
    }
    return out;
  }

  /**
   * PLAYABILITY: drop any live mob inside a spawn-safe disc (moved there by
   * knockback/forced moves, or spawned before this guard existed). Returns
   * removed ids. tickGameplay calls this after ensureAround so the safe discs
   * stay clear even for long-lived shards.
   *
   * PERF: this runs on the 20Hz gameplay hot path, so it must not scale with
   * the size of the world. It walks the spatial index around each anchor
   * (a handful of cells) rather than the whole mob map — a full scan here cost
   * ~54ms on a tick with 18 players, because the previous version allocated a
   * copy of every mob, once per player, per tick. A disc is 12u across and the
   * anchors are >= 24u apart, so the per-anchor query sets cannot overlap; the
   * `seen` set is belt-and-braces for a future that shrinks the separation.
   */
  pruneSpawnSafe(radius: number = SPAWN_SAFE_RADIUS): number[] {
    const doomed = new Set<Mob>();
    for (const p of SPAWN_SAFE_POINTS) {
      this.forEachMobNear(p.x, p.y, radius, (m) => {
        if (!m.alive || doomed.has(m)) return;
        if (isSpawnSafeZone(m.pos.x, m.pos.y, radius)) doomed.add(m);
      });
    }
    const out: number[] = [];
    for (const m of doomed) {
      this.unindex(m);
      this.mobs.delete(m.id);
      out.push(m.id);
    }
    return out;
  }

  killMob(id: number, now: number, respawnDelayMs = 5000): boolean {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return false;
    m.hp = 0;
    m.alive = false;
    m.respawnAt = now + respawnDelayMs;
    m.targetId = null;
    m.downedUntil = 0;
    m.stunUntil = 0;
    return true;
  }

  /**
   * Apply flat damage to a living spawner mob. Mirrors combat.tryMeleeAttack's
   * death bookkeeping (hp clamp, alive=false, RESPAWN_DELAY_MS timer) so
   * updateRespawns() brings it back unchanged — the 5s timer stays the single
   * respawn authority. Returns null for unknown/dead mobs.
   *
   * NOTE: the authoritative melee path (game/index.ts playerMeleeAttack)
   * intercepts lethal swings BEFORE calling this and routes them into DOWNED
   * via downMob() instead, so `damageMob` keeps its direct-kill semantics for
   * existing callers and tests.
   */
  damageMob(id: number, amount: number, now: number): MobHit | null {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return null;
    const resolved = Math.max(0, Math.round(amount));
    const before = m.hp;
    m.hp = Math.max(0, m.hp - resolved);
    const removed = before - m.hp;
    if (m.hp <= 0) {
      m.alive = false;
      m.respawnAt = now + RESPAWN_DELAY_MS;
      m.targetId = null;
      return { mob: m, dmg: removed, resolved, killed: true };
    }
    return { mob: m, dmg: removed, resolved, killed: false };
  }

  removeMob(id: number): boolean {
    const m = this.mobs.get(id);
    if (m) this.unindex(m);
    return this.mobs.delete(id);
  }

  // ------------------------------------------------- downed / finisher / stun
  //
  // Close-quarters finish loop (see game/melee/downed.ts for the shared
  // tuning). Downed mobs stay `alive` with 0 HP so targeting, snapshots and
  // the interest filter keep seeing them; only the melee finish path
  // (finishMob) can kill them. Ranged-equivalent damage must check isDowned()
  // first and refuse the finish.

  /** True while the mob's crawl timer still covers `now`. */
  isDowned(id: number, now: number): boolean {
    const m = this.mobs.get(id);
    return !!m && (m.downedUntil ?? 0) > now;
  }

  /** True while the mob's stun timer still covers `now`. */
  isStunned(id: number, now: number): boolean {
    const m = this.mobs.get(id);
    return !!m && (m.stunUntil ?? 0) > now;
  }

  /**
   * Knock a living mob DOWNED instead of killing it: hp floored at 0, crawl
   * timer armed for DOWNED_DURATION_MS, aggro dropped. Returns the mob, or
   * null for unknown/dead/already-downed mobs.
   */
  downMob(id: number, now: number, durationMs = DOWNED_DURATION_MS): Mob | null {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return null;
    if ((m.downedUntil ?? 0) > now) return null;
    m.hp = 0;
    m.downedUntil = now + Math.max(0, durationMs);
    m.targetId = null;
    return m;
  }

  /**
   * Finish a downed mob: instant kill with the standard 5s respawn timer.
   * Returns null unless the mob is downed right now (wrong target, expired
   * timer, or a ranged attempt that must refuse — callers check first).
   */
  finishMob(id: number, now: number): MobHit | null {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return null;
    if ((m.downedUntil ?? 0) <= now) return null;
    m.hp = 0;
    m.alive = false;
    m.downedUntil = 0;
    m.stunUntil = 0;
    m.respawnAt = now + RESPAWN_DELAY_MS;
    m.targetId = null;
    return { mob: m, dmg: 0, resolved: 0, killed: true, finished: true };
  }

  /**
   * Stand expired downed mobs back up at DOWNED_RECOVER_FRAC of max HP.
   * Returns the recovered mobs (callers announce one `mob-up` each). Mobs
   * never bleed out: an unanswered knockdown always gets back up.
   */
  recoverDowned(now: number, frac = DOWNED_RECOVER_FRAC): Mob[] {
    const out: Mob[] = [];
    for (const m of this.mobs.values()) {
      const until = m.downedUntil ?? 0;
      if (!m.alive || until === 0 || until > now) continue;
      m.hp = Math.max(1, Math.ceil(m.maxHp * Math.max(0, frac)));
      m.downedUntil = 0;
      out.push(m);
    }
    return out;
  }

  /** Stun a living mob for `stunMs` (thrown sidearms). Returns false when unknown/dead. */
  stunMob(id: number, now: number, stunMs = THROW_STUN_MS): boolean {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return false;
    m.stunUntil = now + Math.max(0, stunMs);
    return true;
  }
}
