// AETHERFALL AI — NPC tick (10Hz).
// Owns minions + the two bosses, drives them with FSM (locomotion state)
// + behavior trees (per-tick action selection), and uses engine
// SpatialHash (target acquisition) + astar (pathing).
// index.ts calls tick() at 10Hz and merges snapshot()/events.

import { SpatialHash, astar } from '@aetherfall/engine';
import type { EntitySnapshot } from '@aetherfall/shared';
import { NPC_ID_MAX, NPC_ID_MIN } from '../game/mobs.js';
import type { BossName } from '../game/content.js';
import { NPCFSM } from './fsm.js';
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
}
export type NpcEvent = NpcDamageEvent | NpcTelegraphEvent | NpcBossKillEvent;

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
}

const WORLD = 100; // arena bounds (matches server index.ts)
const CELL = 2; // path grid resolution (world units per cell)
const GRID_N = Math.ceil(WORLD / CELL); // 50x50
const ATTACK_RANGE = 1.8;
const AGGRO_RANGE = 14;
const MELEE_DAMAGE = 8;
const MELEE_COOLDOWN = 1.0;

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
    const m: Minion = {
      id, kind, name, x, y,
      hp: maxHp, maxHp,
      fsm: new NPCFSM('idle', 1.5 + stagger * 1.0),
      bt: this.buildMinionBT(bb),
      bb,
      patrol, patrolIdx: 0, path: [], repathT: stagger * 0.5,
      attackCd: 0, deadT: 0,
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
   * Player basic attack: nearest NPC within 3u takes `amount` dmg. Returns the
   * hit id or -1. `attackerId` credits the hit (boss-kill payout). Boss hits go
   * through damageBoss() so the Warden's shield actually blocks them.
   */
  damageFromPlayer(x: number, y: number, amount = 12, attackerId = 0): number {
    let best = -1;
    let bd = 3.0;
    for (const m of this.minions.values()) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bd) { bd = d; best = m.id; }
    }
    for (const b of this.bosses) {
      if (b.dormant || b.ctl.dead) continue;
      const d = Math.hypot(b.ctl.x - x, b.ctl.y - y);
      if (d < bd) { bd = d; best = b.id; }
    }
    if (best < 0) return -1;
    const m = this.minions.get(best);
    if (m) {
      m.hp = Math.max(0, m.hp - amount);
      return best;
    }
    const boss = this.bosses.find((b) => b.id === best);
    if (!boss) return -1;
    if (damageBoss(boss.ctl, amount) > 0 && attackerId > 0) boss.lastHitBy = attackerId;
    return best;
  }

  /** Alive (non-dormant, non-corpse) bosses — snapshot + tick inclusion. */
  private awakeBosses(): BossEntry[] {
    return this.bosses.filter((b) => !b.dormant && b.deadT === 0);
  }

  npcCount(): number {
    return this.minions.size + this.awakeBosses().length;
  }

  // ----------------------------------------------------------------- tick
  /** Advance AI by dt (call at 10Hz). Returns damage/telegraph/boss-kill events. */
  tick(dt: number, players: PlayerView[]): NpcEvent[] {
    const ev: NpcEvent[] = [];
    const targets = players.filter((p) => p.hp > 0);

    this.updateBossSpawns(dt, targets, ev);

    // rebuild spatial hash: players + minions + awake bosses
    const pos = new Map<number, { x: number; y: number }>();
    for (const p of players) if (p.hp > 0) pos.set(p.id, { x: p.x, y: p.y });
    for (const m of this.minions.values()) pos.set(m.id, { x: m.x, y: m.y });
    for (const b of this.awakeBosses()) pos.set(b.id, { x: b.ctl.x, y: b.ctl.y });
    this.hash.rebuild(pos);
    const byId = new Map(players.map((p) => [p.id, p]));

    for (const m of this.minions.values()) {
      if (m.hp <= 0) {
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
      // acquire nearest living player via spatial hash
      const ids = this.hash.near(m.x, m.y, AGGRO_RANGE * 2.5);
      let target: PlayerView | null = null;
      let bd = Infinity;
      for (const id of ids) {
        const p = byId.get(id);
        if (!p || p.hp <= 0) continue;
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < bd) { bd = d; target = p; }
      }
      const visible = !!target && bd <= AGGRO_RANGE;
      const distT = target ? bd : Infinity;

      // BT action selection
      m.bb.set('hp', m.hp);
      m.bb.set('maxHp', m.maxHp);
      m.bb.set('dist', visible ? distT : Infinity);
      m.bb.set('attackRange', ATTACK_RANGE);
      m.bb.set('aggroRange', AGGRO_RANGE);
      m.bb.set('visible', visible);
      m.bt.reset();
      m.bt.tick(m.bb);

      // FSM locomotion state (authoritative for movement/death)
      const st = m.fsm.update(dt, {
        hp: m.hp, maxHp: m.maxHp,
        targetVisible: visible, distToTarget: visible ? distT : Infinity,
        attackRange: ATTACK_RANGE, aggroRange: AGGRO_RANGE, fleeThreshold: 0.25,
      });

      m.attackCd -= dt;
      m.repathT -= dt;
      const act = (m.bb.get<string>('act') ?? 'patrol') as string;

      if (st === 'flee' || act === 'flee') {
        if (target) this.moveAway(m, target, 3.2, dt);
      } else if (st === 'attack' || act === 'attack') {
        if (target && distT <= ATTACK_RANGE + 0.4 && m.attackCd <= 0) {
          m.attackCd = MELEE_COOLDOWN;
          ev.push({ kind: 'damage-player', targetId: target.id, amount: MELEE_DAMAGE, fromId: m.id });
        } else if (target) {
          this.moveAlongPath(m, target.x, target.y, 3.5, dt);
        }
      } else if (st === 'chase' || act === 'chase') {
        if (target) this.moveAlongPath(m, target.x, target.y, 3.5, dt);
      } else {
        // idle / patrol
        const wp = m.patrol[m.patrolIdx];
        const d = Math.hypot(wp.x - m.x, wp.y - m.y);
        if (d < 1.0) m.patrolIdx = (m.patrolIdx + 1) % m.patrol.length;
        else this.moveAlongPath(m, wp.x, wp.y, 1.5, dt);
        void act;
      }
    }

    // bosses
    for (const b of this.awakeBosses()) {
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
   */
  private updateBossSpawns(dt: number, players: PlayerView[], ev: NpcEvent[]): void {
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
    const step = Math.min(d, speed * dt);
    m.x = Math.max(0, Math.min(WORLD, m.x + ((tx - m.x) / d) * step));
    m.y = Math.max(0, Math.min(WORLD, m.y + ((ty - m.y) / d) * step));
  }

  private moveAway(m: Minion, t: PlayerView, speed: number, dt: number): void {
    const d = Math.hypot(m.x - t.x, m.y - t.y) || 0.001;
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
        hp: m.hp, maxHp: m.maxHp, name: m.name,
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
