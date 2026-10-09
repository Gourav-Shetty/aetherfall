// @aetherfall/server — zero-dependency Prometheus-style metrics.
// Tracks: tick duration (ms), players connected, snapshot bytes, anticheat rejects.
// Exposed as Prometheus text exposition on GET /metrics (see index.ts).
// Also serves GET /healthz -> {"ok":true,...} on the same metrics port.
//
// Operational metrics — additive extension. Nothing above this line changed: every
// pre-existing field, method and rendered line is byte-identical so older
// dashboards/alerts keep working. Added below:
//   * gameplay gauges   players alive, mobs alive, mobs killed (5m), avg HP%,
//                       active quests, parties, anticheat strikes
//   * wire gauges       binary vs json frame counts, snapshot encode µs,
//                       wire bytes/player/s
//   * histograms        tick-duration buckets + snapshot-duration buckets
//   * ops gauges        schedule lag / tick drift, errors, process memory,
//                       shard load ratio, drain state, build info
// Every new family emits its own `# HELP` + `# TYPE` line ahead of its samples
// (see metrics.test.ts, which parses the whole exposition).

export type RejectKind = 'input-rate' | 'speed' | 'teleport' | 'burst' | 'shadowban';

/** Tick-section profiler: per-section avg/max over a rolling window. */
export type TickSection = 'sim' | 'gameplay' | 'npc' | 'snapshot' | 'db' | 'total';

/** Every section, in pipeline order, for stable exposition output. */
export const ALL_TICK_SECTIONS: readonly TickSection[] = ['sim', 'gameplay', 'npc', 'snapshot', 'db', 'total'];

const MAX_TICK_SAMPLES = 512;

/** Rolling-rate window (seconds) for per-second gauges (wire bytes, errors). */
export const RATE_WINDOW_SEC = 15;
/** Rolling window for the "kills in the last 5 minutes" gauge. */
export const KILL_WINDOW_SEC = 300;
/** Cumulative histogram bounds in ms for the server tick. */
export const OPS_TICK_HIST_MS: readonly number[] = [1, 2, 5, 10, 25, 50, 100, 250];
/** Cumulative histogram bounds in ms for one snapshot encode+broadcast stage. */
export const OPS_SNAPSHOT_HIST_MS: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25];

/** Wire encoding of one outbound frame. */
export type FrameKind = 'json' | 'binary';

/** Coarse error buckets for `aetherfall_errors_total`. */
export type ErrorKind = 'tick' | 'http' | 'ws' | 'persist';

export const ERROR_KINDS: readonly ErrorKind[] = ['tick', 'http', 'ws', 'persist'];

/**
 * Fixed-size ring of per-second counters. O(1) add, O(window) read. Used for
 * the rate gauges (wire bytes/s, errors/min) that alerts and dashboards need;
 * monotonic totals stay available separately as `_total` counters.
 */
export class RollingRate {
  private readonly buf: Float64Array;
  private readonly stamps: Int32Array;

  constructor(readonly windowSec: number = RATE_WINDOW_SEC) {
    this.buf = new Float64Array(Math.max(1, windowSec));
    this.stamps = new Int32Array(Math.max(1, windowSec)).fill(-1);
  }

  /** Monotonic lifetime total (never decays). */
  total = 0;

  add(n: number, nowMs: number = Date.now()): void {
    if (!Number.isFinite(n) || n === 0) return;
    this.total += n;
    const sec = Math.floor(nowMs / 1000);
    const w = this.buf.length;
    const slot = ((sec % w) + w) % w;
    // Slot reuse after a full window: drop the stale value before adding.
    if (this.stamps[slot] !== sec) {
      this.stamps[slot] = sec;
      this.buf[slot] = 0;
    }
    this.buf[slot] += n;
  }

  /** Sum of every populated second still inside the window. */
  windowSum(nowMs: number = Date.now()): number {
    const sec = Math.floor(nowMs / 1000);
    let sum = 0;
    for (let i = 0; i < this.stamps.length; i++) {
      const age = sec - this.stamps[i]!;
      if (this.stamps[i]! >= 0 && age >= 0 && age < this.stamps.length) sum += this.buf[i]!;
    }
    return sum;
  }

  /** Mean per second across the populated part of the window. */
  perSec(nowMs: number = Date.now()): number {
    const sec = Math.floor(nowMs / 1000);
    let sum = 0;
    let oldest = -1;
    for (let i = 0; i < this.stamps.length; i++) {
      const age = sec - this.stamps[i]!;
      if (this.stamps[i]! >= 0 && age >= 0 && age < this.stamps.length) {
        sum += this.buf[i]!;
        if (oldest < 0 || this.stamps[i]! < oldest) oldest = this.stamps[i]!;
      }
    }
    if (oldest < 0) return 0;
    // Divide by the span actually covered, not the window size, so a
    // partially filled window (server just booted) does not read as idle.
    const span = Math.min(this.stamps.length, sec - oldest + 1);
    return sum / span;
  }

  /** Mean per minute across the populated part of the window. */
  perMin(nowMs: number = Date.now()): number {
    return this.perSec(nowMs) * 60;
  }

  reset(): void {
    this.buf.fill(0);
    this.stamps.fill(-1);
    this.total = 0;
  }
}

/** Cumulative Prometheus histogram (`le` buckets + the +Inf overflow slot). */
export class OpsHistogram {
  private readonly counts: Float64Array;
  private overflow = 0;
  sum = 0;
  count = 0;

  constructor(readonly boundsMs: readonly number[]) {
    this.counts = new Float64Array(Math.max(0, boundsMs.length));
  }

  observe(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.count++;
    this.sum += ms;
    let i = 0;
    while (i < this.boundsMs.length && ms > this.boundsMs[i]!) i++;
    if (i === this.boundsMs.length) this.overflow++;
    else this.counts[i]! += 1;
  }

  /**
   * Cumulative buckets as ordered `[le, count]` pairs including the `+Inf`
   * catch-all. An array (not an object) because JS objects reorder
   * integer-like keys, which would scramble `le` for decimal bounds.
   */
  cumulative(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    let running = 0;
    for (let i = 0; i < this.boundsMs.length; i++) {
      running += this.counts[i]!;
      out.push([String(this.boundsMs[i]), running]);
    }
    out.push(['+Inf', running + this.overflow]);
    return out;
  }

  reset(): void {
    this.counts.fill(0);
    this.overflow = 0;
    this.sum = 0;
    this.count = 0;
  }
}

/** Fixed-window percentile over the rolling sample buffer (values may be empty). */
function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)));
  return s[i]!;
}

/** Escape a label value for Prometheus text exposition (backslash, quote, newline). */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Format a label set as `{k="v",...}` (empty string when there are no labels). */
export function renderLabels(labels: ReadonlyArray<readonly [string, string]>): string {
  if (labels.length === 0) return '';
  return `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

/** Partial gameplay view pushed once per tick from the server loop. */
export type GameplayView = {
  /** Connected players with hp > 0. */
  playersAlive?: number;
  /** Live spawner mobs + AI NPCs/bosses. */
  mobsAlive?: number;
  /** Quests in progress (started, not yet done). */
  questsActive?: number;
  /** Live parties. */
  parties?: number;
  /** Sum of shadow-ban strikes currently held across all players. */
  anticheatStrikes?: number;
  /** Highest strike count held by any single player. */
  anticheatStrikesMax?: number;
  /** Mean player hp fraction, 0..1. */
  hpRatio?: number;
};

/** Build/identity labels rendered on `aetherfall_info`. */
export type InfoView = {
  shard?: string;
  version?: string;
  protocol?: string | number;
  backend?: string;
};

export class Metrics {
  startedAt = Date.now();
  tickCount = 0;
  tickTotalMs = 0;
  tickLastMs = 0;
  private tickSamples: number[] = [];
  private sections = new Map<TickSection, { total: number; count: number; max: number }>();

  players = 0;
  connectionsTotal = 0;

  snapshotsSent = 0;
  snapshotBytesTotal = 0;
  snapshotLastBytes = 0;

  rejects: Record<RejectKind, number> = { 'input-rate': 0, speed: 0, teleport: 0, burst: 0, shadowban: 0 };

  // --- ops state (all additive; defaults are a valid cold-start view) ---

  /** Connected players with hp > 0. */
  playersAlive = 0;
  /** Live mobs (spawner + AI NPCs/bosses). */
  mobsAlive = 0;
  /** Mean player hp fraction 0..1 (1 = everyone at full health). */
  hpRatio = 0;
  /** Quests in progress. */
  questsActive = 0;
  /** Live parties. */
  parties = 0;
  /** Shadow-ban strikes currently held (sum over players). */
  anticheatStrikes = 0;
  /** Worst single-player strike count (0 = nobody is one kick away). */
  anticheatStrikesMax = 0;

  /** Lifetime mob kills. */
  mobsKilledTotal = 0;

  /** Frames written to sockets, split by wire encoding. */
  framesJson = 0;
  framesBinary = 0;

  /** Lifetime outbound bytes across every frame type (not just snapshots). */
  wireBytesTotal = 0;

  /** Snapshot encode cost (serialise entities + splice per-viewer frames). */
  snapshotEncodeUsLast = 0;
  snapshotEncodeUsTotal = 0;
  snapshotEncodeSamples: number[] = [];

  /** Snapshot stage duration (ms) -> histogram. */
  snapshotMs = new OpsHistogram(OPS_SNAPSHOT_HIST_MS);
  /** Tick duration (ms) -> histogram. */
  tickMs = new OpsHistogram(OPS_TICK_HIST_MS);

  /** Tick schedule tracking. */
  private scheduleBaseMs = 0;
  private scheduleTicks = 0;
  private lastTickAtMs = 0;
  /** Configured cadence (20Hz => 50ms). 0 until the first observeSchedule(). */
  tickTargetHz = 0;
  /** Most recent tick's overshoot past one period (a stall detector, not a clock). */
  tickLagMs = 0;
  /** Worst single-tick overshoot since boot. */
  tickLagMaxMs = 0;
  /** actual ticks - ticks the wall clock says should have run since boot. */
  tickDriftTicks = 0;
  /** Wall-clock periods dropped by the drift-compensating scheduler (skip path). */
  ticksSkippedTotal = 0;
  /** Extra fixed steps executed to catch up when briefly behind. */
  tickCatchUpTotal = 0;

  /** Error counters by coarse kind. */
  errors: Record<ErrorKind, number> = { tick: 0, http: 0, ws: 0, persist: 0 };

  /** 1 while SIGTERM drain mode is active (alerting / LB deregistration). */
  draining = 0;

  /** Connected players / shard admission cap (Infinity -> 0). */
  shardLoadRatio = 0;
  shardCapacity = 0;

  info: InfoView = {};

  private wireRate = new RollingRate(RATE_WINDOW_SEC);
  private errorRate = new RollingRate(60);
  private killRate = new RollingRate(KILL_WINDOW_SEC);
  private tickRate = new RollingRate(RATE_WINDOW_SEC);
  private memory = process.memoryUsage();

  observeTick(ms: number): void {
    this.tickCount++;
    this.tickTotalMs += ms;
    this.tickLastMs = ms;
    this.tickSamples.push(ms);
    if (this.tickSamples.length > MAX_TICK_SAMPLES) this.tickSamples.shift();
    this.tickMs.observe(ms);
  }

  /** Record one tick-section duration (ms). */
  observeSection(section: TickSection, ms: number): void {
    const s = this.sections.get(section) ?? { total: 0, count: 0, max: 0 };
    s.total += ms;
    s.count++;
    if (ms > s.max) s.max = ms;
    this.sections.set(section, s);
  }

  sectionAvg(section: TickSection): number {
    const s = this.sections.get(section);
    return !s || s.count === 0 ? 0 : s.total / s.count;
  }

  sectionMax(section: TickSection): number {
    return this.sections.get(section)?.max ?? 0;
  }

  /** Sections sorted slowest-first — top entry is the tick bottleneck. */
  topSections(): Array<{ section: TickSection; avg: number; max: number; count: number }> {
    return [...this.sections.entries()]
      .map(([section, s]) => ({ section, avg: s.total / Math.max(1, s.count), max: s.max, count: s.count }))
      .sort((a, b) => b.avg - a.avg);
  }

  /** Rolling tick histogram buckets (ms) over the sample window. */
  tickHistogram(): Record<string, number> {
    const buckets: Record<string, number> = { '<=1': 0, '<=2': 0, '<=5': 0, '<=10': 0, '<=25': 0, '<=50': 0, '>50': 0 };
    for (const v of this.tickSamples) {
      if (v <= 1) buckets['<=1']++;
      else if (v <= 2) buckets['<=2']++;
      else if (v <= 5) buckets['<=5']++;
      else if (v <= 10) buckets['<=10']++;
      else if (v <= 25) buckets['<=25']++;
      else if (v <= 50) buckets['<=50']++;
      else buckets['>50']++;
    }
    return buckets;
  }

  setPlayers(n: number): void {
    this.players = n;
  }

  addConnection(): void {
    this.connectionsTotal++;
  }

  observeSnapshot(bytes: number): void {
    this.snapshotsSent++;
    this.snapshotBytesTotal += bytes;
    this.snapshotLastBytes = bytes;
  }

  incReject(kind: RejectKind): void {
    this.rejects[kind]++;
  }

  get tickAvgMs(): number {
    return this.tickCount === 0 ? 0 : this.tickTotalMs / this.tickCount;
  }

  get tickP95Ms(): number {
    if (this.tickSamples.length === 0) return 0;
    const s = [...this.tickSamples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }

  get tickP50Ms(): number {
    if (this.tickSamples.length === 0) return 0;
    const s = [...this.tickSamples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.5))];
  }

  get tickMaxMs(): number {
    if (this.tickSamples.length === 0) return 0;
    return Math.max(...this.tickSamples);
  }

  get snapshotAvgBytes(): number {
    return this.snapshotsSent === 0 ? 0 : this.snapshotBytesTotal / this.snapshotsSent;
  }

  // --- ops mutators -------------------------------------------------

  /** Merge a partial gameplay view (called once per tick from the loop). */
  setGameplay(g: GameplayView): void {
    if (g.playersAlive !== undefined) this.playersAlive = g.playersAlive;
    if (g.mobsAlive !== undefined) this.mobsAlive = g.mobsAlive;
    if (g.hpRatio !== undefined) this.hpRatio = g.hpRatio;
    if (g.questsActive !== undefined) this.questsActive = g.questsActive;
    if (g.parties !== undefined) this.parties = g.parties;
    if (g.anticheatStrikes !== undefined) this.anticheatStrikes = g.anticheatStrikes;
    if (g.anticheatStrikesMax !== undefined) this.anticheatStrikesMax = g.anticheatStrikesMax;
  }

  /** Record one mob kill; feeds both the counter and the 5-minute window. */
  observeMobKill(nowMs: number = Date.now()): void {
    this.mobsKilledTotal++;
    this.killRate.add(1, nowMs);
  }

  /** Mob kills inside the trailing 5-minute window. */
  mobsKilled5m(nowMs: number = Date.now()): number {
    return this.killRate.windowSum(nowMs);
  }

  /** Record one outbound frame: bytes + encoding kind. */
  observeFrame(kind: FrameKind, bytes: number, nowMs: number = Date.now()): void {
    if (kind === 'binary') this.framesBinary++;
    else this.framesJson++;
    if (Number.isFinite(bytes)) {
      this.wireBytesTotal += bytes;
      this.wireRate.add(bytes, nowMs);
    }
  }

  /** Snapshot encode cost in microseconds. */
  observeSnapshotEncode(us: number): void {
    if (!Number.isFinite(us) || us < 0) return;
    this.snapshotEncodeUsLast = us;
    this.snapshotEncodeUsTotal += us;
    this.snapshotEncodeSamples.push(us);
    if (this.snapshotEncodeSamples.length > MAX_TICK_SAMPLES) this.snapshotEncodeSamples.shift();
  }

  /** Whole snapshot stage duration in ms (feeds the snapshot histogram). */
  observeSnapshotStage(ms: number): void {
    this.snapshotMs.observe(ms);
  }

  get snapshotEncodeUsAvg(): number {
    if (this.snapshotEncodeSamples.length === 0) return 0;
    const s = this.snapshotEncodeSamples;
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  get snapshotEncodeUsP95(): number {
    return percentile(this.snapshotEncodeSamples, 0.95);
  }

  /** Bytes/second currently leaving the process. */
  wireBytesPerSec(nowMs: number = Date.now()): number {
    return this.wireRate.perSec(nowMs);
  }

  /** Bytes/second per connected player (division-by-zero safe). */
  wireBytesPerPlayerPerSec(nowMs: number = Date.now()): number {
    return this.wireRate.perSec(nowMs) / Math.max(1, this.players);
  }

  /** Fraction of outbound frames using the binary wire format (0..1). */
  get binaryFrameRatio(): number {
    const total = this.framesJson + this.framesBinary;
    return total === 0 ? 0 : this.framesBinary / total;
  }

  /**
   * Called once at the top of every tick.
   *
   * `tickLagMs` is the overshoot past ONE period (a stall detector: 0 while the
   * timer is on cadence, large when the loop was blocked). It deliberately does
   * NOT accumulate, because timers are not exact - Windows' ~15.6ms granularity
   * caps a 50ms `setInterval` at ~16Hz, so an accumulating "lag since boot"
   * would grow without bound on a perfectly healthy host.
   *
   * `tickRateRatio` is the platform-honest cadence signal for alerting:
   * observed ticks/sec over a 15s window divided by the configured rate. 1.0 =
   * on cadence, ~0.8 = the Windows timer baseline, <0.5 = a real stall.
   * Returns the lag in ms (>= 0).
   */
  observeSchedule(periodMs: number, nowMs: number = Date.now()): number {
    if (periodMs <= 0) return 0;
    this.tickTargetHz = 1000 / periodMs;
    if (this.scheduleBaseMs === 0) {
      this.scheduleBaseMs = nowMs;
      this.lastTickAtMs = nowMs;
      this.scheduleTicks = 0;
    }
    const completed = this.scheduleTicks; // ticks finished before this one
    const dueAt = this.scheduleBaseMs + completed * periodMs;
    this.scheduleTicks++;
    this.tickRate.add(1, nowMs);

    // Bounded per-tick overshoot, not an accumulating deadline miss.
    const lag = Math.max(0, nowMs - this.lastTickAtMs - periodMs);
    this.lastTickAtMs = nowMs;
    this.tickLagMs = lag;
    if (lag > this.tickLagMaxMs) this.tickLagMaxMs = lag;

    // Cumulative view, kept for debugging; alert on tickRateRatio instead.
    const expected = (nowMs - this.scheduleBaseMs) / periodMs;
    this.tickDriftTicks = completed - expected;
    return lag;
  }

  /** Observed tick rate over the trailing window (ticks/second). */
  tickRateHz(nowMs: number = Date.now()): number {
    return this.tickRate.perSec(nowMs);
  }

  /** observed / configured tick rate; 1.0 = on cadence. */
  tickRateRatio(nowMs: number = Date.now()): number {
    if (this.tickTargetHz === 0) return 1;
    return this.tickRateHz(nowMs) / this.tickTargetHz;
  }

  /**
   * Account for wall-clock periods the drift-compensating scheduler
   * intentionally dropped (skip path). Skipped periods are not executed ticks,
   * so they must not inflate `tick_rate_hz` — but they ARE accounted for in the
   * schedule clock, otherwise `tick_drift_ticks` (executed - expected) would
   * grow without bound every time the loop sheds load on purpose.
   */
  noteSkipped(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const k = Math.floor(n);
    if (k <= 0) return;
    this.ticksSkippedTotal += k;
    this.scheduleTicks += k;
  }

  /** Count extra fixed steps executed to catch up when briefly behind. */
  noteCatchUp(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const k = Math.floor(n);
    if (k <= 0) return;
    this.tickCatchUpTotal += k;
  }

  /** Record one error by coarse kind; also feeds the per-minute rate gauge. */
  noteError(kind: ErrorKind, nowMs: number = Date.now()): void {
    this.errors[kind] = (this.errors[kind] ?? 0) + 1;
    this.errorRate.add(1, nowMs);
  }

  get errorsTotal(): number {
    return ERROR_KINDS.reduce((sum, k) => sum + (this.errors[k] ?? 0), 0);
  }

  /** Errors per minute over the trailing 60-second window. */
  errorsPerMin(nowMs: number = Date.now()): number {
    return this.errorRate.perMin(nowMs);
  }

  /** Snapshot the process memory gauges (cheap; call once per tick). */
  sampleMemory(): NodeJS.MemoryUsage {
    this.memory = process.memoryUsage();
    return this.memory;
  }

  /** Set identity labels rendered on `aetherfall_info`. */
  setInfo(info: InfoView): void {
    this.info = { ...this.info, ...info };
  }

  /** Admission cap for the local shard; drives `aetherfall_shard_load_ratio`. */
  setShardCapacity(cap: number): void {
    this.shardCapacity = Number.isFinite(cap) && cap > 0 ? cap : 0;
    this.refreshShardLoadRatio();
  }

  private refreshShardLoadRatio(): void {
    this.shardLoadRatio = this.shardCapacity === 0 ? 0 : this.players / this.shardCapacity;
  }

  /** Prometheus text exposition format. */
  render(): string {
    const nowMs = Date.now();
    const uptimeSec = Math.floor((nowMs - this.startedAt) / 1000);
    this.sampleMemory();
    if (this.shardCapacity > 0) this.shardLoadRatio = this.players / this.shardCapacity;
    const L: string[] = [];
    L.push('# HELP aetherfall_tick_duration_ms server tick duration in ms');
    L.push('# TYPE aetherfall_tick_duration_ms gauge');
    L.push(`aetherfall_tick_duration_ms_last ${this.tickLastMs.toFixed(3)}`);
    L.push(`aetherfall_tick_duration_ms_avg ${this.tickAvgMs.toFixed(3)}`);
    L.push(`aetherfall_tick_duration_ms_p50 ${this.tickP50Ms.toFixed(3)}`);
    L.push(`aetherfall_tick_duration_ms_p95 ${this.tickP95Ms.toFixed(3)}`);
    L.push(`aetherfall_tick_duration_ms_max ${this.tickMaxMs.toFixed(3)}`);
    for (const [bucket, count] of Object.entries(this.tickHistogram())) {
      L.push(`aetherfall_tick_histogram_ms_bucket{le="${bucket}"} ${count}`);
    }
    for (const { section, avg, max } of this.topSections()) {
      L.push(`aetherfall_tick_section_ms_avg{section="${section}"} ${avg.toFixed(3)}`);
      L.push(`aetherfall_tick_section_ms_max{section="${section}"} ${max.toFixed(3)}`);
    }
    // Emit every known section even before it is observed so the Grafana
    // section panel has a series from the very first scrape.
    for (const section of ALL_TICK_SECTIONS) {
      if (this.sections.has(section)) continue;
      L.push(`aetherfall_tick_section_ms_avg{section="${section}"} 0.000`);
      L.push(`aetherfall_tick_section_ms_max{section="${section}"} 0.000`);
    }
    L.push('# HELP aetherfall_ticks_total total fixed-tick iterations');
    L.push('# TYPE aetherfall_ticks_total counter');
    L.push(`aetherfall_ticks_total ${this.tickCount}`);
    L.push('# HELP aetherfall_players connected players (gauge)');
    L.push('# TYPE aetherfall_players gauge');
    L.push(`aetherfall_players ${this.players}`);
    L.push('# HELP aetherfall_connections_total total ws connections accepted');
    L.push('# TYPE aetherfall_connections_total counter');
    L.push(`aetherfall_connections_total ${this.connectionsTotal}`);
    L.push('# HELP aetherfall_snapshot_bytes_total total snapshot payload bytes sent');
    L.push('# TYPE aetherfall_snapshot_bytes_total counter');
    L.push(`aetherfall_snapshot_bytes_total ${this.snapshotBytesTotal}`);
    L.push('# HELP aetherfall_snapshots_sent_total total snapshot messages sent');
    L.push('# TYPE aetherfall_snapshots_sent_total counter');
    L.push(`aetherfall_snapshots_sent_total ${this.snapshotsSent}`);
    L.push('# HELP aetherfall_snapshot_last_bytes bytes of last snapshot message');
    L.push('# TYPE aetherfall_snapshot_last_bytes gauge');
    L.push(`aetherfall_snapshot_last_bytes ${this.snapshotLastBytes}`);
    L.push('# HELP aetherfall_anticheat_rejects_total rejected inputs by check kind');
    L.push('# TYPE aetherfall_anticheat_rejects_total counter');
    for (const k of Object.keys(this.rejects) as RejectKind[]) {
      L.push(`aetherfall_anticheat_rejects_total{kind="${k}"} ${this.rejects[k]}`);
    }
    L.push('# HELP aetherfall_uptime_seconds server process uptime');
    L.push('# TYPE aetherfall_uptime_seconds counter');
    L.push(`aetherfall_uptime_seconds ${uptimeSec}`);

    // --- build identity ------------------------------------------
    const infoLabels: string[] = [];
    const infoValues: string[] = [];
    if (this.info.shard !== undefined) {
      infoLabels.push('shard');
      infoValues.push(this.info.shard);
    }
    if (this.info.version !== undefined) {
      infoLabels.push('version');
      infoValues.push(this.info.version);
    }
    if (this.info.protocol !== undefined) {
      infoLabels.push('protocol');
      infoValues.push(String(this.info.protocol));
    }
    if (this.info.backend !== undefined) {
      infoLabels.push('backend');
      infoValues.push(this.info.backend);
    }
    L.push('# HELP aetherfall_info build and shard identity, always 1');
    L.push('# TYPE aetherfall_info gauge');
    const infoLabelText = renderLabels(infoLabels.map((l, i) => [l, infoValues[i]!] as const));
    L.push(`aetherfall_info${infoLabelText} 1`);

    // --- gameplay gauges -----------------------------------------
    L.push('# HELP aetherfall_players_alive connected players with hp above zero');
    L.push('# TYPE aetherfall_players_alive gauge');
    L.push(`aetherfall_players_alive ${this.playersAlive}`);
    L.push('# HELP aetherfall_player_hp_ratio mean player health fraction (0 dead, 1 full)');
    L.push('# TYPE aetherfall_player_hp_ratio gauge');
    L.push(`aetherfall_player_hp_ratio ${this.hpRatio.toFixed(4)}`);
    L.push('# HELP aetherfall_mobs_alive live mobs including AI npcs and bosses');
    L.push('# TYPE aetherfall_mobs_alive gauge');
    L.push(`aetherfall_mobs_alive ${this.mobsAlive}`);
    L.push('# HELP aetherfall_mobs_killed_total lifetime mob kills');
    L.push('# TYPE aetherfall_mobs_killed_total counter');
    L.push(`aetherfall_mobs_killed_total ${this.mobsKilledTotal}`);
    L.push('# HELP aetherfall_mobs_killed_5m mob kills in the trailing 5 minutes');
    L.push('# TYPE aetherfall_mobs_killed_5m gauge');
    L.push(`aetherfall_mobs_killed_5m ${this.mobsKilled5m(nowMs)}`);
    L.push('# HELP aetherfall_mobs_killed_per_min mob kill rate per minute over the last 5 minutes');
    L.push('# TYPE aetherfall_mobs_killed_per_min gauge');
    L.push(`aetherfall_mobs_killed_per_min ${(this.killRate.perMin(nowMs)).toFixed(3)}`);
    L.push('# HELP aetherfall_quests_active quests in progress across all players');
    L.push('# TYPE aetherfall_quests_active gauge');
    L.push(`aetherfall_quests_active ${this.questsActive}`);
    L.push('# HELP aetherfall_parties live parties');
    L.push('# TYPE aetherfall_parties gauge');
    L.push(`aetherfall_parties ${this.parties}`);

    // --- anticheat strikes ---------------------------------------
    L.push('# HELP aetherfall_anticheat_strikes shadow-ban strikes currently held across all players');
    L.push('# TYPE aetherfall_anticheat_strikes gauge');
    L.push(`aetherfall_anticheat_strikes ${this.anticheatStrikes}`);
    L.push('# HELP aetherfall_anticheat_strikes_max highest strike count held by any single player');
    L.push('# TYPE aetherfall_anticheat_strikes_max gauge');
    L.push(`aetherfall_anticheat_strikes_max ${this.anticheatStrikesMax}`);

    // --- wire / frames -------------------------------------------
    L.push('# HELP aetherfall_frames_json_total outbound frames sent as json');
    L.push('# TYPE aetherfall_frames_json_total counter');
    L.push(`aetherfall_frames_json_total ${this.framesJson}`);
    L.push('# HELP aetherfall_frames_binary_total outbound frames sent as binary v2');
    L.push('# TYPE aetherfall_frames_binary_total counter');
    L.push(`aetherfall_frames_binary_total ${this.framesBinary}`);
    L.push('# HELP aetherfall_binary_frame_ratio fraction of outbound frames using the binary wire format');
    L.push('# TYPE aetherfall_binary_frame_ratio gauge');
    L.push(`aetherfall_binary_frame_ratio ${this.binaryFrameRatio.toFixed(6)}`);
    L.push('# HELP aetherfall_wire_bytes_total lifetime outbound bytes across all frame types');
    L.push('# TYPE aetherfall_wire_bytes_total counter');
    L.push(`aetherfall_wire_bytes_total ${this.wireBytesTotal}`);
    L.push('# HELP aetherfall_wire_bytes_per_sec outbound bytes per second');
    L.push('# TYPE aetherfall_wire_bytes_per_sec gauge');
    L.push(`aetherfall_wire_bytes_per_sec ${this.wireBytesPerSec(nowMs).toFixed(3)}`);
    L.push('# HELP aetherfall_wire_bytes_per_player_per_sec outbound bytes per second per connected player');
    L.push('# TYPE aetherfall_wire_bytes_per_player_per_sec gauge');
    L.push(`aetherfall_wire_bytes_per_player_per_sec ${this.wireBytesPerPlayerPerSec(nowMs).toFixed(3)}`);
    L.push('# HELP aetherfall_snapshot_encode_us_last microseconds to encode the last snapshot stage');
    L.push('# TYPE aetherfall_snapshot_encode_us_last gauge');
    L.push(`aetherfall_snapshot_encode_us_last ${this.snapshotEncodeUsLast.toFixed(3)}`);
    L.push('# HELP aetherfall_snapshot_encode_us_avg mean microseconds to encode a snapshot stage');
    L.push('# TYPE aetherfall_snapshot_encode_us_avg gauge');
    L.push(`aetherfall_snapshot_encode_us_avg ${this.snapshotEncodeUsAvg.toFixed(3)}`);
    L.push('# HELP aetherfall_snapshot_encode_us_p95 p95 microseconds to encode a snapshot stage');
    L.push('# TYPE aetherfall_snapshot_encode_us_p95 gauge');
    L.push(`aetherfall_snapshot_encode_us_p95 ${this.snapshotEncodeUsP95.toFixed(3)}`);

    // --- histograms ----------------------------------------------
    L.push('# HELP aetherfall_tick_duration_histogram_ms server tick duration histogram in ms');
    L.push('# TYPE aetherfall_tick_duration_histogram_ms histogram');
    for (const [le, count] of this.tickMs.cumulative()) {
      L.push(`aetherfall_tick_duration_histogram_ms_bucket{le="${le}"} ${count}`);
    }
    L.push(`aetherfall_tick_duration_histogram_ms_sum ${this.tickMs.sum.toFixed(3)}`);
    L.push(`aetherfall_tick_duration_histogram_ms_count ${this.tickMs.count}`);
    L.push('# HELP aetherfall_snapshot_duration_histogram_ms snapshot stage duration histogram in ms');
    L.push('# TYPE aetherfall_snapshot_duration_histogram_ms histogram');
    for (const [le, count] of this.snapshotMs.cumulative()) {
      L.push(`aetherfall_snapshot_duration_histogram_ms_bucket{le="${le}"} ${count}`);
    }
    L.push(`aetherfall_snapshot_duration_histogram_ms_sum ${this.snapshotMs.sum.toFixed(3)}`);
    L.push(`aetherfall_snapshot_duration_histogram_ms_count ${this.snapshotMs.count}`);

    // --- schedule health -----------------------------------------
    L.push('# HELP aetherfall_tick_schedule_lag_ms milliseconds this tick overshot one period (stall detector, does not accumulate)');
    L.push('# TYPE aetherfall_tick_schedule_lag_ms gauge');
    L.push(`aetherfall_tick_schedule_lag_ms ${this.tickLagMs.toFixed(3)}`);
    L.push('# HELP aetherfall_tick_schedule_lag_ms_max worst single-tick overshoot since boot');
    L.push('# TYPE aetherfall_tick_schedule_lag_ms_max gauge');
    L.push(`aetherfall_tick_schedule_lag_ms_max ${this.tickLagMaxMs.toFixed(3)}`);
    L.push('# HELP aetherfall_tick_rate_hz observed ticks per second over the trailing window');
    L.push('# TYPE aetherfall_tick_rate_hz gauge');
    L.push(`aetherfall_tick_rate_hz ${this.tickRateHz(nowMs).toFixed(3)}`);
    L.push('# HELP aetherfall_tick_rate_target_hz configured tick rate');
    L.push('# TYPE aetherfall_tick_rate_target_hz gauge');
    L.push(`aetherfall_tick_rate_target_hz ${this.tickTargetHz.toFixed(3)}`);
    L.push('# HELP aetherfall_tick_rate_ratio observed tick rate divided by the configured rate (1 = on cadence)');
    L.push('# TYPE aetherfall_tick_rate_ratio gauge');
    L.push(`aetherfall_tick_rate_ratio ${this.tickRateRatio(nowMs).toFixed(4)}`);
    L.push('# HELP aetherfall_tick_drift_ticks ticks executed minus ticks the wall clock expects since boot (negative is behind)');
    L.push('# TYPE aetherfall_tick_drift_ticks gauge');
    L.push(`aetherfall_tick_drift_ticks ${this.tickDriftTicks.toFixed(3)}`);
    L.push('# HELP aetherfall_ticks_skipped_total wall-clock periods dropped by the drift-compensating scheduler when behind by more than max catch-up');
    L.push('# TYPE aetherfall_ticks_skipped_total counter');
    L.push(`aetherfall_ticks_skipped_total ${this.ticksSkippedTotal}`);
    L.push('# HELP aetherfall_ticks_catchup_total extra fixed steps executed to catch up when briefly behind');
    L.push('# TYPE aetherfall_ticks_catchup_total counter');
    L.push(`aetherfall_ticks_catchup_total ${this.tickCatchUpTotal}`);

    // --- errors ---------------------------------------------------
    L.push('# HELP aetherfall_errors_total errors by stage (tick, http, ws, persist)');
    L.push('# TYPE aetherfall_errors_total counter');
    for (const k of ERROR_KINDS) {
      L.push(`aetherfall_errors_total{kind="${k}"} ${this.errors[k] ?? 0}`);
    }
    L.push('# HELP aetherfall_errors_per_min error rate per minute over the last 60 seconds');
    L.push('# TYPE aetherfall_errors_per_min gauge');
    L.push(`aetherfall_errors_per_min ${this.errorsPerMin(nowMs).toFixed(3)}`);

    // --- process health ------------------------------------------
    L.push('# HELP aetherfall_process_resident_memory_bytes process resident set size');
    L.push('# TYPE aetherfall_process_resident_memory_bytes gauge');
    L.push(`aetherfall_process_resident_memory_bytes ${this.memory.rss}`);
    L.push('# HELP aetherfall_process_heap_used_bytes v8 heap used bytes');
    L.push('# TYPE aetherfall_process_heap_used_bytes gauge');
    L.push(`aetherfall_process_heap_used_bytes ${this.memory.heapUsed}`);
    L.push('# HELP aetherfall_process_heap_total_bytes v8 heap total bytes');
    L.push('# TYPE aetherfall_process_heap_total_bytes gauge');
    L.push(`aetherfall_process_heap_total_bytes ${this.memory.heapTotal}`);
    L.push('# HELP aetherfall_process_external_memory_bytes v8 external memory bytes');
    L.push('# TYPE aetherfall_process_external_memory_bytes gauge');
    L.push(`aetherfall_process_external_memory_bytes ${this.memory.external}`);

    // --- shard / lifecycle ---------------------------------------
    L.push('# HELP aetherfall_shard_load_ratio connected players divided by the shard admission cap');
    L.push('# TYPE aetherfall_shard_load_ratio gauge');
    L.push(`aetherfall_shard_load_ratio ${this.shardLoadRatio.toFixed(4)}`);
    L.push('# HELP aetherfall_draining 1 while the server is draining after SIGTERM, else 0');
    L.push('# TYPE aetherfall_draining gauge');
    L.push(`aetherfall_draining ${this.draining}`);
    return L.join('\n') + '\n';
  }

  reset(): void {
    this.tickCount = 0;
    this.tickTotalMs = 0;
    this.tickLastMs = 0;
    this.tickSamples = [];
    this.sections.clear();
    this.players = 0;
    this.connectionsTotal = 0;
    this.snapshotsSent = 0;
    this.snapshotBytesTotal = 0;
    this.snapshotLastBytes = 0;
    this.rejects = { 'input-rate': 0, speed: 0, teleport: 0, burst: 0, shadowban: 0 };
    // extended gauges
    this.playersAlive = 0;
    this.mobsAlive = 0;
    this.hpRatio = 0;
    this.questsActive = 0;
    this.parties = 0;
    this.anticheatStrikes = 0;
    this.anticheatStrikesMax = 0;
    this.mobsKilledTotal = 0;
    this.framesJson = 0;
    this.framesBinary = 0;
    this.wireBytesTotal = 0;
    this.snapshotEncodeUsLast = 0;
    this.snapshotEncodeUsTotal = 0;
    this.snapshotEncodeSamples = [];
    this.snapshotMs.reset();
    this.tickMs.reset();
    this.scheduleBaseMs = 0;
    this.scheduleTicks = 0;
    this.lastTickAtMs = 0;
    this.tickTargetHz = 0;
    this.tickLagMs = 0;
    this.tickLagMaxMs = 0;
    this.tickDriftTicks = 0;
    this.ticksSkippedTotal = 0;
    this.tickCatchUpTotal = 0;
    this.tickRate.reset();
    this.errors = { tick: 0, http: 0, ws: 0, persist: 0 };
    this.draining = 0;
    this.wireRate.reset();
    this.errorRate.reset();
    this.killRate.reset();
  }
}

/** Process-wide singleton wired into server/src/index.ts. */
export const metrics = new Metrics();