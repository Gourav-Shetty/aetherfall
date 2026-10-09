import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mulberry32, type EntitySnapshot, type ServerMsg } from '@aetherfall/shared';
import { encodeContainer, type RecordingRecord } from './container.js';

// Snapshot recorder: dumps server snapshots to .ndjson (one JSON object per line).
// Usage:
//   node dist/recorder.js --server ws://localhost:8081 --duration 30 --out recordings/run.ndjson
// Each line: { "t": <ms since record start>, "msg": <ServerMsg snapshot|welcome|chat|event> }
// Replay with tools/replay/viewer.html (open in browser, load the .ndjson file).
// Metrics with tools/replay/viewer.html's sibling CLI: `npm run analyze -- --in <file>`.
//
// Flags:
//   --all          also record chat + event records (needed for kills/damage)
//   --drive        send 20Hz inputs on a seeded patrol loop (otherwise the client
//                  stands still and the recording has no motion to analyze)
//   --format bin   write the compact AFRB container instead of ndjson
//   --seed <n>     patrol seed (default 1337); same seed -> same path

export type RecorderArgs = {
  server: string;
  duration: number;
  out: string;
  recordAll: boolean;
  drive: boolean;
  seed: number;
  format: 'ndjson' | 'bin';
};

export function parseRecorderArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  defaultOut = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'recordings', `run-${Date.now()}.ndjson`),
): RecorderArgs {
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    const pref = flag + '=';
    const found = argv.find((a) => a.startsWith(pref));
    return found ? found.slice(pref.length) : undefined;
  };
  const durationRaw = Number(getArg('--duration') ?? env.DURATION ?? 30);
  const seedRaw = Number(getArg('--seed') ?? env.SEED ?? 1337);
  const format = getArg('--format') === 'bin' ? 'bin' : 'ndjson';
  return {
    server: getArg('--server') ?? env.SERVER ?? 'ws://localhost:8081',
    duration: Number.isFinite(durationRaw) ? Math.max(1, durationRaw) : 30,
    out: getArg('--out') ?? defaultOut,
    recordAll: argv.includes('--all'),
    drive: argv.includes('--drive'),
    seed: Number.isFinite(seedRaw) ? seedRaw : 1337,
    format,
  };
}

export function shouldRecord(msg: ServerMsg, recordAll: boolean): boolean {
  return msg.t === 'snapshot' || msg.t === 'welcome' || recordAll;
}

/**
 * Seeded patrol input for one 20Hz tick. Deterministic for a given (seed, tick),
 * so two runs with the same seed trace the same path through the arena. Keeps a
 * unit-length move vector (server normalizes anyway) and attacks when a mob is
 * inside melee reach, which is what produces kill/damage events to analyze.
 */
/** Patrol waypoints are re-aimed every 25 ticks (0.5s at 20Hz). */
export const DRIVE_REAIM_TICKS = 25;
/** Arena is 100x100; waypoints stay inside this inset. */
const DRIVE_MARGIN = 10;
const DRIVE_SPAN = 80;
/** Melee reach that gates the attack flag (matches combat MELEE_RANGE). */
const DRIVE_MELEE = 2.2;

/** Deterministic patrol waypoint for a seed and tick block (no shared state). */
export function driveWaypoint(seed: number, tick: number): { x: number; y: number } {
  const block = Math.floor(Math.max(0, tick) / DRIVE_REAIM_TICKS);
  const rand = mulberry32((seed ^ Math.imul(block + 1, 2654435761)) >>> 0);
  return { x: DRIVE_MARGIN + rand() * DRIVE_SPAN, y: DRIVE_MARGIN + rand() * DRIVE_SPAN };
}

export function driveInput(
  tick: number,
  seed: number,
  entities: readonly EntitySnapshot[],
  selfId: number,
): { seq: number; dt: number; move: { x: number; y: number }; attack: boolean } {
  const self = entities.find((e) => e.id === selfId);
  const me = self?.p ?? { x: 50, y: 50 };
  const goal = driveWaypoint(seed, tick);
  const dx = goal.x - me.x;
  const dy = goal.y - me.y;
  const len = Math.hypot(dx, dy);
  // Standing on the waypoint (or no position yet): hold still rather than
  // dividing by zero, which the anticheat would read as a teleport.
  const move = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 };
  const attack = entities.some(
    (e) => e.kind === 'mob' && Math.hypot(e.p.x - me.x, e.p.y - me.y) <= DRIVE_MELEE,
  );
  return { seq: tick, dt: 1 / 20, move, attack };
}

function main(): void {
  const { server, duration, out, recordAll, drive, seed, format } = parseRecorderArgs(process.argv.slice(2));

  const records: RecordingRecord[] = [];
  const t0 = Date.now();
  const now = (): number => Date.now() - t0;
  console.log(
    `[replay] recording server=${server} duration=${duration}s out=${out} ` +
      `format=${format}${recordAll ? ' all' : ''}${drive ? ` drive(seed=${seed})` : ''}`,
  );

  const ws = new WebSocket(server);
  let selfId = 0;
  let tick = 0;
  let driveTimer: NodeJS.Timeout | null = null;
  let entities: EntitySnapshot[] = [];

  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', name: 'recorder', proto: 1 }));
    // Drive mode: 20Hz inputs so the recorded path has real motion and the
    // server emits kill/xp/pickup events for the analyzer to count.
    if (drive) {
      driveTimer = setInterval(() => {
        const input = driveInput(tick++, seed, entities, selfId);
        try {
          ws.send(JSON.stringify({ t: 'input', input }));
        } catch { /* socket closing */ }
      }, 50);
    }
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      if (msg.t === 'welcome') {
        selfId = msg.id;
        entities = msg.snapshot;
      } else if (msg.t === 'snapshot') {
        entities = msg.entities;
      }
      // Record snapshots + welcome (initial state); skip chat chatter to keep files small,
      // unless --all is passed.
      if (shouldRecord(msg, recordAll)) {
        records.push({ t: now(), msg });
      }
    } catch { /* ignore malformed */ }
  });
  ws.on('error', (e: Error) => console.error('[replay] ws-error', e.message));

  setTimeout(() => {
    if (driveTimer) clearInterval(driveTimer);
    try { ws.close(); } catch { /* noop */ }
    setTimeout(() => {
      mkdirSync(dirname(out), { recursive: true });
      if (format === 'bin') {
        writeFileSync(out, encodeContainer(records));
      } else {
        writeFileSync(out, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      }
      const snaps = records.filter((r) => r.msg.t === 'snapshot').length;
      const evts = records.filter((r) => r.msg.t === 'event').length;
      console.log(`[replay] wrote ${records.length} records (${snaps} snapshots, ${evts} events) -> ${out}`);
      process.exit(0);
    }, 500);
  }, Math.max(1, duration) * 1000);
}

// Import-safe: unit tests import parseRecorderArgs/shouldRecord without connecting.
const invokedAsMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main();
