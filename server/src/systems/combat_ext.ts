// @aetherfall/systems — combat_ext: damage types, resistances, crit, block,
// stagger/knockback, damage-over-time (burn) and heal-over-time.
//
// Design contract: every exported function is PURE. State goes in,
// a NEW state object plus a list of events come out. No mutation of inputs,
// no Date.now(), no Math.random() except via an injected `rand` argument
// (default Math.random). The server tick therefore owns state and simply
// replays `events` as `t:'event'` payloads (protocol v1 untouched).

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** The three damage channels. `holy` is the armour-piercing lane. */
export const DAMAGE_TYPES = ['physical', 'fire', 'holy'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Crit: 5% base chance, x2 multiplier. */
export const CRIT_CHANCE = 0.05;
export const CRIT_MULTIPLIER = 2;

/** Block: 30% damage reduction, 200 ms internal cooldown. */
export const BLOCK_REDUCTION = 0.3;
export const BLOCK_COOLDOWN_MS = 200;

/**
 * Stagger: a single hit that lands >= STAGGER_HP_FRACTION of the target's
 * max HP (or that breaks its poise) interrupts the target for STAGGER_MS.
 * Staggered combatants cannot swing and are immune to further stagger.
 */
export const STAGGER_HP_FRACTION = 0.25;
export const STAGGER_MS = 1200;
export const POISE_MAX = 100;
export const POISE_DAMAGE_PER_HP = 1; // 1 poise per HP of damage dealt
export const POISE_REGEN_PER_SEC = 10;

/** Knockback: `KNOCKBACK_UNITS` travelled over `KNOCKBACK_MS` (caller lerps). */
export const KNOCKBACK_UNITS = 1.8;
export const KNOCKBACK_MS = 220;

/** Burn (DoT). Ticks every second for 4s. Immune targets take no burn at all. */
export const BURN_TICK_MS = 1000;
export const BURN_DURATION_MS = 4000;
export const BURN_DAMAGE_PER_TICK = 6;

/** Regeneration (HoT). Ticks every second for 5s, never overheals past max. */
export const HOT_TICK_MS = 1000;
export const HOT_DURATION_MS = 5000;
export const HOT_HEAL_PER_TICK = 8;

// ---------------------------------------------------------------------------
// Resistances
// ---------------------------------------------------------------------------

/** Partial resistance map. Values are FRACTIONS REDUCED, clamped to [0, 1]. */
export type Resistances = Partial<Record<DamageType, number>>;

/**
 * Per-mob resistances. Tuned so zone threats stay meaningful: meadow mobs are
 * physical, dungeon mobs resist fire, volcano mobs resist fire heavily and
 * take bonus holy, bosses split the difference.
 */
export const MOB_RESISTANCES: Record<string, Resistances> = {
  gloomfang: { physical: 0.1, fire: 0, holy: -0.1 },
  mistwisp: { physical: 0.25, fire: 0.25, holy: 0 },
  thornback: { physical: 0.3, fire: -0.1, holy: 0 },
  'meadow-sprite': { physical: 0, fire: 0.4, holy: -0.15 },
  ashcrawler: { physical: 0.2, fire: 0.3, holy: 0 },
  'hollow-knight': { physical: 0.35, fire: 0, holy: 0.15 },
  'cinder-imp': { physical: 0.1, fire: 0.5, holy: -0.2 },
  'caldera-wyrm': { physical: 0.15, fire: 0.45, holy: -0.25 },
  'void-wisp': { physical: -0.1, fire: 0.2, holy: 0.35 },
  'magma-golem': { physical: 0.25, fire: 0.6, holy: -0.3 },
  'ember-wyrm': { physical: 0.2, fire: 0.5, holy: 0.1 },
  'crypt-warden': { physical: 0.3, fire: -0.2, holy: 0.4 },
};

export function isDamageType(t: string): t is DamageType {
  return (DAMAGE_TYPES as readonly string[]).includes(t);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Resistances for a mob name (empty table for unknown names). Never null. */
export function resistancesForMob(mobName: string): Resistances {
  return { ...(MOB_RESISTANCES[mobName] ?? {}) };
}

/** Remaining damage multiplier after resistance. `1 - resist`, clamped. */
export function resistFactor(resistances: Resistances | undefined, type: DamageType): number {
  const r = resistances?.[type];
  if (r === undefined) return 1;
  return 1 - clamp01(r);
}

/**
 * Apply resistance to a flat damage number. Fully immune (resist 1) yields 0;
 * negative resistance (vulnerable) is capped at +50% so it never trivialises
 * content. Result is rounded up to a whole point, min 0.
 */
export function applyResistance(amount: number, resistances: Resistances | undefined, type: DamageType): number {
  if (amount <= 0) return 0;
  const resist = resistances?.[type] ?? 0;
  const capped = resist >= 1 ? 1 : resist <= -0.5 ? -0.5 : resist;
  const dealt = amount * (1 - capped);
  return dealt <= 0 ? 0 : Math.ceil(dealt);
}

// ---------------------------------------------------------------------------
// Combatant state
// ---------------------------------------------------------------------------

export type Vec2 = { x: number; y: number };

export type CombatantState = {
  id: number;
  name: string;
  pos: Vec2;
  hp: number;
  maxHp: number;
  /** Resistance map; absent = takes full damage from everything. */
  resistances?: Resistances;
  /** ms timestamp of the last successful block (BLOCK_COOLDOWN_MS gate). */
  lastBlockAt: number;
  /** Whether this combatant may block at all (mobs with `blockable:false`). */
  blockable: boolean;
  /** ms timestamp until which the combatant is staggered; 0 = not staggered. */
  staggeredUntil: number;
  /** Stagger poise pool; empties -> stagger. Regenerates out of combat. */
  poise: number;
  dead: boolean;
};

export function makeCombatant(
  id: number,
  x: number,
  y: number,
  opts: { name?: string; maxHp?: number; resistances?: Resistances; blockable?: boolean; lastBlockAt?: number; poise?: number } = {},
): CombatantState {
  const maxHp = opts.maxHp ?? 100;
  return {
    id,
    name: opts.name ?? `unit-${id}`,
    pos: { x, y },
    hp: maxHp,
    maxHp,
    ...(opts.resistances ? { resistances: { ...opts.resistances } } : {}),
    lastBlockAt: opts.lastBlockAt ?? -Infinity,
    blockable: opts.blockable ?? true,
    staggeredUntil: 0,
    poise: opts.poise ?? POISE_MAX,
    dead: false,
  };
}

export function isDead(c: CombatantState): boolean {
  return c.dead || c.hp <= 0;
}

export function isStaggered(c: CombatantState, now: number): boolean {
  return c.staggeredUntil > now;
}

// ---------------------------------------------------------------------------
// Crit + block
// ---------------------------------------------------------------------------

/** Roll for crit. `rand` defaults to Math.random; inject a seeded RNG in tests. */
export function rollCrit(rand: () => number = Math.random, chance: number = CRIT_CHANCE): boolean {
  if (chance <= 0) return false;
  if (chance >= 1) return true;
  return rand() < chance;
}

/** Apply the crit multiplier (x2 base). Rounded to a whole point. */
export function applyCrit(amount: number, crit: boolean, multiplier: number = CRIT_MULTIPLIER): number {
  return crit ? Math.max(0, Math.round(amount * multiplier)) : Math.max(0, amount);
}

/** True when BLOCK_COOLDOWN_MS has elapsed since the last block. */
export function canBlock(now: number, c: CombatantState): boolean {
  if (isDead(c) || !c.blockable || isStaggered(c, now)) return false;
  return now - c.lastBlockAt >= BLOCK_COOLDOWN_MS;
}

/** Damage left after a successful block (BLOCK_REDUCTION = 30%). */
export function applyBlock(amount: number, reduction: number = BLOCK_REDUCTION): number {
  const r = clamp01(reduction);
  return Math.max(0, Math.round(amount * (1 - r)));
}

// ---------------------------------------------------------------------------
// Stagger + knockback
// ---------------------------------------------------------------------------

export type StaggerCheck = { staggered: boolean; poiseLeft: number };

/**
 * Poise-based stagger: damage drains poise 1:1 (HP_FRACTION route also works
 * for high-damage builds). An already-staggered target cannot be re-staggered.
 */
export function checkStagger(before: CombatantState, damage: number, now: number, hpFraction: number = STAGGER_HP_FRACTION): StaggerCheck {
  const poiseLeft = Math.max(0, before.poise - Math.max(0, damage) * POISE_DAMAGE_PER_HP);
  if (isStaggered(before, now)) return { staggered: false, poiseLeft };
  const poiseBroken = before.poise > 0 && poiseLeft <= 0;
  const bigHit = before.maxHp > 0 && damage >= before.maxHp * hpFraction;
  return { staggered: poiseBroken || bigHit, poiseLeft };
}

/**
 * Knockback destination. Falls back to +X push when the combatants overlap so
 * the vector is never NaN. Walls are the caller's problem (see server walls).
 */
export function computeKnockback(
  target: Vec2,
  attacker: Vec2,
  units: number = KNOCKBACK_UNITS,
): Vec2 {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || !Number.isFinite(len)) return { x: target.x + units, y: target.y };
  const scale = units / len;
  return { x: target.x + dx * scale, y: target.y + dy * scale };
}

/** Poise regen for combatants not staggered and not hit recently. */
export function regenPoise(c: CombatantState, dtMs: number, now: number): CombatantState {
  if (isDead(c) || isStaggered(c, now)) return c;
  if (c.poise >= POISE_MAX) return c;
  const gained = (dtMs / 1000) * POISE_REGEN_PER_SEC;
  return { ...c, poise: Math.min(POISE_MAX, c.poise + gained) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CombatEvent =
  | { type: 'damage'; targetId: number; amount: number; damageType: DamageType; crit: boolean; blocked: boolean }
  | { type: 'immune'; targetId: number; damageType: DamageType }
  | { type: 'block'; targetId: number; reduced: number }
  | { type: 'stagger'; targetId: number; until: number }
  | { type: 'knockback'; targetId: number; from: Vec2; to: Vec2; units: number }
  | { type: 'dot-apply'; targetId: number; effectId: string }
  | { type: 'dot-tick'; targetId: number; effectId: string; amount: number; remainingMs: number }
  | { type: 'hot-tick'; targetId: number; effectId: string; amount: number }
  | { type: 'death'; targetId: number };

export type HitInput = {
  /** Raw damage before resistance/crit/block. */
  amount: number;
  type: DamageType;
  /** ms timestamp of the swing. */
  now: number;
  /** Optional crit roll override (for tests / scripted enemies). */
  crit?: boolean;
  /** Force-block (AI tells the mob to guard). */
  guard?: boolean;
};

export type HitResult = {
  state: CombatantState;
  events: CombatEvent[];
  /** Final HP actually removed, after resistance + crit + block. */
  dealt: number;
  crit: boolean;
  blocked: boolean;
  staggered: boolean;
  killed: boolean;
};

/**
 * THE damage pipeline, in fixed order:
 *   dead check -> resistance -> crit -> block -> apply -> stagger -> knockback -> death
 * Returns a fresh target state; the input is never mutated.
 */
export function resolveHit(
  attacker: CombatantState,
  target: CombatantState,
  hit: HitInput,
  rand: () => number = Math.random,
): HitResult {
  const events: CombatEvent[] = [];
  const none = (s: CombatantState): HitResult => ({
    state: s,
    events,
    dealt: 0,
    crit: false,
    blocked: false,
    staggered: false,
    killed: false,
  });
  if (isDead(target)) return none(target);
  if (hit.amount <= 0) return none(target);

  // 1. resistance
  const afterResist = applyResistance(hit.amount, target.resistances, hit.type);
  if (afterResist <= 0) {
    events.push({ type: 'immune', targetId: target.id, damageType: hit.type });
    return none(target);
  }

  // 2. crit
  const crit = hit.crit ?? rollCrit(rand);
  const afterCrit = applyCrit(afterResist, crit);

  // 3. block (200ms cooldown; blocking does NOT stop a stagger from a big hit)
  const blocked = hit.guard === true && canBlock(hit.now, target);
  const finalDamage = blocked ? applyBlock(afterCrit) : afterCrit;

  // 4. apply
  let hp = Math.max(0, target.hp - finalDamage);
  let state: CombatantState = { ...target, hp };
  events.push({
    type: 'damage',
    targetId: target.id,
    amount: finalDamage,
    damageType: hit.type,
    crit,
    blocked,
  });
  if (blocked) {
    events.push({ type: 'block', targetId: target.id, reduced: afterCrit - finalDamage });
    state = { ...state, lastBlockAt: hit.now };
  }

  // 5. stagger + 6. knockback
  let staggered = false;
  if (finalDamage > 0) {
    const check = checkStagger(state, finalDamage, hit.now);
    state = { ...state, poise: check.poiseLeft };
    if (check.staggered) {
      staggered = true;
      const until = hit.now + STAGGER_MS;
      state = { ...state, staggeredUntil: until };
      events.push({ type: 'stagger', targetId: target.id, until });
      const to = computeKnockback(state.pos, attacker.pos);
      events.push({
        type: 'knockback',
        targetId: target.id,
        from: { ...state.pos },
        to,
        units: KNOCKBACK_UNITS,
      });
      state = { ...state, pos: to };
    }
  }

  // 7. death
  let killed = false;
  if (hp <= 0 && !state.dead) {
    killed = true;
    state = { ...state, dead: true, hp: 0 };
    events.push({ type: 'death', targetId: target.id });
  }

  return { state, events, dealt: finalDamage, crit, blocked, staggered, killed };
}

// ---------------------------------------------------------------------------
// Burn (DoT) + Regeneration (HoT)
// ---------------------------------------------------------------------------

export type TimedEffect = {
  id: string;
  targetId: number;
  kind: 'burn' | 'regen';
  amountPerTick: number;
  startedAt: number;
  expiresAt: number;
  intervalMs: number;
  lastTickAt: number;
};

/** Factory for a burn stack. Defaults: 4s / 1s ticks / 6 dmg per tick. */
export function makeBurn(
  id: string,
  targetId: number,
  now: number,
  opts: { damagePerTick?: number; durationMs?: number; intervalMs?: number } = {},
): TimedEffect {
  const intervalMs = opts.intervalMs ?? BURN_TICK_MS;
  const durationMs = opts.durationMs ?? BURN_DURATION_MS;
  return {
    id,
    targetId,
    kind: 'burn',
    amountPerTick: opts.damagePerTick ?? BURN_DAMAGE_PER_TICK,
    startedAt: now,
    expiresAt: now + durationMs,
    intervalMs,
    lastTickAt: now,
  };
}

/** Factory for a regeneration stack. Defaults: 5s / 1s ticks / 8 hp per tick. */
export function makeRegen(
  id: string,
  targetId: number,
  now: number,
  opts: { healPerTick?: number; durationMs?: number; intervalMs?: number } = {},
): TimedEffect {
  const intervalMs = opts.intervalMs ?? HOT_TICK_MS;
  const durationMs = opts.durationMs ?? HOT_DURATION_MS;
  return {
    id,
    targetId,
    kind: 'regen',
    amountPerTick: opts.healPerTick ?? HOT_HEAL_PER_TICK,
    startedAt: now,
    expiresAt: now + durationMs,
    intervalMs,
    lastTickAt: now,
  };
}

/**
 * Does this effect still have time left? Inclusive at `expiresAt` so a 4s burn
 * on a 1s interval lands its fourth tick before it is swept.
 */
export function isEffectActive(e: TimedEffect, now: number): boolean {
  return now <= e.expiresAt;
}

/**
 * Apply one burn stack to a target. Burning is a fire damage source, so fire
 * resistance applies — a magma-golem at 60% fire resist barely burns. Fully
 * immune targets reject the application entirely (no effect is created).
 */
export function applyBurn(
  target: CombatantState,
  effect: TimedEffect,
  now: number,
): { state: CombatantState; applied: boolean; events: CombatEvent[] } {
  const events: CombatEvent[] = [];
  const resist = target.resistances?.fire ?? 0;
  if (resist >= 1) {
    events.push({ type: 'immune', targetId: target.id, damageType: 'fire' });
    return { state: target, applied: false, events };
  }
  if (isDead(target) || effect.kind !== 'burn' || !isEffectActive(effect, now)) {
    return { state: target, applied: false, events };
  }
  events.push({ type: 'dot-apply', targetId: target.id, effectId: effect.id });
  return { state: target, applied: true, events };
}

export type EffectTickResult = {
  state: CombatantState;
  /** Effects still alive after this tick (expired ones removed). */
  effects: TimedEffect[];
  events: CombatEvent[];
  /** Total damage dealt this tick. */
  dotDamage: number;
  /** Total healing done this tick. */
  hotHealing: number;
};

/**
 * Advance every timed effect on ONE combatant by `now`. Ticks are quantised to
 * the effect's interval and catch up if the tick is late (capped at 10 ticks to
 * stop a long stall from exploding damage). Burn damage goes through fire
 * resistance and can kill; regen never overheals and never revives.
 */
export function tickEffects(
  target: CombatantState,
  effects: TimedEffect[],
  now: number,
): EffectTickResult {
  const out: CombatEvent[] = [];
  const kept: TimedEffect[] = [];
  let hp = target.hp;
  let dotDamage = 0;
  let hotHealing = 0;

  for (const e of effects) {
    if (e.targetId !== target.id) {
      kept.push(e);
      continue;
    }
    if (!isEffectActive(e, now) || isDead({ ...target, hp })) {
      continue; // expired (or dead combatant stops burning) -> drop
    }
    const due = Math.floor(Math.max(0, now - e.lastTickAt) / e.intervalMs);
    const ticks = Math.min(10, Math.max(0, due));
    if (ticks === 0) {
      kept.push(e);
      continue;
    }
    const lastTickAt = e.lastTickAt + ticks * e.intervalMs;
    const updated: TimedEffect = { ...e, lastTickAt };
    for (let i = 0; i < ticks; i++) {
      if (e.kind === 'burn') {
        const amount = applyResistance(e.amountPerTick, target.resistances, 'fire');
        if (amount <= 0) continue;
        hp = Math.max(0, hp - amount);
        dotDamage += amount;
        out.push({
          type: 'dot-tick',
          targetId: target.id,
          effectId: e.id,
          amount,
          remainingMs: Math.max(0, e.expiresAt - lastTickAt),
        });
      } else {
        if (hp <= 0) continue; // regen never revives
        const before = hp;
        hp = Math.min(target.maxHp, hp + e.amountPerTick);
        const healed = hp - before;
        if (healed > 0) {
          hotHealing += healed;
          out.push({ type: 'hot-tick', targetId: target.id, effectId: e.id, amount: healed });
        }
      }
    }
    if (lastTickAt < e.expiresAt) kept.push(updated);
  }

  let state: CombatantState = hp === target.hp ? target : { ...target, hp };
  if (hp <= 0 && !state.dead) {
    state = { ...state, dead: true, hp: 0 };
    out.push({ type: 'death', targetId: target.id });
  }
  return { state, effects: kept, events: out, dotDamage, hotHealing };
}

// ---------------------------------------------------------------------------
// Batch helpers
// ---------------------------------------------------------------------------

/** Tick a whole roster, dropping dead combatants' effects. */
export function tickRoster(
  roster: Map<number, CombatantState>,
  effects: TimedEffect[],
  now: number,
): { roster: Map<number, CombatantState>; effects: TimedEffect[]; events: CombatEvent[] } {
  const nextRoster = new Map(roster);
  const events: CombatEvent[] = [];
  const kept: TimedEffect[] = [];
  const buckets = new Map<number, TimedEffect[]>();
  for (const e of effects) {
    const list = buckets.get(e.targetId);
    if (list) list.push(e);
    else buckets.set(e.targetId, [e]);
  }
  for (const [id, list] of buckets) {
    const c = nextRoster.get(id);
    if (!c) continue;
    const r = tickEffects(c, list, now);
    nextRoster.set(id, r.state);
    kept.push(...r.effects);
    events.push(...r.events);
  }
  return { roster: nextRoster, effects: kept, events };
}