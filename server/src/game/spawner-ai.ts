// AETHERFALL AI — spawner mob driver (10Hz).
//
// The deterministic worldgen population (`game/spawner.ts`: gloomfang,
// ashcrawler, thornback, mistwisp — 4 per 32x32 chunk) had NO behaviour at all:
// `Spawner.moveMob()` was only ever called from tests and `m.targetId` was only
// ever set to `null`, so every mob the player actually fought was a statue.
// This module is the missing brain. It reuses the existing `ai/` machinery
// rather than inventing a parallel one:
//
//   * `ai/vision.ts`     — 90-degree cone (VISION_HALF_ANGLE), the
//     moving-or-close sneak rule (SNEAK_STILL_DIST / MOVE_SPEED_EPS), and the
//     alert-state tracking leg (`canTrack` vs `canDetect`).
//   * `engine/src/los.ts` — reached through vision.ts: `gridLos` against the
//     worldgen tile grid and `rectLos` against the authoritative walls.json.
//   * `ai/fsm.ts`        — `NPCFSM` per mob (idle -> patrol -> chase -> attack ->
//     search -> patrol), including its idle-dwell and search-sweep timers.
//   * `ai/npc.ts`        — the shared damage budget (`MELEE_DAMAGE` 7 /
//     `MELEE_COOLDOWN` 1.5s) and `LEASH_RANGE` (20u), imported, not re-invented.
//
// Nothing here touches spawn, loot, ids or `pruneSpawnSafe` — it only moves
// living mobs (`Spawner.moveMob`, which re-files the spatial index) and emits
// `damage-player` events the server resolves through `Sim.damagePlayer` exactly
// like the NPC lane.
//
// PERFORMANCE: runs on the existing 10Hz NPC cadence and early-outs twice — once
// when there are no players at all, and once per mob that has no player inside
// ACTIVE_RADIUS. An idle shard pays one squared-distance test per mob and moves
// nothing.

import { genChunk, gridLos, rectLos } from '@aetherfall/engine';
import type { LosRect } from '@aetherfall/engine';
import {
  getMobLoadout,
  mulberry32,
  type MobLoadoutKind,
  type MobLoadoutProfile,
} from '@aetherfall/shared';
import { AGGRO_RANGE, MELEE_RANGE, type Mob } from './combat.js';
import {
  SPAWN_SAFE_POINTS,
  SPAWN_SAFE_RADIUS,
  isSpawnSafeZone,
  type Spawner,
} from './spawner.js';
import { NPCFSM, type NPCState } from '../ai/fsm.js';
import {
  LEASH_RANGE,
  MELEE_COOLDOWN,
  MELEE_DAMAGE,
  type PlayerView,
} from '../ai/npc.js';
import { canDetect, canTrack, faceToward, type SightQuery } from '../ai/vision.js';

// ---------------------------------------------------------------- tuning
//
// Every number below is either imported from the shared AI/gameplay constants
// or a patrol/leash parameter with no counterpart yet. The damage budget (7 per
// hit, 1.5s cadence) is NOT redefined here — see docs/GAMEPLAY.md "Damage
// budget", which this driver holds itself to.

/**
 * Sight pull for a spawner mob. Deliberately the same 12u as the legacy
 * proximity aggro (`combat.AGGRO_RANGE`) and inside `vision.VISION_RANGE` (14),
 * so the shared cone/LoS/sneak legs run unchanged and a mob never notices a
 * player from further away than the existing aggro bookkeeping says.
 */
export const SPAWNER_SIGHT_RANGE = AGGRO_RANGE;

/**
 * Melee reach: the SAME 2.2u the player swings at (`combat.MELEE_RANGE`), so a
 * duel is symmetric — neither side out-ranges the other.
 */
export const SPAWNER_MELEE_RANGE = MELEE_RANGE;

/** Chase speed (u/s). Fast enough to pressure a player who lingers, slower than
 *  the player's 8u/s (`sim.MAX_SPEED`) so walking away always works — the
 *  LEASH, not the chase speed, is what ends a fight. */
export const CHASE_SPEED = 5.0;
/** Idle drift around the home tile. */
export const PATROL_SPEED = 1.5;
/** Last-known-position sweep after losing sight (matches `ai/npc.ts`). */
export const SEARCH_SPEED = 2.0;
/** Walk-home pace after a leash break or a spawn-disc retreat. */
export const HOME_SPEED = 3.5;

/** Patrol radius band, drawn per mob from an id-seeded stream (the world reads
 *  as wandering packs rather than clones). */
export const PATROL_RADIUS_MIN = 3;
export const PATROL_RADIUS_MAX = 6;
/** Facing sweep rate while searching a lost target (rad/s). */
export const SEARCH_SPIN = 1.2;
/** A mob that cannot make progress toward its waypoint re-rolls it after this. */
export const STUCK_SEC = 1.5;
/** Upper bound on a "walking home" episode before normal patrol resumes. */
export const HOMING_TIMEOUT_SEC = 10;

/**
 * Radius around a mob in which some living player makes it worth thinking at
 * all. Sized to cover everything a chasing mob can legitimately reach — the
 * leash band (20u) plus the widest patrol (6u) plus slack — so an engaged mob is
 * never asleep, and everything further away costs one squared-distance test.
 */
export const ACTIVE_RADIUS = LEASH_RANGE + PATROL_RADIUS_MAX + 2;

/** Cached worldgen tile grids (see `chunkGrid`). */
export const CHUNK_CACHE_MAX = 96;

/** One hit landed on a player. Same shape as `NpcDamageEvent`, so the server
 *  resolves it through the same `sim.damagePlayer` path. */
export interface SpawnerAiEvent {
  kind: 'damage-player';
  targetId: number;
  amount: number;
  fromId: number;
}

/** Per-tick counters for tests / the perf story. */
export interface SpawnerAiStats {
  /** Mobs considered (the cheap early-out loop). */
  considered: number;
  /** Mobs inside ACTIVE_RADIUS of a player — the only ones that do work. */
  awake: number;
  /** Mob/target pairs that cleared cone + range (LoS runs after). */
  sensed: number;
  /** Mobs actually repositioned this tick. */
  moved: number;
}

/** Observable AI state for tests/debug (copies, safe to retain). */
export interface SpawnerAiDebug {
  id: number;
  x: number;
  y: number;
  /** Patrol anchor (`mob.spawnPos`). */
  home: { x: number; y: number };
  /** Vision cone facing in radians (0 = +X). */
  facing: number;
  state: NPCState;
  /** AI-owned aggro target, or null. NOT the legacy proximity `mob.targetId`. */
  targetId: number | null;
  /** True while walking home after a leash break / spawn-disc retreat. */
  homing: boolean;
  /** ms timestamp of the last swing (attack cadence). */
  attackAt: number;
  weaponId: string;
  loadoutKind: MobLoadoutKind;
  substate?: string;
}

/** Per-mob brain state. Held in a WeakMap keyed by the Mob so it cannot outlive
 *  the mob (no id-reuse leak) and `combat.ts` stays untouched. */
interface AiState {
  fsm: NPCFSM;
  /** Weapon loadout profile */
  loadout: MobLoadoutProfile;
  /** Tactical substate for spectator and tests */
  substate?: string;
  /** Deterministic per-id stream (patrol radius, waypoints, dwell). */
  rng: () => number;
  /** Patrol radius for this mob, drawn once from `rng`. */
  patrolR: number;
  /** Vision cone facing (radians, 0 = +X). */
  facing: number;
  /** AI-owned target (the legacy `mob.targetId` stays the 20Hz proximity field). */
  targetId: number | null;
  /** Current patrol waypoint. */
  waypoint: { x: number; y: number };
  /** Seconds left parked at the waypoint before picking the next one. */
  waypointPause: number;
  /** Seconds spent unable to make progress toward the waypoint. */
  stuck: number;
  /** Last known target position (search sweep anchor). */
  lastSeen: { x: number; y: number } | null;
  /** True while walking home; blocks re-acquisition until home is reached. */
  homing: boolean;
  /** Seconds spent in the current homing episode. */
  homeT: number;
  /** ms timestamp of the last melee swing; -Infinity = never swung. */
  attackAt: number;
  /** True while the mob was in ACTIVE_RADIUS last tick (drives the reset). */
  awake: boolean;
}

function homeOf(m: Mob): { x: number; y: number } {
  return m.spawnPos ?? m.pos;
}

/**
 * Project a point out of every spawn-safe disc it overlaps, radially.
 *
 * PLAYABILITY (spawn safety): the discs around (0,0) and (50,50) are where a
 * fresh bot lands, so a patrol waypoint that landed inside one would park a mob
 * in the "clear" zone. Waypoints are pushed back out before use.
 */
export function outsideSpawnSafeZone(
  x: number,
  y: number,
  radius: number = SPAWN_SAFE_RADIUS,
  points: ReadonlyArray<{ x: number; y: number }> = SPAWN_SAFE_POINTS,
): { x: number; y: number } {
  for (const p of points) {
    const dx = x - p.x;
    const dy = y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > radius * radius) continue;
    const d = Math.sqrt(d2);
    // Degenerate case (waypoint exactly on an anchor): deterministic +X push.
    const ux = d > 1e-6 ? dx / d : 1;
    const uy = d > 1e-6 ? dy / d : 0;
    x = p.x + ux * (radius + 0.05);
    y = p.y + uy * (radius + 0.05);
  }
  return { x, y };
}

export class SpawnerAI {
  /** Mob -> brain. Weak so a removed mob takes its state with it. */
  private ai = new WeakMap<Mob, AiState>();
  /** Authoritative walls.json rects for the LoS leg (empty = open world). */
  private walls: LosRect[] = [];
  /** Chunk-local worldgen tile grids: `tiles[ly][lx]` for world (ox+lx, oy+ly). */
  private chunks = new Map<string, number[][]>();
  /** Last-tick player positions for the moving-or-close leg of vision. */
  private lastPos = new Map<number, { x: number; y: number }>();
  /** Mobs repositioned THIS tick (index.ts mirrors them onto engine entities). */
  private moved: number[] = [];
  /** Mob ids that were in play on the previous tick (see the early-out). */
  private activeIds = new Set<number>();
  private stats: SpawnerAiStats = { considered: 0, awake: 0, sensed: 0, moved: 0 };

  constructor(
    private spawner: Spawner,
    private opts: { seed?: number; chunkSize?: number } = {},
  ) {}

  /** Worldgen seed the tile grids must match (defaults to the server's). */
  private get seed(): number {
    return this.opts.seed ?? 1337;
  }

  private get chunkSize(): number {
    return this.opts.chunkSize ?? 32;
  }

  /**
   * Install the authoritative walls.json rects for the LoS leg (mirrors
   * `NPCManager.setWalls` and the `Sim.setWalls` boot / POST /walls path).
   */
  setWalls(walls: Array<{ x: number; y: number; w: number; h: number }>): void {
    this.walls = walls.map((w) => ({ ...w }));
  }

  /** Per-tick counters from the last `tick()`. */
  lastStats(): SpawnerAiStats {
    return { ...this.stats };
  }

  /** Mobs repositioned during the last `tick()` (consumed, then cleared). */
  takeMoved(): number[] {
    const out = this.moved;
    this.moved = [];
    return out;
  }

  /** Observable AI state for tests/debug (undefined for unknown ids). */
  debugMob(id: number): SpawnerAiDebug | undefined {
    const m = this.spawner.getMob(id);
    if (!m) return undefined;
    const st = this.ai.get(m);
    const loadout = st ? st.loadout : getMobLoadout(m.weaponId, m.name);
    return {
      id: m.id,
      x: m.pos.x,
      y: m.pos.y,
      home: { ...homeOf(m) },
      facing: st ? st.facing : 0,
      state: st ? st.fsm.state : 'idle',
      targetId: st ? st.targetId : null,
      homing: st ? st.homing : false,
      attackAt: st ? st.attackAt : -Infinity,
      weaponId: loadout.weaponId,
      loadoutKind: loadout.kind,
      substate: st ? st.substate : undefined,
    };
  }

  /** Whether (x,y) is walkable terrain for a mob (chunk edge / ocean / obstacle). */
  walkable(x: number, y: number): boolean {
    return !this.solid(x, y);
  }

  /**
   * Debug/preview sight check: would `mobId` see (tx,ty) right now at
   * `targetSpeed` u/s, through the same cone + LoS + sneak legs as the tick?
   */
  canSee(mobId: number, tx: number, ty: number, targetSpeed = 0): boolean {
    const m = this.spawner.getMob(mobId);
    const st = m ? this.ai.get(m) : undefined;
    if (!m || !st) return false;
    const effSpeed = targetSpeed / Math.max(0.1, st.loadout.alertThreshold);
    return canDetect(this.sightQuery(m, st, tx, ty, st.loadout.sightRange, effSpeed));
  }

  // ------------------------------------------------------------------ tick

  /**
   * Advance every spawner mob by `dt` (call at 10Hz, alongside `npcs.tick`).
   * Returns `damage-player` events for `Sim.damagePlayer` — the same contract
   * (and the same damage budget) as the NPC lane.
   */
  tick(dt: number, players: PlayerView[], nowMs: number = Date.now()): SpawnerAiEvent[] {
    const ev: SpawnerAiEvent[] = [];
    this.moved.length = 0;
    this.stats = { considered: 0, awake: 0, sensed: 0, moved: 0 };

    // Early-out 1: an empty shard does zero per-mob work.
    if (players.length === 0) {
      this.lastPos.clear();
      this.stats.considered = this.spawner.mobCount();
      return ev;
    }

    // Target speeds for the moving-or-close leg. Caller velocity wins; else
    // per-tick deltas; a first sighting reads as still (sneak works at once).
    const step = dt > 0 ? dt : 0.1;
    const live: PlayerView[] = [];
    const speeds = new Map<number, number>();
    const huntable: boolean[] = [];
    for (const p of players) {
      if (p.hp <= 0) continue;
      let sp: number;
      if (typeof p.vx === 'number' && typeof p.vy === 'number') {
        sp = Math.hypot(p.vx, p.vy);
      } else {
        const last = this.lastPos.get(p.id);
        sp = last ? Math.hypot(p.x - last.x, p.y - last.y) / step : 0;
      }
      speeds.set(p.id, sp);
      this.lastPos.set(p.id, { x: p.x, y: p.y });
      live.push(p);
      // PLAYABILITY (spawn safety): nobody inside a spawn-safe disc is hunted.
      // Together with the movement barrier in `step()` this is the whole
      // "no camping on a fresh bot" rule: a mob cannot enter the clear zone, and
      // once the player is inside it the mob has nothing left to chase.
      huntable.push(!isSpawnSafeZone(p.x, p.y));
    }
    const liveIds = new Set<number>();
    for (const p of live) liveIds.add(p.id);
    // Deleting the current key during Map iteration is safe per spec, so this
    // needs no copy of the key set.
    for (const id of this.lastPos.keys()) {
      if (!liveIds.has(id)) this.lastPos.delete(id);
    }

    const active: Mob[] = [];
    const nextActive = new Set<number>();
    // Early-out 2 is driven from the PLAYER side through the spawner's cell
    // index, so the cost is O(players x nearby mobs) instead of
    // O(all mobs x players): a 6k-mob shard with nobody around it walks the
    // candidate cells of a handful of players and nothing else.
    for (const p of live) {
      this.spawner.forEachMobNear(p.x, p.y, ACTIVE_RADIUS, (m) => {
        if (nextActive.has(m.id)) return;
        nextActive.add(m.id);
        active.push(m);
      });
    }
    // Mobs that were in play last tick and are not any more: rest them so their
    // brain resets when a player comes back into range.
    for (const id of this.activeIds) {
      if (nextActive.has(id)) continue;
      const m = this.spawner.getMob(id);
      if (m) this.sleep(m);
    }
    this.activeIds = nextActive;
    this.stats.considered = this.spawner.mobCount();
    this.stats.awake = active.length;

    for (const m of active) {
      // Inert: dead (respawn timer), downed (crawl) or stunned (thrown
      // sidearm). No sensing, no movement, no swings — same rule as ai/npc.ts.
      if (!m.alive || m.hp <= 0 || (m.downedUntil ?? 0) > nowMs || (m.stunUntil ?? 0) > nowMs) {
        this.sleep(m);
        continue;
      }
      this.think(this.wake(m), m, live, huntable, speeds, ev, dt, nowMs);
    }
    return ev;
  }

  /** Mark a mob as resting (its brain is reset the next time it wakes). */
  private sleep(m: Mob): void {
    const st = this.ai.get(m);
    if (st) st.awake = false;
  }

  /** Brain for `m`, created (or reset) when it comes back into play. */
  private wake(m: Mob): AiState {
    const prev = this.ai.get(m);
    if (!prev || !prev.awake) {
      // Fresh mob, woke from sleep, or stood back up from a knockdown: new
      // patrol, no stale target. The attack timer survives (it is wall-clock).
      const fresh = this.makeState(m);
      fresh.attackAt = prev ? prev.attackAt : -Infinity;
      this.ai.set(m, fresh);
      return fresh;
    }
    prev.awake = true;
    return prev;
  }

  private makeState(m: Mob): AiState {
    // Deterministic stagger/stream derived from the mob id (same idiom as
    // ai/npc.ts), so a given world always behaves the same way.
    const rng = mulberry32(((Math.imul(m.id, 2654435761) >>> 0) ^ 0x9e3779b9) >>> 0);
    const loadout = getMobLoadout(m.weaponId, m.name);
    const patrolR = PATROL_RADIUS_MIN + rng() * (PATROL_RADIUS_MAX - PATROL_RADIUS_MIN);
    const st: AiState = {
      fsm: new NPCFSM('idle', 2.0 + rng() * 1.0),
      loadout,
      rng,
      patrolR,
      facing: 0,
      targetId: null,
      waypoint: { x: m.pos.x, y: m.pos.y },
      waypointPause: 0,
      stuck: 0,
      lastSeen: null,
      homing: false,
      homeT: 0,
      attackAt: -Infinity,
      awake: true,
    };
    // Initial facing: toward the first patrol waypoint, so the cone sweeps the
    // neighbourhood from the first tick instead of staring down +X forever.
    st.waypoint = this.pickWaypoint(m, st);
    const dx = st.waypoint.x - m.pos.x;
    const dy = st.waypoint.y - m.pos.y;
    st.facing = dx * dx + dy * dy > 1e-9 ? Math.atan2(dy, dx) : 0;
    return st;
  }

  /** Deterministic patrol waypoint inside the mob's patrol radius, outside the
   *  spawn-safe discs and off solid tiles. */
  private pickWaypoint(m: Mob, st: AiState): { x: number; y: number } {
    const home = homeOf(m);
    for (let i = 0; i < 8; i++) {
      const ang = st.rng() * Math.PI * 2;
      const rad = st.patrolR * (0.35 + 0.65 * st.rng());
      const c = outsideSpawnSafeZone(home.x + Math.cos(ang) * rad, home.y + Math.sin(ang) * rad);
      if (!this.solid(c.x, c.y)) return c;
    }
    return { x: home.x, y: home.y };
  }

  // ------------------------------------------------------------- behaviour

  private think(
    st: AiState,
    m: Mob,
    live: PlayerView[],
    huntable: boolean[],
    speeds: Map<number, number>,
    ev: SpawnerAiEvent[],
    dt: number,
    nowMs: number,
  ): void {
    const home = homeOf(m);

    // --- 1. sense -------------------------------------------------------
    // ALERT states (chase/attack/search) drop the movement leg via canTrack;
    // calm states use canDetect so a perfectly still player beyond 4u is
    // invisible (sneak).
    const loadout = st.loadout;
    const alert =
      st.fsm.state === 'chase' || st.fsm.state === 'attack' || st.fsm.state === 'search';
    const range = loadout.sightRange;
    let target: PlayerView | null = null;
    let dist = Infinity;
    // Set when a player inside the sight pull is standing in a spawn-safe
    // disc — i.e. the mob was chasing someone and that someone ducked into a
    // sanctuary. See the leash block below.
    let sanctuaryNear = false;
    if (!st.homing) {
      for (let i = 0; i < live.length; i++) {
        const p = live[i]!;
        // PLAYABILITY: spawn-protected players are untargetable (no aggro).
        if ((p.spawnProtectedUntil ?? 0) > nowMs) continue;
        const d = Math.hypot(p.x - m.pos.x, p.y - m.pos.y);
        if (!huntable[i]) {
          if (d <= range + 1) sanctuaryNear = true;
          continue;
        }
        if (d >= dist || d > range) continue;
        this.stats.sensed++;
        const effSpeed = (speeds.get(p.id) ?? 0) / Math.max(0.1, loadout.alertThreshold);
        const q = this.sightQuery(m, st, p.x, p.y, range, effSpeed);
        if (alert ? canTrack(q) : canDetect(q)) {
          dist = d;
          target = p;
        }
      }
    }
    st.targetId = target ? target.id : null;
    if (target) st.lastSeen = { x: target.x, y: target.y };

    // --- 2. leash + sanctuary retreat --------------------------------------
    // Kited further than LEASH_RANGE from home, give up and walk back. Checked
    // every tick (not after the search sweep) so the return starts at once. A
    // target that stepped into a spawn-safe disc breaks the chase the same way:
    // that is the "do not camp a fresh bot" half of the rule (the movement
    // barrier in step() is the other half). Breaking off — rather than freezing
    // on the disc boundary — is deliberate: a mob pressed against the clear zone
    // still reads as "camped on spawn".
    const dHome = Math.hypot(m.pos.x - home.x, m.pos.y - home.y);
    const leashed = dHome > LEASH_RANGE;
    const targetInSafe = target !== null && isSpawnSafeZone(target.x, target.y);
    const sanctuary = sanctuaryNear && alert;
    if (leashed || targetInSafe || sanctuary) {
      target = null;
      dist = Infinity;
      st.targetId = null;
      st.lastSeen = null;
      this.goHome(st);
    }

    // --- 3. FSM ---------------------------------------------------------
    // Weapon loadout determines flee threshold and engagement range
    let state = st.fsm.update(dt, {
      hp: m.hp,
      maxHp: m.maxHp,
      targetVisible: target !== null,
      distToTarget: target ? dist : Infinity,
      attackRange: loadout.attackRange,
      aggroRange: range,
      fleeThreshold: loadout.fleeThreshold,
    });
    if (st.homing) {
      // Straight home: the FSM would otherwise comb the last-seen point.
      st.fsm.force('patrol');
      state = 'patrol';
    } else if (!loadout.allowedStates.includes(state as any)) {
      // If FSM elected a state disallowed by loadout, re-route to combat
      if (state === 'flee') state = 'attack';
      st.fsm.force(state);
    }

    // --- 4. act ---------------------------------------------------------
    if (st.homing) {
      st.substate = 'homing';
      st.homeT += dt;
      if (dHome <= 1.0 || st.homeT > HOMING_TIMEOUT_SEC) {
        st.homing = false;
        st.homeT = 0;
      } else {
        this.step(m, st, home.x, home.y, HOME_SPEED, dt);
        return;
      }
    }

    switch (state) {
      case 'flee': {
        st.substate = 'flee';
        const escapeFrom = target ?? st.lastSeen;
        if (escapeFrom) {
          const dx = m.pos.x - escapeFrom.x;
          const dy = m.pos.y - escapeFrom.y;
          const d = Math.hypot(dx, dy);
          if (d > 1e-4) {
            st.facing = Math.atan2(dy, dx);
            const destX = m.pos.x + (dx / d) * 8.0;
            const destY = m.pos.y + (dy / d) * 8.0;
            this.step(m, st, destX, destY, loadout.combatSpeed, dt);
          }
        }
        break;
      }
      case 'attack':
      case 'chase': {
        if (!target) break;
        st.facing = faceToward(m.pos.x, m.pos.y, target.x, target.y);

        if (loadout.kind === 'ranged') {
          // Ranged loadout holds distance and repositions
          const minR = loadout.preferredRangeMin ?? 5.0;
          const maxR = loadout.preferredRangeMax ?? 8.0;
          if (dist < minR) {
            // Target closed inside minimum range: back away to hold distance!
            const awayX = m.pos.x - target.x;
            const awayY = m.pos.y - target.y;
            const destX = m.pos.x + (awayX / dist) * 4.0;
            const destY = m.pos.y + (awayY / dist) * 4.0;
            this.step(m, st, destX, destY, loadout.combatSpeed, dt);
            st.substate = 'reposition';
          } else if (dist <= maxR) {
            // In optimal pocket: hold distance, strafe laterally, and fire on cooldown
            const perpX = -(target.y - m.pos.y) / dist;
            const perpY = (target.x - m.pos.x) / dist;
            const strafeSign = (m.id % 2 === 0 ? 1 : -1);
            const destX = m.pos.x + perpX * strafeSign * 2.0;
            const destY = m.pos.y + perpY * strafeSign * 2.0;
            this.step(m, st, destX, destY, loadout.patrolSpeed * 1.5, dt);
            st.substate = 'hold-distance';

            if (nowMs - st.attackAt >= MELEE_COOLDOWN * 1000) {
              st.attackAt = nowMs;
              if ((target.spawnProtectedUntil ?? 0) <= nowMs) {
                ev.push({
                  kind: 'damage-player',
                  targetId: target.id,
                  amount: MELEE_DAMAGE,
                  fromId: m.id,
                });
              }
            }
          } else {
            // Out of range: close in
            this.step(m, st, target.x, target.y, loadout.chaseSpeed, dt);
          }
          st.facing = faceToward(m.pos.x, m.pos.y, target.x, target.y);
        } else if (loadout.kind === 'melee') {
          // Melee loadout charges and flanks
          if (dist <= loadout.attackRange) {
            st.substate = 'strike';
            if (nowMs - st.attackAt >= MELEE_COOLDOWN * 1000) {
              st.attackAt = nowMs;
              if ((target.spawnProtectedUntil ?? 0) <= nowMs) {
                ev.push({
                  kind: 'damage-player',
                  targetId: target.id,
                  amount: MELEE_DAMAGE,
                  fromId: m.id,
                });
              }
            }
          } else {
            let destX = target.x;
            let destY = target.y;
            let spd = loadout.chaseSpeed;
            if (dist > 2.5 && dist < 7.5) {
              spd = loadout.combatSpeed; // Rapid charge speed!
              st.substate = 'charge';
              destX = target.x;
              destY = target.y;
            } else {
              // Close-in flank: wrap around the target while preserving sightline
              st.substate = 'flank';
              const flankSign = (m.id % 2 === 0 ? 1 : -1);
              const directAngle = Math.atan2(target.y - m.pos.y, target.x - m.pos.x);
              const offsetDist = Math.max(1.0, loadout.attackRange * 0.85);
              let flanked = false;
              for (const sign of [flankSign, -flankSign]) {
                const flankAngle = directAngle + sign * 0.52; // ~30 deg
                const tryX = target.x - Math.cos(flankAngle) * offsetDist;
                const tryY = target.y - Math.sin(flankAngle) * offsetDist;
                if (!this.blocked(m.pos.x, m.pos.y, tryX, tryY) && this.hasLos(tryX, tryY, target.x, target.y)) {
                  destX = tryX;
                  destY = tryY;
                  flanked = true;
                  break;
                }
              }
              if (!flanked) {
                destX = target.x;
                destY = target.y;
              }
            }
            this.step(m, st, destX, destY, spd, dt);
            st.facing = faceToward(m.pos.x, m.pos.y, target.x, target.y);
          }
        } else {
          // Unarmed brawler
          if (dist <= loadout.attackRange) {
            st.substate = 'strike';
            if (nowMs - st.attackAt >= MELEE_COOLDOWN * 1000) {
              st.attackAt = nowMs;
              if ((target.spawnProtectedUntil ?? 0) <= nowMs) {
                ev.push({
                  kind: 'damage-player',
                  targetId: target.id,
                  amount: MELEE_DAMAGE,
                  fromId: m.id,
                });
              }
            }
          } else {
            this.step(m, st, target.x, target.y, loadout.chaseSpeed, dt);
            st.substate = 'chase';
            st.facing = faceToward(m.pos.x, m.pos.y, target.x, target.y);
          }
        }
        break;
      }
      case 'search': {
        st.substate = 'search';
        const p = st.lastSeen;
        if (!p) break;
        if (isSpawnSafeZone(p.x, p.y)) break; // never sweep into the clear disc
        const d = Math.hypot(p.x - m.pos.x, p.y - m.pos.y);
        if (d > 0.8) {
          this.step(m, st, p.x, p.y, loadout.patrolSpeed * 1.3, dt);
        } else {
          st.facing += SEARCH_SPIN * dt; // sweep the gaze where it stood
        }
        break;
      }
      case 'idle':
        st.substate = 'idle';
        // A fresh mob dwells before its first patrol step (FSM idle timer).
        st.stuck = 0;
        break;
      default: {
        // patrol: drift around home so the world is not full of statues.
        st.substate = 'patrol';
        if (st.waypointPause > 0) {
          st.waypointPause -= dt;
          st.stuck = 0;
          break;
        }
        const wp = st.waypoint;
        if (Math.hypot(wp.x - m.pos.x, wp.y - m.pos.y) < 0.6 || st.stuck >= STUCK_SEC) {
          st.waypoint = this.pickWaypoint(m, st);
          st.waypointPause = 0.4 + st.rng() * 1.2;
          st.stuck = 0;
          break;
        }
        const beforeX = m.pos.x;
        const beforeY = m.pos.y;
        this.step(m, st, wp.x, wp.y, loadout.patrolSpeed, dt);
        st.stuck =
          Math.hypot(m.pos.x - beforeX, m.pos.y - beforeY) < 0.02 ? st.stuck + dt : 0;
        break;
      }
    }
  }

  /** Give up: walk home, block re-acquisition until home is reached. */
  private goHome(st: AiState): void {
    if (st.homing) return;
    st.homing = true;
    st.homeT = 0;
    st.fsm.force('patrol');
  }

  // ------------------------------------------------------------- movement

  /**
   * Straight-line seek toward (tx,ty) with wall rejection.
   *
   * PLAYABILITY (spawn safety): a destination inside a spawn-safe disc is
   * refused outright, so no mob can be walked into the 12u clear zone to camp a
   * fresh bot — the barrier holds even in the cases the targeting rule does not
   * cover.
   *
   * Solid tiles (worldgen `genChunk`) and `walls.json` rects both block; a
   * blocked step falls back to an axis-separated slide so a mob brushes along a
   * wall instead of sticking to it.
   */
  private step(m: Mob, st: AiState, tx: number, ty: number, speed: number, dt: number): void {
    const dx = tx - m.pos.x;
    const dy = ty - m.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    st.facing = Math.atan2(dy, dx);
    const len = Math.min(d, speed * dt);
    let nx = m.pos.x + (dx / d) * len;
    let ny = m.pos.y + (dy / d) * len;
    if (isSpawnSafeZone(nx, ny)) return; // never enter the clear disc
    if (this.blocked(m.pos.x, m.pos.y, nx, ny)) {
      const slideX = nx !== m.pos.x && !this.blocked(m.pos.x, m.pos.y, nx, m.pos.y);
      const slideY = ny !== m.pos.y && !this.blocked(m.pos.x, m.pos.y, m.pos.x, ny);
      if (slideX) ny = m.pos.y;
      else if (slideY) nx = m.pos.x;
      else return;
    }
    if (nx === m.pos.x && ny === m.pos.y) return;
    this.spawner.moveMob(m.id, nx, ny);
    this.moved.push(m.id);
    this.stats.moved++;
  }

  /** Clear line-of-sight between two world coordinates (walls.json + tile grid). */
  private hasLos(x0: number, y0: number, x1: number, y1: number): boolean {
    if (this.walls.length > 0 && !rectLos(this.walls, x0, y0, x1, y1)) return false;
    const size = this.chunkSize;
    const cx0 = Math.floor(x0 / size);
    const cy0 = Math.floor(y0 / size);
    const cx1 = Math.floor(x1 / size);
    const cy1 = Math.floor(y1 / size);
    if (cx0 === cx1 && cy0 === cy1) {
      const ox = cx0 * size;
      const oy = cy0 * size;
      const grid = this.chunkGrid(cx0, cy0);
      return gridLos(grid, x0 - ox, y0 - oy, x1 - ox, y1 - oy, 1);
    }
    return true;
  }

  /** A wall rect or a solid tile on the segment (inclusive of both endpoints). */
  private blocked(x0: number, y0: number, x1: number, y1: number): boolean {
    if (this.walls.length > 0 && !rectLos(this.walls, x0, y0, x1, y1)) return true;
    return this.solid(x1, y1);
  }

  /** Solid worldgen tile at a world position (chunk border / ocean / obstacle). */
  private solid(x: number, y: number): boolean {
    const size = this.chunkSize;
    const cx = Math.floor(x / size);
    const cy = Math.floor(y / size);
    const grid = this.chunkGrid(cx, cy);
    const row = grid[Math.floor(y) - cy * size];
    if (!row) return true;
    return row[Math.floor(x) - cx * size] === 1;
  }

  /** Cached `genChunk` tile grid, indexed chunk-local with 1u cells. */
  private chunkGrid(cx: number, cy: number): number[][] {
    const key = `${cx},${cy}`;
    const hit = this.chunks.get(key);
    if (hit) return hit;
    const grid = genChunk(cx, cy, this.chunkSize, this.seed).tiles as number[][];
    if (this.chunks.size >= CHUNK_CACHE_MAX) {
      // FIFO eviction (Map preserves insertion order): the driver only ever
      // touches chunks a player is near, so this is a no-op in practice.
      const oldest = this.chunks.keys().next();
      if (!oldest.done) this.chunks.delete(oldest.value);
    }
    this.chunks.set(key, grid);
    return grid;
  }

  /**
   * Sight query for one mob/target pair.
   *
   * Same-chunk pairs run the tile-grid LoS leg in chunk-local coordinates
   * (`gridLos` with cell = 1 world unit) against the cached chunk: the cone and
   * range legs are translation invariant, so shifting BOTH endpoints by the
   * chunk origin changes nothing but the grid indexing. Cross-chunk pairs skip
   * the tile leg (the ray would leave the cached grid) and rely on the
   * walls.json rects — at a 12u pull two bodies only straddle a chunk line in
   * the last few tiles of a 32u chunk.
   */
  private sightQuery(
    m: Mob,
    st: AiState,
    tx: number,
    ty: number,
    range: number,
    targetSpeed: number,
  ): SightQuery {
    const size = this.chunkSize;
    const nx = m.pos.x;
    const ny = m.pos.y;
    const cx0 = Math.floor(nx / size);
    const cy0 = Math.floor(ny / size);
    if (cx0 === Math.floor(tx / size) && cy0 === Math.floor(ty / size)) {
      const ox = cx0 * size;
      const oy = cy0 * size;
      return {
        nx: nx - ox,
        ny: ny - oy,
        facing: st.facing,
        tx: tx - ox,
        ty: ty - oy,
        range,
        grid: this.chunkGrid(cx0, cy0),
        cell: 1,
        walls: this.walls,
        targetSpeed,
      };
    }
    return {
      nx,
      ny,
      facing: st.facing,
      tx,
      ty,
      range,
      grid: null,
      walls: this.walls,
      targetSpeed,
    };
  }
}