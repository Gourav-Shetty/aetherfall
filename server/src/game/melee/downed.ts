// @aetherfall/gameplay — melee finish loop: shared downed/finisher tuning and
// mob adapters. Mobs reduced to 0 HP by a close-quarters swing go DOWNED and
// crawl for DOWNED_DURATION_MS; only a melee swing inside FINISH_RANGE
// finishes them. Projectile-equivalent hits knock down but never finish, and
// an unanswered knockdown stands back up at partial HP — waiting at range
// buys nothing, so the killer must walk up and take the risk.
//
// Canonical numbers live in systems/combat_ext.ts (single source of truth);
// this module re-exports them beside the spawner-Mob adapters so the melee
// path, the throw path and the NPC brains all read the same values.

import {
  ARMED_PICKUP_RANGE,
  DOWNED_DURATION_MS,
  DOWNED_RECOVER_FRAC,
  FINISH_RANGE,
  FINISHER_BONUS_XP,
  HIT_STOP_MS,
  THROW_RANGE,
  THROW_STUN_MS,
  UNARMED_PICKUP_RANGE,
} from '../../systems/combat_ext.js';
import type { Mob } from '../combat.js';

export {
  ARMED_PICKUP_RANGE,
  DOWNED_DURATION_MS,
  DOWNED_RECOVER_FRAC,
  FINISH_RANGE,
  FINISHER_BONUS_XP,
  HIT_STOP_MS,
  THROW_RANGE,
  THROW_STUN_MS,
  UNARMED_PICKUP_RANGE,
};

/** True while the mob's crawl timer still covers `now`. */
export function isMobDowned(m: Pick<Mob, 'downedUntil'>, now: number): boolean {
  return (m.downedUntil ?? 0) > now;
}

/** True while the mob's stun timer still covers `now`. */
export function isMobStunned(m: Pick<Mob, 'stunUntil'>, now: number): boolean {
  return (m.stunUntil ?? 0) > now;
}

/**
 * Can this swing finish the mob? Requires a downed target, a melee
 * (non-ranged) swing, and the attacker inside FINISH_RANGE of the target.
 */
export function canFinishMob(
  attacker: { x: number; y: number },
  target: Pick<Mob, 'pos' | 'downedUntil'>,
  now: number,
  opts: { ranged?: boolean; range?: number } = {},
): boolean {
  if (opts.ranged === true) return false;
  if (!isMobDowned(target, now)) return false;
  const range = opts.range ?? FINISH_RANGE;
  const dx = attacker.x - target.pos.x;
  const dy = attacker.y - target.pos.y;
  return dx * dx + dy * dy <= range * range;
}

/** HP a recovered mob stands back up with (min 1). */
export function recoverHpFor(maxHp: number, frac: number = DOWNED_RECOVER_FRAC): number {
  return Math.max(1, Math.ceil(maxHp * Math.max(0, frac)));
}
