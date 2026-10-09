// @aetherfall/replay — protocol v2 vs protocol v1 byte measurement.
//
// Produces the numbers quoted in docs/PROTOCOL2.md. Everything is measured, not
// estimated: each scenario encodes the same state twice (v1 JSON via
// JSON.stringify, v2 via the shared binary codec) and reports the real byte
// counts.
//
//   node dist/measure.js              # markdown tables
//   node dist/measure.js --json       # machine-readable JSON
//   node dist/measure.js --out f.json # also write the JSON report
//   node dist/measure.js --recording <path.ndjson>
//
// Scenario world: a deterministic pseudo-walk (same shape as a live MMO tick
// loop: players moving under input, mobs wandering, bosses mostly still).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  P2_KEYFRAME_INTERVAL,
  P2SnapshotStream,
  encodeAckBinary,
  encodeChatBinary,
  encodeEventBinary,
  encodeInputBinary,
  encodeWelcomeBinary,
  toP2Entity,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot } from '@aetherfall/shared';
import { ndjsonToBin, parseNdjson } from './binlog.js';

const SNAPSHOT_HZ = 10;
const INPUT_HZ = 20;

type EntityOverrides = { names: boolean; hp: boolean };

/**
 * Deterministic world state at `tick`.
 * - players (i % 3 == 0): fast movers with hp churn (damage/heal events)
 * - mobs: wander at half speed
 * - bosses (i % 17 == 0): heavy, slow, long names, mostly stationary
 */
function world(n: number, tick: number, opts: EntityOverrides = { names: true, hp: true }): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const boss = i % 17 === 0;
    const player = i % 3 === 0;
    const speed = boss ? 0.15 : player ? 1 : 0.5;
    const t = tick + i;
    const x = 50 + Math.sin(t / (boss ? 29 : 7)) * 20 * speed;
    const y = 50 + Math.cos(t / (boss ? 23 : 5)) * 20 * speed;
    const e: EntitySnapshot = {
      id: i + 1,
      kind: boss ? 'mob' : player ? 'player' : i % 2 === 0 ? 'mob' : 'npc',
      p: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 },
      v: { x: Math.round(Math.sin(t / 3) * 4 * 1000) / 1000, y: Math.round(Math.cos(t / 3) * 4 * 1000) / 1000 },
      hp: opts.hp ? 80 + ((i * 7 + Math.floor(t / 5)) % 21) : 100,
      maxHp: 100,
      dir: Math.round(((i * 0.78) % 6.28) * 1000) / 1000,
      level: 1 + (i % 20),
    };
    if (opts.names && (boss || i % 4 === 0)) e.name = boss ? `Ancient-Boss-${i}` : `mob-${i}`;
    if (player) e.seq = tick * INPUT_HZ + (i % 3);
    out.push(e);
  }
  return out;
}

function jsonBytes(msg: unknown): number {
  return Buffer.byteLength(JSON.stringify(msg), 'utf8');
}

export type Row = {
  scenario: string;
  entities: number;
  frames: number;
  keyframes: number;
  jsonBytes: number;
  binBytes: number;
  jsonPerFrame: number;
  binPerFrame: number;
  ratio: number;
  savingPct: number;
  bitsPerEntity: number | null;
};

/** Encode a moving world as a v2 stream and compare against v1 JSON. */

/** The real measurement: one stream, both encodings. */
export function measureScenario(
  scenario: string,
  entityCount: number,
  ticks: number,
  opts: { keyframeEvery?: number; names?: boolean; hp?: boolean; idle?: boolean } = {},
): Row {
  const keyframeEvery = opts.keyframeEvery ?? P2_KEYFRAME_INTERVAL;
  const flags = { names: opts.names !== false, hp: opts.hp !== false };
  const stream = new P2SnapshotStream(keyframeEvery);
  let jsonTotal = 0;
  let binTotal = 0;
  let keyframes = 0;
  const hold = opts.idle === true;

  for (let tick = 0; tick < ticks; tick++) {
    const entities = hold ? world(entityCount, 0, flags) : world(entityCount, tick, flags);
    const msg = { t: 'snapshot' as const, tick, entities, removed: [] as number[] };
    jsonTotal += jsonBytes(msg);
    binTotal += stream.encode(entities.map(toP2Entity), [], tick).length;
    if (stream.seq % keyframeEvery === 0) keyframes++;
  }
  const binPerFrame = binTotal / ticks;
  const jsonPerFrame = jsonTotal / ticks;
  return {
    scenario,
    entities: entityCount,
    frames: ticks,
    keyframes,
    jsonBytes: jsonTotal,
    binBytes: binTotal,
    jsonPerFrame,
    binPerFrame,
    ratio: jsonPerFrame === 0 ? 0 : binPerFrame / jsonPerFrame,
    savingPct: jsonPerFrame === 0 ? 0 : (1 - binPerFrame / jsonPerFrame) * 100,
    bitsPerEntity: entityCount === 0 ? null : (binPerFrame * 8) / entityCount,
  };
}

/** Single-shot frames (welcome / ack / chat / event) have no baseline. */
export function measureSingleton(): Array<{ frame: string; jsonBytes: number; binBytes: number; ratio: number }> {
  const out: Array<{ frame: string; jsonBytes: number; binBytes: number; ratio: number }> = [];
  const push = (frame: string, json: unknown, bin: Uint8Array) => {
    const j = jsonBytes(json);
    out.push({ frame, jsonBytes: j, binBytes: bin.length, ratio: j === 0 ? 0 : bin.length / j });
  };
  const ent = (i: number): EntitySnapshot => ({
    id: i,
    kind: i % 3 === 0 ? 'player' : 'mob',
    p: { x: 12.5, y: -7.25 },
    v: { x: 1.5, y: -2 },
    hp: 90,
    maxHp: 100,
    dir: 1.5,
    level: 3,
    name: `mob-${i}`,
  });
  const ents = Array.from({ length: 60 }, (_, i) => ent(i + 1));
  push('welcome (60 entities)', { t: 'welcome', id: 42, tick: 1234, snapshot: ents }, encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 42, tick: 1234, name: 'hero', snapshot: ents.map(toP2Entity) }));
  push('ack', { t: 'ack', tick: 1234, baseTick: 1200, lastInputSeq: 24680, rttMs: 37 }, encodeAckBinary({ t: 'ack', tick: 1234, baseTick: 1200, lastInputSeq: 24680, rttMs: 37 }));
  push('chat', { t: 'chat', from: 'Elder Maren', text: 'welcome to the village, traveller', channel: 'global' }, encodeChatBinary({ t: 'chat', from: 'Elder Maren', text: 'welcome to the village, traveller', channel: 'global' }));
  push('event (telegraph)', { t: 'event', kind: 'telegraph', payload: { shape: 'circle', x: 50, y: 50, r: 6, ttlMs: 900, label: 'Cleave' } }, encodeEventBinary({ t: 'event', kind: 'telegraph', payload: JSON.stringify({ shape: 'circle', x: 50, y: 50, r: 6, ttlMs: 900, label: 'Cleave' }) }));
  push('input (idle)', { t: 'input', input: { seq: 24680, dt: 0.05, move: { x: 0, y: 0 } } }, encodeInputBinary({ t: 'input', input: { seq: 24680, dt: 0.05, move: { x: 0, y: 0 } } }));
  push('input (moving+attack)', { t: 'input', input: { seq: 24680, dt: 0.05, move: { x: 0.70703125, y: -0.70703125 }, attack: true } }, encodeInputBinary({ t: 'input', input: { seq: 24680, dt: 0.05, move: { x: 0.70703125, y: -0.70703125 }, attack: true } }));
  push('input (chat)', { t: 'input', input: { seq: 24680, dt: 0.05, move: { x: 0.5, y: 0.5 }, chat: 'anyone selling a sword?' } }, encodeInputBinary({ t: 'input', input: { seq: 24680, dt: 0.05, move: { x: 0.5, y: 0.5 }, chat: 'anyone selling a sword?' } }));
  return out;
}

/** Re-encode a real archived .ndjson recording (if one is present). */
export function measureRecording(path: string): {
  path: string;
  lines: number;
  skipped: number;
  welcomeJson: number;
  welcomeBin: number;
  snapshotJson: number;
  snapshotBin: number;
  frames: number;
  entitiesInFirstSnapshot: number;
  keyframes: number;
  otherJson: number;
  otherBin: number;
  fileBytes: number;
  savingPct: number;
} | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const { lines, skipped } = parseNdjson(text);
  if (lines.length === 0) return null;
  const out = ndjsonToBin(lines);
  const firstSnapshot = lines.find((l) => l.msg.t === 'snapshot');
  const jsonTotal = out.jsonBytes.total;
  return {
    path,
    lines: lines.length,
    skipped,
    welcomeJson: out.jsonBytes.welcome,
    welcomeBin: out.binBytes.welcome,
    snapshotJson: out.jsonBytes.snapshot,
    snapshotBin: out.binBytes.snapshot,
    frames: out.counts.snapshot,
    entitiesInFirstSnapshot: firstSnapshot && firstSnapshot.msg.t === 'snapshot' ? firstSnapshot.msg.entities.length : 0,
    keyframes: out.keyframes,
    otherJson: out.jsonBytes.other,
    otherBin: out.binBytes.other,
    fileBytes: out.log.records.reduce((a, r) => a + r.frame.length, 0),
    savingPct: jsonTotal === 0 ? 0 : (1 - out.binBytes.total / jsonTotal) * 100,
  };
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */

export function buildReport(recordingPath?: string) {
  const scenarios: Row[] = [];
  for (const n of [5, 20, 60, 200]) {
    scenarios.push(measureScenario(`moving, ${n} entities`, n, 200));
  }
  scenarios.push(measureScenario('idle (nothing moved), 60 entities', 60, 200, { idle: true }));
  scenarios.push(measureScenario('moving, 60 entities, no names', 60, 200, { names: false }));
  scenarios.push(measureScenario('moving, 60 entities, no hp churn', 60, 200, { hp: false }));
  scenarios.push(measureScenario('moving, 60 entities, keyframe every 10', 60, 200, { keyframeEvery: 10 }));
  scenarios.push(measureScenario('moving, 60 entities, keyframe every snapshot', 60, 200, { keyframeEvery: 1 }));
  return { scenarios, singletons: measureSingleton(), recording: recordingPath ? measureRecording(recordingPath) : null };
}

function table(rows: Array<Record<string, string | number | null>>, headers: string[]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${headers.map((h) => String(r[h] ?? '')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

export function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const out: string[] = [];
  out.push('# Protocol v2 vs v1 — measured');
  out.push('');
  out.push(`Generated by tools/replay/measure.ts. Snapshots ${SNAPSHOT_HZ}Hz, inputs ${INPUT_HZ}Hz, keyframe every ${P2_KEYFRAME_INTERVAL} snapshots.`);
  out.push('');
  out.push('## Snapshot streams');
  out.push('');
  out.push(
    table(
      report.scenarios.map((r) => ({
        scenario: r.scenario,
        entities: r.entities,
        frames: r.frames,
        keyframes: r.keyframes,
        'JSON B': r.jsonBytes,
        'v2 B': r.binBytes,
        'JSON B/frame': r.jsonPerFrame.toFixed(0),
        'v2 B/frame': r.binPerFrame.toFixed(1),
        'v2/JSON': `${(r.ratio * 100).toFixed(1)}%`,
        saved: `${r.savingPct.toFixed(1)}%`,
        'bits/entity/frame': r.bitsPerEntity === null ? '-' : r.bitsPerEntity.toFixed(1),
      })),
      ['scenario', 'entities', 'frames', 'keyframes', 'JSON B', 'v2 B', 'JSON B/frame', 'v2 B/frame', 'v2/JSON', 'saved', 'bits/entity/frame'],
    ),
  );
  out.push('');
  out.push('## Single frames (no baseline)');
  out.push('');
  out.push(
    table(
      report.singletons.map((s) => ({ frame: s.frame, 'JSON B': s.jsonBytes, 'v2 B': s.binBytes, 'v2/JSON': `${(s.ratio * 100).toFixed(1)}%` })),
      ['frame', 'JSON B', 'v2 B', 'v2/JSON'],
    ),
  );
  if (report.recording) {
    const r = report.recording;
    out.push('');
    out.push('## Archived .ndjson session re-encoded');
    out.push('');
    out.push(`Source: \`${r.path}\` (${r.lines} records, ${r.skipped} skipped)`);
    out.push('');
    out.push(
      table(
        [
          { frame: `welcome (${r.entitiesInFirstSnapshot} entities)`, 'JSON B': r.welcomeJson, 'v2 B': r.welcomeBin },
          { frame: `${r.frames} snapshots`, 'JSON B': r.snapshotJson, 'v2 B': r.snapshotBin },
          { frame: 'chat/event', 'JSON B': r.otherJson, 'v2 B': r.otherBin },
          { frame: 'total', 'JSON B': r.welcomeJson + r.snapshotJson + r.otherJson, 'v2 B': r.welcomeBin + r.snapshotBin + r.otherBin },
        ],
        ['frame', 'JSON B', 'v2 B'],
      ),
    );
    out.push('');
    out.push(`Total saving: **${r.savingPct.toFixed(1)}%** over the archived session (${r.keyframes} keyframes).`);
  }

  // downstream/upstream budget for one player at the default cadences
  const inputRow = measureScenario('input @20Hz, moving', 1, 200);
  out.push('');
  out.push('## Per-player wire budget');
  out.push('');
  out.push(
    table(
      report.scenarios
        .filter((r) => r.scenario.startsWith('moving,') || r.scenario.startsWith('idle'))
        .map((r) => ({
          scenario: r.scenario,
          'down B/s (v1)': (r.jsonPerFrame * SNAPSHOT_HZ).toFixed(0),
          'down B/s (v2)': (r.binPerFrame * SNAPSHOT_HZ).toFixed(0),
          'down KB/s (v2)': ((r.binPerFrame * SNAPSHOT_HZ) / 1024).toFixed(2),
          'up B/s (v1)': ((inputRow.jsonPerFrame * INPUT_HZ)).toFixed(0),
          'up B/s (v2)': ((inputRow.binPerFrame * INPUT_HZ)).toFixed(0),
        })),
      ['scenario', 'down B/s (v1)', 'down B/s (v2)', 'down KB/s (v2)', 'up B/s (v1)', 'up B/s (v2)'],
    ),
  );
  out.push('');
  return out.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const outIdx = argv.indexOf('--out');
  const recIdx = argv.indexOf('--recording');
  const here = dirname(fileURLToPath(import.meta.url));
  const recording = recIdx >= 0 && argv[recIdx + 1] ? resolve(argv[recIdx + 1]!) : resolve(here, '..', 'recordings', 'trial.ndjson');
  const report = buildReport(recording);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderMarkdown(report));
  if (outIdx >= 0 && argv[outIdx + 1]) {
    const file = resolve(argv[outIdx + 1]!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.error(`[measure] wrote ${file}`);
  }
}

const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main();