// @aetherfall/server — drift-compensating fixed-step scheduler.
//
// Why this exists: `setInterval(fn, 50)` on Windows never holds 20Hz. The OS
// timer granularity (~15.6ms) rounds every 50ms sleep up to ~62.4ms, so the
// loop measures 11-16Hz even idle and `tick_drift_ticks` grows without bound.
// This scheduler chains `setTimeout` off an absolute deadline
// (`nextTick = last + period`) so a late wake shortens the next sleep and the
// long-run average converges to the target. Brief lateness (<= maxCatchUp
// periods) runs extra fixed steps back-to-back to catch up; sustained
// lateness sheds load (skip + count) instead of spiralling.
//
// Contract:
//   - periodMs: nominal step (20Hz => 50ms).
//   - maxCatchUp (default 2): extra steps per wakeup when briefly behind.
//   - else skip: run a single step, count the dropped periods, advance the
//     deadline on the absolute grid so the phase does not drift.
//   - Gameplay/AI 10Hz halves stay aligned because they key off `sim.tick`
//     (even/odd), and every executed step increments it exactly once.
//   - `perf.record` / `snapshotFrame` are called once per executed step by the
//     tick body, never by this scheduler, so the perf hooks are untouched.

export const DEFAULT_MAX_CATCH_UP = 2;

export type TickTimerFn = (fn: () => void, ms: number) => unknown;
export type TickClearFn = (handle: unknown) => void;

export type TickSchedulerOptions = {
  periodMs: number;
  maxCatchUp?: number;
  now?: () => number;
  setTimer?: TickTimerFn;
  clearTimer?: TickClearFn;
  onCatchUp?: (extra: number) => void;
  onSkip?: (skipped: number) => void;
};

export type TickPlan = {
  /** Wall-clock periods missed before this wake (0 = on time). */
  missed: number;
  /** Fixed steps to execute now (1 nominal + catch-up, or 1 when skipping). */
  ticksToRun: number;
  /** Wall-clock periods dropped (0 unless skipping). */
  skipped: number;
  /** Next absolute deadline after accounting for every missed period. */
  nextTickMs: number;
};

/**
 * Pure deadline math, extracted for deterministic unit tests.
 * `wakeNowMs` is the wall time of this wake, `nextTickMs` the deadline it met.
 */
export function planTicks(
  wakeNowMs: number,
  nextTickMs: number,
  periodMs: number,
  maxCatchUp: number = DEFAULT_MAX_CATCH_UP,
): TickPlan {
  if (!(periodMs > 0)) throw new Error('planTicks: periodMs must be > 0');
  const cap = Math.max(0, Math.floor(maxCatchUp));
  let missed = Math.floor((wakeNowMs - nextTickMs) / periodMs);
  if (!Number.isFinite(missed)) missed = 0;
  if (missed < 0) missed = 0; // early wake: treat as on time, keep the grid
  if (missed <= cap) {
    return { missed, ticksToRun: 1 + missed, skipped: 0, nextTickMs: nextTickMs + (1 + missed) * periodMs };
  }
  return { missed, ticksToRun: 1, skipped: missed, nextTickMs: nextTickMs + (1 + missed) * periodMs };
}

export class TickScheduler {
  readonly periodMs: number;
  readonly maxCatchUp: number;
  private readonly now: () => number;
  private readonly setTimerFn: TickTimerFn;
  private readonly clearTimerFn: TickClearFn;
  private readonly onCatchUp: ((extra: number) => void) | undefined;
  private readonly onSkip: ((skipped: number) => void) | undefined;
  private readonly tickFn: () => void;

  private timer: unknown = null;
  private nextTickMs = 0;
  private _running = false;

  /** Total fixed steps executed (includes catch-up). */
  ticksExecuted = 0;
  /** Total wall-clock periods dropped by the skip path. */
  ticksSkipped = 0;
  /** Extra steps beyond one-per-wakeup (sum of catch-up). */
  catchUpTicks = 0;
  /** Wakes that ran at least one catch-up step. */
  catchUpBatches = 0;
  /** Total timer fires. */
  wakes = 0;

  constructor(tickFn: () => void, opts: TickSchedulerOptions) {
    if (!(opts.periodMs > 0)) throw new Error('TickScheduler: periodMs must be > 0');
    this.tickFn = tickFn;
    this.periodMs = opts.periodMs;
    this.maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
    this.now = opts.now ?? Date.now;
    this.setTimerFn = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as unknown);
    this.clearTimerFn = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onCatchUp = opts.onCatchUp;
    this.onSkip = opts.onSkip;
  }

  get isRunning(): boolean {
    return this._running;
  }

  get nextTick(): number {
    return this.nextTickMs;
  }

  start(nowMs?: number): void {
    if (this._running) return;
    this._running = true;
    const t = nowMs ?? this.now();
    this.nextTickMs = t + this.periodMs;
    this.timer = this.setTimerFn(() => this.onWake(), this.periodMs);
  }

  stop(): void {
    this._running = false;
    if (this.timer !== null) {
      try {
        this.clearTimerFn(this.timer);
      } catch {
        /* ignore */
      }
      this.timer = null;
    }
  }

  private onWake(): void {
    if (!this._running) return;
    this.timer = null;
    this.wakes++;
    const wakeNow = this.now();
    const plan = planTicks(wakeNow, this.nextTickMs, this.periodMs, this.maxCatchUp);
    this.nextTickMs = plan.nextTickMs;
    if (plan.skipped > 0) {
      this.ticksSkipped += plan.skipped;
      try {
        this.onSkip?.(plan.skipped);
      } catch {
        /* a metrics hook must not break the loop */
      }
    } else if (plan.missed > 0) {
      this.catchUpTicks += plan.missed;
      this.catchUpBatches++;
      try {
        this.onCatchUp?.(plan.missed);
      } catch {
        /* ignore */
      }
    }
    try {
      for (let i = 0; i < plan.ticksToRun; i++) {
        this.tickFn();
        this.ticksExecuted++;
      }
    } finally {
      if (!this._running) return;
      const after = this.now();
      let delay = this.nextTickMs - after;
      if (!Number.isFinite(delay) || delay < 0) delay = 0;
      this.timer = this.setTimerFn(() => this.onWake(), delay);
    }
  }
}
