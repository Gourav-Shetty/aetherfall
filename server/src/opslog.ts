// @aetherfall/server — structured ops logging.
//
// When LOG_JSON=1 every line goes to stdout/stderr as a single JSON object so a
// log shipper (Loki/ELK/Datadog) can index `tick`, `requestId`, `event` and
// `shard` as fields instead of grepping text. With LOG_JSON unset the module
// degrades to the previous human-readable `[level] msg key=value` lines, so
// local dev output is unchanged.
//
// Correlation model:
//   * `tick`     — the current simulation tick, set once per tick by the loop
//                  (`log.setTick`), so a tick spike is attributable to a tick id.
//   * `requestId`— one id per inbound WS connection, minted on 'connection' and
//                  inherited by every log line emitted while handling it.
//   * `event`    — structured event name (join, kick, wall-change, drain, ...).
//   * `shard`/`pid` — always present so multi-shard output can be split.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export type OpsLogOptions = {
  /** Force JSON on/off; defaults to logJsonEnabled(process.env). */
  json?: boolean;
  /** Fields merged into every line (shard, pid, ...). */
  base?: LogFields;
  /** Sink override; defaults to process.stdout/stderr write. */
  write?: (line: string, level: LogLevel) => void;
  /** Levels below this are dropped. Default 'info'. */
  minLevel?: LogLevel;
};

/** LOG_JSON=1 | true | yes | on enables structured JSON output. */
export function logJsonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LOG_JSON ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Longest string value kept verbatim; longer values are tail-truncated. */
export const MAX_VALUE_CHARS = 512;

let requestSeq = 0;

/** Short, collision-resistant request id: `r-<base36 time>-<counter>`. */
export function nextRequestId(nowMs: number = Date.now()): string {
  requestSeq = (requestSeq + 1) % 0xffffff;
  return `r-${nowMs.toString(36)}-${requestSeq.toString(36)}`;
}

/** Errors serialize as `{name, message, stack}` instead of collapsing to `{}`. */
function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}...[+${s.length - MAX_VALUE_CHARS}]` : s;
  }
  if (t === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (t === 'boolean') return value;
  // JSON.stringify throws on bigint; bigints are IDs/sizes, string is lossless enough.
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? null };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => normalize(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (v === undefined) continue;
    out[k] = normalize(v, seen);
  }
  return out;
}

/** Strip undefined/functions and make everything JSON-safe. */
export function sanitizeFields(fields: LogFields | undefined): Record<string, unknown> {
  if (!fields) return {};
  return normalize(fields, new WeakSet<object>()) as Record<string, unknown>;
}

function defaultWrite(line: string, level: LogLevel): void {
  if (level === 'error') process.stderr.write(line + '\n');
  else if (level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function renderText(level: LogLevel, msg: string, fields: Record<string, unknown>): string {
  let line = `[${level}] ${msg}`;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    line += ` ${k}=${typeof v === 'string' ? (v.includes(' ') ? JSON.stringify(v) : v) : JSON.stringify(v)}`;
  }
  return line;
}

function renderJson(level: LogLevel, msg: string, fields: Record<string, unknown>, ts: string): string {
  const rec: Record<string, unknown> = { ts, level, msg };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    rec[k] = v;
  }
  try {
    return JSON.stringify(rec);
  } catch {
    // Last-resort: never let a log call throw into the game loop.
    return JSON.stringify({ ts, level, msg, logError: 'unserializable-fields' });
  }
}

/**
 * Structured logger. One instance per server process; `child()` derives scoped
 * loggers (per connection, per tick) that inherit the parent's fields.
 */
export class OpsLog {
  readonly json: boolean;
  private readonly base: LogFields;
  private readonly write: (line: string, level: LogLevel) => void;
  private readonly minLevelName: LogLevel;
  private readonly minLevel: number;
  /** Shared with children so a per-connection logger still sees the live tick id. */
  private tickRef: { value: number | null };

  constructor(opts: OpsLogOptions = {}) {
    this.json = opts.json ?? logJsonEnabled();
    this.base = { pid: process.pid, ...sanitizeFields(opts.base) };
    this.write = opts.write ?? defaultWrite;
    this.minLevelName = opts.minLevel ?? 'info';
    this.minLevel = LEVEL_ORDER[this.minLevelName];
    this.tickRef = { value: null };
  }

  /** Bind the current simulation tick so every line carries a tick id. */
  setTick(tick: number | null): void {
    this.tickRef.value = tick;
  }

  get tick(): number | null {
    return this.tickRef.value;
  }

  /** Derived logger: fields merge under the parent's; the tick source is shared. */
  child(fields: LogFields = {}): OpsLog {
    const c = new OpsLog({
      json: this.json,
      base: { ...this.base, ...sanitizeFields(fields) },
      write: this.write,
      minLevel: this.minLevelName,
    });
    c.tickRef = this.tickRef;
    return c;
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const merged: Record<string, unknown> = { ...this.base };
    if (this.tickRef.value !== null && merged.tick === undefined) merged.tick = this.tickRef.value;
    Object.assign(merged, sanitizeFields(fields));
    const ts = new Date().toISOString();
    const line = this.json ? renderJson(level, msg, merged, ts) : renderText(level, msg, merged);
    try {
      this.write(line, level);
    } catch {
      /* a broken sink must never break the tick loop */
    }
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  /** Structured domain event: `event` field + level chosen by the caller. */
  event(name: string, fields?: LogFields, level: LogLevel = 'info'): void {
    this.emit(level, name, { ...fields, event: name });
  }
}

/** Process-wide singleton. `LOG_JSON=1` switches it to structured output. */
export const opsLog = new OpsLog();