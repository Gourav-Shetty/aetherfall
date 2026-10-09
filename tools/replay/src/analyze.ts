// @aetherfall/replay — offline replay analytics.
//
// Usage:
//   node dist/analyze.js --in recordings/trial.ndjson
//   node dist/analyze.js --in recordings/trial.bin --json out/m.json --csv out/t.csv
//   node dist/analyze.js --in recordings/trial.ndjson --svg-dir ../docs/analytics
//   node dist/analyze.js --in recordings/trial.ndjson --bin recordings/trial.bin
//
// Reads `.ndjson`/`.jsonl` recordings (one `{t, msg}` record per line) or the
// compact `.bin` container (see container.ts), and emits deterministic metrics:
// player-path heatmap grid, movement speed, time-to-first-kill, deaths/damage
// per player, mob density over time, and disconnect points.
//
// Determinism contract: the report depends ONLY on the input bytes + the options
// below. No wall-clock, no absolute paths, sorted JSON keys, fixed numeric
// precision. Same input -> byte-identical JSON/CSV/SVG.

import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';
import {
  decodeContainer,
  encodeContainer,
  isContainer,
  type RecordingRecord,
} from './container.js';

export const REPORT_FORMAT = 'aetherfall-analytics/v1';

export type PlayerSummary = {
  id: number;
  name: string;
  self: boolean;
  samples: number;
  distanceUnits: number;
  avgSpeed: number;
  maxSpeed: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  uncreditedDamage: number;
};

export type DensityBucket = {
  tMs: number;
  frames: number;
  players: number;
  mobs: number;
  peakMobs: number;
};

export type TimelinePoint = {
  tMs: number;
  tick: number;
  players: number;
  mobs: number;
  playerHp: number;
  playerMaxHp: number;
  speed: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
};

export type HeatCell = { x: number; y: number; players: number; mobs: number };

export type Heatmap = {
  cell: number;
  origin: { x: number; y: number };
  cols: number;
  rows: number;
  maxPlayers: number;
  maxMobs: number;
  totalPlayerSamples: number;
  totalMobSamples: number;
  occupiedCells: number;
  playerGrid: number[];
  mobGrid: number[];
  topCells: HeatCell[];
};

export type DisconnectPoint = { tMs: number; gapMs: number; reason: string; detail: string };

/** A player other than the recording client that left the shard mid-run. */
export type PlayerExit = { tMs: number; id: number; reason: string };

export type ReplayReport = {
  format: string;
  source: string;
  digest: string | null;
  options: AnalyzeOptions;
  records: number;
  frames: number;
  events: number;
  chats: number;
  malformedLines: number;
  startTMs: number;
  durationMs: number;
  tick: { first: number; last: number };
  self: { id: number; name: string } | null;
  players: PlayerSummary[];
  movement: {
    avgSpeed: number;
    maxSpeed: number;
    p95Speed: number;
    distanceUnits: number;
    movingFraction: number;
    samples: number;
    /**
     * Displacements dropped from the speed/distance stats: respawn jumps and
     * interest-filter re-entries that would otherwise read as huge speeds.
     */
    excludedJumps: number;
  };
  combat: {
    kills: number;
    deaths: number;
    damageDealt: number;
    damageTaken: number;
    uncreditedDamage: number;
    mobSpawns: number;
    mobRespawns: number;
    mobsKilled: number;
    /** Mobs seen reaching 0 HP, including deaths with no `mob-die` event. */
    mobDeathsObserved: number;
    xpGained: number;
    levelups: number;
    firstKillAtMs: number | null;
    timeToFirstKillMs: number | null;
  };
  mobDensity: {
    bucketMs: number;
    buckets: DensityBucket[];
    avg: number;
    peak: number;
    peakAtMs: number | null;
    min: number;
  };
  heatmap: Heatmap;
  timeline: TimelinePoint[];
  /** Points where the recording client's stream itself broke. */
  disconnects: DisconnectPoint[];
  /** Other players seen leaving; not client disconnects. */
  playerExits: PlayerExit[];
  eventCounts: Record<string, number>;
  warnings: string[];
};

export type Arena = { minX: number; minY: number; maxX: number; maxY: number };

export type AnalyzeOptions = {
  cell: number;
  bucketMs: number;
  gapFactor: number;
  gapMinMs: number;
  creditRadius: number;
  movingSpeed: number;
  /**
   * Speed samples above this (units/sec) are discarded as artifacts. Default is
   * 3x the server's MAX_SPEED (8 u/s), leaving room for knockback/interpolation
   * while dropping interest-filter re-entries that read as hundreds of u/s.
   */
  maxSpeed: number;
  precision: number;
  maxTimelinePoints: number;
  topCells: number;
  /**
   * Heatmap bounds. `null` means auto-fit to the observed entity positions
   * (deterministic: depends only on the input records). Pass explicit bounds to
   * force a fixed grid.
   */
  arena: Arena | null;
};

export const DEFAULT_OPTIONS: AnalyzeOptions = {
  cell: 4,
  bucketMs: 1000,
  gapFactor: 3,
  gapMinMs: 500,
  creditRadius: 3,
  movingSpeed: 0.5,
  maxSpeed: 24,
  precision: 4,
  maxTimelinePoints: 20000,
  topCells: 12,
  // The live arena is 100x100 but NPCs/walls push entities a few units past the
  // edge, so the default is auto-fit: the grid grows to hold whatever the
  // recording actually contains instead of silently clipping samples.
  arena: null,
};

/**
 * Deterministic heatmap bounds from observed positions: floor the minimums, ceil
 * the maximums, snap outward to whole cells, and keep at least one cell of
 * extent so a degenerate recording still yields a 1x1 grid.
 */
export function fitArena(
  frames: readonly { entities: readonly EntitySnapshot[] }[],
  cell: number,
): Arena {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of frames) {
    for (const e of f.entities) {
      if (!Number.isFinite(e.p.x) || !Number.isFinite(e.p.y)) continue;
      if (e.p.x < minX) minX = e.p.x;
      if (e.p.y < minY) minY = e.p.y;
      if (e.p.x > maxX) maxX = e.p.x;
      if (e.p.y > maxY) maxY = e.p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: cell, maxY: cell };
  const lo = (v: number): number => Math.floor(v / cell) * cell;
  const hi = (v: number): number => Math.ceil((v + Number.EPSILON) / cell) * cell;
  const minXx = lo(minX);
  const minYy = lo(minY);
  return {
    minX: minXx,
    minY: minYy,
    maxX: Math.max(hi(maxX), minXx + cell),
    maxY: Math.max(hi(maxY), minYy + cell),
  };
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

export type AnalyzeArgs = {
  input: string;
  json: string | null;
  csv: string | null;
  playersCsv: string | null;
  svgDir: string | null;
  bin: string | null;
  cell: number;
  bucketMs: number;
  gapFactor: number;
  gapMinMs: number;
  creditRadius: number;
  maxSpeed: number;
  precision: number;
  topCells: number;
  /** `--arena x0,y0,x1,y1`; null keeps the default auto-fit grid. */
  arena: Arena | null;
  quiet: boolean;
  stdout: boolean;
};

export function parseAnalyzeArgs(argv: string[], env: Record<string, string | undefined> = process.env): AnalyzeArgs {
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
    const pref = flag + '=';
    const found = argv.find((a) => a.startsWith(pref));
    return found ? found.slice(pref.length) : undefined;
  };
  // Positional = a non-flag token that is not the value of a space-separated
  // flag (`--flag value`). `--flag=value` consumes nothing, so a path may follow it.
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = i > 0 ? argv[i - 1]! : '';
    return !(prev.startsWith('--') && !prev.includes('='));
  });
  const num = (flag: string, fallback: number, lo: number, hi: number): number => {
    const raw = Number(getArg(flag) ?? NaN);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(lo, Math.min(hi, raw));
  };
  const input = getArg('--in') ?? getArg('--input') ?? positional[0] ?? env.REPLAY_IN ?? 'recordings/trial.ndjson';
  // `--arena x0,y0,x1,y1` pins the heatmap grid; anything else auto-fits.
  const arenaRaw = getArg('--arena');
  let arena: Arena | null = null;
  if (arenaRaw !== undefined) {
    const parts = arenaRaw.split(',').map(Number);
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v)) && parts[0]! < parts[2]! && parts[1]! < parts[3]!) {
      arena = { minX: parts[0]!, minY: parts[1]!, maxX: parts[2]!, maxY: parts[3]! };
    }
  }
  return {
    input,
    json: getArg('--json') ?? null,
    csv: getArg('--csv') ?? null,
    playersCsv: getArg('--players-csv') ?? null,
    svgDir: getArg('--svg-dir') ?? null,
    bin: getArg('--bin') ?? null,
    arena,
    cell: num('--cell', DEFAULT_OPTIONS.cell, 1, 50),
    bucketMs: num('--bucket-ms', DEFAULT_OPTIONS.bucketMs, 100, 600000),
    gapFactor: num('--gap-factor', DEFAULT_OPTIONS.gapFactor, 1, 100),
    gapMinMs: num('--gap-min-ms', DEFAULT_OPTIONS.gapMinMs, 0, 600000),
    creditRadius: num('--credit-radius', DEFAULT_OPTIONS.creditRadius, 0, 50),
    maxSpeed: num('--max-speed', DEFAULT_OPTIONS.maxSpeed, 0, 100000),
    precision: Math.round(num('--precision', DEFAULT_OPTIONS.precision, 0, 12)),
    topCells: Math.round(num('--top-cells', DEFAULT_OPTIONS.topCells, 0, 500)),
    quiet: argv.includes('--quiet') || env.REPLAY_QUIET === '1',
    stdout: argv.includes('--stdout') || env.REPLAY_STDOUT === '1',
  };
}

// ---------------------------------------------------------------------------
// recording io
// ---------------------------------------------------------------------------

export type Recording = {
  source: string;
  records: RecordingRecord[];
  malformedLines: number;
  digest: string | null;
  format: 'ndjson' | 'bin';
};

/** Parse NDJSON text. Malformed lines are counted and skipped, never thrown. */
export function parseNdjson(text: string): { records: RecordingRecord[]; malformedLines: number } {
  const records: RecordingRecord[] = [];
  let malformedLines = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    try {
      const rec = JSON.parse(line) as { t?: unknown; msg?: ServerMsg };
      if (rec === null || typeof rec !== 'object' || rec.msg === null || typeof rec.msg !== 'object') {
        malformedLines++;
        continue;
      }
      const t = Number(rec.t);
      records.push({ t: Number.isFinite(t) ? t : 0, msg: rec.msg });
    } catch {
      malformedLines++;
    }
  }
  return { records, malformedLines };
}

/** Stable order: by timestamp, ties broken by kind+id so output never wobbles. */
function sortRecords(records: RecordingRecord[]): RecordingRecord[] {
  return [...records].map((r, i) => ({ r, i })).sort((a, b) => {
    if (a.r.t !== b.r.t) return a.r.t - b.r.t;
    if (a.r.msg.t !== b.r.msg.t) return a.r.msg.t < b.r.msg.t ? -1 : 1;
    return a.i - b.i;
  }).map((x) => x.r);
}

/** Parse either container shape; sniffed by magic first, extension second. */
export function parseRecordingBytes(buf: Uint8Array): { records: RecordingRecord[]; malformedLines: number; format: 'ndjson' | 'bin' } {
  if (isContainer(buf)) return { records: decodeContainer(buf), malformedLines: 0, format: 'bin' };
  return { ...parseNdjson(new TextDecoder().decode(buf)), format: 'ndjson' };
}

/** Load a recording from disk. Extension decides the hint, magic decides the truth. */
export function loadRecording(path: string): Recording {
  const abs = resolve(path);
  const buf = readFileSync(abs);
  const { records, malformedLines, format } = parseRecordingBytes(buf);
  return {
    source: basename(abs),
    records: sortRecords(records),
    malformedLines,
    digest: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    format,
  };
}

// ---------------------------------------------------------------------------
// numeric + serialization helpers (determinism)
// ---------------------------------------------------------------------------

/** Round to `p` decimals; non-finite -> 0; -0 normalized to 0. */
export function round(n: number, p = DEFAULT_OPTIONS.precision): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(round(n));
}

function escapeString(s: string): string {
  return JSON.stringify(s);
}

/** JSON with recursively sorted object keys — byte-stable across runs/platforms. */
export function stableStringify(value: unknown, indent = 2): string {
  return write(value, indent, 0) + '\n';
}

function write(value: unknown, indent: number, depth: number): string {
  const pad = ' '.repeat(indent * (depth + 1));
  const closePad = ' '.repeat(indent * depth);
  if (value === null) return 'null';
  if (typeof value === 'number') return fmtNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return escapeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => pad + write(v, indent, depth + 1));
    return `[\n${items.join(',\n')}\n${closePad}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => `${pad}${escapeString(k)}: ${write(obj[k], indent, depth + 1)}`);
    return `{\n${items.join(',\n')}\n${closePad}}`;
  }
  return 'null';
}

/** CSV field escaping (RFC4180-ish): quote when it contains , " or newline. */
export function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: Array<string | number>): string {
  return cells.map(csvCell).join(',');
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/** One recorded view of the world, with the running combat totals at that time. */
type Frame = {
  t: number;
  tick: number;
  entities: EntitySnapshot[];
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
};

function isMobKind(kind: string): boolean {
  return kind === 'mob' || kind === 'npc';
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

type PlayerAcc = {
  id: number;
  name: string;
  self: boolean;
  samples: number;
  distance: number;
  speeds: number[];
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  uncredited: number;
  dead: boolean;
  lastDeathT: number | null;
};

/** Two HP observations closer than this are the same death (hp<=0 + respawn). */
const DEATH_LINGER_MS = 500;

export function analyze(
  records: readonly RecordingRecord[],
  options: Partial<AnalyzeOptions> = {},
  meta: { source?: string; digest?: string | null; malformedLines?: number } = {},
): ReplayReport {
  const opts: AnalyzeOptions = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  const recs = records.map((r) => ({ ...r }));
  const startT = recs.length > 0 ? recs[0]!.t : 0;
  const endT = recs.length > 0 ? recs[recs.length - 1]!.t : 0;
  const durationMs = Math.max(0, endT - startT);

  // Pre-pass over frame timestamps only, so the stall threshold is known before
  // the main walk. A stalled stream must not become a huge fake speed sample:
  // dividing a 1.2s stall into a 2u move reads as 1.7 u/s of "movement" that
  // never happened, and a stall+position gap reads as a teleport.
  const frameTimes: number[] = [];
  for (const rec of recs) {
    if (rec.msg.t === 'welcome' || rec.msg.t === 'snapshot') frameTimes.push(rec.t);
  }
  const preIntervals: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) {
    const d = frameTimes[i]! - frameTimes[i - 1]!;
    if (d > 0) preIntervals.push(d);
  }
  const medInterval = median(preIntervals);
  const gapThreshold = Math.max(opts.gapMinMs, round(opts.gapFactor * medInterval, 3));
  const speedStaleMs = gapThreshold;
  // MAX_SPEED is 8 u/s server-side. Allow headroom for interpolation, but stay
  // far below any respawn or interest-filter jump.
  const maxPlausibleJump = Math.max(32, (medInterval / 1000) * 32);

  let outOfSpeedBand = 0;
  let selfId: number | null = null;
  let selfName = '';
  let firstTick = 0;
  let lastTick = 0;
  let sawTick = false;
  let eventCount = 0;
  let chatCount = 0;
  const eventCounts: Record<string, number> = {};

  const players = new Map<number, PlayerAcc>();
  const hpById = new Map<number, number>();
  const kindById = new Map<number, string>();
  const posById = new Map<number, { x: number; y: number }>();

  const frames: Frame[] = [];
  const disconnects: DisconnectPoint[] = [];
  const playerExits: PlayerExit[] = [];
  let cumKills = 0;
  let cumDeaths = 0;
  let cumDealt = 0;
  let cumTaken = 0;
  let uncreditedDamage = 0;
  let mobSpawns = 0;
  let mobRespawns = 0;
  let mobsKilled = 0;
  let mobDeathsObserved = 0;
  let xpGained = 0;
  let levelups = 0;
  let firstKillAtMs: number | null = null;

  const bump = (k: string): void => {
    eventCounts[k] = (eventCounts[k] ?? 0) + 1;
  };

  const playerAcc = (id: number, name?: string): PlayerAcc => {
    let p = players.get(id);
    if (!p) {
      p = {
        id,
        name: name && name !== '' ? name : `p${id}`,
        self: selfId !== null && id === selfId,
        samples: 0,
        distance: 0,
        speeds: [],
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        damageTaken: 0,
        uncredited: 0,
        dead: false,
        lastDeathT: null,
      };
      players.set(id, p);
    } else if (name && name !== '' && p.name.startsWith('p') && p.name.slice(1) === String(id)) {
      p.name = name;
    }
    return p;
  };

  const noteDeath = (id: number, t: number): void => {
    const p = playerAcc(id);
    if (p.lastDeathT !== null && t - p.lastDeathT < DEATH_LINGER_MS) return;
    p.deaths++;
    p.dead = true;
    p.lastDeathT = t;
    if (selfId !== null && id === selfId) cumDeaths++;
  };

  for (const rec of recs) {
    const t = rec.t;
    const rel = t - startT;
    const msg = rec.msg;
    if (msg.t === 'welcome' || msg.t === 'snapshot') {
      const entities = msg.t === 'welcome' ? msg.snapshot : msg.entities;
      const tick = msg.tick;
      if (!sawTick) {
        firstTick = tick;
        sawTick = true;
      }
      lastTick = tick;
      if (msg.t === 'welcome' && selfId === null) {
        selfId = msg.id;
        selfName = entities.find((e) => e.id === msg.id)?.name ?? '';
      }

      const playerList: PlayerAcc[] = [];
      const mobList: EntitySnapshot[] = [];
      for (const e of entities) {
        kindById.set(e.id, e.kind);
        if (e.kind === 'player') {
          const acc = playerAcc(e.id, e.name);
          playerList.push(acc);
          acc.samples++;
        } else if (isMobKind(e.kind)) {
          mobList.push(e);
        }
      }

      // Speed from the previous frame. Two cases must not become speed samples:
      // a stalled stream (dt far larger than the median interval) and a player
      // that was just dropped from the interest set and re-entered (position
      // gap without a continuous track). Both would fake a teleport.
      const prevT = frames.length > 0 ? frames[frames.length - 1]!.t : null;
      const dtMs = prevT === null ? 0 : t - prevT;
      const stale = prevT !== null && dtMs > speedStaleMs;
      for (const acc of playerList) {
        const e = entities.find((x) => x.id === acc.id);
        if (!e) continue;
        const prev = posById.get(acc.id);
        if (!prev || stale) continue;
        const d = Math.hypot(e.p.x - prev.x, e.p.y - prev.y);
        const speed = dtMs > 0 ? (d / dtMs) * 1000 : 0;
        // An interest-filtered entity can re-enter the snapshot set far from
        // where it was last seen, or a player respawns across the arena. Both
        // look like a huge one-frame displacement; neither is movement.
        if (d > maxPlausibleJump || speed > opts.maxSpeed) {
          outOfSpeedBand++;
          continue;
        }
        acc.distance += d;
        if (dtMs > 0) acc.speeds.push(speed);
      }

      // HP deltas -> damage + deaths
      const nearestPlayer = (x: number, y: number): number | null => {
        // Protocol v1 snapshots carry no attacker id: credit the closest player
        // inside creditRadius, otherwise leave the damage uncredited.
        let bestId: number | null = null;
        let bestD = opts.creditRadius;
        for (const acc of playerList) {
          const pe = entities.find((x2) => x2.id === acc.id);
          if (!pe) continue;
          const d = Math.hypot(pe.p.x - x, pe.p.y - y);
          if (d <= bestD) {
            bestD = d;
            bestId = acc.id;
          }
        }
        return bestId;
      };
      for (const e of entities) {
        const prevHp = hpById.get(e.id);
        if (prevHp !== undefined && Number.isFinite(prevHp) && e.hp < prevHp - 1e-9) {
          const delta = prevHp - e.hp;
          if (e.kind === 'player') {
            const acc = playerAcc(e.id);
            acc.damageTaken += delta;
            if (selfId !== null && e.id === selfId) cumTaken += delta;
            if (e.hp <= 0) noteDeath(e.id, t);
          } else if (isMobKind(e.kind)) {
            const bestId = nearestPlayer(e.p.x, e.p.y);
            if (bestId === null) {
              uncreditedDamage += delta;
            } else {
              playerAcc(bestId).damageDealt += delta;
              if (selfId !== null && bestId === selfId) cumDealt += delta;
            }
            // A mob reaching 0 HP is a kill even when no `mob-die` event was
            // broadcast (AI-NPC deaths emit none), so infer it from the snapshot.
            if (e.hp <= 0) {
              mobDeathsObserved++;
              if (bestId !== null) {
                playerAcc(bestId).kills++;
                if (selfId !== null && bestId === selfId) {
                  cumKills++;
                  if (firstKillAtMs === null) firstKillAtMs = rel;
                }
              } else if (firstKillAtMs === null) {
                firstKillAtMs = rel;
              }
            }
          }
        }
        hpById.set(e.id, e.hp);
        posById.set(e.id, { x: e.p.x, y: e.p.y });
      }

      frames.push({
        t,
        tick,
        entities,
        kills: cumKills,
        deaths: cumDeaths,
        damageDealt: round(cumDealt),
        damageTaken: round(cumTaken),
      });
      continue;
    }

    if (msg.t === 'chat') {
      chatCount++;
      continue;
    }

    // events
    eventCount++;
    bump(msg.kind);
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    switch (msg.kind) {
      case 'mob-die': {
        mobsKilled++;
        const killer = Number(payload.killedBy);
        if (Number.isFinite(killer)) {
          playerAcc(killer).kills++;
          if (selfId !== null && killer === selfId) {
            cumKills++;
            if (firstKillAtMs === null) firstKillAtMs = rel;
          }
        }
        break;
      }
      case 'mob-spawn':
        mobSpawns++;
        break;
      case 'mob-respawn':
        mobRespawns++;
        break;
      case 'respawn': {
        const id = Number(payload.id);
        if (Number.isFinite(id)) {
          noteDeath(id, t);
          const acc = playerAcc(id);
          acc.dead = false;
          // A respawn is a teleport to the spawn point, not movement: drop the
          // cached position so the jump is excluded from speed and distance.
          posById.delete(id);
          hpById.delete(id);
        }
        break;
      }
      case 'despawn': {
        // `despawn` is broadcast to everyone when ANY player leaves. Only the
        // recording client going away is a client-side disconnect; other ids
        // are ordinary churn (bots rotating in/out) and land in playerExits.
        const id = Number(payload.id);
        if (Number.isFinite(id) && id !== selfId) {
          playerExits.push({ tMs: round(rel), id, reason: 'despawn' });
        } else {
          disconnects.push({ tMs: round(rel), gapMs: 0, reason: 'player-left', detail: `id=${String(payload.id ?? '?')}` });
        }
        break;
      }
      case 'kicked': {
        disconnects.push({ tMs: round(rel), gapMs: 0, reason: 'kicked', detail: String(payload.reason ?? 'unknown') });
        break;
      }
      case 'redirect': {
        disconnects.push({ tMs: round(rel), gapMs: 0, reason: 'redirect', detail: String(payload.shard ?? payload.url ?? '') });
        break;
      }
      case 'bad-proto': {
        disconnects.push({ tMs: round(rel), gapMs: 0, reason: 'bad-proto', detail: '' });
        break;
      }
      case 'xp-gain': {
        const amount = Number(payload.amount);
        if (Number.isFinite(amount)) xpGained += amount;
        break;
      }
      case 'levelup':
        levelups++;
        break;
      default:
        break;
    }
  }

  // ---- gap-based disconnects (stalled / dropped snapshot stream) -----------
  // Uses the pre-pass medInterval/gapThreshold computed before the walk.
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i]!.t - frames[i - 1]!.t;
    if (dt > gapThreshold) {
      disconnects.push({
        tMs: round(frames[i - 1]!.t - startT),
        gapMs: round(dt),
        reason: 'snapshot-gap',
        detail: `threshold=${gapThreshold}ms`,
      });
    }
  }
  disconnects.sort((a, b) => a.tMs - b.tMs || a.reason.localeCompare(b.reason));

  // ---- per-player speed, timeline, density --------------------------------
  const allSpeeds: number[] = [];
  let totalDistance = 0;
  for (const p of players.values()) {
    allSpeeds.push(...p.speeds);
    totalDistance += p.distance;
  }
  const sortedSpeeds = [...allSpeeds].sort((a, b) => a - b);
  const movingSamples = sortedSpeeds.filter((s) => s >= opts.movingSpeed).length;

  const bucketMs = opts.bucketMs;
  const bucketCount = durationMs > 0 ? Math.floor(durationMs / bucketMs) + 1 : 1;
  const buckets: DensityBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ tMs: i * bucketMs, frames: 0, players: 0, mobs: 0, peakMobs: 0 });
  }
  const step = opts.maxTimelinePoints > 0 && frames.length > opts.maxTimelinePoints
    ? Math.ceil(frames.length / opts.maxTimelinePoints)
    : 1;
  const timeline: TimelinePoint[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const rel = f.t - startT;
    let playersN = 0;
    let mobsN = 0;
    let hp = 0;
    let maxHp = 0;
    let speed = 0;
    let speedN = 0;
    for (const e of f.entities) {
      if (e.kind === 'player') {
        playersN++;
        hp += e.hp;
        maxHp += e.maxHp;
        speed += Math.hypot(e.v?.x ?? 0, e.v?.y ?? 0);
        speedN++;
      } else if (isMobKind(e.kind)) {
        mobsN++;
      }
    }
    const bIdx = Math.min(bucketCount - 1, Math.floor(rel / bucketMs));
    const b = buckets[Math.max(0, bIdx)]!;
    b.frames++;
    b.players += playersN;
    b.mobs += mobsN;
    if (mobsN > b.peakMobs) b.peakMobs = mobsN;
    // One timeline point per sampled frame (always includes the last frame so the
    // series spans the full recording even when `step` downsamples).
    if (i % step === 0 || i === frames.length - 1) {
      if (speedN > 0) speed /= speedN;
      timeline.push({
        tMs: round(rel),
        tick: f.tick,
        players: playersN,
        mobs: mobsN,
        playerHp: round(hp),
        playerMaxHp: round(maxHp),
        speed: round(speed),
        kills: f.kills,
        deaths: f.deaths,
        damageDealt: f.damageDealt,
        damageTaken: f.damageTaken,
      });
    }
  }

  for (const b of buckets) {
    if (b.frames > 0) {
      b.players = round(b.players / b.frames);
      b.mobs = round(b.mobs / b.frames);
    } else {
      b.players = 0;
      b.mobs = 0;
    }
  }
  let densAvg = 0;
  let densPeak = 0;
  let densPeakAt: number | null = null;
  let densMin = 0;
  if (buckets.length > 0) {
    const vals = buckets.map((b) => b.mobs);
    densAvg = round(vals.reduce((s, v) => s + v, 0) / vals.length);
    densPeak = Math.max(...vals);
    densMin = Math.min(...vals);
    densPeakAt = buckets.find((b) => b.mobs === densPeak)?.tMs ?? null;
  }

  // ---- heatmap ------------------------------------------------------------
  const cell = Math.max(1, opts.cell);
  const arena = opts.arena ?? fitArena(frames, cell);
  const spanX = arena.maxX - arena.minX;
  const spanY = arena.maxY - arena.minY;
  const cols = Math.max(1, Math.round(spanX / cell));
  const cellRows = Math.max(1, Math.round(spanY / cell));
  const playerGrid = new Array<number>(cols * cellRows).fill(0);
  const mobGrid = new Array<number>(cols * cellRows).fill(0);
  const cellOf = (x: number, y: number): number | null => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Clamp, don't reject: a sample a hair outside the fitted bounds belongs in
    // the edge cell, and only genuinely unreachable positions are dropped.
    if (x < arena.minX - cell || x > arena.maxX + cell) return null;
    if (y < arena.minY - cell || y > arena.maxY + cell) return null;
    const c = Math.min(cols - 1, Math.max(0, Math.floor((x - arena.minX) / cell)));
    const r = Math.min(cellRows - 1, Math.max(0, Math.floor((y - arena.minY) / cell)));
    return r * cols + c;
  };
  let outOfBounds = 0;
  for (const f of frames) {
    for (const e of f.entities) {
      const idx = cellOf(e.p.x, e.p.y);
      if (idx === null) {
        outOfBounds++;
        continue;
      }
      if (e.kind === 'player') playerGrid[idx]!++;
      else if (isMobKind(e.kind)) mobGrid[idx]!++;
    }
  }
  if (outOfBounds > 0) {
    warn(`${outOfBounds} entity samples outside arena bounds (clipped out of heatmap)`);
  }
  if (outOfSpeedBand > 0) {
    warn(`${outOfSpeedBand} displacement sample(s) above ${opts.maxSpeed}u/s dropped (respawn / interest re-entry)`);
  }
  if (playerExits.length > 0) {
    warn(`${playerExits.length} other player(s) left mid-run (see playerExits)`);
  }
  const maxPlayers = playerGrid.reduce((a, b) => Math.max(a, b), 0);
  const maxMobs = mobGrid.reduce((a, b) => Math.max(a, b), 0);
  const occupied: number[] = [];
  for (let i = 0; i < playerGrid.length; i++) {
    if ((playerGrid[i] ?? 0) > 0 || (mobGrid[i] ?? 0) > 0) occupied.push(i);
  }
  const topCells: HeatCell[] = occupied
    .map((i) => ({
      x: round(arena.minX + (i % cols) * cell, 3),
      y: round(arena.minY + Math.floor(i / cols) * cell, 3),
      players: playerGrid[i] ?? 0,
      mobs: mobGrid[i] ?? 0,
    }))
    .sort((a, b) => b.players - a.players || b.mobs - a.mobs || a.y - b.y || a.x - b.x)
    .slice(0, opts.topCells);

  if (frames.length === 0) warn('no frames (welcome/snapshot records) in recording');
  if (mobsKilled === 0) {
    warn('no mob-die event recorded; record with the recorder\'s --all flag for event metrics');
  }
  if (firstKillAtMs === null) warn('no mob death observed in any snapshot; kill metrics are zero');
  if (uncreditedDamage > 0) {
    warn(`${round(uncreditedDamage, 2)} damage could not be attributed to a player (no attacker id in protocol v1)`);
  }
  if (disconnects.length > 0) warn(`${disconnects.length} client disconnect point(s) detected`);

  const playerSummaries: PlayerSummary[] = [...players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      self: p.self,
      samples: p.samples,
      distanceUnits: round(p.distance),
      avgSpeed: p.speeds.length > 0 ? round(p.speeds.reduce((s, v) => s + v, 0) / p.speeds.length) : 0,
      maxSpeed: p.speeds.length > 0 ? round(Math.max(...p.speeds)) : 0,
      kills: p.kills,
      deaths: p.deaths,
      damageDealt: round(p.damageDealt),
      damageTaken: round(p.damageTaken),
      uncreditedDamage: round(p.uncredited),
    }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.id - b.id);

  return {
    format: REPORT_FORMAT,
    source: meta.source ?? '',
    digest: meta.digest ?? null,
    options: opts,
    records: recs.length,
    frames: frames.length,
    events: eventCount,
    chats: chatCount,
    malformedLines: meta.malformedLines ?? 0,
    startTMs: round(startT),
    durationMs: round(durationMs),
    tick: { first: firstTick, last: lastTick },
    self: selfId === null ? null : { id: selfId, name: selfName || `p${selfId}` },
    players: playerSummaries,
    movement: {
      avgSpeed: sortedSpeeds.length > 0 ? round(sortedSpeeds.reduce((s, v) => s + v, 0) / sortedSpeeds.length) : 0,
      maxSpeed: sortedSpeeds.length > 0 ? round(sortedSpeeds[sortedSpeeds.length - 1]!) : 0,
      p95Speed: round(percentile(sortedSpeeds, 0.95)),
      distanceUnits: round(totalDistance),
      movingFraction: sortedSpeeds.length > 0 ? round(movingSamples / sortedSpeeds.length) : 0,
      samples: sortedSpeeds.length,
      excludedJumps: outOfSpeedBand,
    },
    combat: {
      kills: cumKills,
      deaths: cumDeaths,
      damageDealt: round(cumDealt),
      damageTaken: round(cumTaken),
      uncreditedDamage: round(uncreditedDamage),
      mobSpawns,
      mobRespawns,
      mobsKilled,
      mobDeathsObserved,
      xpGained: round(xpGained),
      levelups,
      firstKillAtMs,
      timeToFirstKillMs: firstKillAtMs,
    },
    mobDensity: {
      bucketMs,
      buckets,
      avg: densAvg,
      peak: densPeak,
      peakAtMs: densPeakAt,
      min: densMin,
    },
    heatmap: {
      cell,
      origin: { x: round(arena.minX, 3), y: round(arena.minY, 3) },
      cols,
      rows: cellRows,
      maxPlayers,
      maxMobs,
      totalPlayerSamples: playerGrid.reduce((s, v) => s + v, 0),
      totalMobSamples: mobGrid.reduce((s, v) => s + v, 0),
      occupiedCells: occupied.length,
      playerGrid,
      mobGrid,
      topCells,
    },
    timeline,
    disconnects,
    playerExits: playerExits.sort((a, b) => a.tMs - b.tMs || a.id - b.id),
    eventCounts,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_HEADER = [
  't_ms',
  'tick',
  'players',
  'mobs',
  'player_hp',
  'player_max_hp',
  'speed_u_s',
  'kills',
  'deaths',
  'damage_dealt',
  'damage_taken',
] as const;

/** Timeline CSV (LF endings, fixed precision, trailing newline). */
export function reportToCsv(report: ReplayReport): string {
  const p = report.options.precision;
  const f = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(p));
  const lines = [csvRow([...CSV_HEADER])];
  for (const t of report.timeline) {
    lines.push(
      csvRow([
        t.tMs,
        t.tick,
        t.players,
        t.mobs,
        f(t.playerHp),
        f(t.playerMaxHp),
        f(t.speed),
        t.kills,
        t.deaths,
        f(t.damageDealt),
        f(t.damageTaken),
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

/** Per-player CSV — same layout as report.players, one row per player. */
export function playersToCsv(report: ReplayReport): string {
  const p = report.options.precision;
  const f = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(p));
  const head = ['id', 'name', 'self', 'samples', 'distance_units', 'avg_speed', 'max_speed', 'kills', 'deaths', 'damage_dealt', 'damage_taken', 'uncredited_damage'];
  const lines = [csvRow(head)];
  for (const pl of report.players) {
    lines.push(
      csvRow([
        pl.id,
        pl.name,
        pl.self ? 1 : 0,
        pl.samples,
        f(pl.distanceUnits),
        f(pl.avgSpeed),
        f(pl.maxSpeed),
        pl.kills,
        pl.deaths,
        f(pl.damageDealt),
        f(pl.damageTaken),
        f(pl.uncreditedDamage),
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// SVG (no deps, deterministic)
// ---------------------------------------------------------------------------

export type SvgOptions = {
  cellPx: number;
  width: number;
  title: string;
  subtitle: string;
  palette: string[];
  value: 'players' | 'mobs';
  footer: string[];
};

export const DEFAULT_SVG: Omit<SvgOptions, 'title' | 'subtitle' | 'footer' | 'value'> = {
  cellPx: 16,
  width: 720,
  palette: ['#0d1b2a', '#123a5a', '#1a6b7a', '#38a169', '#f6c343', '#ff5252'],
};

const PLAYER_PALETTE = ['#0d1b2a', '#123a5a', '#1a6b7a', '#38a169', '#f6c343', '#ff5252'];
const MOB_PALETTE = ['#140b21', '#2d1247', '#4c1d78', '#7b2fa8', '#c14fd6', '#ff8ae0'];

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function n2(v: number): string {
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

/** 6-step quantized ramp -> stable colors for identical inputs. */
export function heatColor(value: number, max: number, palette: string[]): string {
  if (value <= 0 || max <= 0) return palette[0]!;
  const idx = Math.min(palette.length - 1, Math.max(0, Math.floor((value / max) * palette.length)));
  return palette[idx]!;
}

function heatCells(report: ReplayReport, grid: number[], max: number, palette: string[], geo: {
  x0: number; y0: number; cell: number; cellPx: number;
}): string {
  const out: string[] = [];
  for (let r = 0; r < report.heatmap.rows; r++) {
    for (let c = 0; c < report.heatmap.cols; c++) {
      const v = grid[r * report.heatmap.cols + c] ?? 0;
      if (v <= 0) continue;
      out.push(
        `<rect x="${n2(geo.x0 + c * geo.cellPx)}" y="${n2(geo.y0 + r * geo.cellPx)}" width="${n2(geo.cellPx)}" height="${n2(geo.cellPx)}" fill="${heatColor(v, max, palette)}"/>`,
      );
    }
  }
  return out.join('');
}

/** Player-path (or mob-density) heatmap as a standalone SVG document. */
export function renderHeatmapSvg(report: ReplayReport, opts: Partial<SvgOptions> = {}): string {
  const isMobs = opts.value === 'mobs';
  const grid = isMobs ? report.heatmap.mobGrid : report.heatmap.playerGrid;
  const max = isMobs ? report.heatmap.maxMobs : report.heatmap.maxPlayers;
  const palette = opts.palette ?? (isMobs ? MOB_PALETTE : PLAYER_PALETTE);
  const cellPx = opts.cellPx ?? DEFAULT_SVG.cellPx;
  const width = opts.width ?? DEFAULT_SVG.width;
  const left = 54;
  const top = 58;
  const mapW = report.heatmap.cols * cellPx;
  const mapH = report.heatmap.rows * cellPx;
  const height = top + mapH + 74;
  const title = opts.title ?? (isMobs ? 'mob density heatmap' : 'player path heatmap');
  const subtitle =
    opts.subtitle ??
    `${report.source || 'recording'} · ${report.heatmap.cell}u cells · ${report.heatmap.cols}x${report.heatmap.rows} · max ${max} samples/cell`;
  const footer = opts.footer ?? [
    `frames=${report.frames} duration=${(report.durationMs / 1000).toFixed(1)}s`,
    isMobs
      ? `mobSamples=${report.heatmap.totalMobSamples} peakDensity=${report.mobDensity.peak}`
      : `playerSamples=${report.heatmap.totalPlayerSamples} avgSpeed=${report.movement.avgSpeed}u/s`,
    `cellsOccupied=${report.heatmap.occupiedCells}/${report.heatmap.cols * report.heatmap.rows}`,
  ];

  const gridLines: string[] = [];
  for (let c = 0; c <= report.heatmap.cols; c += 5) {
    const x = left + c * cellPx;
    gridLines.push(`<line x1="${n2(x)}" y1="${top}" x2="${n2(x)}" y2="${top + mapH}" stroke="#1c2740"/>`);
    gridLines.push(
      `<text x="${n2(x)}" y="${top + mapH + 18}" fill="#7f8ea8" font-size="10" text-anchor="middle">${report.heatmap.origin.x + c * report.heatmap.cell}</text>`,
    );
  }
  for (let r = 0; r <= report.heatmap.rows; r += 5) {
    const y = top + r * cellPx;
    gridLines.push(`<line x1="${left}" y1="${n2(y)}" x2="${left + mapW}" y2="${n2(y)}" stroke="#1c2740"/>`);
    gridLines.push(
      `<text x="${left - 8}" y="${n2(y + 3)}" fill="#7f8ea8" font-size="10" text-anchor="end">${report.heatmap.origin.y + r * report.heatmap.cell}</text>`,
    );
  }

  const legendW = 150;
  const legendY = top + 8;
  const swatches = palette
    .map((c, i) => {
      const w = legendW / palette.length;
      const lo = max === 0 ? 0 : Math.round((i / palette.length) * max);
      const hi = Math.round(((i + 1) / palette.length) * max);
      return `<rect x="${n2(left + mapW + 24)}" y="${n2(legendY + i * w)}" width="${n2(w)}" height="${n2(w)}" fill="${c}"/>` +
        `<text x="${n2(left + mapW + 24)}" y="${n2(legendY + i * w + w - 3)}" fill="#0b0e14" font-size="9">${lo}-${hi}</text>`;
    })
    .join('');

  const footerText = footer
    .map((f, i) => `<text x="${left}" y="${top + mapH + 40 + i * 14}" fill="#8fa3bf" font-size="11">${xml(f)}</text>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}">
<title>${xml(title)}</title>
<desc>${xml(subtitle)}</desc>
<rect width="${width}" height="${height}" fill="#0b0e14"/>
<text x="${left}" y="28" fill="#e8eef7" font-size="16" font-family="system-ui,sans-serif" letter-spacing="2">${xml(title.toUpperCase())}</text>
<text x="${left}" y="46" fill="#8fa3bf" font-size="11" font-family="system-ui,sans-serif">${xml(subtitle)}</text>
${gridLines.join('\n')}
<rect x="${left}" y="${top}" width="${n2(mapW)}" height="${n2(mapH)}" fill="#101623" stroke="#2a3547"/>
${heatCells(report, grid, max, palette, { x0: left, y0: top, cell: report.heatmap.cell, cellPx })}
<text x="${n2(left + mapW / 2)}" y="${top + mapH + 32}" fill="#8fa3bf" font-size="10" text-anchor="middle">world x (units)</text>
${swatches}
${footerText}
</svg>
`;
}

export type SeriesSpec = { key: 'players' | 'mobs' | 'playerHp' | 'playerMaxHp' | 'speed'; label: string; color: string };

export const TIMELINE_SERIES: SeriesSpec[] = [
  { key: 'mobs', label: 'mobs visible', color: '#ff7a5a' },
  { key: 'players', label: 'players visible', color: '#5aa9ff' },
  { key: 'speed', label: 'player speed (u/s)', color: '#ffd75a' },
  { key: 'playerHp', label: 'player HP', color: '#3ddc84' },
];

/** Multi-series timeline chart as a standalone SVG document. */
export function renderTimelineSvg(report: ReplayReport, opts: { width?: number; height?: number } = {}): string {
  const width = opts.width ?? DEFAULT_SVG.width;
  const height = opts.height ?? 300;
  const left = 54;
  const right = 132;
  const top = 58;
  const bottom = 46;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const pts = report.timeline;
  const maxT = pts.length > 0 ? pts[pts.length - 1]!.tMs : 0;
  let maxY = 1;
  for (const p of pts) {
    for (const s of TIMELINE_SERIES) maxY = Math.max(maxY, p[s.key]);
  }
  maxY = Math.ceil(maxY);
  const px = (t: number): number => left + (maxT <= 0 ? 0 : (t / maxT) * plotW);
  const py = (v: number): number => top + plotH - (maxY <= 0 ? 0 : (v / maxY) * plotH);

  const hLines: string[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (maxY / steps) * i;
    const y = py(v);
    hLines.push(`<line x1="${left}" y1="${n2(y)}" x2="${left + plotW}" y2="${n2(y)}" stroke="#1c2740"/>`);
    hLines.push(`<text x="${left - 8}" y="${n2(y + 3)}" fill="#7f8ea8" font-size="10" text-anchor="end">${Math.round(v)}</text>`);
  }
  const tTicks: string[] = [];
  for (let i = 0; i <= 5; i++) {
    const t = (maxT / 5) * i;
    tTicks.push(`<text x="${n2(px(t))}" y="${top + plotH + 16}" fill="#7f8ea8" font-size="10" text-anchor="middle">${(t / 1000).toFixed(1)}s</text>`);
  }

  const series = TIMELINE_SERIES.map((s) => {
    const d = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${n2(px(p.tMs))},${n2(py(p[s.key]))}`)
      .join(' ');
    const last = pts[pts.length - 1];
    const ly = last ? py(last[s.key]) : top;
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.5"/>` +
      `<rect x="${left + plotW + 14}" y="${n2(ly - 6)}" width="10" height="3" fill="${s.color}"/>` +
      `<text x="${left + plotW + 30}" y="${n2(ly)}" fill="#8fa3bf" font-size="10">${xml(s.label)}</text>`;
  }).join('\n');

  const subtitle = `${report.source || 'recording'} · ${pts.length} frames · ${(report.durationMs / 1000).toFixed(1)}s · kills=${report.combat.kills} deaths=${report.combat.deaths}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="replay timeline">
<title>replay timeline</title>
<desc>${xml(subtitle)}</desc>
<rect width="${width}" height="${height}" fill="#0b0e14"/>
<text x="${left}" y="28" fill="#e8eef7" font-size="16" font-family="system-ui,sans-serif" letter-spacing="2">REPLAY TIMELINE</text>
<text x="${left}" y="46" fill="#8fa3bf" font-size="11" font-family="system-ui,sans-serif">${xml(subtitle)}</text>
${hLines.join('\n')}
${tTicks.join('\n')}
<rect x="${left}" y="${top}" width="${n2(plotW)}" height="${n2(plotH)}" fill="#101623" stroke="#2a3547"/>
${series}
</svg>
`;
}

// ---------------------------------------------------------------------------
// artifact writing
// ---------------------------------------------------------------------------

export type WriteOptions = {
  jsonPath?: string | null;
  csvPath?: string | null;
  playersCsvPath?: string | null;
  svgDir?: string | null;
  binPath?: string | null;
};

export type WrittenArtifact = { path: string; bytes: number; kind: string };

export function writeArtifacts(report: ReplayReport, opts: WriteOptions, records?: readonly RecordingRecord[]): WrittenArtifact[] {
  const out: WrittenArtifact[] = [];
  const put = (path: string, body: string, kind: string): void => {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), body);
    out.push({ path, bytes: Buffer.byteLength(body), kind });
  };
  if (opts.jsonPath) put(opts.jsonPath, stableStringify(report), 'json');
  if (opts.csvPath) put(opts.csvPath, reportToCsv(report), 'csv');
  if (opts.playersCsvPath) put(opts.playersCsvPath, playersToCsv(report), 'csv');
  if (opts.svgDir) {
    const base = report.source.replace(/\.[^.]+$/, '') || 'recording';
    put(`${opts.svgDir}/${base}-path-heatmap.svg`, renderHeatmapSvg(report, { value: 'players' }), 'svg');
    put(`${opts.svgDir}/${base}-mob-density.svg`, renderHeatmapSvg(report, { value: 'mobs' }), 'svg');
    put(`${opts.svgDir}/${base}-timeline.svg`, renderTimelineSvg(report), 'svg');
  }
  if (opts.binPath) {
    if (!records) throw new Error('analyze: --bin requires the parsed records');
    mkdirSync(dirname(resolve(opts.binPath)), { recursive: true });
    const buf = encodeContainer(records);
    writeFileSync(resolve(opts.binPath), buf);
    out.push({ path: opts.binPath, bytes: buf.length, kind: 'bin' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function summarize(report: ReplayReport): string[] {
  const self = report.self;
  const who = self ? `${self.name} (#${self.id})` : 'unknown client';
  const lines = [
    `[analyze] ${report.source} format=${report.format} digest=${report.digest ?? '-'}`,
    `  records=${report.records} frames=${report.frames} events=${report.events} chats=${report.chats} duration=${(report.durationMs / 1000).toFixed(1)}s`,
    `  client=${who} players=${report.players.length}`,
    `  speed avg=${report.movement.avgSpeed}u/s p95=${report.movement.p95Speed}u/s max=${report.movement.maxSpeed}u/s dist=${report.movement.distanceUnits}u moving=${(report.movement.movingFraction * 100).toFixed(1)}% samples=${report.movement.samples} skippedJumps=${report.movement.excludedJumps}`,
    `  combat kills=${report.combat.kills} deaths=${report.combat.deaths} dealt=${report.combat.damageDealt} taken=${report.combat.damageTaken} ttff=${report.combat.timeToFirstKillMs === null ? 'n/a' : `${(report.combat.timeToFirstKillMs / 1000).toFixed(2)}s`}`,
    `  mobs spawns=${report.combat.mobSpawns} respawns=${report.combat.mobRespawns} killed=${report.combat.mobsKilled} density avg=${report.mobDensity.avg} peak=${report.mobDensity.peak}@${(report.mobDensity.peakAtMs ?? 0) / 1000}s`,
    `  heatmap cell=${report.heatmap.cell}u occupied=${report.heatmap.occupiedCells}/${report.heatmap.cols * report.heatmap.rows}`,
    `  disconnects=${report.disconnects.length}${report.disconnects.length > 0 ? ` first=${report.disconnects[0]!.reason}@${(report.disconnects[0]!.tMs / 1000).toFixed(1)}s` : ''} otherPlayersLeft=${report.playerExits.length}`,
  ];
  for (const w of report.warnings) lines.push(`  warn: ${w}`);
  return lines;
}

function main(argv: string[]): void {
  const args = parseAnalyzeArgs(argv);
  const abs = resolve(args.input);
  if (!existsSafe(abs)) {
    console.error(`[analyze] input not found: ${abs}`);
    process.exitCode = 1;
    return;
  }
  const rec = loadRecording(abs);
  if (rec.records.length === 0) {
    console.error(`[analyze] no records in ${args.input}`);
    process.exitCode = 1;
    return;
  }
  const report = analyze(rec.records, {
    cell: args.cell,
    bucketMs: args.bucketMs,
    gapFactor: args.gapFactor,
    gapMinMs: args.gapMinMs,
    creditRadius: args.creditRadius,
    maxSpeed: args.maxSpeed,
    precision: args.precision,
    topCells: args.topCells,
    arena: args.arena,
  }, { source: rec.source, digest: rec.digest, malformedLines: rec.malformedLines });

  const stem = abs.replace(/\.[^.]+$/, '');
  const written = writeArtifacts(
    report,
    {
      jsonPath: args.json ?? `${stem}.metrics.json`,
      csvPath: args.csv ?? `${stem}.timeline.csv`,
      playersCsvPath: args.playersCsv ?? `${stem}.players.csv`,
      svgDir: args.svgDir,
      binPath: args.bin,
    },
    rec.records,
  );
  if (!args.quiet) {
    for (const l of summarize(report)) console.log(l);
    for (const w of written) console.log(`  wrote ${w.kind} ${w.path} (${w.bytes} bytes)`);
  }
  if (args.stdout) process.stdout.write(stableStringify(report));
}

function existsSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Import-safe: unit tests import the pure helpers without running the CLI.
const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main(process.argv.slice(2));