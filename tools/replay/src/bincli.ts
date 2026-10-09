// @aetherfall/replay — CLI for protocol v2 (.bin) recordings.
//
//   node dist/bincli.js convert <in.ndjson> <out.bin> [--keyframe-every 50]
//   node dist/bincli.js inspect <in.bin> [--frames 5] [--json]
//   node dist/bincli.js stats   <in.bin>
//
// `convert` re-encodes an archived protocol v1 session as binary frames (delta
// compressed, keyframed); `inspect`/`stats` read a .bin back through the shared
// decoder, so a truncated or tampered file reports itself instead of exploding.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeServerFrame } from '@aetherfall/shared/dist/protocol2.js';
import {
  BINLOG_VERSION,
  binLogStats,
  binToNdjsonLines,
  decodeBinLog,
  decodeRecordedFrames,
  isBinLog,
  ndjsonToBin,
  parseNdjson,
  readBinLog,
  writeBinLog,
} from './binlog.js';

const TYPE_NAMES: Record<number, string> = {
  1: 'welcome',
  2: 'snapshot',
  3: 'chat',
  4: 'event',
  16: 'hello',
  17: 'input',
  18: 'ack',
};

export type CliArgs = { command: string; positional: string[]; keyframeEvery: number; frames: number; json: boolean };

/** Flags that take no value, so the next token stays a positional. */
const BOOLEAN_FLAGS = new Set(['--json']);

export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0] ?? 'help';
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      // skip a separate flag value (`--frames 5`), but keep `--frames=5`'s tail
      if (!arg.includes('=') && !BOOLEAN_FLAGS.has(arg) && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) i++;
      continue;
    }
    positional.push(arg);
  }
  const flagValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && !argv[i]!.includes('=')) return argv[i + 1];
    const pref = flag + '=';
    const found = argv.find((a) => a.startsWith(pref));
    return found ? found.slice(pref.length) : undefined;
  };
  const kf = Number(flagValue('--keyframe-every') ?? 50);
  const frames = Number(flagValue('--frames') ?? 5);
  return {
    command,
    positional,
    keyframeEvery: Number.isInteger(kf) && kf >= 1 && kf <= 255 ? kf : 50,
    frames: Number.isInteger(frames) && frames >= 0 ? frames : 5,
    json: argv.includes('--json'),
  };
}

/** Short human summary of one recorded frame. */
export function describeFrame(frame: Uint8Array): string {
  if (frame.length < 4) return `short frame (${frame.length} B)`;
  const type = frame[2]!;
  const name = TYPE_NAMES[type] ?? `unknown(${type})`;
  try {
    const msg = decodeServerFrame(frame, new Map());
    if (msg.t === 'welcome') return `welcome id=${msg.id} tick=${msg.tick} entities=${msg.snapshot.length} (${frame.length} B)`;
    if (msg.t === 'snapshot') {
      return `snapshot tick=${msg.tick} base=${msg.baseTick} ${msg.keyframe ? 'KEYFRAME' : 'delta'} entities=${msg.entities.length} removed=${msg.removed.length} (${frame.length} B)`;
    }
    if (msg.t === 'chat') return `chat #${msg.channel} from=${msg.from.slice(0, 16)} (${frame.length} B)`;
    if (msg.t === 'event') return `event ${msg.kind} (${frame.length} B)`;
    if (msg.t === 'ack') return `ack tick=${msg.tick} base=${msg.baseTick} lastInputSeq=${msg.lastInputSeq} (${frame.length} B)`;
    return `${name} (${frame.length} B)`;
  } catch (err) {
    return `${name} UNDECODABLE: ${(err as Error).message} (${frame.length} B)`;
  }
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === 'convert') {
    const [inPath, outPath] = args.positional;
    if (!inPath || !outPath) {
      console.error('usage: bincli convert <in.ndjson> <out.bin> [--keyframe-every 50]');
      process.exitCode = 2;
      return;
    }
    const raw = new Uint8Array(readFileSync(resolve(inPath)));
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    if (isBinLog(raw)) {
      // .bin -> .ndjson: resolve the deltas so viewer.html can replay it
      const { lines, dropped } = binToNdjsonLines(decodeBinLog(raw));
      const text = lines.join('\n') + (lines.length ? '\n' : '');
      writeFileSync(resolve(outPath), text);
      console.log(`[binlog] ${lines.length} frames -> ${outPath} (${Buffer.byteLength(text)} B, ${dropped} dropped)`);
      return;
    }
    const text = raw.length === 0 ? '' : Buffer.from(raw).toString('utf8');
    const { lines, skipped } = parseNdjson(text);
    const res = ndjsonToBin(lines, { keyframeEvery: args.keyframeEvery });
    const { fileBytes, records } = writeBinLog(resolve(outPath), res.log);
    console.log(
      `[binlog] ${records} frames -> ${outPath} (${fileBytes} B, ` +
        `json ${res.jsonBytes.total} B -> bin ${res.binBytes.total} B, ` +
        `${(100 * (1 - res.binBytes.total / Math.max(1, res.jsonBytes.total))).toFixed(1)}% smaller, ` +
        `${res.keyframes} keyframes, ${skipped} lines skipped)`,
    );
    const replay = decodeRecordedFrames(res.log);
    console.log(`[binlog] replay check: ${replay.ok} decodable, ${replay.failed} dropped`);
    return;
  }
  if (args.command === 'inspect' || args.command === 'stats') {
    const [inPath] = args.positional;
    if (!inPath) {
      console.error('usage: bincli inspect <in.bin> [--frames 5] [--json]');
      process.exitCode = 2;
      return;
    }
    const log = readBinLog(resolve(inPath));
    const stats = binLogStats(log);
    const replay = decodeRecordedFrames(log);
    if (args.json) {
      console.log(JSON.stringify({ version: BINLOG_VERSION, stats, replay, frames: log.records.slice(0, args.frames).map((r) => ({ t: r.t, bytes: r.frame.length })) }, null, 2));
      return;
    }
    console.log(`[binlog] ${inPath}: version=${log.version} records=${stats.records} spanMs=${stats.spanMs} (${stats.fps.toFixed(1)} fps)`);
    console.log(`[binlog] frames=${stats.frameBytes} B, container=${stats.containerBytes} B (${stats.overheadPerRecord.toFixed(1)} B/record)`);
    console.log(`[binlog] replay: ${replay.ok} decodable, ${replay.failed} dropped`);
    for (const rec of log.records.slice(0, args.frames)) console.log(`  +${String(rec.t).padStart(6)}ms  ${describeFrame(rec.frame)}`);
    if (log.records.length > args.frames) console.log(`  ... ${log.records.length - args.frames} more`);
    return;
  }
  const raw = new Uint8Array(readFileSync(resolve(args.positional[0] ?? 'x')));
  console.log(
    JSON.stringify({
      bytes: raw.length,
      binlog: isBinLog(raw),
      magic: Buffer.from(raw.subarray(0, 6)).toString('ascii'),
      hint: 'usage: bincli convert|inspect|stats <file>',
    }),
  );
}

// re-exported for tests
export { decodeBinLog };
void pathToFileURL;

const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main();