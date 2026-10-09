// @aetherfall/server — authoritative anti-cheat checks + violations log.
import { MAX_SPEED } from './sim.js';
import { PROTOCOL_VERSION, type ClientMsg } from '@aetherfall/shared';
import { extractRouteKey } from './router/hash.js';

export type ViolationKind = 'input-rate' | 'speed' | 'teleport' | 'burst' | 'shadowban' | 'malformed';

export type Violation = {
  playerId: number;
  kind: ViolationKind;
  tick: number;
  detail: string;
  at: number; // Date.now()
};

export type AntiCheatOpts = {
  /** minimum ms between inputs (>66Hz rejected by default) */
  minInputIntervalMs?: number;
  /** hard cap on velocity magnitude (units/sec) */
  maxSpeed?: number;
  /** max allowed displacement per tick before teleport flag (units) */
  maxStepDist?: number;
  /** keep last N violations in memory */
  maxViolations?: number;
  /** burst heuristic: max dist (units) inside burst window before flag */
  teleportBurstDist?: number;
  /** burst heuristic window (ms) — dist>teleportBurstDist inside this window flags */
  teleportBurstWindowMs?: number;
  /** input burst window (ms) for flood detection */
  burstWindowMs?: number;
  /** max inputs allowed inside burstWindowMs (honest 20Hz = 4 per 200ms; chaos flood = 300/ms) */
  burstMaxInputs?: number;
  /** strikes before shadow-ban kick */
  maxStrikes?: number;
  /** strikes decay after this long without a new strike (ms) */
  strikeDecayMs?: number;
};

const DEFAULTS = {
  minInputIntervalMs: 15,
  maxSpeed: MAX_SPEED,
  maxStepDist: 5,
  maxViolations: 500,
  teleportBurstDist: 15,
  teleportBurstWindowMs: 50,
  // 20 inputs per 200ms: honest 20Hz sends 4 (5x headroom, absorbs server
  // queueing stalls that bunch dequeued inputs); a 300-input flood trips at
  // #21 within the same millisecond. Window clears on trip + strikes decay.
  burstWindowMs: 200,
  burstMaxInputs: 20,
  maxStrikes: 3,
  strikeDecayMs: 10000,
};

/**
 * Absolute speed tolerance (units/sec) before a velocity counts as a violation.
 * Honest clients normalize move axes with float error, e.g. mag 8.0000001 > 8,
 * which previously clamped + log-spammed every tick. Anything within MAX+EPS
 * passes clean; anything beyond is clamped as before.
 */
export const SPEED_EPSILON = 0.01;

export class AntiCheat {
  private opts = { ...DEFAULTS };
  private lastInputAt = new Map<number, number>();
  /** sliding input timestamps per player for burst detection */
  private inputBurstAt = new Map<number, number[]>();
  /** last authoritative pos + wall-clock per player for teleport-burst heuristic */
  private lastPos = new Map<number, { x: number; y: number; at: number }>();
  /** shadow-ban strike counter per player (burst/speed/teleport only — never input-rate) */
  private strikes = new Map<number, number>();
  private strikeAt = new Map<number, number>();
  private banned = new Set<number>();
  /** last wall-clock console.warn per player+kind — violations are always recorded, logging is throttled */
  private lastWarnAt = new Map<string, number>();
  /** minimum ms between console warnings for the same player+kind (prevents tick-rate log spam) */
  warnThrottleMs = 1000;
  violations: Violation[] = [];

  constructor(opts: AntiCheatOpts = {}) {
    Object.assign(this.opts, opts);
  }

  log(playerId: number, kind: ViolationKind, tick: number, detail: string): Violation {
    const v: Violation = { playerId, kind, tick, detail, at: Date.now() };
    this.violations.push(v);
    if (this.violations.length > this.opts.maxViolations) {
      this.violations.splice(0, this.violations.length - this.opts.maxViolations);
    }
    // Throttle console output: record every violation, warn at most once/sec per player+kind.
    const key = `${playerId}:${kind}`;
    const last = this.lastWarnAt.get(key) ?? -Infinity;
    if (v.at - last >= this.warnThrottleMs) {
      this.lastWarnAt.set(key, v.at);
      console.warn(`[anticheat] pid=${playerId} kind=${kind} tick=${tick} ${detail}`);
    }
    return v;
  }

  /**
   * Returns false (reject input) when sender exceeds rate limit.
   * NOTE (scale lesson from load testing): this is lossy backpressure, NOT an abuse
   * signal — no strike. At 100+ players the server's own broadcast loop can
   * delay input processing, so two honest 20Hz inputs get dequeued in the
   * same millisecond (dt=0ms artifact) and would false-positive a strict
   * per-gap check. Real floods are caught by checkInputBurst (strike) below.
   */
  checkInputRate(playerId: number, tick: number, now = Date.now()): boolean {
    const last = this.lastInputAt.get(playerId);
    if (last !== undefined && now - last < this.opts.minInputIntervalMs) {
      this.log(playerId, 'input-rate', tick, `dt=${now - last}ms < min=${this.opts.minInputIntervalMs}ms`);
      return false;
    }
    this.lastInputAt.set(playerId, now);
    return true;
  }

  /**
   * Input burst detector: >burstMaxInputs inside burstWindowMs flags even when
   * individual gaps pass the 15ms floor (e.g. sustained 55Hz — legal per-gap,
   * abusive as a burst). Returns false on burst.
   * On trip the window is CLEARED so one queueing stall costs at most one
   * strike (honest 20Hz rebuilds slowly); a real flood re-fills instantly and
   * strikes again within the same millisecond.
   * Slow-tick exemption: when `slowTick` is true (the tick loop just stalled —
   * see perf.ts SLOW_TICK_MS), the trip is server-side queueing, not client
   * abuse: the input is still dropped (lossy backpressure, same as the rate
   * path) but NO strike accrues. Strikes only count on healthy ticks, so a
   * real flood is still kicked (3 trips on healthy ticks) while a saturated
   * event loop dequeuing honest 20Hz inputs in clumps can never kick.
   */
  checkInputBurst(playerId: number, tick: number, now = Date.now(), slowTick = false): boolean {
    const win = this.opts.burstWindowMs;
    const arr = this.inputBurstAt.get(playerId) ?? [];
    arr.push(now);
    while (arr.length > 0 && now - arr[0] > win) arr.shift();
    if (arr.length > this.opts.burstMaxInputs) {
      this.log(playerId, 'burst', tick, `${arr.length} inputs in ${win}ms > max=${this.opts.burstMaxInputs}${slowTick ? ' (slow-tick, no strike)' : ''}`);
      this.inputBurstAt.set(playerId, []);
      if (!slowTick) this.addStrike(playerId, tick, 'input burst');
      return false;
    }
    this.inputBurstAt.set(playerId, arr);
    return true;
  }

  /** Clamp a requested velocity to maxSpeed. Returns clamped vector + ok flag. */
  checkVelocity(
    playerId: number,
    tick: number,
    vx: number,
    vy: number,
  ): { vx: number; vy: number; ok: boolean } {
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      this.log(playerId, 'speed', tick, `non-finite velocity rejected`);
      this.addStrike(playerId, tick, 'non-finite velocity');
      return { vx: 0, vy: 0, ok: false };
    }
    const mag = Math.hypot(vx, vy);
    // Epsilon budget: float dust on honest normalized input (e.g. 8.0000001) passes clean.
    if (mag <= this.opts.maxSpeed + SPEED_EPSILON) return { vx, vy, ok: true };
    const k = this.opts.maxSpeed / (mag || 1);
    this.log(playerId, 'speed', tick, `mag=${mag.toFixed(2)} clamped to ${this.opts.maxSpeed}`);
    this.addStrike(playerId, tick, 'speed clamp');
    return { vx: vx * k, vy: vy * k, ok: false };
  }

  /**
   * Teleport check: compare last authoritative pos vs newly claimed pos.
   * Returns false when the jump exceeds maxStepDist (caller should reject/snap back).
   */
  checkTeleport(
    playerId: number,
    tick: number,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): boolean {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (d > this.opts.maxStepDist) {
      this.log(playerId, 'teleport', tick, `jump=${d.toFixed(2)} > max=${this.opts.maxStepDist}`);
      this.addStrike(playerId, tick, 'teleport step');
      return false;
    }
    return true;
  }

  /**
   * Teleport-burst heuristic: dist > teleportBurstDist (default 15u)
   * inside teleportBurstWindowMs (default 50ms) flags — catches position
   * hacks that split one big jump into per-tick-legal steps, or wall-clock
   * teleports between authoritative updates. Honest 8u/s moves ~0.4u/50ms,
   * so honest bots never trip it. Returns false on violation.
   * Call with the authoritative pre-move pos and the predicted post-move pos.
   */
  checkTeleportBurst(
    playerId: number,
    tick: number,
    to: { x: number; y: number },
    now = Date.now(),
  ): boolean {
    const last = this.lastPos.get(playerId);
    this.lastPos.set(playerId, { x: to.x, y: to.y, at: now });
    if (!last) return true;
    const d = Math.hypot(to.x - last.x, to.y - last.y);
    const dt = now - last.at;
    if (dt <= this.opts.teleportBurstWindowMs && d > this.opts.teleportBurstDist) {
      this.log(playerId, 'teleport', tick, `burst jump=${d.toFixed(2)}u in ${dt}ms > max=${this.opts.teleportBurstDist}u/${this.opts.teleportBurstWindowMs}ms`);
      this.addStrike(playerId, tick, 'teleport burst');
      return false;
    }
    return true;
  }

  /** Seed/refresh the burst baseline (call on hello/spawn so the first move isn't judged). */
  seedPos(playerId: number, pos: { x: number; y: number }, now = Date.now()): void {
    this.lastPos.set(playerId, { x: pos.x, y: pos.y, at: now });
  }

  /** Clamp a raw client move axis to [-1,1], normalize overlong sticks to the
   * unit circle (diagonal budget), then scale by maxSpeed. NaN/Infinity -> 0. */
  moveToVelocity(mx: number, my: number): { vx: number; vy: number } {
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return { vx: 0, vy: 0 };
    const cx = Math.max(-1, Math.min(1, mx));
    const cy = Math.max(-1, Math.min(1, my));
    const mag = Math.hypot(cx, cy);
    // Diagonal budget: (1,1) normalizes to unit length instead of exceeding
    // maxSpeed before checkVelocity even sees it. Result mag is exactly <= maxSpeed.
    const nx = mag > 1 ? cx / mag : cx;
    const ny = mag > 1 ? cy / mag : cy;
    return { vx: nx * this.opts.maxSpeed, vy: ny * this.opts.maxSpeed };
  }

  resetPlayer(playerId: number): void {
    this.lastInputAt.delete(playerId);
    this.inputBurstAt.delete(playerId);
    this.lastPos.delete(playerId);
    this.strikes.delete(playerId);
    this.strikeAt.delete(playerId);
    this.banned.delete(playerId);
    for (const k of [...this.lastWarnAt.keys()]) {
      if (k.startsWith(`${playerId}:`)) this.lastWarnAt.delete(k);
    }
  }

  /**
   * Shadow-ban strikes: burst/speed/teleport violations add one; 3 strikes
   * inside strikeDecayMs (default 10s) -> kick. Strikes DECAY: a single
   * queueing stall (burst trip) is forgiven after 10s clean, so honest
   * players need 3 violations in 10s to be kicked; a real flood strikes
   * 3+ times within one millisecond.
   */
  private addStrike(playerId: number, tick: number, reason: string): boolean {
    void tick;
    void reason;
    const now = Date.now();
    const last = this.strikeAt.get(playerId) ?? -Infinity;
    let n = this.strikes.get(playerId) ?? 0;
    if (now - last > this.opts.strikeDecayMs) n = 0;
    n++;
    this.strikes.set(playerId, n);
    this.strikeAt.set(playerId, now);
    if (n >= this.opts.maxStrikes && !this.banned.has(playerId)) {
      this.banned.add(playerId);
      // Silent marker: no extra violation entry and no extra console.warn
      // (keeps violationsFor counts + warn-throttle tests stable). The
      // server emits the `kicked` event and closes the socket.
      return true;
    }
    return false;
  }

  /** True when the player hit maxStrikes and should be kicked with an event. */
  shouldKick(playerId: number): boolean {
    return this.banned.has(playerId);
  }

  /**
   * Malformed-payload marker (security hardening): records a `malformed` violation
   * for fuzz traffic (NaN/huge/null-proto) that was safely dropped. Never
   * strikes — malformed input is a robustness event, not a cheat signal.
   */
  checkMalformed(playerId: number, tick: number, detail: string): void {
    this.log(playerId, 'malformed', tick, detail);
  }

  isShadowBanned(playerId: number): boolean {
    return this.banned.has(playerId);
  }

  getStrikes(playerId: number): number {
    return this.strikes.get(playerId) ?? 0;
  }

  // OPS: aggregate strike views for the /metrics gauges.
  // O(strikes) once per tick, not per input.
  /** Sum of shadow-ban strikes currently held across every player. */
  strikeTotal(): number {
    let n = 0;
    for (const v of this.strikes.values()) n += v;
    return n;
  }

  /** Highest strike count held by any single player (0 = nobody is one kick away). */
  maxStrikes(): number {
    let max = 0;
    for (const v of this.strikes.values()) if (v > max) max = v;
    return max;
  }

  violationsFor(playerId: number): Violation[] {
    return this.violations.filter((v) => v.playerId === playerId);
  }
}

// --- crash-safe client-message parsing (fuzz guards) -------------
// safeParseClientMsg() is the only JSON entry point the socket loop should
// use: it never throws, caps string/blob sizes, and rejects NaN/Infinity,
// null-proto, and wrong-shaped payloads with null (caller drops + optional
// checkMalformed log). Honest messages pass through untouched.

/** Max raw socket payload accepted (larger => drop, no parse). */
export const MAX_MSG_BYTES = 64_000;
/** Max chat text length accepted pre-sanitize (post-sanitize caps at 200). */
export const MAX_RAW_CHAT_LEN = 2000;
/** Max input dt accepted (clamped to [0, 0.25] downstream). */
export const MAX_INPUT_DT = 0.25;

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function capStr(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  if (s.length > max) return null;
  return s;
}

/** Sanitize a raw move axis: non-finite -> 0, clamp to [-1,1]. Never throws. */
export function sanitizeMoveAxis(v: unknown): number {
  if (!isFiniteNum(v)) return 0;
  if (v > 1) return 1;
  if (v < -1) return -1;
  return v;
}

/** Sanitize a raw input dt: non-finite -> tick default, clamp [0, 0.25]. */
export function sanitizeInputDt(dt: unknown, fallback = 1 / 20): number {
  if (!isFiniteNum(dt)) return fallback;
  if (dt < 0) return 0;
  if (dt > MAX_INPUT_DT) return MAX_INPUT_DT;
  return dt;
}

/**
 * Sanitize raw chat text: non-string -> null, cap at 200 chars (post-cap
 * length check at MAX_RAW_CHAT_LEN), trim, empty-after-trim -> null.
 * Single source of truth for the chat cap — safeParseClientMsg() uses it.
 */
export function sanitizeChatText(text: unknown): string | null {
  try {
    if (typeof text !== 'string') return null;
    if (text.length > MAX_RAW_CHAT_LEN) return null;
    const t = text.slice(0, 200).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function validChannel(c: unknown): c is 'global' | 'guild' | 'say' {
  return c === 'global' || c === 'guild' || c === 'say';
}

/**
 * Parse + validate one raw socket payload. Returns a sanitized ClientMsg
 * or null when the payload must be dropped. Never throws — safe for
 * NaN / huge / null-proto / wrong-type fuzz traffic.
 */
export function safeParseClientMsg(raw: unknown): ClientMsg | null {
  try {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return null;
    const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : (raw as string);
    if (s.length === 0 || s.length > MAX_MSG_BYTES) return null;
    let m: unknown;
    try {
      m = JSON.parse(s);
    } catch {
      return null;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const o = m as Record<string, unknown>;
    const t = o['t'];
    if (t === 'hello') {
      const proto = o['proto'];
      if (!isFiniteNum(proto) || !Number.isInteger(proto)) return null;
      // Version mismatch is NOT a parse failure: pass through a hello shell
      // (empty name, no token echoed) so the caller can answer with an
      // explicit `bad-proto` event + close instead of silently dropping.
      // No identity is ever derived from it — index.ts rejects on proto
      // BEFORE resolveIdentity(), so an untrusted name/token is never read.
      if (proto !== PROTOCOL_VERSION) return { t: 'hello', name: '', proto } as ClientMsg;
      const name = capStr(o['name'], 1024);
      if (name === null) return null;
      let token: string | undefined;
      if (o['token'] !== undefined) {
        if (typeof o['token'] !== 'string' || o['token'].length > 512) return null;
        token = o['token'];
      }
      // SHARDING: thread the client-stable routing key through so
      // the hello path can sticky-route on it. Attached only when present (the
      // honest-traffic deep-equal test pins the keyless shape); unknown or
      // malformed keys are dropped here and fall back to `token ?? name`.
      const nonce = extractRouteKey(o);
      return { t: 'hello', name, token, proto, ...(nonce !== undefined ? { nonce } : {}) };
    }
    if (t === 'input') {
      const inp = o['input'];
      if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return null;
      const io = inp as Record<string, unknown>;
      const seq = io['seq'];
      if (!isFiniteNum(seq)) return null;
      const move = io['move'];
      if (!move || typeof move !== 'object' || Array.isArray(move)) return null;
      const mo = move as Record<string, unknown>;
      // Fuzz guard: non-finite or absurd-magnitude raw dt/move values are
      // dropped outright (the standalone sanitize* helpers still clamp mild
      // out-of-range input; only honest magnitudes pass through here).
      const rawDt = io['dt'];
      if (rawDt !== undefined && (!isFiniteNum(rawDt) || rawDt < 0 || rawDt > 64)) return null;
      for (const v of [mo['x'], mo['y']]) {
        if (v !== undefined && (!isFiniteNum(v) || Math.abs(v as number) > 64)) return null;
      }
      const mx = sanitizeMoveAxis(mo['x']);
      const my = sanitizeMoveAxis(mo['y']);
      const dt = sanitizeInputDt(io['dt']);
      const out: ClientMsg = {
        t: 'input',
        input: { seq: Math.floor(seq), dt, move: { x: mx, y: my } },
      };
      if (typeof io['attack'] === 'boolean') out.input.attack = io['attack'];
      if (isFiniteNum(io['skill'])) out.input.skill = Math.floor(io['skill'] as number);
      if (isFiniteNum(io['targetId'])) out.input.targetId = Math.floor(io['targetId'] as number);
      // Chat rides on the input frame: oversized/wrong-typed -> drop the whole
      // frame; whitespace-only -> drop just the field (the frame still counts
      // for movement, which is what the sim needs).
      if (io['chat'] !== undefined) {
        if (typeof io['chat'] !== 'string' || io['chat'].length > MAX_RAW_CHAT_LEN) return null;
        const chat = sanitizeChatText(io['chat']);
        if (chat !== null) out.input.chat = chat;
      }
      return out;
    }
    if (t === 'chat') {
      if (typeof o['text'] !== 'string' || o['text'].length > MAX_RAW_CHAT_LEN) return null;
      if (!validChannel(o['channel'])) return null;
      const text = sanitizeChatText(o['text']);
      if (text === null) return null;
      return { t: 'chat', text, channel: o['channel'] as 'global' | 'guild' | 'say' };
    }
    return null;
  } catch {
    return null;
  }
}
