// @aetherfall/server — SIGTERM/SIGINT drain mode (graceful shutdown).
//
// Without this, `docker stop` / `systemctl stop` / a CI job killing a server
// mid-shutdown tore sockets down mid-tick and skipped the DB flush, losing the
// buffered world snapshot. Drain makes shutdown ordered:
//
//   1. stop accepting   — new connections get WS 1013 "server draining", and
//                         the metrics/healthz surface reports `draining = 1`.
//   2. finish the tick  — wait for the in-flight tick to return (the loop marks
//                         begin/end), so no half-applied snapshot is emitted.
//   3. flush the DB     — flushSnapshots()/close() in dependency order.
//   4. hard timeout     — DRAIN_TIMEOUT_MS (default 5000) after which the
//                         process exits regardless, so a stuck step can never
//                         wedge a deploy.
//
// The class is pure (no process.exit by default, timers injectable) so
// drain.test.ts can assert every step and the timeout path deterministically.

import { OpsLog, opsLog as defaultLog } from './opslog.js';

export type DrainState = 'running' | 'draining' | 'stopped';

/** One ordered shutdown step. Steps run in registration order. */
export type DrainStep = {
  name: string;
  run: () => void | Promise<void>;
};

export type DrainReport = {
  reason: string;
  /** Steps that completed, in order. */
  steps: string[];
  /** Steps that threw (name -> message). Shutdown continues regardless. */
  failed: Record<string, string>;
  /** ms spent waiting for in-flight ticks. */
  waitedMs: number;
  /** True when the hard timeout fired before the tick finished. */
  timedOut: boolean;
  /** Total ms from signal to 'stopped'. */
  durationMs: number;
};

export type DrainOptions = {
  /** Hard budget for the whole drain. Default DRAIN_TIMEOUT_MS (5000). */
  timeoutMs?: number;
  /** Signals to trap. Default ['SIGTERM', 'SIGINT']. */
  signals?: NodeJS.Signals[];
  /** Structured log sink. */
  log?: OpsLog;
  /** Process exit on completion / hard timeout. Default process.exit. */
  exit?: (code: number) => void;
  /** Invoked on every state transition (wire to the `draining` gauge). */
  onState?: (state: DrainState, previous: DrainState) => void;
  /** Install the process signal handlers. Default true. */
  install?: boolean;
  /** Timer seam for tests. Default global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** Default hard drain budget in ms. */
export const DRAIN_TIMEOUT_MS = 5000;

/** DRAIN_TIMEOUT_MS env override (0 or less falls back to the default). */
export function drainTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.DRAIN_TIMEOUT_MS ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : DRAIN_TIMEOUT_MS;
}

export class DrainController {
  readonly timeoutMs: number;
  private readonly log: OpsLog;
  private readonly signals: NodeJS.Signals[];
  private readonly exitFn: (code: number) => void;
  private readonly onState: (state: DrainState, previous: DrainState) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private steps: DrainStep[] = [];
  private handlers: Array<{ signal: NodeJS.Signals; fn: () => void }> = [];
  private inFlightTicks = 0;
  private idleWaiters: Array<() => void> = [];
  private _state: DrainState = 'running';
  private drainStartedAt = Date.now();
  private shutdownPromise: Promise<DrainReport> | null = null;
  private hardTimer: unknown = null;
  private lastReport: DrainReport | null = null;

  constructor(opts: DrainOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? drainTimeoutMs();
    this.log = opts.log ?? defaultLog;
    this.signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
    this.exitFn = opts.exit ?? ((code: number) => process.exit(code));
    this.onState = opts.onState ?? (() => undefined);
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as unknown);
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (opts.install !== false) this.install();
  }

  get state(): DrainState {
    return this._state;
  }

  /** True while the process still takes new player connections. */
  get accepting(): boolean {
    return this._state === 'running';
  }

  /** Milliseconds since the drain began (0 while running). */
  get drainMs(): number {
    return this._state === 'running' ? 0 : Date.now() - this.drainStartedAt;
  }

  get report(): DrainReport | null {
    return this.lastReport;
  }

  /** True when a tick is currently executing (drain waits for it). */
  get tickInFlight(): boolean {
    return this.inFlightTicks > 0;
  }

  /** Register a shutdown step. Later registrations run later. */
  addStep(name: string, run: () => void | Promise<void>): void {
    this.steps.push({ name, run });
  }

  /** Add steps from a record (object key order). */
  addSteps(steps: Record<string, () => void | Promise<void>>): void {
    for (const [name, run] of Object.entries(steps)) this.addStep(name, run);
  }

  install(): void {
    for (const signal of this.signals) {
      const fn = (): void => {
        void this.shutdown(signal);
      };
      process.on(signal, fn);
      this.handlers.push({ signal, fn });
    }
  }

  uninstall(): void {
    for (const { signal, fn } of this.handlers) {
      try {
        process.off(signal, fn);
      } catch {
        /* ignore */
      }
    }
    this.handlers = [];
  }

  /** Mark the start of a fixed-step tick; drain waits for these to finish. */
  tickStart(): void {
    this.inFlightTicks++;
  }

  /** Mark the end of a fixed-step tick (call from a finally block). */
  tickEnd(): void {
    this.inFlightTicks = Math.max(0, this.inFlightTicks - 1);
    if (this.inFlightTicks === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Resolves once no tick is in flight. */
  whenIdle(): Promise<void> {
    if (this.inFlightTicks === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private setState(next: DrainState): void {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    try {
      this.onState(next, prev);
    } catch {
      /* a bad gauge hook must not block shutdown */
    }
  }

  /**
   * Run the drain exactly once. Concurrent/repeat signals join the in-flight
   * shutdown instead of restarting it, so a double SIGTERM is harmless.
   */
  shutdown(reason = 'shutdown'): Promise<DrainReport> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.run(reason);
    return this.shutdownPromise;
  }

  private async run(reason: string): Promise<DrainReport> {
    const t0 = Date.now();
    this.drainStartedAt = t0;
    const report: DrainReport = {
      reason,
      steps: [],
      failed: {},
      waitedMs: 0,
      timedOut: false,
      durationMs: 0,
    };
    this.lastReport = report;

    this.log.event('drain-begin', { reason, timeoutMs: this.timeoutMs, tick: this.log.tick });
    this.setState('draining');

    // Hard deadline: whatever happens below, we exit by t0 + timeoutMs.
    this.hardTimer = this.setTimer(() => {
      report.timedOut = true;
      this.log.event('drain-timeout', { reason, waitedMs: report.waitedMs, steps: report.steps });
      this.setState('stopped');
      this.exitFn(0);
    }, this.timeoutMs);

    const deadline = t0 + this.timeoutMs;

    // 1) stop accepting + 2) tell clients + 3) flush, in registration order.
    for (const step of this.steps) {
      try {
        await step.run();
        report.steps.push(step.name);
      } catch (err) {
        report.failed[step.name] = err instanceof Error ? err.message : String(err);
        this.log.error('drain-step-failed', { step: step.name, err });
      }
    }

    // 2b) let the in-flight tick finish inside the remaining budget.
    const waitStarted = Date.now();
    const remaining = Math.max(0, deadline - waitStarted);
    if (this.inFlightTicks > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.clearTimer(bail);
          resolve();
        };
        const bail = this.setTimer(done, remaining);
        void this.whenIdle().then(done);
      });
    }
    report.waitedMs = Date.now() - waitStarted;
    if (this.inFlightTicks > 0) {
      report.timedOut = true;
      this.log.warn('drain-tick-abandoned', { inFlight: this.inFlightTicks, waitedMs: report.waitedMs });
    }

    if (this.hardTimer !== null) {
      this.clearTimer(this.hardTimer);
      this.hardTimer = null;
    }
    report.durationMs = Date.now() - t0;
    this.setState('stopped');
    this.log.event('drain-complete', {
      reason,
      steps: report.steps,
      failed: Object.keys(report.failed),
      timedOut: report.timedOut,
      durationMs: report.durationMs,
    });
    return report;
  }
}