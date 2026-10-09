// AETHERFALL AI — NPC finite-state machine.
// States: idle / patrol / chase / attack / flee / dead.
// `nextState` is a pure transition function (unit-tested); `NPCFSM`
// adds the timers (idle dwell, attack cooldown) the tick needs.

export type NPCState =
  | 'idle'
  | 'patrol'
  | 'chase'
  | 'attack'
  | 'flee'
  | 'dead';

/** Per-tick perception snapshot feeding the transition function. */
export interface FSMPerception {
  hp: number;
  maxHp: number;
  /** false when no living target is acquired */
  targetVisible: boolean;
  /** distance to current target; Infinity when none */
  distToTarget: number;
  /** melee/strike range */
  attackRange: number;
  /** acquire targets inside this radius */
  aggroRange: number;
  /** flee when hp/maxHp is at or below this (0..1) */
  fleeThreshold: number;
  /** idle dwell elapsed (sec) — set by NPCFSM, or manually in tests */
  idleTime?: number;
  /** seconds to loiter in idle before patrolling */
  idleDuration?: number;
}

export const DEFAULT_IDLE_DURATION = 2.0;

function hpFrac(p: FSMPerception): number {
  return p.maxHp > 0 ? p.hp / p.maxHp : 0;
}

/**
 * Pure transition function. Priority order:
 * dead > flee (low hp under threat) > combat > acquisition > recovery.
 */
export function nextState(s: NPCState, p: FSMPerception): NPCState {
  if (p.hp <= 0) return 'dead';
  if (s === 'dead') return 'dead';

  const lowHp = hpFrac(p) <= p.fleeThreshold;
  const hasTarget = p.targetVisible && p.distToTarget !== Infinity;
  const inAggro = hasTarget && p.distToTarget <= p.aggroRange;
  const inAttack = hasTarget && p.distToTarget <= p.attackRange;
  const lostTarget =
    !hasTarget || p.distToTarget > p.aggroRange * 2.5;

  switch (s) {
    case 'idle': {
      if (lowHp && hasTarget) return 'flee';
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      const dwell = p.idleTime ?? 0;
      const want = p.idleDuration ?? DEFAULT_IDLE_DURATION;
      if (dwell >= want) return 'patrol';
      return 'idle';
    }
    case 'patrol': {
      if (lowHp && hasTarget) return 'flee';
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      return 'patrol';
    }
    case 'chase': {
      if (lowHp) return 'flee';
      if (inAttack) return 'attack';
      if (lostTarget) return 'patrol';
      return 'chase';
    }
    case 'attack': {
      if (lowHp) return 'flee';
      if (!hasTarget) return 'patrol';
      // stick to the target until it clearly escapes
      if (p.distToTarget > p.attackRange * 2.5) return 'chase';
      return 'attack';
    }
    case 'flee': {
      // recover once the threat is gone or far away
      if (!hasTarget) return 'patrol';
      if (p.distToTarget > p.aggroRange * 1.5) return 'patrol';
      return 'flee';
    }
  }
}

/** Stateful wrapper: owns state + idle dwell timer. */
export class NPCFSM {
  state: NPCState = 'idle';
  stateTime = 0;
  idleDuration: number;

  constructor(initial: NPCState = 'idle', idleDuration = DEFAULT_IDLE_DURATION) {
    this.state = initial;
    this.idleDuration = idleDuration;
  }

  get dead(): boolean {
    return this.state === 'dead';
  }

  /**
   * Advance one tick. Returns the (possibly new) state.
   * `p.idleTime/idleDuration` are filled in from the internal timer
   * so callers only supply perceptions.
   */
  update(dt: number, p: Omit<FSMPerception, 'idleTime' | 'idleDuration'>): NPCState {
    this.stateTime += dt;
    const full: FSMPerception = {
      ...p,
      idleTime: this.state === 'idle' ? this.stateTime : 0,
      idleDuration: this.idleDuration,
    };
    const n = nextState(this.state, full);
    if (n !== this.state) {
      this.state = n;
      this.stateTime = 0;
    }
    return this.state;
  }

  /** Force a state (spawn, respawn, debug). Resets the timer. */
  force(s: NPCState): void {
    this.state = s;
    this.stateTime = 0;
  }
}
