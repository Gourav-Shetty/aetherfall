// @aetherfall/server — tick performance instrumentation (snapshot hot path).
//
// `metrics.ts` already tracks cumulative tick avg/p95 and per-section totals.
// This module adds the two things you need to chase a regression on a live
// server without re-running under a profiler:
//
//   1. a cumulative Prometheus tick-duration histogram (le = 1,2,5,10,25,50,100,+Inf)
//   2. a slow-tick log: every tick over SLOW_TICK_MS (50ms) is counted, and a
//      per-section breakdown for that exact tick is emitted on a rate-limited
//      single line so a spike is attributable to sim / gameplay / npc /
//      snapshot / db.
//
// Both are exposed on GET /metrics (see index.ts).

/** A tick slower than this is a "slow tick" (the 20Hz budget is 50ms). */
export const SLOW_TICK_MS = 50;

/** Histogram upper bounds in ms. The trailing bucket is the +Inf catch-all. */
export const HIST_BOUNDS_MS: readonly number[] = [1, 2, 5, 10, 25, 50, 100];

/** Sections reported in the slow-tick breakdown, in pipeline order. */
export const PERF_SECTIONS = ['sim', 'gameplay', 'npc', 'snapshot', 'db'] as const;

export type PerfSection = (typeof PERF_SECTIONS)[number];

export type PerfSections = Record<PerfSection, number>;

/**
 * Snapshot sub-stages in pipeline order (egress-profile, additive).
 *
 * The `snapshot` tick section mixes three unrelated costs: interest
 * collection (`InterestIndex.collectIndices` + `updateKnownIndices`), frame
 * encoding (serialize-once pre-pass + per-viewer splice / binary `encodeView`)
 * and socket writes (`ws.send` + metrics accounting). This split records each
 * one separately per snapshot tick (10Hz) so the egress ceiling driver is
 * attributable without a profiler. Totals only — no per-tick retention.
 */
export const SNAP_STAGES = ['collect', 'encode', 'send'] as const;

export type SnapStage = (typeof SNAP_STAGES)[number];

export type SnapSplit = Record<SnapStage, number>;

export type SlowTick = {
  tick: number;
  totalMs: number;
  sections: PerfSections;
  players: number;
};

export type PerfOptions = {
  /** Slow-tick threshold in ms. Default SLOW_TICK_MS. */
  slowMs?: number;
  /** How many recent slow ticks to retain for /metrics. Default 8. */
  maxRecent?: number;
  /** Minimum ms between slow-tick log lines. Default 1000. */
  logEveryMs?: number;
  /** Log sink; defaults to console.warn. */
  log?: (line: string) => void;
};

const DEFAULTS = { slowMs: SLOW_TICK_MS, maxRecent: 8, logEveryMs: 1000 } as const;

/**
 * Records one tick per fixed-step iteration. Allocation-free on the hot path
 * (a handful of float adds) so it is safe to call unconditionally.
 */
export class Perf {
  readonly slowMs: number;
  readonly maxRecent: number;
  readonly logEveryMs: number;

  ticks = 0;
  totalMs = 0;
  maxMs = 0;
  slowTicks = 0;
  slowTotalMs = 0;
  /** Slow ticks not logged due to the rate limit (still counted above). */
  slowLogsSuppressed = 0;

  /** Cumulative histogram; last slot is the +Inf overflow bucket. */
  private buckets: Float64Array;
  private recent: SlowTick[] = [];
  private lastLogAt = Number.NEGATIVE_INFINITY;
  private log: (line: string) => void;

  /** Snapshot sub-stage totals (ms) and per-stage maxima, 10Hz observations. */
  snapTicks = 0;
  snapTotal: SnapSplit = { collect: 0, encode: 0, send: 0 };
  snapMax: SnapSplit = { collect: 0, encode: 0, send: 0 };

  constructor(opts: PerfOptions = {}) {
    this.slowMs = opts.slowMs ?? DEFAULTS.slowMs;
    this.maxRecent = Math.max(0, opts.maxRecent ?? DEFAULTS.maxRecent);
    this.logEveryMs = opts.logEveryMs ?? DEFAULTS.logEveryMs;
    this.buckets = new Float64Array(HIST_BOUNDS_MS.length + 1);
    this.log = opts.log ?? ((line) => console.warn(line));
  }

  /** Slow-tick ratio (0..1) over all recorded ticks. */
  get slowRatio(): number {
    return this.ticks === 0 ? 0 : this.slowTicks / this.ticks;
  }

  /** Mean duration of slow ticks only (ms), 0 when there are none. */
  get slowAvgMs(): number {
    return this.slowTicks === 0 ? 0 : this.slowTotalMs / this.slowTicks;
  }

  /** Most recent slow ticks, oldest first (bounded by maxRecent). */
  recentSlowTicks(): SlowTick[] {
    return this.recent;
  }

  /** Buckets as Prometheus `le` -> cumulative count, including `+Inf`. */
  histogram(): Record<string, number> {
    const out: Record<string, number> = {};
    let running = 0;
    for (let i = 0; i < HIST_BOUNDS_MS.length; i++) {
      running += this.buckets[i]!;
      out[HIST_BOUNDS_MS[i]!] = running;
    }
    out['+Inf'] = running + this.buckets[HIST_BOUNDS_MS.length]!;
    return out;
  }

  /**
   * Record one tick. `sections` is the per-section breakdown measured for this
   * same tick; it is only retained (and logged) when the tick is slow, so the
   * happy path does not copy anything.
   */
  record(tick: number, totalMs: number, sections: PerfSections, players: number, nowMs = Date.now()): void {
    this.ticks++;
    this.totalMs += totalMs;
    if (totalMs > this.maxMs) this.maxMs = totalMs;

    const b = this.buckets;
    let i = 0;
    while (i < HIST_BOUNDS_MS.length && totalMs > HIST_BOUNDS_MS[i]!) i++;
    b[i]! += 1;

    if (totalMs < this.slowMs) return;
    this.slowTicks++;
    this.slowTotalMs += totalMs;

    // Only slow ticks pay for the entry copy.
    const entry: SlowTick = { tick, totalMs, sections: { ...sections }, players };
    if (this.maxRecent > 0) {
      this.recent.push(entry);
      if (this.recent.length > this.maxRecent) this.recent.shift();
    }

    if (nowMs - this.lastLogAt < this.logEveryMs) {
      this.slowLogsSuppressed++;
      return;
    }
    this.lastLogAt = nowMs;
    this.log(formatSlowTick(entry));
  }

  /**
   * Record one snapshot tick's sub-stage split (ms). ~10 calls/s; a few
   * float adds, safe on the hot path. Negative inputs are clamped to 0
   * (a backward clock step must not poison the averages).
   */
  observeSnapSplit(collectMs: number, encodeMs: number, sendMs: number): void {
    const c = Math.max(0, collectMs);
    const e = Math.max(0, encodeMs);
    const s = Math.max(0, sendMs);
    this.snapTicks++;
    this.snapTotal.collect += c;
    this.snapTotal.encode += e;
    this.snapTotal.send += s;
    if (c > this.snapMax.collect) this.snapMax.collect = c;
    if (e > this.snapMax.encode) this.snapMax.encode = e;
    if (s > this.snapMax.send) this.snapMax.send = s;
  }

  /** Mean ms per snapshot tick per sub-stage (0 when nothing observed). */
  snapAvg(): SnapSplit {
    if (this.snapTicks === 0) return { collect: 0, encode: 0, send: 0 };
    return {
      collect: this.snapTotal.collect / this.snapTicks,
      encode: this.snapTotal.encode / this.snapTicks,
      send: this.snapTotal.send / this.snapTicks,
    };
  }

  /** Prometheus text exposition fragment (append to metrics.render()). */
  render(): string {
    const L: string[] = [];
    L.push('# HELP aetherfall_tick_ms Tick duration histogram (cumulative)');
    L.push('# TYPE aetherfall_tick_ms histogram');
    for (const [le, count] of Object.entries(this.histogram())) {
      L.push(`aetherfall_tick_ms_bucket{le="${le}"} ${count}`);
    }
    L.push(`aetherfall_tick_ms_sum ${this.totalMs.toFixed(3)}`);
    L.push(`aetherfall_tick_ms_count ${this.ticks}`);
    L.push('# HELP aetherfall_slow_ticks_total Ticks over the 50ms budget');
    L.push('# TYPE aetherfall_slow_ticks_total counter');
    L.push(`aetherfall_slow_ticks_total ${this.slowTicks}`);
    L.push('# HELP aetherfall_slow_ticks_ratio Fraction of ticks over the 50ms budget');
    L.push('# TYPE aetherfall_slow_ticks_ratio gauge');
    L.push(`aetherfall_slow_ticks_ratio ${this.slowRatio.toFixed(6)}`);
    L.push('# HELP aetherfall_slow_tick_ms_avg Mean duration of slow ticks only');
    L.push('# TYPE aetherfall_slow_tick_ms_avg gauge');
    L.push(`aetherfall_slow_tick_ms_avg ${this.slowAvgMs.toFixed(3)}`);
    L.push('# HELP aetherfall_tick_ms_max Worst single tick since boot');
    L.push('# TYPE aetherfall_tick_ms_max gauge');
    L.push(`aetherfall_tick_ms_max ${this.maxMs.toFixed(3)}`);
    L.push('# HELP aetherfall_slow_tick_logs_suppressed Slow ticks counted but not logged (rate limit)');
    L.push('# TYPE aetherfall_slow_tick_logs_suppressed counter');
    L.push(`aetherfall_slow_tick_logs_suppressed ${this.slowLogsSuppressed}`);
    L.push('# HELP aetherfall_recent_slow_tick_ms Recent slow ticks with section breakdown (oldest first)');
    L.push('# TYPE aetherfall_recent_slow_tick_ms gauge');
    for (const s of this.recent) {
      L.push(`aetherfall_recent_slow_tick_ms{tick="${s.tick}",players="${s.players}"} ${s.totalMs.toFixed(3)}`);
      for (const sec of PERF_SECTIONS) {
        L.push(`aetherfall_recent_slow_tick_section_ms{tick="${s.tick}",section="${sec}"} ${s.sections[sec].toFixed(3)}`);
      }
    }
    L.push('# HELP aetherfall_snapshot_split_ticks_total Snapshot ticks with a sub-stage split recorded');
    L.push('# TYPE aetherfall_snapshot_split_ticks_total counter');
    L.push(`aetherfall_snapshot_split_ticks_total ${this.snapTicks}`);
    L.push('# HELP aetherfall_snapshot_split_ms_avg Mean ms per snapshot tick by sub-stage (collect=interest, encode=frames, send=socket writes)');
    L.push('# TYPE aetherfall_snapshot_split_ms_avg gauge');
    L.push('# HELP aetherfall_snapshot_split_ms_max Worst single snapshot tick by sub-stage');
    L.push('# TYPE aetherfall_snapshot_split_ms_max gauge');
    const avg = this.snapAvg();
    for (const stage of SNAP_STAGES) {
      L.push(`aetherfall_snapshot_split_ms_avg{stage="${stage}"} ${avg[stage].toFixed(3)}`);
      L.push(`aetherfall_snapshot_split_ms_max{stage="${stage}"} ${this.snapMax[stage].toFixed(3)}`);
    }
    return L.join('\n') + '\n';
  }

  reset(): void {
    this.ticks = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.slowTicks = 0;
    this.slowTotalMs = 0;
    this.slowLogsSuppressed = 0;
    this.buckets.fill(0);
    this.recent.length = 0;
    this.lastLogAt = Number.NEGATIVE_INFINITY;
    this.snapTicks = 0;
    this.snapTotal = { collect: 0, encode: 0, send: 0 };
    this.snapMax = { collect: 0, encode: 0, send: 0 };
  }
}

/** One-line, greppable slow-tick log with the section breakdown. */
export function formatSlowTick(s: SlowTick): string {
  const parts = PERF_SECTIONS.map((sec) => `${sec}=${s.sections[sec].toFixed(2)}`);
  return (
    `[perf] slow tick ${s.tick} total=${s.totalMs.toFixed(2)}ms ` +
    `(${parts.join(' ')}) players=${s.players}`
  );
}

/** Process-wide singleton wired into server/src/index.ts. */
export const perf = new Perf();
