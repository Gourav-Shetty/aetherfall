// @aetherfall/replay — protocol v2 (.bin) live recorder.
//
// The v1 recorder (recorder.ts) writes .ndjson. This one speaks the proto-2
// handshake, records the raw binary frames it receives, and writes an .bin
// container (see binlog.ts). If the server declines binary frames it falls back
// to the v1 .ndjson path so a recording is never lost.
//
//   node dist/recorder2.js --server ws://localhost:8081 --duration 30 \
//                          --out recordings/run.bin
//
// Start the server with PROTO=2 for binary frames; without it the recorder logs
// the fallback and writes .ndjson instead.
import WebSocket from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BINLOG_VERSION, encodeBinLog, type BinRecord } from './binlog.js';
import type { ServerMsg } from '@aetherfall/shared';

export type Recorder2Args = {
  server: string;
  duration: number;
  out: string;
};

export function parseRecorder2Args(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  defaultOut = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'recordings', `run-${Date.now()}.bin`),
): Recorder2Args {
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    const pref = flag + '=';
    const found = argv.find((a) => a.startsWith(pref));
    return found ? found.slice(pref.length) : undefined;
  };
  const raw = Number(getArg('--duration') ?? env.DURATION ?? 30);
  return {
    server: getArg('--server') ?? env.SERVER ?? 'ws://localhost:8081',
    duration: Number.isFinite(raw) ? Math.max(1, raw) : 30,
    out: getArg('--out') ?? defaultOut,
  };
}

/** The hello a v2-capable recorder sends (identical to the browser client's). */
export function recorder2Hello(name = 'recorder2', keyframeEvery = 50): string {
  return JSON.stringify({
    t: 'hello',
    name,
    proto: 2,
    caps: { binary: true, deltas: true, keyframe: keyframeEvery, chat: true, event: true },
  });
}

export function toBinRecord(payload: unknown, t: number): BinRecord | null {
  if (payload instanceof Uint8Array) return { t, frame: payload };
  const arr = Array.isArray(payload) ? payload : ArrayBuffer.isView(payload) ? Array.from(payload as unknown as ArrayLike<number>) : null;
  if (arr && arr.every((n) => typeof n === 'number')) return { t, frame: Uint8Array.from(arr as number[]) };
  return null;
}

function main(): void {
  const args = parseRecorder2Args(process.argv.slice(2));
  const records: BinRecord[] = [];
  const jsonLines: string[] = [];
  const t0 = Date.now();
  let negotiated: 1 | 2 = 1;

  const ws = new WebSocket(args.server);
  ws.on('open', () => {
    // JSON capability probe: the server answers with a binary welcome or v1 JSON
    ws.send(recorder2Hello());
  });
  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const t = Date.now() - t0;
    const rec = toBinRecord(raw, t);
    if (rec && rec.frame.length > 3) {
      if (rec.frame[1] === 2) negotiated = 2;
      records.push(rec);
      return;
    }
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    try {
      const msg = JSON.parse(text) as ServerMsg;
      jsonLines.push(JSON.stringify({ t, msg }));
    } catch {
      /* ignore junk */
    }
  });
  ws.on('error', (e: Error) => console.error('[replay2] ws-error', e.message));

  setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    setTimeout(() => {
      mkdirSync(dirname(args.out), { recursive: true });
      if (records.length > 0 && negotiated === 2) {
        const bytes = encodeBinLog({ version: BINLOG_VERSION, records });
        writeFileSync(args.out, bytes);
        const frameBytes = records.reduce((a, r) => a + r.frame.length, 0);
        console.log(`[replay2] wrote ${records.length} binary frames (${frameBytes} B payload, ${bytes.length} B file) -> ${args.out}`);
      } else {
        const out = args.out.replace(/\.bin$/, '.ndjson');
        writeFileSync(out, jsonLines.join('\n') + (jsonLines.length ? '\n' : ''));
        console.log(`[replay2] server negotiated proto ${negotiated}; wrote ${jsonLines.length} JSON records -> ${out}`);
      }
      process.exit(0);
    }, 500);
  }, args.duration * 1000);
}

const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main();