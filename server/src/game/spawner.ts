// @aetherfall/gameplay — deterministic mob spawner driven by engine worldgen.
// Uses genChunk() walkable tiles + seeded RNG so every server computes identical spawns.
// Names/levels come from content.ts per-zone spawn tables; HP from content.mobMaxHp
// (zone-scaled for 3-5-hit TTK). Zone of a mob = getZone() at its world position.

import { genChunk, getZone } from '@aetherfall/engine';
import { mulberry32 } from '@aetherfall/shared';
import { RESPAWN_DELAY_MS, makeMob, type Mob } from './combat.js';
import { mobMaxHp, rollSpawnForZone } from './content.js';
import { MOB_ID_MAX, MOB_ID_MIN, isSpawnerMobId } from './mobs.js';

export const MOBS_PER_CHUNK = 4;
export const MOB_NAMES = ['gloomfang', 'ashcrawler', 'thornback', 'mistwisp'] as const;

/**
 * Spatial-index cell size in world units. Player melee reaches MELEE_RANGE
 * (2.2) and aggro pulls at AGGRO_RANGE (12); 8 keeps the candidate fan-out at
 * <=9 cells for a melee query while holding ~2 mobs per cell at MOBS_PER_CHUNK
 * per 32x32 chunk. Spawner mobs never walk, so the index is written once at
 * spawn and only patched on remove/move — no per-tick rebuild.
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
   * Spawn one chunk (idempotent). Returns newly spawned mobs.
   * Hash bases can theoretically collide across distant chunks, so ids already
   * taken are bumped forward (staying inside the spawner namespace). */
  spawnChunk(cx: number, cy: number, mobLevel?: number): Mob[] {
    const key = `${cx},${cy}`;
    if (this.spawnedChunks.has(key)) return [];
    this.spawnedChunks.add(key);
    const mobs = spawnMobsForChunk(cx, cy, {
      seed: this.seed,
      chunkSize: this.chunkSize,
      mobLevel,
    });
    for (const m of mobs) {
      while (this.mobs.has(m.id)) {
        // Linear probe inside [MOB_ID_MIN, MOB_ID_MAX]; wraps safely.
        m.id = m.id >= MOB_ID_MAX ? MOB_ID_MIN : m.id + 1;
      }
      if (!isSpawnerMobId(m.id)) {
        throw new Error(`[spawner] mob id out of namespace: ${m.id}`);
      }
      this.mobs.set(m.id, m);
      this.index(m);
    }
    return mobs;
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

  killMob(id: number, now: number, respawnDelayMs = 5000): boolean {
    const m = this.mobs.get(id);
    if (!m || !m.alive) return false;
    m.hp = 0;
    m.alive = false;
    m.respawnAt = now + respawnDelayMs;
    m.targetId = null;
    return true;
  }

  /**
   * Apply flat damage to a living spawner mob. Mirrors combat.tryMeleeAttack's
   * death bookkeeping (hp clamp, alive=false, RESPAWN_DELAY_MS timer) so
   * updateRespawns() brings it back unchanged — the 5s timer stays the single
   * respawn authority. Returns null for unknown/dead mobs.
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
}
