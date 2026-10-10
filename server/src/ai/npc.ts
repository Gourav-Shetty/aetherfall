// AETHERFALL AI — NPC tick (10Hz).
// Owns minions + the two bosses, drives them with FSM (locomotion state)
// + behavior trees (per-tick action selection), and uses engine
// SpatialHash (target acquisition) + astar (pathing).
// index.ts calls tick() at 10Hz and merges snapshot()/events.

import { SpatialHash, astar } from '@aetherfall/engine';
import type { EntitySnapshot } from '@aetherfall/shared';
import { mulberry32 } from '@aetherfall/shared';
import { NPC_ID_MAX, NPC_ID_MIN } from '../game/mobs.js';
import type { BossName } from '../game/content.js';
import {
  DOWNED_DURATION_MS,
  DOWNED_RECOVER_FRAC,
} from '../systems/combat_ext.js';
import { NPCFSM, type NPCState } from './fsm.js';
import {
  NOISE_RADIUS,
  canDetect,
  canTrack,
  faceToward,
  visionRangeAt,
} from './vision.js';
import {
  Blackboard,
  action,
  condition,
  selector,
  sequence,
  type BTNode,
} from './behavior.js';
import {
  CryptWardenBoss,
  EmberWyrmBoss,
  GolemBoss,
  WispBoss,
  damageBoss,
  distToSegmentSq,
  type BossCtl,
  type BossEvent,
} from './bosses.js';

export interface PlayerView {
  id: number;
  x: number;
  y: number;
  hp: number;
  /**
   * Authoritative velocity (u/s) when the caller provides it. Otherwise the
   * manager derives speed from per-tick position deltas for the
   * moving-or-close leg of vision (see vision.ts).
   */
  vx?: number;
  vy?: number;
  /**
   * PLAYABILITY (spawn protection): ms timestamp until which this player
   * takes no damage (Sim.protectedUntil). Protected players are never
   * targeted and never take pool/boss/minion damage while it covers nowMs.
   */
  spawnProtectedUntil?: number;
}

export type NPCKind = 'gloomfang' | 'crypt-husk';

export interface NpcDamageEvent {
  kind: 'damage-player';
  targetId: number;
  amount: number;
  fromId: number;
}
export interface NpcTelegraphEvent {
  kind: 'telegraph';
  shape: 'circle';
  x: number;
  y: number;
  r: number;
  ttlMs: number;
  label: string;
}
/** A lootable boss died: index.ts turns this into boss loot + achievement XP. */
export interface NpcBossKillEvent {
  kind: 'boss-kill';
  boss: BossName;
  id: number;
  name: string;
  x: number;
  y: number;
  killedBy: number;
  /** True when the kill was a melee finisher on a downed boss (bonus XP path). */
  finisher?: boolean;
}
/**
 * DOWNED: a minion/boss reduced to 0 HP crawls instead of dying. Clients
 * render the crawl state off this event; a follow-up melee swing finishes it.
 * Unknown kinds are ignored by old clients, so this is wire-safe.
 */
export interface NpcDownedEvent {
  kind: 'mob-downed';
  id: number;
  name: string;
  x: number;
  y: number;
  downedUntil: number;
}
/** An unanswered knockdown stood back up at partial HP. */
export interface NpcUpEvent {
  kind: 'mob-up';
  id: number;
}
/** A thrown sidearm stunned a minion/boss (no actions until `until`). */
export interface NpcStunEvent {
  kind: 'mob-stun';
  id: number;
  until: number;
}
/** A downed minion was finished in melee (instant kill, credited). */
export interface NpcFinishEvent {
  kind: 'mob-die';
  id: number;
  killedBy: number;
  finisher: true;
}
/**
 * TAUNT: a minion acquiring a target plays an emote bubble. `emote` reuses
 * the existing `laugh` id so the composed-systems client renders it through
 * the normal emote broadcast (`{t:'event',kind:'emote',payload}` — the same
 * lane index.ts already forwards for every other NPC event kind).
 */
export interface NpcEmoteEvent {
  kind: 'emote';
  fromId: number;
  name: string;
  emote: 'laugh';
  label: string;
  x: number;
  y: number;
  expiresAt: number;
  seq: number;
}
/**
 * SURRENDER: a solo low-HP mob threw up its hands. Clients render the
 * hands-up state off this event (the mob stands still server-side);
 * unknown kinds are ignored by old clients, so this is wire-safe.
 */
export interface NpcSurrenderEvent {
  kind: 'surrender';
  id: number;
  name: string;
  x: number;
  y: number;
}
export type NpcEvent =
  | NpcDamageEvent
  | NpcTelegraphEvent
  | NpcBossKillEvent
  | NpcEmoteEvent
  | NpcSurrenderEvent
  | NpcDownedEvent
  | NpcUpEvent
  | NpcStunEvent
  | NpcFinishEvent;

/** Lingering Wyrm fire: burns `tickDamage` once per POOL_TICK_SEC per player. */
interface FirePool {
  x: number;
  y: number;
  r: number;
  left: number;
  tickDamage: number;
  acc: number;
  label: string;
}

interface BossEntry {
  ctl: BossCtl;
  id: number;
  name: string;
  level: number;
  /** Boss drop-table name (null: golem/wisp have no boss loot table). */
  bossName: BossName | null;
  home: { x: number; y: number };
  /** Living-player distance that wakes a dormant boss (Infinity = always awake). */
  wakeRange: number;
  dormant: boolean;
  /** Seconds of corpse left after death, then the slot goes dormant again. */
  deadT: number;
  /** Player id credited with the most recent hit (boss-kill payout). */
  lastHitBy: number;
  /** ms timestamp until which the boss is downed (crawls); 0 = up. */
  downedUntil: number;
  /** ms timestamp until which the boss is stunned (no actions); 0 = free. */
  stunUntil: number;
}

interface Minion {
  id: number;
  kind: NPCKind;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  fsm: NPCFSM;
  bt: BTNode;
  bb: Blackboard;
  patrol: Array<{ x: number; y: number }>;
  patrolIdx: number;
  path: Array<[number, number]>;
  repathT: number;
  attackCd: number;
  deadT: number;
  /** Vision cone facing (radians, 0 = +X). Updated on every move/attack. */
  facing: number;
  /** Last known target position (search sweep anchor). */
  lastSeen: { x: number; y: number } | null;
  /** Search sweep: last-seen + 2 neighbors, visited in order. */
  searchPts: Array<{ x: number; y: number }>;
  searchIdx: number;
  /** Noise position this suspicious episode stares at (null = none). */
  noiseAt: { x: number; y: number } | null;
  /** True while ALERT on the current target episode (gates the TAUNT). */
  taunted: boolean;
  /** True once the 40% surrender roll resolved this life (win or lose). */
  surrenderRolled: boolean;
  /** True once a surrender broke (attacked) — never re-roll this life. */
  surrenderBroken: boolean;
  /** True when hit while surrendered (exits to re-aggro via the FSM). */
  hitWhileSurrendered: boolean;
  /** Per-minion deterministic stream (id-seeded) for the surrender roll. */
  rng: () => number;
  /** ms timestamp until which the minion is downed (crawls); 0 = up. */
  downedUntil: number;
  /** ms timestamp until which the minion is stunned (no actions); 0 = free. */
  stunUntil: number;
}

const WORLD = 100; // arena bounds (matches server index.ts)
const CELL = 2; // path grid resolution (world units per cell)
const GRID_N = Math.ceil(WORLD / CELL); // 50x50
const ATTACK_RANGE = 1.8;
const AGGRO_RANGE = 14;
/**
 * PLAYABILITY (difficulty sanity): a single minion hit deals 7 in the
 * required 6-14 band, one swing every 1.5s. TTD for a naked 100HP idle
 * player is therefore (ceil(100/7)-1)*1.5 = 21s (>20s required), while TTK
 * for the player is untouched (12 + 3/lvl, 3-5 swings — see docs/GAMEPLAY.md).
 */
export const MELEE_DAMAGE = 7;
export const MELEE_COOLDOWN = 1.5;
/**
 * PLAYABILITY (leash): a minion that has been kited this far from its patrol
 * anchor drops its target and walks home. Without this a chase can be dragged
 * to spawn and camp new players; with it the 35u FSM loss range is never the
 * limiter near home.
 */
export const LEASH_RANGE = 20;

// --- Hotline Miami senses (see vision.ts + docs/AI.md) ------------------------
// SURRENDER_CHANCE: solo mobs at/below SURRENDER_HP_FRAC roll once per life.
// ALLY_RADIUS: another living minion inside this radius means "not solo".
// SEARCH_OFFSET: neighbor spacing for the last-seen + 2 sweep.
// SEARCH_SPEED: sweep pace (slower than the 3.5 chase, faster than patrol).
const SURRENDER_HP_FRAC = 0.25;
const SURRENDER_CHANCE = 0.4;
const ALLY_RADIUS = 10;
const SEARCH_OFFSET = 3;
const SEARCH_SPEED = 2.0;
/** Cap on noise events remembered between 10Hz ticks (attacks are loud). */
const MAX_NOISES = 16;

/**
 * Pure surrender gate: solo (no allies nearby) + at/below 25% HP + wins the
 * 40% roll. `roll` is caller RNG in [0, 1) — pass a seeded stream in tests.
 */
export function shouldSurrender(
  hp: number,
  maxHp: number,
  alliesNearby: boolean,
  roll: number,
): boolean {
  if (alliesNearby) return false;
  if (maxHp <= 0) return false;
  if (hp / maxHp > SURRENDER_HP_FRAC) return false;
  return roll < SURRENDER_CHANCE;
}

/** Observable minion state for tests/debug (copies, safe to retain). */
export interface MinionDebug {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: NPCState;
  facing: number;
  lastSeen: { x: number; y: number } | null;
  searchPts: Array<{ x: number; y: number }>;
}

// --- boss spawn rules (see docs/WORLD.md) -----------------------------------
/** A living player this close to a boss anchor wakes it. */
const BOSS_WAKE_RANGE = 30;
/** Corpse seconds before a dead boss despawns to its dormant anchor. */
const BOSS_CORPSE_SEC = 2;
/** Husk add HP — deliberately chaff-tier so add cleanup stays inside the TTK window. */
const HUSK_HP = 35;
/**
 * Living-husk cap. The Warden FSM decides *when* to summon; the world decides
 * whether there is room. Without this a long fight (summonCooldown 18s) would
 * stack husks forever and walk the 10Hz NPC tick up with minion BT/astar cost.
 */
const MAX_HUSKS = 8;
/** Fire-pool damage cadence (seconds). poolTick is therefore ~dps while inside. */
const POOL_TICK_SEC = 1.0;
/** Cap on circle telegraphs rasterized along one charge line (client keeps 12 total). */
const MAX_LINE_SAMPLES = 4;
/** Protocol cap: client/src/telegraph.ts rejects ttlMs > 5000. */
const TELEGRAPH_TTL_MAX_MS = 5000;
/** ...and r > 30. */
const TELEGRAPH_R_MAX = 30;

/** Clamp an outgoing telegraph into the client's accepted envelope. */
function wireTelegraph(
  x: number,
  y: number,
  r: number,
  ttlMs: number,
  label: string,
): NpcTelegraphEvent {
  return {
    kind: 'telegraph',
    shape: 'circle',
    x,
    y,
    r: Math.max(0.1, Math.min(TELEGRAPH_R_MAX, r)),
    ttlMs: Math.max(1, Math.min(TELEGRAPH_TTL_MAX_MS, Math.round(ttlMs))),
    label,
  };
}

/**
 * Rasterize a charge line into circles the protocol can carry.
 * `client/src/telegraph.ts` only accepts shape:'circle', so the corridor is
 * drawn as a chain of circles plus the exact landing circle (which is the same
 * radius the impact `damage` event uses). Samples are spaced 2r apart so the
 * chain has no gaps, capped at MAX_LINE_SAMPLES to stay inside the client's
 * 12-telegraph ring buffer.
 */
function lineTelegraphs(e: Extract<BossEvent, { kind: 'charge' }>): NpcTelegraphEvent[] {
  const out: NpcTelegraphEvent[] = [];
  const r = Math.max(0.6, e.width / 2 + 0.25);
  const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (len > 1e-6) {
    const n = Math.min(MAX_LINE_SAMPLES, Math.max(1, Math.ceil(len / (2 * r))));
    // Skip t=1: the landing circle below covers the end of the corridor.
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      out.push(wireTelegraph(e.x1 + (e.x2 - e.x1) * t, e.y1 + (e.y2 - e.y1) * t, r, e.ttlMs, e.label));
    }
  }
  out.push(wireTelegraph(e.x2, e.y2, e.width + 1.0, e.ttlMs, e.label));
  return out;
}

// NPC/boss ids live in [NPC_ID_MIN, NPC_ID_MAX] (see game/mobs.ts namespaces);
// spawner mobs live at >= 1_000_000, players at small ints — no collisions.
let nextNpcId = NPC_ID_MIN + 1;

/** Reset id counter (tests only). */
export function _resetNpcIds(): void {
  nextNpcId = NPC_ID_MIN + 1;
}

function allocNpcId(): number {
  if (nextNpcId > NPC_ID_MAX) throw new Error('[npc] NPC id namespace exhausted');
  return nextNpcId++;
}

export class NPCManager {
  private minions = new Map<number, Minion>();
  /** Living crypt-husk adds (Warden). Bounded by MAX_HUSKS. */
  private husks = 0;
  /** All boss controllers, awake or dormant. Order is snapshot order. */
  private bosses: BossEntry[] = [];
  private pools: FirePool[] = [];
  private hash = new SpatialHash();
  /** Open arena with walled border; shared by all astar queries. */
  private grid: number[][];
  /** Authoritative walls.json rects for the LoS leg (empty = open arena). */
  private walls: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** Noises queued since the last tick (attacks via damageFromPlayer + notifyNoise). */
  private noises: Array<{ x: number; y: number }> = [];
  /** Downed/finish/stun events queued by damageFromPlayer, drained by tick(). */
  private pending: NpcEvent[] = [];
  /** Last-tick player positions for the moving-or-close leg of vision. */
  private lastPos = new Map<number, { x: number; y: number }>();
  /** Emote seq counter for TAUNT bubbles (client EmoteStore identity). */
  private emoteSeq = 1;

  constructor() {
    this.grid = [];
    for (let y = 0; y < GRID_N; y++) {
      const row: number[] = [];
      for (let x = 0; x < GRID_N; x++) {
        const edge = x === 0 || y === 0 || x === GRID_N - 1 || y === GRID_N - 1;
        row.push(edge ? 1 : 0);
      }
      this.grid.push(row);
    }
    const spots = [
      { x: 30, y: 30, patrol: [{ x: 30, y: 30 }, { x: 40, y: 34 }, { x: 34, y: 42 }] },
      { x: 65, y: 25, patrol: [{ x: 65, y: 25 }, { x: 72, y: 32 }, { x: 60, y: 36 }] },
      { x: 50, y: 70, patrol: [{ x: 50, y: 70 }, { x: 58, y: 66 }, { x: 44, y: 62 }] },
    ];
    spots.forEach((s, i) => this.spawnMinion(`gloomfang-${i + 1}`, s.x, s.y, s.patrol));
    // Golem/Wisp are arena fixtures (always awake, no boss loot table).
    this.bosses.push(
      this.makeBoss(new GolemBoss(80, 80), 'Stone Golem', 10, null, 80, 80, Infinity),
      this.makeBoss(new WispBoss(20, 80), 'Void Wisp', 8, null, 20, 80, Infinity),
    );
    // Late-game bosses spawn lazily: dormant until a player enters BOSS_WAKE_RANGE
    // of the anchor, so idle shards pay nothing for them.
    this.bosses.push(
      this.makeBoss(new EmberWyrmBoss(86, 16), 'Ember Wyrm', 8, 'ember-wyrm', 86, 16, BOSS_WAKE_RANGE),
      this.makeBoss(new CryptWardenBoss(14, 86), 'Crypt Warden', 5, 'crypt-warden', 14, 86, BOSS_WAKE_RANGE),
    );
  }

  private makeBoss(
    ctl: BossCtl,
    name: string,
    level: number,
    bossName: BossName | null,
    homeX: number,
    homeY: number,
    wakeRange: number,
  ): BossEntry {
    return {
      ctl,
      id: allocNpcId(),
      name,
      level,
      bossName,
      home: { x: homeX, y: homeY },
      wakeRange,
      dormant: wakeRange !== Infinity,
      deadT: 0,
      lastHitBy: 0,
      downedUntil: 0,
      stunUntil: 0,
    };
  }

  /** Reset a boss to its anchor and go dormant (post-death or on construction). */
  private resetBoss(b: BossEntry): void {
    b.ctl.x = b.home.x;
    b.ctl.y = b.home.y;
    b.ctl.hp = b.ctl.maxHp;
    b.ctl.phase = 'chase';
    b.deadT = 0;
    b.lastHitBy = 0;
    b.downedUntil = 0;
    b.stunUntil = 0;
  }

  // ------------------------------------------------------------- spawning
  spawnMinion(name: string, x: number, y: number, patrol: Array<{ x: number; y: number }>): number {
    return this.makeMinion('gloomfang', name, x, y, patrol, 60);
  }

  /**
   * Warden add: a husk with a tiny two-point leash so it walks to the fight and
   * back to its spawn. Deliberately weak (HUSK_HP) — adds are chip damage, and
   * their total HP is part of the Warden's TTK budget (see docs/WORLD.md).
   */
  private spawnHusk(x: number, y: number): number {
    if (this.husks >= MAX_HUSKS) return -1;
    this.husks++;
    return this.makeMinion(
      'crypt-husk',
      'crypt-husk',
      x,
      y,
      [{ x, y }, { x: x + 2, y: y + 2 }],
      HUSK_HP,
    );
  }

  private makeMinion(
    kind: NPCKind,
    name: string,
    x: number,
    y: number,
    patrol: Array<{ x: number; y: number }>,
    maxHp: number,
  ): number {
    const id = allocNpcId();
    const bb = new Blackboard();
    // Deterministic stagger (was Math.random): derived from id so sims stay reproducible.
    const stagger = ((Math.imul(id, 2654435761) >>> 0) % 1000) / 1000;
    // Initial facing: toward the second patrol waypoint (first is home).
    const wp1 = patrol[1] ?? patrol[0];
    const facing = wp1 ? Math.atan2(wp1.y - y, wp1.x - x) : 0;
    const m: Minion = {
      id, kind, name, x, y,
      hp: maxHp, maxHp,
      fsm: new NPCFSM('idle', 1.5 + stagger * 1.0),
      bt: this.buildMinionBT(bb),
      bb,
      patrol, patrolIdx: 0, path: [], repathT: stagger * 0.5,
      attackCd: 0, deadT: 0,
      facing,
      lastSeen: null, searchPts: [], searchIdx: 0, noiseAt: null,
      taunted: false, surrenderRolled: false, surrenderBroken: false,
      hitWhileSurrendered: false,
      rng: mulberry32((Math.imul(id, 2654435761) ^ 0x9e3779b9) >>> 0),
      downedUntil: 0,
      stunUntil: 0,
    };
    this.minions.set(id, m);
    return id;
  }

  /** Minion BT. Blackboard keys in: hp/maxHp/dist/attackRange/aggroRange/visible. Out: `act`. */
  private buildMinionBT(bb: Blackboard): BTNode {
    void bb;
    return selector(
      'root',
      sequence(
        'dead?',
        condition('is-dead', (b) => (b.get<number>('hp') ?? 1) <= 0),
        action('die', (b) => { b.set('act', 'die'); return 'success'; }),
      ),
      sequence(
        'flee?',
        condition('low-hp', (b) => {
          const hp = b.get<number>('hp') ?? 1;
          const max = b.get<number>('maxHp') ?? 1;
          return max > 0 && hp / max <= 0.25 && (b.get<boolean>('visible') ?? false);
        }),
        action('flee', (b) => { b.set('act', 'flee'); return 'success'; }),
      ),
      sequence(
        'strike?',
        condition('in-range', (b) => (b.get<number>('dist') ?? Infinity) <= (b.get<number>('attackRange') ?? 1.8)),
        action('attack', (b) => { b.set('act', 'attack'); return 'success'; }),
      ),
      sequence(
        'pursue?',
        condition('seen', (b) => b.get<boolean>('visible') ?? false),
        action('chase', (b) => { b.set('act', 'chase'); return 'success'; }),
      ),
      action('patrol', (b) => { b.set('act', 'patrol'); return 'success'; }),
    );
  }

  // ------------------------------------------------------------- combat io
  /**
   * Install the authoritative walls.json rects for the LoS leg of vision
   * (mirrors what sim.setWalls() holds). Empty by default (open arena).
   */
  setWalls(walls: Array<{ x: number; y: number; w: number; h: number }>): void {
    this.walls = walls.map((w) => ({ ...w }));
  }

  /**
   * Queue a heard noise (gunshots, explosions, other loud systems).
   * Patrol/idle minions within NOISE_RADIUS turn toward it (SUSPICIOUS).
   * Player melee attacks queue automatically via damageFromPlayer.
   */
  notifyNoise(x: number, y: number): void {
    this.noises.push({ x, y });
    if (this.noises.length > MAX_NOISES) this.noises.splice(0, this.noises.length - MAX_NOISES);
  }

  /** Observable minion state for tests/debug (copies, safe to retain). */
  debugMinion(id: number): MinionDebug | undefined {
    const m = this.minions.get(id);
    if (!m) return undefined;
    return {
      id: m.id, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp,
      state: m.fsm.state, facing: m.facing,
      lastSeen: m.lastSeen ? { ...m.lastSeen } : null,
      searchPts: m.searchPts.map((p) => ({ ...p })),
    };
  }

  /** Living minion ids (spawn order) — tests use this to find subjects. */
  minionIds(): number[] {
    return [...this.minions.keys()];
  }

  /**
   * Player basic attack: nearest NPC within 3u takes `amount` dmg. Returns the
   * hit id or -1. `attackerId` credits the hit (boss-kill payout). Boss hits go
   * through damageBoss() so the Warden's shield actually blocks them.
   *
   * Lethal hits knock the target DOWNED (3s crawl) instead of killing it; a
   * follow-up melee swing on the downed target finishes it (minions emit
   * `mob-die`, bosses emit `boss-kill` on the next tick). Ranged swings
   * (`opts.ranged`) knock down but NEVER finish — they return -1 on a downed
   * target, so the killer must walk up. Pass `opts.now` in tests for a
   * deterministic clock (defaults to Date.now()).
   *
   * Every swing is loud: the attack position is queued as noise (even on a
   * miss), so nearby patrols turn toward gunfire/melee within NOISE_RADIUS.
   * Hitting a surrendered mob breaks the surrender (it still takes damage).
   */
  damageFromPlayer(
    x: number,
    y: number,
    amount = 12,
    attackerId = 0,
    opts: { ranged?: boolean; now?: number } = {},
  ): number {
    this.notifyNoise(x, y);
    const now = opts.now ?? Date.now();
    const ranged = opts.ranged ?? false;
    let best = -1;
    let bd = 3.0;
    for (const m of this.minions.values()) {
      // Downed minions (0 HP, crawl timer running) stay targetable so a melee
      // swing can finish them; true corpses are skipped.
      if (m.hp <= 0 && m.downedUntil <= now) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bd) { bd = d; best = m.id; }
    }
    for (const b of this.bosses) {
      if (b.dormant) continue;
      if (b.ctl.dead && b.downedUntil <= now) continue;
      const d = Math.hypot(b.ctl.x - x, b.ctl.y - y);
      if (d < bd) { bd = d; best = b.id; }
    }
    if (best < 0) return -1;
    const m = this.minions.get(best);
    if (m) {
      // FINISH branch: melee only, on a downed minion.
      if (m.downedUntil > now) {
        if (ranged) return -1;
        m.downedUntil = 0;
        m.stunUntil = 0;
        this.pending.push({ kind: 'mob-die', id: m.id, killedBy: attackerId, finisher: true });
        if (m.fsm.state === 'surrender') m.hitWhileSurrendered = true;
        return best;
      }
      m.hp = Math.max(0, m.hp - amount);
      if (m.fsm.state === 'surrender' && m.hp >= 0) m.hitWhileSurrendered = true;
      if (m.hp <= 0) {
        m.downedUntil = now + DOWNED_DURATION_MS;
        this.pending.push({ kind: 'mob-downed', id: m.id, name: m.name, x: m.x, y: m.y, downedUntil: m.downedUntil });
      }
      return best;
    }
    const boss = this.bosses.find((b) => b.id === best);
    if (!boss) return -1;
    // FINISH branch: melee only, on a downed boss (hp already 0; the next
    // tick's updateBossSpawns emits the `boss-kill`).
    if (boss.downedUntil > now) {
      if (ranged) return -1;
      boss.downedUntil = 0;
      boss.stunUntil = 0;
      if (attackerId > 0) boss.lastHitBy = attackerId;
      return best;
    }
    if (damageBoss(boss.ctl, amount) > 0 && attackerId > 0) boss.lastHitBy = attackerId;
    if (boss.ctl.hp <= 0 && boss.downedUntil <= now) {
      boss.downedUntil = now + DOWNED_DURATION_MS;
      this.pending.push({
        kind: 'mob-downed', id: boss.id, name: boss.name,
        x: boss.ctl.x, y: boss.ctl.y, downedUntil: boss.downedUntil,
      });
    }
    return best;
  }

  /** True while the NPC (minion or boss) is downed right now. */
  isNpcDowned(id: number, nowMs: number = Date.now()): boolean {
    const m = this.minions.get(id);
    if (m) return m.downedUntil > nowMs;
    const b = this.bosses.find((e) => e.id === id);
    return !!b && b.downedUntil > nowMs;
  }

  /**
   * Stun an NPC until `untilMs` (thrown sidearms). Stunned fighters hold
   * still and cannot attack. Returns false for unknown ids.
   */
  stunNpc(id: number, untilMs: number): boolean {
    const m = this.minions.get(id);
    if (m) {
      if (m.hp <= 0) return false;
      m.stunUntil = untilMs;
      this.pending.push({ kind: 'mob-stun', id, until: untilMs });
      return true;
    }
    const b = this.bosses.find((e) => e.id === id);
    if (!b || b.dormant || b.ctl.dead) return false;
    b.stunUntil = untilMs;
    this.pending.push({ kind: 'mob-stun', id, until: untilMs });
    return true;
  }

  /** Alive (non-dormant, non-corpse) bosses — snapshot + tick inclusion. */
  private awakeBosses(): BossEntry[] {
    return this.bosses.filter((b) => !b.dormant && b.deadT === 0);
  }

  npcCount(): number {
    return this.minions.size + this.awakeBosses().length;
  }

  // ----------------------------------------------------------------- tick
  /**
   * Advance AI by dt (call at 10Hz). Returns damage/telegraph/boss-kill
   * events plus TAUNT `emote` bubbles (first acquisition) and `surrender`
   * events. index.ts forwards unknown kinds as `{t:'event'}` payloads, so
   * no protocol change was needed.
   */
  tick(dt: number, players: PlayerView[], nowMs: number = Date.now()): NpcEvent[] {
    const ev: NpcEvent[] = [];
    // Damage-path events (downed/finish/stun) queued since the last tick go
    // out first so the client learns the crawl state within one 10Hz step.
    if (this.pending.length > 0) {
      ev.push(...this.pending);
      this.pending.length = 0;
    }
    const targets = players.filter((p) => p.hp > 0 && (p.spawnProtectedUntil ?? 0) <= nowMs);

    this.updateBossSpawns(dt, targets, ev, nowMs);

    // rebuild spatial hash: players + minions + awake bosses
    const pos = new Map<number, { x: number; y: number }>();
    for (const p of players) if (p.hp > 0) pos.set(p.id, { x: p.x, y: p.y });
    for (const m of this.minions.values()) pos.set(m.id, { x: m.x, y: m.y });
    for (const b of this.awakeBosses()) pos.set(b.id, { x: b.ctl.x, y: b.ctl.y });
    this.hash.rebuild(pos);
    const byId = new Map(players.map((p) => [p.id, p]));

    // Target speeds for the moving-or-close leg of vision. Caller velocity
    // wins; otherwise per-tick position deltas; first sighting reads as
    // still (0) so sneaking works immediately.
    const speeds = new Map<number, number>();
    const step = dt > 0 ? dt : 0.1;
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
    }
    for (const p of players) this.lastPos.set(p.id, { x: p.x, y: p.y });
    for (const id of [...this.lastPos.keys()]) {
      if (!byId.has(id)) this.lastPos.delete(id);
    }

    for (const m of this.minions.values()) {
      if (m.hp <= 0) {
        // DOWNED crawl: hold still, no BT/FSM, no death timer. The corpse
        // timer only runs for true deaths (downed flag cleared by a finish).
        if (m.downedUntil > nowMs) continue;
        if (m.downedUntil !== 0) {
          // Unanswered knockdown: stand back up at partial HP, never bleed out.
          m.hp = Math.max(1, Math.ceil(m.maxHp * DOWNED_RECOVER_FRAC));
          m.downedUntil = 0;
          m.deadT = 0;
          m.surrenderRolled = false;
          m.hitWhileSurrendered = false;
          m.fsm.force('idle');
          ev.push({ kind: 'mob-up', id: m.id });
          continue;
        }
        m.fsm.force('dead');
        m.deadT += dt;
        if (m.deadT > 5) {
          // Adds are temporary: they leave the world instead of respawning so a
          // long Warden fight can't stack husks (see MAX_HUSKS).
          if (m.kind === 'crypt-husk') {
            this.minions.delete(m.id);
            this.husks = Math.max(0, this.husks - 1);
          } else {
            this.respawn(m);
          }
        }
        continue;
      }
      // STUNNED (thrown sidearm): hold still — no sensing, no attacks — until
      // the timer lapses. The crawl/death branch above already ran.
      if (m.stunUntil > nowMs) continue;
      // Sight range follows the zone underfoot (12u dungeon/volcano, 14u open).
      const range = visionRangeAt(m.x, m.y);
      // ALERT (chase/attack) and SEARCH track by cone+LoS+range only; calm
      // states additionally need the target moving-or-close (sneak works).
      const alert = m.fsm.state === 'chase' || m.fsm.state === 'attack';
      const sweeping = m.fsm.state === 'search';
      const ids = this.hash.near(m.x, m.y, AGGRO_RANGE * 2.5);
      let target: PlayerView | null = null;
      let bd = Infinity;
      for (const id of ids) {
        const p = byId.get(id);
        if (!p || p.hp <= 0) continue;
        // PLAYABILITY: spawn-protected players are untargetable (no aggro).
        if ((p.spawnProtectedUntil ?? 0) > nowMs) continue;
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d >= bd || d > range) continue;
        const q = {
          nx: m.x, ny: m.y, facing: m.facing, tx: p.x, ty: p.y, range,
          grid: this.grid, walls: this.walls, cell: CELL,
          targetSpeed: speeds.get(p.id) ?? 0,
        };
        if (alert || sweeping ? canTrack(q) : canDetect(q)) {
          bd = d;
          target = p;
        }
      }
      const visible = target !== null;
      const distT = target ? bd : Infinity;
      if (target) m.lastSeen = { x: target.x, y: target.y };

      // PLAYABILITY (leash): kited past LEASH_RANGE from the patrol anchor,
      // drop the target — the FSM below falls back to patrol and walks home
      // instead of camping spawn. Checked every tick so the return starts at
      // once rather than after the 6s search sweep.
      const home = m.patrol[0] ?? { x: m.x, y: m.y };
      const leashed = Math.hypot(m.x - home.x, m.y - home.y) > LEASH_RANGE;
      let effVisible = visible;
      let effDistT = distT;
      let effTarget: PlayerView | null = target;
      if (leashed) {
        effVisible = false;
        effDistT = Infinity;
        effTarget = null;
      }

      // Noise: calm minions within earshot turn toward the shot.
      let heardNoise = false;
      if (m.fsm.state === 'patrol' || m.fsm.state === 'idle') {
        for (const n of this.noises) {
          if (Math.hypot(n.x - m.x, n.y - m.y) <= NOISE_RADIUS) {
            heardNoise = true;
            m.noiseAt = { x: n.x, y: n.y };
            break;
          }
        }
        if (!heardNoise) m.noiseAt = null;
      }

      // Surrender election: solo + <=25% HP rolls once per life (40%).
      const hpFrac = m.maxHp > 0 ? m.hp / m.maxHp : 0;
      if (hpFrac > SURRENDER_HP_FRAC) m.surrenderRolled = false;
      let wantSurrender = false;
      if (!m.surrenderRolled && !m.surrenderBroken && hpFrac <= SURRENDER_HP_FRAC) {
        let allies = false;
        for (const o of this.minions.values()) {
          if (o.id === m.id || o.hp <= 0) continue;
          if (Math.hypot(o.x - m.x, o.y - m.y) <= ALLY_RADIUS) {
            allies = true;
            break;
          }
        }
        m.surrenderRolled = true;
        wantSurrender = shouldSurrender(m.hp, m.maxHp, allies, m.rng());
      }

      // BT action selection
      m.bb.set('hp', m.hp);
      m.bb.set('maxHp', m.maxHp);
      m.bb.set('dist', effVisible ? effDistT : Infinity);
      m.bb.set('attackRange', ATTACK_RANGE);
      m.bb.set('aggroRange', range);
      m.bb.set('visible', effVisible);
      m.bt.reset();
      m.bt.tick(m.bb);

      // FSM locomotion state (authoritative for movement/death)
      const prev = m.fsm.state;
      let st = m.fsm.update(dt, {
        hp: m.hp, maxHp: m.maxHp,
        targetVisible: effVisible, distToTarget: effVisible ? effDistT : Infinity,
        attackRange: ATTACK_RANGE, aggroRange: range, fleeThreshold: 0.25,
        heardNoise, wantSurrender, wasAttacked: m.hitWhileSurrendered,
      });
      // Leashed minions skip the 6s search sweep and walk straight home: the
      // FSM above routes chase->search on lost sight, which would comb a
      // far-off lastSeen instead of the anchor.
      if (leashed && (st === 'chase' || st === 'attack' || st === 'search')) {
        m.fsm.force('patrol');
        st = 'patrol';
        m.lastSeen = null;
        m.searchPts = [];
        m.searchIdx = 0;
        m.taunted = false;
      }

      // Entering surrender: hands-up event, hold still.
      if (prev !== 'surrender' && st === 'surrender') {
        m.hitWhileSurrendered = false;
        m.path = [];
        m.taunted = false;
        ev.push({ kind: 'surrender', id: m.id, name: m.name, x: m.x, y: m.y });
      }
      // Leaving surrender via a hit: never re-roll this life (re-aggro).
      if (prev === 'surrender' && st !== 'surrender') {
        if (m.hitWhileSurrendered) m.surrenderBroken = true;
        m.hitWhileSurrendered = false;
        m.taunted = false;
      }
      // TAUNT on first acquisition: calm -> ALERT with a target in sight.
      const wasAlert = prev === 'chase' || prev === 'attack';
      const nowAlert = st === 'chase' || st === 'attack';
      if (!wasAlert && nowAlert && effTarget && !m.taunted) {
        m.taunted = true;
        m.facing = faceToward(m.x, m.y, effTarget.x, effTarget.y);
        ev.push({
          kind: 'emote', fromId: m.id, name: m.name,
          emote: 'laugh', label: 'Taunt', x: m.x, y: m.y,
          expiresAt: Date.now() + 2000, seq: this.emoteSeq++,
        });
      }
      if (!nowAlert) m.taunted = false;
      // Losing the target into SEARCH: sweep last-seen + 2 neighbors.
      if ((prev === 'chase' || prev === 'attack') && st === 'search') {
        const anchor = m.lastSeen ?? { x: m.x, y: m.y };
        m.searchPts = [
          { x: anchor.x, y: anchor.y },
          { x: Math.max(0, Math.min(WORLD, anchor.x + SEARCH_OFFSET)), y: anchor.y },
          { x: anchor.x, y: Math.max(0, Math.min(WORLD, anchor.y + SEARCH_OFFSET)) },
        ];
        m.searchIdx = 0;
      }

      m.attackCd -= dt;
      m.repathT -= dt;
      const act = (m.bb.get<string>('act') ?? 'patrol') as string;

      if (st === 'surrender') {
        // Hands up, stands still (tracks the threat with its stare).
        if (effTarget) m.facing = faceToward(m.x, m.y, effTarget.x, effTarget.y);
      } else if (st === 'suspicious') {
        // Stare toward the noise for 1.5s (the FSM stands down to patrol).
        if (m.noiseAt) m.facing = faceToward(m.x, m.y, m.noiseAt.x, m.noiseAt.y);
        else if (effTarget) m.facing = faceToward(m.x, m.y, effTarget.x, effTarget.y);
      } else if (st === 'search') {
        // Sweep last-seen + neighbors; the 6s timer returns to patrol and
        // vision re-acquires through the tracking leg while sweeping.
        const pt = m.searchPts[m.searchIdx];
        if (pt) {
          const d = Math.hypot(pt.x - m.x, pt.y - m.y);
          if (d < 1.0) {
            if (m.searchIdx < m.searchPts.length - 1) m.searchIdx++;
          } else {
            this.moveAlongPath(m, pt.x, pt.y, SEARCH_SPEED, dt);
          }
        }
      } else if (st === 'flee' || act === 'flee') {
        if (effTarget) this.moveAway(m, effTarget, 3.2, dt);
      } else if (st === 'attack' || act === 'attack') {
        if (effTarget) m.facing = faceToward(m.x, m.y, effTarget.x, effTarget.y);
        if (effTarget && effDistT <= ATTACK_RANGE + 0.4 && m.attackCd <= 0) {
          m.attackCd = MELEE_COOLDOWN;
          ev.push({ kind: 'damage-player', targetId: effTarget.id, amount: MELEE_DAMAGE, fromId: m.id });
        } else if (effTarget) {
          this.moveAlongPath(m, effTarget.x, effTarget.y, 3.5, dt);
        }
      } else if (st === 'chase' || act === 'chase') {
        if (effTarget) this.moveAlongPath(m, effTarget.x, effTarget.y, 3.5, dt);
      } else {
        // idle / patrol
        const wp = m.patrol[m.patrolIdx];
        const d = Math.hypot(wp.x - m.x, wp.y - m.y);
        if (d < 1.0) m.patrolIdx = (m.patrolIdx + 1) % m.patrol.length;
        else this.moveAlongPath(m, wp.x, wp.y, 1.5, dt);
        void act;
      }
    }
    // Noises are heard for exactly one tick (the 10Hz sense pass).
    this.noises.length = 0;

    // bosses
    for (const b of this.awakeBosses()) {
      // Thrown-sidearm stun eats the whole tick (no telegraphs, no movement).
      // Downed bosses are already inert: their controller is dead (0 HP), so
      // update() early-returns on its own.
      if (b.stunUntil > nowMs) continue;
      for (const e of b.ctl.update(dt, targets)) this.pushBossEvent(e, b, targets, ev);
      // clamp to arena
      b.ctl.x = Math.max(1, Math.min(99, b.ctl.x));
      b.ctl.y = Math.max(1, Math.min(99, b.ctl.y));
    }

    this.updatePools(dt, targets, ev);

    return ev;
  }

  /**
   * Lazy boss spawns: wake on approach, despawn after death. Emits `boss-kill`
   * exactly once per death (corpses stay visible for BOSS_CORPSE_SEC).
   *
   * Downed bosses (0 HP, crawl timer running) are NOT dead: no `boss-kill`,
   * no corpse timer. Only a melee finish (downed flag cleared by
   * damageFromPlayer) lets the death branch run. Unanswered knockdowns stand
   * back up at partial HP via `mob-up`.
   */
  private updateBossSpawns(dt: number, players: PlayerView[], ev: NpcEvent[], nowMs: number = Date.now()): void {
    for (const b of this.bosses) {
      if (b.dormant) {
        const near = players.some(
          (p) => p.hp > 0 && Math.hypot(p.x - b.home.x, p.y - b.home.y) <= b.wakeRange,
        );
        if (near) {
          this.resetBoss(b);
          b.dormant = false;
        }
        continue;
      }
      if (b.downedUntil > nowMs) continue; // crawling: not dead yet
      if (b.downedUntil !== 0) {
        // Unanswered knockdown stood back up; never bled out.
        b.ctl.hp = Math.max(1, Math.ceil(b.ctl.maxHp * DOWNED_RECOVER_FRAC));
        b.ctl.phase = 'chase';
        b.downedUntil = 0;
        ev.push({ kind: 'mob-up', id: b.id });
        continue;
      }
      if (b.deadT > 0) {
        b.deadT -= dt;
        if (b.deadT <= 0) {
          this.resetBoss(b);
          if (b.wakeRange !== Infinity) b.dormant = true;
        }
        continue;
      }
      if (b.ctl.dead) {
        b.deadT = BOSS_CORPSE_SEC;
        if (b.bossName) {
          ev.push({
            kind: 'boss-kill',
            boss: b.bossName,
            id: b.id,
            name: b.name,
            x: b.ctl.x,
            y: b.ctl.y,
            killedBy: b.lastHitBy,
            finisher: true,
          });
        }
      }
    }
  }

  /** Burn Wyrm fire pools: `tickDamage` per POOL_TICK_SEC per player inside. */
  private updatePools(dt: number, players: PlayerView[], ev: NpcEvent[]): void {
    if (this.pools.length === 0) return;
    for (const pool of this.pools) {
      pool.left -= dt * 1000;
      pool.acc += dt;
      if (pool.acc >= POOL_TICK_SEC) {
        pool.acc -= POOL_TICK_SEC;
        for (const p of players) {
          if (p.hp <= 0) continue;
          if (Math.hypot(p.x - pool.x, p.y - pool.y) <= pool.r) {
            ev.push({ kind: 'damage-player', targetId: p.id, amount: pool.tickDamage, fromId: 0 });
          }
        }
      }
    }
    // keep the newest pools so one fight can't spam the damage-player stream
    this.pools = this.pools.filter((p) => p.left > 0).slice(-8);
  }

  /** Translate one engine-agnostic boss event into wire events. */
  private pushBossEvent(
    e: BossEvent,
    b: BossEntry,
    targets: PlayerView[],
    ev: NpcEvent[],
  ): void {
    switch (e.kind) {
      case 'telegraph':
        ev.push(wireTelegraph(e.x, e.y, e.r, e.ttlMs, e.label));
        break;
      case 'charge':
        // line corridor -> circle chain (client wire accepts shape:'circle' only)
        for (const t of lineTelegraphs(e)) ev.push(t);
        break;
      case 'pool':
        this.pools.push({
          x: e.x, y: e.y, r: e.r, left: e.ttlMs,
          tickDamage: e.tickDamage, acc: 0, label: e.label,
        });
        ev.push(wireTelegraph(e.x, e.y, e.r, e.ttlMs, e.label));
        break;
      case 'summon':
        this.spawnHusk(e.x, e.y);
        ev.push(wireTelegraph(e.x, e.y, 1.2, 400, e.label));
        break;
      case 'shield':
        // immunity is server-side (takeDamage); the aura is the tell
        ev.push(wireTelegraph(b.ctl.x, b.ctl.y, 3.5, e.on ? 4000 : 400, e.label));
        break;
      case 'damage':
        for (const p of targets) {
          if (Math.hypot(p.x - e.x, p.y - e.y) <= e.r) {
            ev.push({ kind: 'damage-player', targetId: p.id, amount: e.amount, fromId: b.id });
          }
        }
        break;
      case 'damageLine': {
        const half = e.width / 2;
        for (const p of targets) {
          if (distToSegmentSq(p.x, p.y, e.x1, e.y1, e.x2, e.y2) <= half * half) {
            ev.push({ kind: 'damage-player', targetId: p.id, amount: e.amount, fromId: b.id });
          }
        }
        break;
      }
      case 'move':
      case 'blink':
        break; // position is authoritative in snapshot(), no event needed
      default:
        break;
    }
  }

  private respawn(m: Minion): void {
    const wp = m.patrol[0];
    m.x = wp.x; m.y = wp.y;
    m.hp = m.maxHp;
    m.path = []; m.deadT = 0;
    m.downedUntil = 0;
    m.stunUntil = 0;
    const wp1 = m.patrol[1] ?? m.patrol[0];
    m.facing = wp1 ? Math.atan2(wp1.y - m.y, wp1.x - m.x) : 0;
    m.lastSeen = null;
    m.searchPts = []; m.searchIdx = 0;
    m.noiseAt = null;
    m.taunted = false;
    m.surrenderRolled = false;
    m.surrenderBroken = false;
    m.hitWhileSurrendered = false;
    m.fsm.force('idle');
  }

  // -------------------------------------------------------------- movement
  private toCell(v: number): number {
    return Math.max(0, Math.min(GRID_N - 1, Math.floor(v / CELL)));
  }

  private moveAlongPath(m: Minion, tx: number, ty: number, speed: number, dt: number): void {
    if (m.repathT <= 0 || m.path.length === 0) {
      m.repathT = 0.6;
      const cells = astar(this.grid, this.toCell(m.x), this.toCell(m.y), this.toCell(tx), this.toCell(ty));
      // drop current cell, convert to world waypoints
      m.path = cells.slice(1).map(([cx, cy]) => [cx * CELL + CELL / 2, cy * CELL + CELL / 2] as [number, number]);
      if (m.path.length === 0) {
        // straight-line fallback (open arena)
        this.stepToward(m, tx, ty, speed, dt);
        return;
      }
    }
    const [wx, wy] = m.path[0];
    const d = Math.hypot(wx - m.x, wy - m.y);
    if (d < 0.6) {
      m.path.shift();
      return;
    }
    this.stepToward(m, wx, wy, speed, dt);
  }

  private stepToward(m: Minion, tx: number, ty: number, speed: number, dt: number): void {
    const d = Math.hypot(tx - m.x, ty - m.y) || 0.001;
    if (d > 1e-9) m.facing = Math.atan2(ty - m.y, tx - m.x);
    const step = Math.min(d, speed * dt);
    m.x = Math.max(0, Math.min(WORLD, m.x + ((tx - m.x) / d) * step));
    m.y = Math.max(0, Math.min(WORLD, m.y + ((ty - m.y) / d) * step));
  }

  private moveAway(m: Minion, t: PlayerView, speed: number, dt: number): void {
    const d = Math.hypot(m.x - t.x, m.y - t.y) || 0.001;
    if (d > 1e-9) m.facing = Math.atan2(m.y - t.y, m.x - t.x);
    m.x = Math.max(0, Math.min(WORLD, m.x + ((m.x - t.x) / d) * speed * dt));
    m.y = Math.max(0, Math.min(WORLD, m.y + ((m.y - t.y) / d) * speed * dt));
    m.path = [];
  }

  // -------------------------------------------------------------- snapshot
  snapshot(): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (const m of this.minions.values()) {
      if (m.hp <= 0 && m.deadT > 1) continue; // brief corpse, then hidden till respawn
      out.push({
        id: m.id, kind: 'mob', p: { x: m.x, y: m.y }, v: { x: 0, y: 0 },
        hp: m.hp, maxHp: m.maxHp, name: m.name, dir: m.facing,
      });
    }
    // Non-dormant bosses: includes the brief corpse so players can see what died
    // (loot drops as its own pickups). Corpses are not ticked or targetable.
    for (const b of this.bosses) {
      if (b.dormant) continue;
      out.push({
        id: b.id, kind: 'mob', p: { x: b.ctl.x, y: b.ctl.y }, v: { x: 0, y: 0 },
        hp: b.ctl.hp, maxHp: b.ctl.maxHp, name: b.name, level: b.level,
      });
    }
    return out;
  }
}
