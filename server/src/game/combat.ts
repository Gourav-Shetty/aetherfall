// @aetherfall/gameplay — melee combat: range, cooldowns, hp/dmg, death/respawn, aggro.
// Pure functions + small mutable helpers so tests and server tick can share logic.
// Protocol-safe: callers translate results into `t:'event'` payloads; nothing here touches sockets.

export const MELEE_RANGE = 2.2;
export const ATTACK_COOLDOWN_MS = 800;
export const BASE_DMG = 12;
export const MAX_HP = 100;
export const RESPAWN_DELAY_MS = 5000;
export const AGGRO_RANGE = 12;
export const DEAGGRO_RANGE = 20;

export type Vec = { x: number; y: number };

export type Fighter = {
  id: number;
  pos: Vec;
  hp: number;
  maxHp: number;
  alive: boolean;
  lastAttackAt: number; // ms timestamp of last swing
  respawnAt: number; // ms timestamp when dead fighter respawns (0 if alive)
  level: number;
  /** Optional flat damage bonus (weapons/skills). Defaults to 0. */
  bonusDmg?: number;
  /** ms timestamp until which the fighter is downed (crawls); 0/undefined = up. */
  downedUntil?: number;
  /** ms timestamp until which the fighter is stunned (no actions); 0/undefined = free. */
  stunUntil?: number;
};

export type Mob = Fighter & {
  spawnPos: Vec;
  targetId: number | null; // aggro target player id
  name: string;
};

export function makeFighter(id: number, x: number, y: number, level = 1, maxHp = MAX_HP): Fighter {
  return { id, pos: { x, y }, hp: maxHp, maxHp, alive: true, lastAttackAt: -Infinity, respawnAt: 0, level };
}

export function makeMob(id: number, x: number, y: number, name = 'gloomfang', level = 1): Mob {
  const maxHp = MAX_HP + (level - 1) * 20;
  return {
    ...makeFighter(id, x, y, level, maxHp),
    spawnPos: { x, y },
    targetId: null,
    name,
  };
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function inMeleeRange(a: Vec, b: Vec, range = MELEE_RANGE): boolean {
  return dist(a, b) <= range;
}

/**
 * MELEE: reach also accepts a bare `{x,y}` holder (GamePlayer) so callers
 * on the input hot path do not have to allocate a throwaway Vec per swing.
 */
export function inReachOf(a: { x: number; y: number }, b: Vec, range = MELEE_RANGE): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= range * range;
}

export function damageFor(level: number, bonusDmg = 0): number {
  return BASE_DMG + (level - 1) * 3 + bonusDmg;
}

// MELEE: resistance + crit resolution for a player swing. combat_ext (the pure
// systems layer) is imported here so there is exactly ONE damage pipeline
// in the codebase rather than a second, divergent formula in this module.
import { applyCrit, applyResistance, resistFactor, resistancesForMob, rollCrit } from '../systems/combat_ext.js';

export type MeleeResolution = {
  /** Post-resistance, post-crit damage to apply to the target. */
  dmg: number;
  crit: boolean;
  /** Flat multiplier the mob applies to physical damage (`1 - resist`). */
  resist: number;
};

/**
 * Resolve one player swing against a named mob.
 *
 * Base damage stays `damageFor(level, bonusDmg)` — the same curve
 * `tryMeleeAttack` and `content.meleeDamageFor` use, so hits-to-kill is
 * unchanged for a mob with no resistance entry and docs/WORLD.md's TTK table
 * stays valid. On top of that, combat_ext contributes exactly the two things a
 * basic swing can express: the mob's physical resistance and the 5% crit (x2).
 *
 * Deliberately NOT applied here: block, stagger and knockback. Blocking is an
 * NPC-side decision rather than a swing outcome, and spawner mobs are static
 * grid entries — a knockback would need a cell re-file on every hit for no
 * gameplay gain. Those lanes remain available to skill/boss code that wants
 * them via combat_ext directly.
 *
 * `rand` is injected so tests and replay stay deterministic.
 */
export function resolveMeleeDamage(
  attackerLevel: number,
  mobName: string,
  opts: { bonusDmg?: number; crit?: boolean; rand?: () => number } = {},
): MeleeResolution {
  const rand = opts.rand ?? Math.random;
  const raw = damageFor(attackerLevel, opts.bonusDmg ?? 0);
  const res = resistancesForMob(mobName);
  const afterResist = applyResistance(raw, res, 'physical');
  const crit = opts.crit ?? rollCrit(rand);
  return { dmg: applyCrit(afterResist, crit), crit, resist: resistFactor(res, 'physical') };
}

export function canAttack(now: number, attacker: Fighter): boolean {
  return attacker.alive && now - attacker.lastAttackAt >= ATTACK_COOLDOWN_MS;
}

export type AttackResult =
  | { ok: true; dmg: number; killed: boolean }
  | { ok: false; reason: 'dead' | 'cooldown' | 'out-of-range' };

/** Authoritative melee swing. Mutates target/attacker timestamps. Returns outcome. */
export function tryMeleeAttack(
  now: number,
  attacker: Fighter,
  target: Fighter,
  opts: { range?: number } = {},
): AttackResult {
  if (!attacker.alive || !target.alive) return { ok: false, reason: 'dead' };
  if (!canAttack(now, attacker)) return { ok: false, reason: 'cooldown' };
  if (!inMeleeRange(attacker.pos, target.pos, opts.range ?? MELEE_RANGE)) {
    return { ok: false, reason: 'out-of-range' };
  }
  attacker.lastAttackAt = now;
  const dmg = damageFor(attacker.level, attacker.bonusDmg ?? 0);
  target.hp -= dmg;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.respawnAt = now + RESPAWN_DELAY_MS;
    return { ok: true, dmg, killed: true };
  }
  return { ok: true, dmg, killed: false };
}

/** Respawn fighters whose timer elapsed. Returns ids that respawned. */
export function updateRespawns(now: number, fighters: Fighter[], home?: (f: Fighter) => Vec): number[] {
  const out: number[] = [];
  for (const f of fighters) {
    if (!f.alive && f.respawnAt > 0 && now >= f.respawnAt) {
      f.alive = true;
      f.hp = f.maxHp;
      f.respawnAt = 0;
      if (home) f.pos = home(f);
      else if ((f as Mob).spawnPos) f.pos = { ...(f as Mob).spawnPos };
      out.push(f.id);
    }
  }
  return out;
}

/**
 * Aggro: each mob targets the nearest alive player within AGGRO_RANGE of the
 * mob, and drops the target beyond DEAGGRO_RANGE. Returns mob ids whose target changed.
 *
 * Downed and stunned mobs drop their target and acquire none while the timer
 * runs (pass `now`; omitted = legacy behaviour, no downed/stun filtering).
 */
export function updateAggro(mobs: Mob[], players: Fighter[], now?: number): number[] {
  const changed: number[] = [];
  for (const m of mobs) {
    if (!m.alive) {
      if (m.targetId !== null) {
        m.targetId = null;
        changed.push(m.id);
      }
      continue;
    }
    if (now !== undefined && ((m.downedUntil ?? 0) > now || (m.stunUntil ?? 0) > now)) {
      if (m.targetId !== null) {
        m.targetId = null;
        changed.push(m.id);
      }
      continue;
    }
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = dist(m.pos, p.pos);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    const prev = m.targetId;
    if (best === null || bestD > DEAGGRO_RANGE) m.targetId = null;
    else if (bestD <= AGGRO_RANGE || (prev === best.id && bestD <= DEAGGRO_RANGE)) m.targetId = best.id;
    // else: keep previous target (hysteresis) — prev stays
    if (m.targetId !== prev) changed.push(m.id);
  }
  return changed;
}
