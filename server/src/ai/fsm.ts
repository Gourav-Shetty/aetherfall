// AETHERFALL AI — NPC finite-state machine.
// States: idle / patrol / chase / attack / flee / dead, plus the Hotline
// Miami alert chain: suspicious (heard noise, looks 1.5s) / search (lost
// sight, sweeps last-seen + neighbors 6s) / surrender (solo + low HP).
//
// Alert model: PATROL -> SUSPICIOUS (noise) -> ALERT (chase+attack, the two
// combat states) -> SEARCH (lost sight) -> PATROL. `nextState` is a pure
// transition function (unit-tested); `NPCFSM` adds the timers the tick
// needs (idle dwell, suspicious/search/surrender durations).

export type NPCState =
  | 'idle'
  | 'patrol'
  | 'chase'
  | 'attack'
  | 'flee'
  | 'dead'
  | 'suspicious'
  | 'search'
  | 'surrender';

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
  /** true when an attack/gunshot was heard within NOISE_RADIUS this tick */
  heardNoise?: boolean;
  /** suspicious look elapsed (sec) — set by NPCFSM, or manually in tests */
  suspiciousTime?: number;
  /** seconds to stare toward a noise before standing down */
  suspiciousDuration?: number;
  /** search sweep elapsed (sec) — set by NPCFSM, or manually in tests */
  searchTime?: number;
  /** seconds to sweep last-seen + neighbors before giving up */
  searchDuration?: number;
  /** surrender elapsed (sec) — set by NPCFSM, or manually in tests */
  surrenderTime?: number;
  /** seconds a surrender holds before the mob stands down to patrol */
  surrenderDuration?: number;
  /** true when the surrendered mob was hit (breaks the surrender) */
  wasAttacked?: boolean;
  /**
   * Backdoor for the surrender roll: npc.ts sets this when a solo low-HP
   * mob wins its 40% roll, so the pure function can route flee -> surrender.
   */
  wantSurrender?: boolean;
}

export const DEFAULT_IDLE_DURATION = 2.0;
/** Suspicious stare length: look toward the noise this long, then patrol. */
export const DEFAULT_SUSPICIOUS_DURATION = 1.5;
/** Search sweep length: check last-seen + 2 neighbors this long, then patrol. */
export const DEFAULT_SEARCH_DURATION = 6.0;
/** Surrender hold: stands down to patrol after this long unless attacked. */
export const DEFAULT_SURRENDER_DURATION = 20.0;

function hpFrac(p: FSMPerception): number {
  return p.maxHp > 0 ? p.hp / p.maxHp : 0;
}

/**
 * Pure transition function. Priority order:
 * dead > surrender-hold/break > flee (low hp under threat) > surrender
 * election > combat > acquisition > noise > recovery.
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
  const suspDone = (p.suspiciousTime ?? 0) >= (p.suspiciousDuration ?? DEFAULT_SUSPICIOUS_DURATION);
  const searchDone = (p.searchTime ?? 0) >= (p.searchDuration ?? DEFAULT_SEARCH_DURATION);
  const surrDone = (p.surrenderTime ?? 0) >= (p.surrenderDuration ?? DEFAULT_SURRENDER_DURATION);
  const electSurrender = !!p.wantSurrender && lowHp;

  // Surrendered mobs hold still until attacked (re-aggro) or the hold lapses.
  if (s === 'surrender') {
    if (p.wasAttacked) {
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      return 'patrol';
    }
    if (surrDone) return 'patrol';
    return 'surrender';
  }

  switch (s) {
    case 'idle': {
      if (electSurrender) return 'surrender';
      if (lowHp && hasTarget) return 'flee';
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      if (p.heardNoise) return 'suspicious';
      const dwell = p.idleTime ?? 0;
      const want = p.idleDuration ?? DEFAULT_IDLE_DURATION;
      if (dwell >= want) return 'patrol';
      return 'idle';
    }
    case 'patrol': {
      if (electSurrender) return 'surrender';
      if (lowHp && hasTarget) return 'flee';
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      if (p.heardNoise) return 'suspicious';
      return 'patrol';
    }
    case 'suspicious': {
      if (electSurrender) return 'surrender';
      if (lowHp && hasTarget) return 'flee';
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      if (suspDone) return 'patrol';
      return 'suspicious';
    }
    case 'chase': {
      if (electSurrender) return 'surrender';
      if (lowHp) return 'flee';
      if (inAttack) return 'attack';
      if (lostTarget) return 'search';
      return 'chase';
    }
    case 'attack': {
      if (electSurrender) return 'surrender';
      if (lowHp) return 'flee';
      if (!hasTarget) return 'search';
      // stick to the target until it clearly escapes
      if (p.distToTarget > p.attackRange * 2.5) return 'chase';
      return 'attack';
    }
    case 'search': {
      if (electSurrender) return 'surrender';
      if (lowHp && hasTarget) return 'flee';
      if (inAttack) return 'attack';
      if (inAggro) return 'chase';
      if (searchDone) return 'patrol';
      return 'search';
    }
    case 'flee': {
      if (electSurrender) return 'surrender';
      // recover once the threat is gone or far away
      if (!hasTarget) return 'patrol';
      if (p.distToTarget > p.aggroRange * 1.5) return 'patrol';
      return 'flee';
    }
  }
}

/** Stateful wrapper: owns state + dwell timers. */
export class NPCFSM {
  state: NPCState = 'idle';
  stateTime = 0;
  idleDuration: number;
  suspiciousDuration: number;
  searchDuration: number;
  surrenderDuration: number;

  constructor(
    initial: NPCState = 'idle',
    idleDuration = DEFAULT_IDLE_DURATION,
    opts: {
      suspiciousDuration?: number;
      searchDuration?: number;
      surrenderDuration?: number;
    } = {},
  ) {
    this.state = initial;
    this.idleDuration = idleDuration;
    this.suspiciousDuration = opts.suspiciousDuration ?? DEFAULT_SUSPICIOUS_DURATION;
    this.searchDuration = opts.searchDuration ?? DEFAULT_SEARCH_DURATION;
    this.surrenderDuration = opts.surrenderDuration ?? DEFAULT_SURRENDER_DURATION;
  }

  get dead(): boolean {
    return this.state === 'dead';
  }

  /**
   * Advance one tick. Returns the (possibly new) state.
   * Timer perceptions (`idleTime`, `suspiciousTime`, `searchTime`,
   * `surrenderTime`) are filled in from the internal timer so callers only
   * supply perceptions; per-call durations default to the instance tunables.
   */
  update(
    dt: number,
    p: Omit<FSMPerception, 'idleTime' | 'idleDuration' | 'suspiciousTime' | 'searchTime' | 'surrenderTime'>,
  ): NPCState {
    this.stateTime += dt;
    const full: FSMPerception = {
      ...p,
      idleTime: this.state === 'idle' ? this.stateTime : 0,
      idleDuration: this.idleDuration,
      suspiciousTime: this.state === 'suspicious' ? this.stateTime : 0,
      suspiciousDuration: p.suspiciousDuration ?? this.suspiciousDuration,
      searchTime: this.state === 'search' ? this.stateTime : 0,
      searchDuration: p.searchDuration ?? this.searchDuration,
      surrenderTime: this.state === 'surrender' ? this.stateTime : 0,
      surrenderDuration: p.surrenderDuration ?? this.surrenderDuration,
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
