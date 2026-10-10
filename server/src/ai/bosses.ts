// AETHERFALL AI — boss controllers.
// Four bosses, all telegraphed (fair) and deterministic:
//   Stone Golem  — slow chase + periodic AOE slam (circle telegraph).
//   Void Wisp    — fast drift + blink to a flank spot, then radial burst.
//   Ember Wyrm   — volcano: chase + charge dash (line telegraph) leaving fire pools.
//   Crypt Warden — dungeon: slow chase + slam, summons 2 husks, shield phases.
// Controllers are engine-agnostic: update(dt, targets) returns events;
// npc.ts applies movement + damage and broadcasts telegraphs to clients.
//
// Every controller also owns a `BossBrain` (roost + aggro radius + leash +
// sticky target). Without it a boss acquired the nearest living player
// anywhere on the 100x100 map and never gave up: the Stone Golem left its
// (80,80) roost on the first login and stood next to a player 106u away
// forever. `reset()` (new life) and `resetPhase()` (knockdown stand-up) put
// that state back — see `npc.ts` BossManager.

export type BossKind = 'golem' | 'wisp' | 'ember-wyrm' | 'crypt-warden';

export interface BossTarget {
  id: number;
  x: number;
  y: number;
  hp: number;
}

export type BossEvent =
  | {
      kind: 'telegraph';
      shape: 'circle';
      x: number;
      y: number;
      r: number;
      /** ms the telegraph stays visible before the hit lands */
      ttlMs: number;
      label: string;
    }
  | { kind: 'damage'; x: number; y: number; r: number; amount: number }
  // Capsule hit (segment x1,y1 -> x2,y2 inflated by width/2) — the Wyrm's dash.
  // Separate from `damage` so the circle-slam/impact code path is untouched.
  | {
      kind: 'damageLine';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      amount: number;
    }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'blink'; fromX: number; fromY: number; toX: number; toY: number }
  // New-boss events (additive; golem/wisp never emit these, so npc.ts and the
  // protocol-v1 telegraph broadcast are untouched):
  //   charge — line telegraph for the Wyrm's dash (render like a telegraph).
  //   pool   — lingering fire zone; consumers apply tickDamage while inside.
  //   summon — one event per spawned add.
  //   shield — damage-immunity window on/off (route hits via takeDamage()).
  | {
      kind: 'charge';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      /** ms the line stays visible before the dash lands */
      ttlMs: number;
      label: string;
    }
  | {
      kind: 'pool';
      x: number;
      y: number;
      r: number;
      /** ms the pool burns */
      ttlMs: number;
      tickDamage: number;
      label: string;
    }
  | { kind: 'summon'; name: string; x: number; y: number; label: string }
  | { kind: 'shield'; on: boolean; label: string };

export interface BossSnapshot {
  kind: BossKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  phase: string;
}

/** Every boss controller (all expose x/y/hp/maxHp/dead + update()). */
export type BossCtl = GolemBoss | WispBoss | EmberWyrmBoss | CryptWardenBoss;

/** Uniform shape every controller exposes (union member narrowing helper). */
type CommonCtl = {
  dead: boolean;
  hp: number;
  x: number;
  y: number;
  reset(): void;
  resetPhase(): void;
  takeDamage?(amount: number): number;
};

/**
 * Uniform damage entry point for any boss kind. Shield-aware kinds implement
 * takeDamage() and return 0 while immune; the rest take plain HP off. Returns
 * the HP actually removed so callers can credit the hit (boss-kill) correctly.
 */
export function damageBoss(b: BossCtl, amount: number): number {
  const c = b as unknown as CommonCtl;
  if (c.dead || amount <= 0) return 0;
  const before = c.hp;
  if (typeof c.takeDamage === 'function') {
    c.takeDamage(amount);
  } else {
    c.hp = Math.max(0, c.hp - amount);
  }
  // Report the HP that actually left the bar, not the number asked for: the
  // Warden used to return `amount` verbatim, so a 99999 swing against a
  // 2200 HP boss claimed 99999 and mis-credited the kill.
  return before - c.hp;
}

/** Squared distance from point (px,py) to segment (x1,y1)-(x2,y2). */
export function distToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return (px - x1) ** 2 + (py - y1) ** 2;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

const dist = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(ax - bx, ay - by);

/**
 * Nearest *engageable* player: alive and no further than `maxRange`. The
 * old `nearest()` had no range argument at all, which is how a boss roosted
 * in one corner ended up walking 100+ units to the far side of the map.
 * Callers still pass `Infinity` when they deliberately want map-wide reach
 * (no boss does).
 */
function nearestInRange(
  x: number,
  y: number,
  targets: BossTarget[],
  maxRange: number,
): BossTarget | null {
  let best: BossTarget | null = null;
  let bd = Infinity;
  for (const t of targets) {
    if (t.hp <= 0) continue;
    const d = dist(x, y, t.x, t.y);
    if (d > maxRange) continue;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/** Same, but keeps the id the boss is already fighting if it stays valid. */
function nearestSticky(
  x: number,
  y: number,
  targets: BossTarget[],
  maxRange: number,
  holdId: number,
): { target: BossTarget | null; hold: number } {
  let best: BossTarget | null = null;
  let bd = Infinity;
  let held: BossTarget | null = null;
  for (const t of targets) {
    if (t.hp <= 0) continue;
    const d = dist(x, y, t.x, t.y);
    if (d > maxRange) continue;
    if (t.id === holdId) held = t;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  if (held) return { target: held, hold: held.id };
  return { target: best, hold: best ? best.id : 0 };
}

/**
 * Shared roster-keeping for a boss: where it lives, how far it will stray, and
 * who it is currently fighting.
 *
 * The controllers are pure state machines driven by `update(dt, targets)` with
 * no knowledge of the world around them, so the *roost* (the anchor the boss
 * must return to), the *aggro radius* (how far it will notice a player) and the
 * *sticky target* all live here. Without it a boss chased a target off the
 * edge of the map and, once the target vanished, simply stood there forever in
 * `chase` at the far corner — the "boss abandons its roost and never comes
 * back" bug.
 *
 * `resetBoss()` in npc.ts already had the roost (`BossEntry.home`); this
 * mirrors it inside the controller so `update()` can enforce the leash itself.
 */
export interface BossBrainConfig {
  homeX?: number;
  homeY?: number;
  /** How far from its CURRENT position a player may be and still be chased. */
  aggroRange?: number;
  /** How far from the ROOST the boss may be dragged before it disengages. */
  leashRange?: number;
}

/**
 * Defaults chosen against `engine/src/spawn-anchors.ts`:
 *   * `aggroRange` (32) is deliberately LARGER than `BOSS_WAKE_RANGE` (30) in
 *     npc.ts, so a lazily-spawned boss that woke on approach can always
 *     actually reach the player who woke it — otherwise a player standing on
 *     the exact edge of the wake disc could wake a boss that then stood still
 *     forever (awake, burning tick budget, engaging nobody). It is also larger
 *     than `SPAWN_SAFE_RADIUS` (12) so no boss can camp a fresh login, and
 *     smaller than `leashRange` so a target that breaks contact cleanly drops.
 *   * `leashRange` (40) is the arena-fixture golem/wisp leash: they used to
 *     have none, so a player could drag the Stone Golem 106 units from its
 *     (80,80) roost and leave it parked there for the rest of the shard's
 *     life. 40u keeps a boss fight inside its own corner of the 100x100 arena.
 */
export const DEFAULT_BOSS_AGGRO_RANGE = 32;
export const DEFAULT_BOSS_LEASH_RANGE = 40;

export class BossBrain {
  homeX: number;
  homeY: number;
  readonly aggroRange: number;
  readonly leashRange: number;
  /** Id of the player currently being fought; 0 = nobody. */
  hold = 0;

  constructor(x: number, y: number, cfg: BossBrainConfig = {}) {
    this.homeX = cfg.homeX ?? x;
    this.homeY = cfg.homeY ?? y;
    this.aggroRange = cfg.aggroRange ?? DEFAULT_BOSS_AGGRO_RANGE;
    this.leashRange = cfg.leashRange ?? DEFAULT_BOSS_LEASH_RANGE;
  }

  /** Distance from the roost. */
  homeDist(x: number, y: number): number {
    return dist(x, y, this.homeX, this.homeY);
  }

  /** True once the fight has been dragged past the leash. */
  leashed(x: number, y: number): boolean {
    return this.homeDist(x, y) > this.leashRange;
  }

  /** Reset between lives (respawn) and on knockdown stand-up. */
  reset(x: number, y: number): void {
    this.hold = 0;
    this.homeX = x;
    this.homeY = y;
  }
}

/**
 * Step a boss `step` units toward a point, never overshooting. Returns true
 * when it actually moved (so callers only emit a `move` event when the
 * authoritative position changed).
 */
function stepToward(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  step: number,
): { x: number; y: number; moved: boolean } {
  const d = dist(fromX, fromY, toX, toY);
  if (d <= 1e-6 || step <= 0) return { x: fromX, y: fromY, moved: false };
  const s = Math.min(d, step);
  return { x: fromX + ((toX - fromX) / d) * s, y: fromY + ((toY - fromY) / d) * s, moved: true };
}

// ---------------------------------------------------------------- Golem ---

export interface GolemConfig {
  maxHp?: number;
  speed?: number;
  slamRadius?: number;
  slamDamage?: number;
  slamCooldown?: number;
  windupMs?: number;
  recoverSec?: number;
  brain?: BossBrainConfig;
}

type GolemPhase = 'chase' | 'windup' | 'recover' | 'return';

/** Distance the golem drifts from home before it breaks off and walks back. */
const GOLEM_LEASH = 40;

/** Stone Golem: lumbers at the nearest player, slams the ground (AOE). */
export class GolemBoss {
  readonly kind: BossKind = 'golem';
  x: number;
  y: number;
  hp: number;
  readonly maxHp: number;
  readonly speed: number;
  readonly slamRadius: number;
  readonly slamDamage: number;
  readonly slamCooldown: number;
  readonly windupMs: number;
  readonly recoverSec: number;
  /** Roost / aggro / leash bookkeeping (shared BossBrain, see bosses.ts). */
  readonly brain: BossBrain;

  phase: GolemPhase = 'chase';
  private cd = 2.0; // first slam comes early so players learn it
  private windupT = 0;
  private recoverT = 0;
  private slamX = 0;
  private slamY = 0;

  constructor(x: number, y: number, cfg: GolemConfig = {}) {
    this.x = x;
    this.y = y;
    this.maxHp = cfg.maxHp ?? 400;
    this.hp = this.maxHp;
    this.speed = cfg.speed ?? 2.2;
    this.slamRadius = cfg.slamRadius ?? 4.5;
    this.slamDamage = cfg.slamDamage ?? 25;
    this.slamCooldown = cfg.slamCooldown ?? 4.0;
    this.windupMs = cfg.windupMs ?? 900;
    this.recoverSec = cfg.recoverSec ?? 1.2;
    this.brain = new BossBrain(x, y, { leashRange: GOLEM_LEASH, ...cfg.brain });
  }

  get dead(): boolean {
    return this.hp <= 0;
  }

  get enraged(): boolean {
    return this.hp < this.maxHp * 0.3;
  }

  snapshot(): BossSnapshot {
    return { kind: this.kind, x: this.x, y: this.y, hp: this.hp, maxHp: this.maxHp, phase: this.phase };
  }

  /**
   * Full reset to the roost for a new life (npc.ts resetBoss). Without this
   * the stale `windupT` from the killing blow survived the respawn.
   */
  reset(): void {
    this.x = this.brain.homeX;
    this.y = this.brain.homeY;
    this.hp = this.maxHp;
    this.phase = 'chase';
    this.cd = 2.0;
    this.windupT = 0;
    this.recoverT = 0;
    this.slamX = this.x;
    this.slamY = this.y;
    this.brain.reset(this.x, this.y);
  }

  /**
   * Knockdown stand-up (npc.ts mob-up). HP is restored by the caller (it owns
   * the downed ladder); this only clears a half-finished windup/recover so a
   * slam that was mid-telegraph does not fire on the way back up.
   */
  resetPhase(): void {
    this.phase = 'chase';
    this.windupT = 0;
    this.recoverT = 0;
    this.brain.hold = 0;
  }

  update(dt: number, targets: BossTarget[]): BossEvent[] {
    const ev: BossEvent[] = [];
    if (this.dead) return ev;
    const enrageMul = this.enraged ? 1.35 : 1;

    if (this.phase === 'recover') {
      this.recoverT -= dt;
      if (this.recoverT <= 0) {
        this.phase = 'chase';
        this.cd = this.slamCooldown / enrageMul;
      }
      return ev;
    }

    if (this.phase === 'windup') {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        // slam lands where the telegraph was planted
        ev.push({
          kind: 'damage',
          x: this.slamX,
          y: this.slamY,
          r: this.slamRadius * (this.enraged ? 1.2 : 1),
          amount: Math.round(this.slamDamage * enrageMul),
        });
        this.phase = 'recover';
        this.recoverT = this.recoverSec;
      }
      return ev;
    }

    // Leash: pulled too far off the roost, the golem gives the fight up and
    // lumbers home. Previously it chased to the far wall of a 100x100 map and
    // then sat there forever in `chase` with no target at all.
    if (this.brain.leashed(this.x, this.y)) {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.phase = 'return';
      this.brain.hold = 0;
      return ev;
    }

    if (this.phase === 'return') {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      // Arrived (or close enough): re-arm the slam and let the chase resume.
      if (!to.moved || this.brain.homeDist(this.x, this.y) <= 0.5) this.phase = 'chase';
      return ev;
    }

    // chase
    const { target: t, hold } = nearestSticky(this.x, this.y, targets, this.brain.aggroRange, this.brain.hold);
    this.brain.hold = hold;
    if (t) {
      const d = dist(this.x, this.y, t.x, t.y);
      if (d > 0.01) {
        const step = Math.min(d, this.speed * enrageMul * dt);
        this.x += ((t.x - this.x) / d) * step;
        this.y += ((t.y - this.y) / d) * step;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.cd -= dt;
      if (this.cd <= 0 && d <= this.slamRadius + 2.5) {
        this.phase = 'windup';
        this.windupT = this.windupMs / 1000 / enrageMul;
        this.slamX = t.x;
        this.slamY = t.y;
        ev.push({
          kind: 'telegraph',
          shape: 'circle',
          x: this.slamX,
          y: this.slamY,
          r: this.slamRadius * (this.enraged ? 1.2 : 1),
          ttlMs: Math.round(this.windupMs / enrageMul),
          label: 'golem-slam',
        });
      }
    } else {
      // Nobody in aggro range: drift back to the roost instead of standing
      // in the middle of an empty map where the fight happened to end.
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
    }
    return ev;
  }
}

// ----------------------------------------------------------------- Wisp ---

export interface WispConfig {
  maxHp?: number;
  speed?: number;
  burstRadius?: number;
  burstDamage?: number;
  blinkCooldown?: number;
  blinkWindupMs?: number;
  burstWindupMs?: number;
  brain?: BossBrainConfig;
}

type WispPhase = 'drift' | 'blinkWindup' | 'burstWindup' | 'recover' | 'return';

/** Distance the wisp drifts from home before it breaks off and drifts back. */
const WISP_LEASH = 40;

/**
 * Void Wisp: keeps ~6u range, blinks to a flank position near its target
 * (destination telegraphed), then detonates a burst (circle telegraph).
 */
export class WispBoss {
  readonly kind: BossKind = 'wisp';
  x: number;
  y: number;
  hp: number;
  readonly maxHp: number;
  readonly speed: number;
  readonly burstRadius: number;
  readonly burstDamage: number;
  readonly blinkCooldown: number;
  readonly blinkWindupMs: number;
  readonly burstWindupMs: number;
  /** Roost / aggro / leash bookkeeping (shared BossBrain, see bosses.ts). */
  readonly brain: BossBrain;

  phase: WispPhase = 'drift';
  private cd = 3.0;
  private windupT = 0;
  private blinkX = 0;
  private blinkY = 0;
  private flankSign = 1;

  constructor(x: number, y: number, cfg: WispConfig = {}) {
    this.x = x;
    this.y = y;
    this.maxHp = cfg.maxHp ?? 220;
    this.hp = this.maxHp;
    this.speed = cfg.speed ?? 4.0;
    this.burstRadius = cfg.burstRadius ?? 3.5;
    this.burstDamage = cfg.burstDamage ?? 18;
    this.blinkCooldown = cfg.blinkCooldown ?? 5.0;
    this.blinkWindupMs = cfg.blinkWindupMs ?? 500;
    this.burstWindupMs = cfg.burstWindupMs ?? 700;
    this.brain = new BossBrain(x, y, { leashRange: WISP_LEASH, ...cfg.brain });
  }

  get dead(): boolean {
    return this.hp <= 0;
  }

  snapshot(): BossSnapshot {
    return { kind: this.kind, x: this.x, y: this.y, hp: this.hp, maxHp: this.maxHp, phase: this.phase };
  }

  /** Full reset to the roost for a new life (npc.ts resetBoss). */
  reset(): void {
    this.x = this.brain.homeX;
    this.y = this.brain.homeY;
    this.hp = this.maxHp;
    this.phase = 'drift';
    this.cd = 3.0;
    this.windupT = 0;
    this.blinkX = this.x;
    this.blinkY = this.y;
    this.brain.reset(this.x, this.y);
  }

  /** Knockdown stand-up (npc.ts mob-up): HP restored by the caller. */
  resetPhase(): void {
    this.phase = 'drift';
    this.windupT = 0;
    this.brain.hold = 0;
  }

  update(dt: number, targets: BossTarget[]): BossEvent[] {
    const ev: BossEvent[] = [];
    if (this.dead) return ev;

    if (this.phase === 'blinkWindup') {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        ev.push({ kind: 'blink', fromX: this.x, fromY: this.y, toX: this.blinkX, toY: this.blinkY });
        this.x = this.blinkX;
        this.y = this.blinkY;
        this.phase = 'burstWindup';
        this.windupT = this.burstWindupMs / 1000;
        ev.push({
          kind: 'telegraph',
          shape: 'circle',
          x: this.x,
          y: this.y,
          r: this.burstRadius,
          ttlMs: this.burstWindupMs,
          label: 'wisp-burst',
        });
      }
      return ev;
    }

    if (this.phase === 'burstWindup') {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        ev.push({ kind: 'damage', x: this.x, y: this.y, r: this.burstRadius, amount: this.burstDamage });
        if (this.hp < this.maxHp * 0.3) {
          // enrage: chain a second blink instead of full recovery
          this.phase = 'drift';
          this.cd = 1.2;
        } else {
          this.phase = 'recover';
          this.windupT = 0.8;
        }
      }
      return ev;
    }

    if (this.phase === 'recover') {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        this.phase = 'drift';
        this.cd = this.blinkCooldown;
      }
      return ev;
    }

    // Leash: the wisp is a skirmisher, not a pursuit unit. Once it has been
    // dragged off the roost it stops blinking and drifts home. Previously it
    // had neither leash nor idle, so `drift` with no target froze it wherever
    // the fight ended — mid-arena, hundreds of units from its post.
    if (this.brain.leashed(this.x, this.y)) {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.phase = 'return';
      this.brain.hold = 0;
      return ev;
    }

    if (this.phase === 'return') {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      if (!to.moved || this.brain.homeDist(this.x, this.y) <= 0.5) this.phase = 'drift';
      return ev;
    }

    // drift: hover at ~6u from the sticky target, count down to blink
    const { target: t, hold } = nearestSticky(this.x, this.y, targets, this.brain.aggroRange, this.brain.hold);
    this.brain.hold = hold;
    if (t) {
      const d = dist(this.x, this.y, t.x, t.y) || 0.01;
      const want = 6;
      const radial = d - want; // + too far, - too close
      const step = Math.max(-1, Math.min(1, radial / 3)) * this.speed * dt;
      this.x += ((t.x - this.x) / d) * step;
      this.y += ((t.y - this.y) / d) * step;
      ev.push({ kind: 'move', x: this.x, y: this.y });

      this.cd -= dt;
      if (this.cd <= 0) {
        // flank spot: 3.5u from target, alternating sides
        this.flankSign *= -1;
        const ang = Math.atan2(this.y - t.y, this.x - t.x) + (this.flankSign * Math.PI) / 2;
        this.blinkX = Math.max(1, Math.min(99, t.x + Math.cos(ang) * 3.5));
        this.blinkY = Math.max(1, Math.min(99, t.y + Math.sin(ang) * 3.5));
        this.phase = 'blinkWindup';
        this.windupT = this.blinkWindupMs / 1000;
        ev.push({
          kind: 'telegraph',
          shape: 'circle',
          x: this.blinkX,
          y: this.blinkY,
          r: this.burstRadius,
          ttlMs: this.blinkWindupMs,
          label: 'wisp-blink',
        });
      }
    } else {
      // No engageable player: drift home so it never ends up stranded.
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
    }
    return ev;
  }
}

// ------------------------------------------------------------ Ember Wyrm ---
// Volcano boss. Chases the nearest player; periodically telegraphs a straight
// charge line, dashes along it, and leaves burning pools at the impact.
// Enrage (<30% HP): shorter cooldown, faster windup, wider charge, 2 pools.

export interface WyrmConfig {
  maxHp?: number;
  speed?: number;
  chargeRange?: number;
  chargeWidth?: number;
  chargeDamage?: number;
  chargeCooldown?: number;
  windupMs?: number;
  recoverSec?: number;
  poolRadius?: number;
  poolTick?: number;
  poolTtlMs?: number;
  brain?: BossBrainConfig;
}

export type WyrmPhase = 'chase' | 'chargeWindup' | 'recover' | 'return';

/** Distance the wyrm is dragged from its caldera roost before it disengages. */
const WYRM_LEASH = 40;

export class EmberWyrmBoss {
  readonly kind: BossKind = 'ember-wyrm';
  x: number;
  y: number;
  hp: number;
  readonly maxHp: number;
  readonly speed: number;
  readonly chargeRange: number;
  readonly chargeWidth: number;
  readonly chargeDamage: number;
  readonly chargeCooldown: number;
  readonly windupMs: number;
  readonly recoverSec: number;
  readonly poolRadius: number;
  readonly poolTick: number;
  readonly poolTtlMs: number;
  /** Roost / aggro / leash bookkeeping (shared BossBrain, see bosses.ts). */
  readonly brain: BossBrain;

  phase: WyrmPhase = 'chase';
  private cd = 3.0; // first charge comes early so players learn the line
  private windupT = 0;
  private recoverT = 0;
  private x1 = 0;
  private y1 = 0;
  private x2 = 0;
  private y2 = 0;

  constructor(x: number, y: number, cfg: WyrmConfig = {}) {
    this.x = x;
    this.y = y;
    this.maxHp = cfg.maxHp ?? 3200; // 60-90s duo @ lvl7/+10, ~50% uptime (see content.bossDuoTtkSec)
    this.hp = this.maxHp;
    this.speed = cfg.speed ?? 3.4;
    this.chargeRange = cfg.chargeRange ?? 14;
    this.chargeWidth = cfg.chargeWidth ?? 2.5;
    this.chargeDamage = cfg.chargeDamage ?? 30;
    this.chargeCooldown = cfg.chargeCooldown ?? 6.0;
    this.windupMs = cfg.windupMs ?? 800;
    this.recoverSec = cfg.recoverSec ?? 1.0;
    this.poolRadius = cfg.poolRadius ?? 3;
    this.poolTick = cfg.poolTick ?? 8;
    // 5s keeps the pool telegraph inside the 5s protocol cap (telegraph.ts
    // rejects ttlMs > 5000); npc.ts burns poolTick once per second.
    this.poolTtlMs = cfg.poolTtlMs ?? 5000;
    this.brain = new BossBrain(x, y, { leashRange: WYRM_LEASH, ...cfg.brain });
  }

  get dead(): boolean {
    return this.hp <= 0;
  }

  /** Player damage entry point (kept in step with the Warden's shield-aware one). */
  takeDamage(amount: number): number {
    if (this.dead || amount <= 0) return 0;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    return before - this.hp;
  }

  get enraged(): boolean {
    return this.hp < this.maxHp * 0.3;
  }

  snapshot(): BossSnapshot {
    return { kind: this.kind, x: this.x, y: this.y, hp: this.hp, maxHp: this.maxHp, phase: this.phase };
  }

  /** Full reset to the roost for a new life (npc.ts resetBoss). */
  reset(): void {
    this.x = this.brain.homeX;
    this.y = this.brain.homeY;
    this.hp = this.maxHp;
    this.phase = 'chase';
    this.cd = 3.0;
    this.windupT = 0;
    this.recoverT = 0;
    this.x1 = this.x;
    this.y1 = this.y;
    this.x2 = this.x;
    this.y2 = this.y;
    this.brain.reset(this.x, this.y);
  }

  /** Knockdown stand-up (npc.ts mob-up): HP restored by the caller. */
  resetPhase(): void {
    this.phase = 'chase';
    this.windupT = 0;
    this.recoverT = 0;
    this.brain.hold = 0;
  }

  update(dt: number, targets: BossTarget[]): BossEvent[] {
    const ev: BossEvent[] = [];
    if (this.dead) return ev;
    const enrageMul = this.enraged ? 1.35 : 1;

    if (this.phase === 'recover') {
      this.recoverT -= dt;
      if (this.recoverT <= 0) {
        this.phase = 'chase';
        this.cd = this.chargeCooldown / enrageMul;
      }
      return ev;
    }

    if (this.phase === 'chargeWindup') {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        // dash lands along the telegraphed line; impact + fire pools
        this.x = this.x2;
        this.y = this.y2;
        ev.push({ kind: 'move', x: this.x, y: this.y });
        const width = this.chargeWidth * (this.enraged ? 1.3 : 1);
        // Whole dash corridor hurts (capsule), not just the landing point.
        ev.push({
          kind: 'damageLine',
          x1: this.x1,
          y1: this.y1,
          x2: this.x2,
          y2: this.y2,
          width,
          amount: Math.round(this.chargeDamage * enrageMul),
        });
        ev.push({
          kind: 'damage',
          x: this.x2,
          y: this.y2,
          r: width + 1.0,
          amount: Math.round(this.chargeDamage * enrageMul),
        });
        ev.push({
          kind: 'pool',
          x: this.x2,
          y: this.y2,
          r: this.poolRadius,
          ttlMs: this.poolTtlMs,
          tickDamage: this.poolTick,
          label: 'wyrm-fire',
        });
        if (this.enraged) {
          // second pool midway: cuts off kiting straight back
          ev.push({
            kind: 'pool',
            x: (this.x1 + this.x2) / 2,
            y: (this.y1 + this.y2) / 2,
            r: this.poolRadius,
            ttlMs: this.poolTtlMs,
            tickDamage: this.poolTick,
            label: 'wyrm-fire',
          });
        }
        this.phase = 'recover';
        this.recoverT = this.recoverSec;
      }
      return ev;
    }

    // Leash: the wyrm returns to the caldera vent rather than chasing a kiter
    // across the whole 100x100 arena (it had no disengage condition at all).
    if (this.brain.leashed(this.x, this.y)) {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.phase = 'return';
      this.brain.hold = 0;
      return ev;
    }

    if (this.phase === 'return') {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      if (!to.moved || this.brain.homeDist(this.x, this.y) <= 0.5) this.phase = 'chase';
      return ev;
    }

    // chase
    const { target: t, hold } = nearestSticky(this.x, this.y, targets, this.brain.aggroRange, this.brain.hold);
    this.brain.hold = hold;
    if (t) {
      const d = dist(this.x, this.y, t.x, t.y);
      if (d > 0.01) {
        const step = Math.min(d, this.speed * dt);
        this.x += ((t.x - this.x) / d) * step;
        this.y += ((t.y - this.y) / d) * step;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.cd -= dt;
      if (this.cd <= 0 && d <= this.chargeRange) {
        this.phase = 'chargeWindup';
        this.windupT = this.windupMs / 1000 / enrageMul;
        this.x1 = this.x;
        this.y1 = this.y;
        this.x2 = Math.max(1, Math.min(99, t.x));
        this.y2 = Math.max(1, Math.min(99, t.y));
        ev.push({
          kind: 'charge',
          x1: this.x1,
          y1: this.y1,
          x2: this.x2,
          y2: this.y2,
          width: this.chargeWidth * (this.enraged ? 1.3 : 1),
          ttlMs: Math.round(this.windupMs / enrageMul),
          label: 'wyrm-charge',
        });
      }
    } else {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
    }
    return ev;
  }
}

// ---------------------------------------------------------- Crypt Warden ---
// Dungeon boss. Slow chase + circle slam (same telegraph shape as the Golem),
// summons 2 crypt-husk adds on a timer (and on every shield), and raises a
// damage-immune shield at 66% / 33% HP. Route player hits through
// takeDamage() so the shield actually blocks; update() drives the phases.

export interface WardenConfig {
  maxHp?: number;
  speed?: number;
  slamRadius?: number;
  slamDamage?: number;
  slamCooldown?: number;
  windupMs?: number;
  recoverSec?: number;
  summonCooldown?: number;
  shieldSec?: number;
  brain?: BossBrainConfig;
}

export type WardenPhase = 'chase' | 'windup' | 'recover' | 'shield' | 'return';

export const WARDEN_THRESHOLDS = [0.66, 0.33];

/** Distance the warden is dragged from its crypt roost before it disengages. */
const WARDEN_LEASH = 40;

export class CryptWardenBoss {
  readonly kind: BossKind = 'crypt-warden';
  x: number;
  y: number;
  hp: number;
  readonly maxHp: number;
  readonly speed: number;
  readonly slamRadius: number;
  readonly slamDamage: number;
  readonly slamCooldown: number;
  readonly windupMs: number;
  readonly recoverSec: number;
  readonly summonCooldown: number;
  readonly shieldSec: number;
  /** Roost / aggro / leash bookkeeping (shared BossBrain, see bosses.ts). */
  readonly brain: BossBrain;

  phase: WardenPhase = 'chase';
  private slamCd = 2.0; // first slam comes early so players learn it
  private summonCd: number;
  private windupT = 0;
  private recoverT = 0;
  private shieldT = 0;
  private slamX = 0;
  private slamY = 0;
  private shieldsUsed = 0;
  /** Threshold crossed mid-attack: arm the shield as soon as the attack lands. */
  private shieldPending = false;
  private summonN = 0;
  /** Total adds summoned (deterministic; tests + tuning). */
  summonsSpawned = 0;

  constructor(x: number, y: number, cfg: WardenConfig = {}) {
    this.x = x;
    this.y = y;
    this.maxHp = cfg.maxHp ?? 2200; // 60-90s duo @ lvl4/+6 including shields + adds
    this.hp = this.maxHp;
    this.speed = cfg.speed ?? 1.8;
    this.slamRadius = cfg.slamRadius ?? 4;
    this.slamDamage = cfg.slamDamage ?? 22;
    this.slamCooldown = cfg.slamCooldown ?? 4.5;
    this.windupMs = cfg.windupMs ?? 900;
    this.recoverSec = cfg.recoverSec ?? 1.0;
    // 2x4.5s shields = 9s of immunity. Both values sit inside the 5s protocol
    // telegraph cap so the shield visual never outlives/under-runs the window.
    this.summonCooldown = cfg.summonCooldown ?? 18;
    this.shieldSec = cfg.shieldSec ?? 4.5;
    this.summonCd = this.summonCooldown;
    this.brain = new BossBrain(x, y, { leashRange: WARDEN_LEASH, ...cfg.brain });
  }

  get dead(): boolean {
    return this.hp <= 0;
  }

  get shielded(): boolean {
    return this.phase === 'shield';
  }

  /**
   * Player/boss damage entry point: 0 while shielded or dead. Returns the HP
   * actually removed (NOT the requested `amount`) — `damageBoss()`'s contract,
   * and `npc.ts` uses the return to credit the killer.
   */
  takeDamage(amount: number): number {
    if (this.dead || this.shielded || amount <= 0) return 0;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    return before - this.hp;
  }

  snapshot(): BossSnapshot {
    return { kind: this.kind, x: this.x, y: this.y, hp: this.hp, maxHp: this.maxHp, phase: this.phase };
  }

  /**
   * Full reset to the roost for a new life (npc.ts resetBoss). Also clears
   * `shieldsUsed` — otherwise the second life would start with both shield
   * windows already spent and never raise one.
   */
  reset(): void {
    this.x = this.brain.homeX;
    this.y = this.brain.homeY;
    this.hp = this.maxHp;
    this.phase = 'chase';
    this.slamCd = 2.0;
    this.summonCd = this.summonCooldown;
    this.windupT = 0;
    this.recoverT = 0;
    this.shieldT = 0;
    this.slamX = this.x;
    this.slamY = this.y;
    this.shieldsUsed = 0;
    this.shieldPending = false;
    this.summonsSpawned = 0;
    this.brain.reset(this.x, this.y);
  }

  /** Knockdown stand-up (npc.ts mob-up): HP restored by the caller. */
  resetPhase(): void {
    this.phase = 'chase';
    this.slamCd = 2.0;
    this.windupT = 0;
    this.recoverT = 0;
    this.shieldT = 0;
    this.shieldPending = false;
    this.brain.hold = 0;
  }

  /** Emit 2 husk summons at deterministic flank spots around the boss. */
  private summonPair(ev: BossEvent[]): void {
    const base = this.summonN * 1.7;
    this.summonN += 1;
    for (let i = 0; i < 2; i++) {
      const a = base + i * Math.PI;
      ev.push({
        kind: 'summon',
        name: 'crypt-husk',
        x: Math.max(1, Math.min(99, this.x + Math.cos(a) * 2.5)),
        y: Math.max(1, Math.min(99, this.y + Math.sin(a) * 2.5)),
        label: 'warden-husk',
      });
    }
    this.summonsSpawned += 2;
  }

  update(dt: number, targets: BossTarget[]): BossEvent[] {
    const ev: BossEvent[] = [];
    if (this.dead) return ev;

    // Shield-arm check. NEVER armed out of `windup`: a slam telegraph is
    // broadcast the tick the phase becomes `windup`, and the old code let the
    // threshold check run ahead of every phase branch — so a hit that crossed
    // 66% or 33% *mid-windup* flipped the phase to `shield`, threw `windupT`
    // away, and the slam circle the player was already dodging never
    // resolved. A telegraph that resolves into nothing is the single worst
    // fairness bug a boss can have. Arming between attacks costs at most
    // windupMs (900ms) of extra delay and keeps every telegraph honest.
    if (this.shieldsUsed < WARDEN_THRESHOLDS.length && this.hp / this.maxHp <= WARDEN_THRESHOLDS[this.shieldsUsed]!) {
      this.shieldPending = true;
    }
    if (
      this.shieldPending &&
      this.phase !== 'shield' &&
      this.phase !== 'windup' &&
      this.shieldsUsed < WARDEN_THRESHOLDS.length
    ) {
      this.shieldPending = false;
      this.phase = 'shield';
      this.shieldT = this.shieldSec;
      this.shieldsUsed += 1;
      ev.push({ kind: 'shield', on: true, label: 'warden-shield' });
      this.summonPair(ev); // reinforcements with every shield
      return ev;
    }

    if (this.phase === 'shield') {
      this.shieldT -= dt;
      if (this.shieldT <= 0) {
        this.phase = 'chase';
        this.slamCd = Math.min(this.slamCd, 1.0);
        ev.push({ kind: 'shield', on: false, label: 'warden-shield' });
      }
      return ev;
    }

    // Leash: warden walks back to its crypt plinth instead of following a
    // kiter across the map (it previously had no disengage at all).
    if (this.brain.leashed(this.x, this.y)) {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.phase = 'return';
      this.brain.hold = 0;
      return ev;
    }

    if (this.phase === 'return') {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      if (!to.moved || this.brain.homeDist(this.x, this.y) <= 0.5) this.phase = 'chase';
      return ev;
    }

    if (this.phase === 'recover') {
      this.recoverT -= dt;
      if (this.recoverT <= 0) {
        this.phase = 'chase';
        this.slamCd = this.slamCooldown;
      }
      return ev;
    }

    if (this.phase === 'windup') {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        ev.push({ kind: 'damage', x: this.slamX, y: this.slamY, r: this.slamRadius, amount: this.slamDamage });
        this.phase = 'recover';
        this.recoverT = this.recoverSec;
      }
      return ev;
    }

    // chase
    const { target: t, hold } = nearestSticky(this.x, this.y, targets, this.brain.aggroRange, this.brain.hold);
    this.brain.hold = hold;
    if (t) {
      const d = dist(this.x, this.y, t.x, t.y);
      if (d > 0.01) {
        const step = Math.min(d, this.speed * dt);
        this.x += ((t.x - this.x) / d) * step;
        this.y += ((t.y - this.y) / d) * step;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
      this.summonCd -= dt;
      if (this.summonCd <= 0) {
        this.summonCd = this.summonCooldown;
        this.summonPair(ev);
      }
      this.slamCd -= dt;
      if (this.slamCd <= 0 && d <= this.slamRadius + 2.5) {
        this.phase = 'windup';
        this.windupT = this.windupMs / 1000;
        this.slamX = t.x;
        this.slamY = t.y;
        ev.push({
          kind: 'telegraph',
          shape: 'circle',
          x: this.slamX,
          y: this.slamY,
          r: this.slamRadius,
          ttlMs: this.windupMs,
          label: 'warden-slam',
        });
      }
    } else {
      const to = stepToward(this.x, this.y, this.brain.homeX, this.brain.homeY, this.speed * dt);
      if (to.moved) {
        this.x = to.x;
        this.y = to.y;
        ev.push({ kind: 'move', x: this.x, y: this.y });
      }
    }
    return ev;
  }
}
