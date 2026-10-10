// Combat feedback primitives — the pure half of the feedback layer.
//
// Everything the two renderers need to agree on lives here so the Canvas2D
// path, the three.js path and the DOM float layer cannot drift apart:
//
//   * damage numbers  — pooled, capped, time-driven, a11y-gated
//   * mob HP bars     — "recently hit OR currently targeted" visibility rule
//   * hit flash       — 100ms white (mob struck) / red (player struck) tint
//   * swing           — 800ms-cadence lunge + whoosh envelope
//   * kill burst      — normal kill vs finisher, distinct without relying on hue
//
// No DOM, no WebGL, no per-frame allocation: every container here is a
// preallocated fixed-size array stepped in place, so the hot render loop only
// reads fields. That keeps the whole file headless-testable under node:test.

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Damage numbers alive at once. The pool is a fixed ring of this size. */
export const DMG_MAX = 24;
/** Lifetime of a damage number with full motion (rise + fade). */
export const DMG_TTL_MS = 700;
/** Lifetime under reduced motion: the number still appears, it just holds. */
export const DMG_TTL_REDUCED_MS = 260;
/** How far a number travels upward over its lifetime, in px. */
export const DMG_RISE_PX = 34;
/** Hits landing on the same target within this window fold into one number. */
export const DMG_MERGE_MS = 140;
/** ...and within this radius (world units) fold into one number. */
export const DMG_MERGE_DIST = 1.6;

/** White-out duration for the struck body, in ms. */
export const HIT_FLASH_MS = 100;
/** White-out applied to a mob the player hit (any hue the palette picks). */
export const HIT_FLASH_MOB = 0xffffff;
/** Red tint applied to the player when something hits them. */
export const HIT_FLASH_PLAYER = 0xff2f3f;

/** Concurrent hit flashes tracked (ring). */
export const FLASH_MAX = 64;

/** A mob keeps its world HP bar for this long after the last damage it took. */
export const MOB_BAR_RECENT_MS = 5000;
/** Concurrent "recently damaged" markers tracked (ring). */
export const RECENT_MAX = 64;

/**
 * How long one melee swing animation plays. Mirrors the server's attack
 * cadence (ATTACK_COOLDOWN_MS = 800) so the animation reads as "a swing that
 * the server will actually accept", not as a keypress echo.
 */
export const SWING_MS = 240;
/** Client-side gate between swing animations; mirrors server cooldown 800ms. */
export const SWING_COOLDOWN_MS = 800;
/** Forward lunge peak, in world units (3D) / px (2D). */
export const SWING_LUNGE = 0.55;

/** Concurrent kill-burst rings (ring, per renderer). */
export const KILL_FX_MAX = 12;
/** Kill-burst ring lifetime, ms. */
export const KILL_FX_MS = 420;

/** A hit this much above the player's running average reads as a heavy hit. */
export const HEAVY_HIT_RATIO = 1.5;
/** Samples needed before the tracker is willing to call anything heavy. */
export const HEAVY_HIT_MIN_SAMPLES = 4;

/** Melee reach mirrored from server/src/game/combat.ts (MELEE_RANGE). */
export const MELEE_REACH = 2.2;

// ---------------------------------------------------------------------------
// Damage numbers — presentation + accessibility mode
// ---------------------------------------------------------------------------

export type DamageKind = 'normal' | 'crit' | 'taken' | 'finisher';

export interface DamageStyle {
  /** CSS colour for the 2D canvas / DOM overlay. */
  color: string;
  /** Font size in px. */
  size: number;
  /** Pixels travelled upward over the lifetime. */
  rise: number;
  /**
   * Non-colour marker prepended to the value. Colour is never the only channel
   * that distinguishes a crit from a normal hit — the glyph, the size and the
   * text all do.
   */
  prefix: string;
}

export const DAMAGE_STYLES: Readonly<Record<DamageKind, DamageStyle>> = {
  // White, small: the common case.
  normal: { color: '#f2f5ff', size: 13, rise: DMG_RISE_PX, prefix: '' },
  // Crit: gold AND larger AND marked with a glyph.
  crit: { color: '#ffd24a', size: 19, rise: DMG_RISE_PX * 1.25, prefix: '\u2726' },
  // Damage the player takes: red, larger, and signed with a minus (the sign is
  // its non-colour marker, so the prefix stays empty).
  taken: { color: '#ff4d5e', size: 16, rise: DMG_RISE_PX * 0.8, prefix: '' },
  // Finisher kill: gold, biggest, unmistakable glyph.
  finisher: { color: '#ffcf3d', size: 22, rise: DMG_RISE_PX * 1.5, prefix: '\u2716' },
};

/** How damage numbers should be presented given the a11y settings. */
export type DmgMode = 'off' | 'short' | 'full';

/**
 * a11y gate. High contrast removes the numbers outright — those players get
 * the world HP bars, the hit flash, the screen shake, the HUD bar and the
 * audio cues instead, so nothing is carried by floating text alone. Reduced
 * motion keeps the number but collapses it to a short, motionless hold.
 */
export function damageNumberMode(opts: { reducedMotion: boolean; highContrast: boolean }): DmgMode {
  if (opts.highContrast) return 'off';
  if (opts.reducedMotion) return 'short';
  return 'full';
}

/** Lifetime for a mode (0 when numbers are off entirely). */
export function damageNumberTtl(mode: DmgMode): number {
  return mode === 'full' ? DMG_TTL_MS : mode === 'short' ? DMG_TTL_REDUCED_MS : 0;
}

/** Rise distance for a mode (0 when off or reduced-motion). */
export function damageNumberRise(mode: DmgMode, kind: DamageKind = 'normal'): number {
  if (mode !== 'full') return 0;
  return DAMAGE_STYLES[kind]?.rise ?? DMG_RISE_PX;
}

/** Verbatim finisher marker: the swing removed no HP worth printing. */
export const FINISHER_LABEL = '\u2716 FINISH';

/** Rendered string for a damage value: glyph marker + signed amount. */
export function formatDamage(amount: number, kind: DamageKind): string {
  const style = DAMAGE_STYLES[kind] ?? DAMAGE_STYLES.normal;
  const n = Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
  const sign = kind === 'taken' ? '-' : '';
  return `${style.prefix}${sign}${n}`;
}

/**
 * Text a pooled slot should paint: its verbatim label when it has one (the
 * finisher marker), otherwise the formatted value.
 */
export function damageNumberText(d: DamageNumber): string {
  return d.label !== '' ? d.label : formatDamage(d.amount, d.kind);
}

export interface DamageNumber {
  /** World anchor (overridden by `followId` when that entity is alive). */
  x: number;
  y: number;
  /** Entity id to track (player's own damage); null anchors in place. */
  followId: number;
  /** Accumulated damage (merge window folds repeat hits in). */
  amount: number;
  kind: DamageKind;
  bornAt: number;
  ttl: number;
  /** Total px the number travels over its life. */
  rise: number;
  /** Verbatim text override; empty means "derive from amount + kind". */
  label: string;
  // --- stepped every frame by step(); read by the renderers ---
  active: boolean;
  /** 0..1 lifetime progress. */
  progress: number;
  /** 1 -> 0 fade curve. */
  alpha: number;
  /** Current offset above the anchor, px. */
  offset: number;
}

/**
 * Fixed-size ring of damage numbers. `spawn` never grows the pool: past
 * DMG_MAX live numbers the oldest slot is recycled, so a burst of hits costs a
 * bounded amount of memory and the renderer never allocates.
 */
export class DamageNumberPool {
  /** Slot capacity (DMG_MAX). */
  readonly capacity = DMG_MAX;
  private readonly slots: DamageNumber[] = [];
  private cursor = 0;
  private live = 0;

  constructor() {
    for (let i = 0; i < DMG_MAX; i++) {
      this.slots.push({
        x: 0, y: 0, followId: -1, amount: 0, kind: 'normal',
        bornAt: 0, ttl: DMG_TTL_MS, rise: DMG_RISE_PX, label: '',
        active: false, progress: 0, alpha: 0, offset: 0,
      });
    }
  }

  /** Live numbers as of the last step(). */
  get liveCount(): number {
    return this.live;
  }

  /** Slot access for the render loop (check `.active`, no allocation). */
  at(i: number): DamageNumber {
    return this.slots[i]!;
  }

  /**
   * Add a number. Returns false when it was dropped: numbers are off
   * (`mode: 'off'`) or the input was not renderable (non-finite position or
   * a non-positive amount).
   */
  spawn(
    x: number,
    y: number,
    amount: number,
    kind: DamageKind,
    nowMs: number,
    mode: DmgMode,
    followId = -1,
  ): boolean {
    if (mode === 'off') return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (!Number.isFinite(nowMs)) return false;
    const merged = this.mergeInto(x, y, amount, kind, nowMs, followId);
    if (merged) return true;

    const slot = this.slots[this.cursor]!;
    this.cursor = (this.cursor + 1) % DMG_MAX;
    slot.x = x;
    slot.y = y;
    slot.followId = followId;
    slot.amount = amount;
    slot.kind = kind;
    slot.bornAt = nowMs;
    slot.ttl = damageNumberTtl(mode);
    slot.rise = damageNumberRise(mode, kind);
    slot.label = '';
    slot.active = true;
    slot.progress = 0;
    slot.alpha = 1;
    slot.offset = 0;
    return true;
  }

  /**
   * Spawn a number with verbatim text instead of a value — used for the
   * finisher marker, where the swing removed no HP worth printing. Same pool,
   * same cap, same a11y gate.
   */
  spawnLabel(
    x: number,
    y: number,
    label: string,
    kind: DamageKind,
    nowMs: number,
    mode: DmgMode,
    followId = -1,
  ): boolean {
    if (mode === 'off') return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (typeof label !== 'string' || label.length === 0) return false;
    if (!Number.isFinite(nowMs)) return false;
    const slot = this.slots[this.cursor]!;
    this.cursor = (this.cursor + 1) % DMG_MAX;
    slot.x = x;
    slot.y = y;
    slot.followId = followId;
    slot.amount = 0;
    slot.kind = kind;
    slot.bornAt = nowMs;
    slot.ttl = damageNumberTtl(mode);
    slot.rise = damageNumberRise(mode, kind);
    slot.label = label;
    slot.active = true;
    slot.progress = 0;
    slot.alpha = 1;
    slot.offset = 0;
    return true;
  }

  /**
   * Fold a repeat hit into the newest matching number instead of stacking a
   * second one on top of it. Matches on kind + anchor + time + distance.
   */
  private mergeInto(
    x: number,
    y: number,
    amount: number,
    kind: DamageKind,
    nowMs: number,
    followId: number,
  ): boolean {
    // Newest spawn first: the ring's previous slot is the most recent one.
    for (let back = 1; back <= DMG_MAX; back++) {
      const i = (this.cursor - back + DMG_MAX * 2) % DMG_MAX;
      const s = this.slots[i]!;
      if (!s.active || s.kind !== kind || s.followId !== followId) continue;
      if (nowMs - s.bornAt > DMG_MERGE_MS) return false;
      if (Math.hypot(x - s.x, y - s.y) > DMG_MERGE_DIST) return false;
      s.amount += amount;
      s.bornAt = nowMs; // restart the timer so the folded total stays readable
      s.progress = 0;
      s.alpha = 1;
      s.offset = 0;
      return true;
    }
    return false;
  }

  /** Advance every slot in place: expire, compute progress/alpha/offset. */
  step(nowMs: number): void {
    let live = 0;
    for (let i = 0; i < DMG_MAX; i++) {
      const s = this.slots[i]!;
      if (!s.active) continue;
      const age = nowMs - s.bornAt;
      if (age < 0 || age >= s.ttl || s.ttl <= 0) {
        s.active = false;
        s.alpha = 0;
        continue;
      }
      live++;
      const p = age / s.ttl;
      s.progress = p;
      // Hold full opacity for the first third, then fade out.
      s.alpha = p < 0.35 ? 1 : 1 - (p - 0.35) / 0.65;
      s.offset = s.rise * p;
    }
    this.live = live;
  }

  /** Live count without stepping (tests). */
  count(nowMs: number): number {
    let n = 0;
    for (let i = 0; i < DMG_MAX; i++) {
      const s = this.slots[i]!;
      if (s.active && nowMs - s.bornAt < s.ttl && s.ttl > 0) n++;
    }
    return n;
  }

  /** Drop everything (mode flips to off, disconnect, respawn). */
  clear(): void {
    for (let i = 0; i < DMG_MAX; i++) {
      this.slots[i]!.active = false;
      this.slots[i]!.alpha = 0;
    }
    this.live = 0;
    this.cursor = 0;
  }
}

// ---------------------------------------------------------------------------
// Hit flashes
// ---------------------------------------------------------------------------

export interface HitFlashSlot {
  id: number;
  until: number;
  tint: number;
  active: boolean;
}

/**
 * Ring of "this body is flashing" markers. Fixed capacity, stepped in place.
 * A struck mob flashes white, the player flashes red; both are 100ms.
 *
 * Live entries are compacted into [0, live) by step(), so the per-entity
 * lookup the render loop does every frame is O(live) — typically 0-3 — rather
 * than O(capacity).
 */
export class HitFlashRing {
  readonly capacity = FLASH_MAX;
  private readonly slots: HitFlashSlot[] = [];
  /** Live entries occupy slots [0, live). */
  private live = 0;

  constructor() {
    for (let i = 0; i < FLASH_MAX; i++) this.slots.push({ id: -1, until: 0, tint: HIT_FLASH_MOB, active: false });
  }

  /** Live flashes right now (tests). */
  get liveCount(): number {
    return this.live;
  }

  /** Flash an entity for HIT_FLASH_MS. Repeats extend, never stack. */
  flash(id: number, tint: number, nowMs: number): void {
    if (!Number.isInteger(id) || id < 0) return;
    if (!Number.isFinite(nowMs)) return;
    const t = Number.isFinite(tint) ? tint : HIT_FLASH_MOB;
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (s.id === id) {
        s.until = nowMs + HIT_FLASH_MS;
        s.tint = t;
        return;
      }
    }
    let idx = this.live;
    if (idx >= FLASH_MAX) {
      // Full: evict the flash closest to expiring, so the newest survives.
      idx = 0;
      for (let i = 1; i < this.live; i++) {
        if (this.slots[i]!.until < this.slots[idx]!.until) idx = i;
      }
    } else {
      this.live++;
    }
    const s = this.slots[idx]!;
    s.id = id;
    s.until = nowMs + HIT_FLASH_MS;
    s.tint = t;
    s.active = true;
  }

  /** 1 -> 0 flash strength for an id (0 when idle). Expiry is lazy here. */
  strengthFor(id: number, nowMs: number): number {
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (s.id !== id) continue;
      if (nowMs >= s.until) return 0;
      return 1 - (nowMs - (s.until - HIT_FLASH_MS)) / HIT_FLASH_MS;
    }
    return 0;
  }

  /** Tint recorded for an id (meaningless when strength is 0). */
  tintFor(id: number): number {
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (s.id === id) return s.tint;
    }
    return HIT_FLASH_MOB;
  }

  /** Expire finished flashes and compact the ring (once per frame). */
  step(nowMs: number): void {
    let w = 0;
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (nowMs >= s.until) continue;
      if (w !== i) {
        const tmp = this.slots[w]!;
        this.slots[w] = s;
        this.slots[i] = tmp;
      }
      w++;
    }
    for (let i = w; i < this.live; i++) {
      this.slots[i]!.active = false;
      this.slots[i]!.id = -1;
    }
    this.live = w;
  }

  clear(): void {
    for (let i = 0; i < FLASH_MAX; i++) {
      this.slots[i]!.active = false;
      this.slots[i]!.id = -1;
    }
    this.live = 0;
  }
}

// ---------------------------------------------------------------------------
// Mob HP bar visibility
// ---------------------------------------------------------------------------

export interface MobBarInput {
  hp: number;
  maxHp: number;
  /** Timestamp of the last damage this entity took (0 = never). */
  lastHitAt: number;
  /** True while the entity is the player's current swing target. */
  targeted: boolean;
  nowMs: number;
  /** Bypass the gate entirely (the local player always shows their own bar). */
  always?: boolean;
}

/**
 * Should this entity wear a world HP bar?
 *
 * A quiet field shows none, so the bars mean something when they appear: the
 * mob either took damage inside MOB_BAR_RECENT_MS or is the mob the player is
 * standing next to about to swing at.
 */
export function mobBarVisible(o: MobBarInput): boolean {
  if (o.always === true) return true;
  if (!Number.isFinite(o.hp) || !Number.isFinite(o.maxHp) || o.maxHp <= 0) return false;
  if (o.hp <= 0) return false; // a corpse carries no bar
  if (o.targeted) return true;
  if (!Number.isFinite(o.lastHitAt) || o.lastHitAt <= 0) return false;
  return o.nowMs - o.lastHitAt < MOB_BAR_RECENT_MS;
}

/**
 * Allocation-free form of `mobBarVisible` for the render loop: writes into a
 * renderer-owned scratch record instead of building a fresh object per entity
 * per frame. Same predicate, same result — see the tests that pin both.
 */
export function mobBarVisibleInto(
  scratch: MobBarInput,
  hp: number,
  maxHp: number,
  lastHitAt: number,
  targeted: boolean,
  nowMs: number,
  always?: boolean,
): boolean {
  scratch.hp = hp;
  scratch.maxHp = maxHp;
  scratch.lastHitAt = lastHitAt;
  scratch.targeted = targeted;
  scratch.nowMs = nowMs;
  scratch.always = always;
  return mobBarVisible(scratch);
}

/** A fresh, reusable scratch record for `mobBarVisibleInto`. */
export function mobBarScratch(): MobBarInput {
  return { hp: 0, maxHp: 0, lastHitAt: 0, targeted: false, nowMs: 0, always: false };
}

export interface RecentSlot {
  id: number;
  at: number;
}

/**
 * Ring of "this entity took damage at" markers feeding `mobBarVisible`.
 * Compacted by step() into [0, live) so the per-entity lookup the render loop
 * does every frame stays O(live).
 */
export class RecentDamageRing {
  readonly capacity = RECENT_MAX;
  private readonly slots: RecentSlot[] = [];
  private live = 0;

  constructor() {
    for (let i = 0; i < RECENT_MAX; i++) this.slots.push({ id: -1, at: 0 });
  }

  /** Live markers right now (tests). */
  get liveCount(): number {
    return this.live;
  }

  /** Record damage time for an entity (repeat hits move the same slot). */
  mark(id: number, nowMs: number): void {
    if (!Number.isInteger(id) || id < 0) return;
    if (!Number.isFinite(nowMs)) return;
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (s.id === id) {
        s.at = nowMs;
        return;
      }
    }
    let idx = this.live;
    if (idx >= RECENT_MAX) {
      // Full: drop the oldest marker, the newest hit is the useful one.
      idx = 0;
      for (let i = 1; i < this.live; i++) {
        if (this.slots[i]!.at < this.slots[idx]!.at) idx = i;
      }
    } else {
      this.live++;
    }
    this.slots[idx]!.id = id;
    this.slots[idx]!.at = nowMs;
  }

  /** Last damage timestamp for an id, or 0 when it was never hit. */
  lastAt(id: number): number {
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (s.id === id) return s.at;
    }
    return 0;
  }

  /** Forget markers older than MOB_BAR_RECENT_MS, then compact. */
  step(nowMs: number): void {
    let w = 0;
    for (let i = 0; i < this.live; i++) {
      const s = this.slots[i]!;
      if (nowMs - s.at >= MOB_BAR_RECENT_MS) continue;
      if (w !== i) {
        const tmp = this.slots[w]!;
        this.slots[w] = s;
        this.slots[i] = tmp;
      }
      w++;
    }
    for (let i = w; i < this.live; i++) this.slots[i]!.id = -1;
    this.live = w;
  }

  clear(): void {
    for (let i = 0; i < RECENT_MAX; i++) this.slots[i]!.id = -1;
    this.live = 0;
  }
}

// ---------------------------------------------------------------------------
// Swing
// ---------------------------------------------------------------------------

/**
 * 0 -> 1 -> 0 envelope across SWING_MS. Used for the lunge offset and the
 * whoosh arc so both track exactly the same shape.
 */
export function swingEnvelope(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0;
  if (ageMs >= SWING_MS) return 0;
  return Math.sin((Math.PI * ageMs) / SWING_MS);
}

/** Single-swing state (the player has at most one in flight). */
export class SwingState {
  private startedAt = -1e9;
  private dx = 0;
  private dy = 1;

  /**
   * Begin a swing if the 800ms cadence allows one. Returns false when the
   * previous swing is still inside the cooldown, so mashing the key animates
   * at the rate the server actually resolves swings.
   */
  swing(dirX: number, dirY: number, nowMs: number, cooldownMs = SWING_COOLDOWN_MS): boolean {
    if (!Number.isFinite(nowMs)) return false;
    if (nowMs - this.startedAt < cooldownMs) return false;
    const mag = Math.hypot(dirX, dirY);
    if (Number.isFinite(mag) && mag > 1e-4) {
      this.dx = dirX / mag;
      this.dy = dirY / mag;
    }
    this.startedAt = nowMs;
    return true;
  }

  /** True while the SWING_MS animation window is open. */
  isActive(nowMs: number): boolean {
    return Number.isFinite(nowMs) && nowMs - this.startedAt < SWING_MS && nowMs >= this.startedAt;
  }

  /** 0 -> 1 -> 0 progress of the current swing (0 when idle). */
  envelope(nowMs: number): number {
    return swingEnvelope(nowMs - this.startedAt);
  }

  get dirX(): number { return this.dx; }
  get dirY(): number { return this.dy; }
  /** Timestamp the current/next swing started. */
  get startedAtMs(): number { return this.startedAt; }

  clear(): void {
    this.startedAt = -1e9;
  }
}

// ---------------------------------------------------------------------------
// Kill confirmation
// ---------------------------------------------------------------------------

export interface KillBurstStyle {
  /** Ring + particle colour. */
  color: string;
  /** Particles thrown on the burst. */
  particles: number;
  /** Ring radius multiplier (finishers read bigger, not just brighter). */
  ringScale: number;
  /** How many rings expand (finishers get a double ring). */
  rings: number;
  /** Suggested camera shake contribution, in renderer units. */
  shake: number;
  /** Ring lifetime in ms. */
  lifeMs: number;
}

/**
 * Normal kill vs finisher. They differ in three non-colour ways (particle
 * count, ring count, ring size) as well as hue, so the distinction survives a
 * colourblind palette or a greyscale screenshot.
 */
export function killBurstStyle(finisher: boolean): KillBurstStyle {
  return finisher
    ? { color: '#ffcf3d', particles: 26, ringScale: 2.1, rings: 2, shake: 1.0, lifeMs: KILL_FX_MS + 160 }
    : { color: '#ffe9a8', particles: 14, ringScale: 1.15, rings: 1, shake: 0.4, lifeMs: KILL_FX_MS };
}

export interface KillFx {
  x: number;
  y: number;
  t0: number;
  lifeMs: number;
  r0: number;
  color: string;
  active: boolean;
}

/** Fixed ring of expanding kill rings (bright confirmation on both renderers). */
export class KillFxRing {
  readonly capacity = KILL_FX_MAX;
  private readonly slots: KillFx[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < KILL_FX_MAX; i++) {
      this.slots.push({ x: 0, y: 0, t0: 0, lifeMs: KILL_FX_MS, r0: 1, color: '#ffe9a8', active: false });
    }
  }

  /** Queue one ring. Non-finite positions are ignored. */
  spawn(x: number, y: number, style: KillBurstStyle, nowMs: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(nowMs)) return false;
    const s = this.slots[this.cursor]!;
    this.cursor = (this.cursor + 1) % KILL_FX_MAX;
    s.x = x;
    s.y = y;
    s.t0 = nowMs;
    s.lifeMs = style.lifeMs;
    s.r0 = style.ringScale;
    s.color = style.color;
    s.active = true;
    return true;
  }

  at(i: number): KillFx { return this.slots[i]!; }

  /** Expire finished rings (called once per frame). */
  step(nowMs: number): void {
    for (let i = 0; i < KILL_FX_MAX; i++) {
      const s = this.slots[i]!;
      if (s.active && nowMs - s.t0 >= s.lifeMs) s.active = false;
    }
  }

  clear(): void {
    for (let i = 0; i < KILL_FX_MAX; i++) this.slots[i]!.active = false;
    this.cursor = 0;
  }
}

// ---------------------------------------------------------------------------
// Heavy-hit detection (the server never flags a crit on the wire)
// ---------------------------------------------------------------------------

/**
 * Learns the player's typical swing damage from their own observed hits and
 * flags anything at least HEAVY_HIT_RATIO above it. A pure client-side stand-in
 * for the server's crit roll: it never invents a number, it only decides how
 * loudly an already-known number is presented.
 */
export class HeavyHitTracker {
  private ema = 0;
  private count = 0;

  /** Samples folded into the average so far. */
  get samples(): number { return this.count; }
  /** Current running average (0 until the first sample). */
  get average(): number { return this.ema; }

  /** Feed one hit; returns true when this hit reads as a heavy/crit hit. */
  observe(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const heavy =
      this.count >= HEAVY_HIT_MIN_SAMPLES && amount >= this.ema * HEAVY_HIT_RATIO;
    if (this.count === 0) this.ema = amount;
    else this.ema += (amount - this.ema) / (this.count + 1);
    this.count++;
    return heavy;
  }

  reset(): void {
    this.ema = 0;
    this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// Target prediction
// ---------------------------------------------------------------------------

export interface TargetCandidate {
  id: number;
  kind: string;
  x: number;
  y: number;
  hp: number;
}

/**
 * The mob a swing would hit: nearest living hostile inside MELEE_REACH of the
 * player. Mirrors the server's `nearestMobWithin` + `inReachOf` so the "this is
 * my target" HP bar matches what the next attack actually resolves against.
 * Returns -1 when nothing is in reach.
 */
export function pickMeleeTarget(
  ents: readonly TargetCandidate[],
  px: number,
  py: number,
  reach = MELEE_REACH,
): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  // A hair of slack on the squared comparison so a mob standing exactly at
  // MELEE_REACH is not dropped by float error and its bar flickers off at the
  // boundary. Sub-pixel in world terms.
  const limit = reach * reach + 1e-6;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]!;
    if (e.kind !== 'mob' && e.kind !== 'npc') continue;
    if (!(e.hp > 0)) continue;
    const dx = e.x - px, dy = e.y - py;
    const d = dx * dx + dy * dy;
    if (d > limit) continue;
    if (d > bestD) continue;
    bestD = d;
    best = e.id;
  }
  return best;
}