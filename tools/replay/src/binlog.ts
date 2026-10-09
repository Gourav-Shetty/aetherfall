// @aetherfall/replay — binary (.bin) recording container for protocol v2 frames.
//
// The existing recorder dumps one JSON object per line (.ndjson, protocol v1).
// This module adds the binary sibling used to archive and replay v2 sessions:
//
//   header (8 bytes)
//     off size field
//     0   6    magic "AFBIN2"
//     6   1    version = 2
//     7   1    flags (reserved, 0)
//
//   record (repeated, terminated by an EOF marker)
//     0   1    type: 1 = frame, 0 = EOF
//     1   n    varint  ms since record start
//     n   n    varint  frame byte length
//     ..  m    frame bytes — exactly one complete protocol v2 frame
//
// Every record carries a real P2 frame, so `readBinLog` + the shared decoder is
// enough to replay; nothing here needs to know what is *inside* a frame.
// `ndjsonToBin` converts an archived v1 .ndjson session into this format using
// the shared delta codec, which is also how the numbers in docs/PROTOCOL2.md
// were measured.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  P2SnapshotStream,
  P2Reader,
  P2Writer,
  PROTO2_VERSION,
  applySnapshot,
  baselineFromEntities,
  decodeServerFrame,
  encodeChatBinary,
  encodeEventBinary,
  encodeWelcomeBinary,
  isKeyframeSeq,
  toEntitySnapshot,
  toP2Entity,
  type P2Channel,
  type P2Quant,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';

export const BINLOG_MAGIC = 'AFBIN2';
export const BINLOG_VERSION = 2;
export const BINLOG_HEADER_BYTES = 8;
const REC_FRAME = 1;
const REC_EOF = 0;

/** One recorded frame: milliseconds since the record started + raw frame bytes. */
export type BinRecord = { t: number; frame: Uint8Array };

export type BinLog = {
  version: number;
  records: BinRecord[];
};

export type BinLogStats = {
  records: number;
  /** Sum of the framed payload bytes (what went over the wire). */
  frameBytes: number;
  /** Total file size, including the header and per-record varints. */
  fileBytes: number;
  /** fileBytes - frameBytes: the container's own overhead. */
  containerBytes: number;
  /** Bytes of overhead per record (type byte + two varints). */
  overheadPerRecord: number;
  spanMs: number;
  fps: number;
};

/** Container-level failure (bad magic, truncated record, bad varint...). */
export class BinLogError extends Error {
  constructor(message: string) {
    super('binlog: ' + message);
    this.name = 'BinLogError';
  }
}

/* ------------------------------------------------------------------ *
 * encode / decode
 * ------------------------------------------------------------------ */

/** Serialize a log to bytes. Frames are copied, so the input stays immutable. */
export function encodeBinLog(log: BinLog): Uint8Array {
  const w = new P2Writer(4096);
  for (let i = 0; i < BINLOG_MAGIC.length; i++) w.u8(BINLOG_MAGIC.charCodeAt(i));
  w.u8(BINLOG_VERSION);
  w.u8(0); // flags
  for (const rec of log.records) {
    if (!Number.isInteger(rec.t) || rec.t < 0) throw new BinLogError(`record ${rec.t} has a bad timestamp`);
    if (rec.frame.length === 0) throw new BinLogError('record has an empty frame');
    w.u8(REC_FRAME);
    w.varint(rec.t);
    w.varint(rec.frame.length);
    w.raw(rec.frame);
  }
  w.u8(REC_EOF);
  return w.toBytes();
}

/** Parse bytes produced by `encodeBinLog`. Strict: no trailing garbage. */
export function decodeBinLog(bytes: Uint8Array): BinLog {
  if (bytes.length < BINLOG_HEADER_BYTES) throw new BinLogError('file too short for a header');
  for (let i = 0; i < BINLOG_MAGIC.length; i++) {
    if (bytes[i] !== BINLOG_MAGIC.charCodeAt(i)) throw new BinLogError('bad magic');
  }
  const version = bytes[6]!;
  if (version !== BINLOG_VERSION) throw new BinLogError(`unsupported version ${version}`);
  const r = new P2Reader(bytes, BINLOG_HEADER_BYTES);
  const records: BinRecord[] = [];
  for (;;) {
    if (r.remaining === 0) throw new BinLogError('missing EOF marker (file truncated?)');
    const type = r.u8();
    if (type === REC_EOF) {
      if (r.remaining !== 0) throw new BinLogError('trailing bytes after EOF marker');
      return { version, records };
    }
    if (type !== REC_FRAME) throw new BinLogError(`unknown record type ${type}`);
    const t = r.varint();
    const len = r.varint();
    records.push({ t, frame: r.bytes(len).slice() });
  }
}

/** Cheap sniff: does this buffer start with a binlog header? */
export function isBinLog(bytes: Uint8Array): boolean {
  if (bytes.length < BINLOG_HEADER_BYTES) return false;
  for (let i = 0; i < BINLOG_MAGIC.length; i++) if (bytes[i] !== BINLOG_MAGIC.charCodeAt(i)) return false;
  return bytes[6] === BINLOG_VERSION;
}

export function writeBinLog(path: string, log: BinLog): { fileBytes: number; records: number } {
  const bytes = encodeBinLog(log);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { fileBytes: bytes.length, records: log.records.length };
}

export function readBinLog(path: string): BinLog {
  return decodeBinLog(new Uint8Array(readFileSync(path)));
}

/** Byte accounting for a log — the raw numbers docs/PROTOCOL2.md quotes. */
export function binLogStats(log: BinLog): BinLogStats {
  let frameBytes = 0;
  let minT = Number.POSITIVE_INFINITY;
  let maxT = 0;
  for (const rec of log.records) {
    frameBytes += rec.frame.length;
    if (rec.t < minT) minT = rec.t;
    if (rec.t > maxT) maxT = rec.t;
  }
  const fileBytes = encodeBinLog(log).length;
  const spanMs = log.records.length === 0 ? 0 : maxT - (minT === Number.POSITIVE_INFINITY ? 0 : minT);
  return {
    records: log.records.length,
    frameBytes,
    fileBytes,
    containerBytes: fileBytes - frameBytes,
    overheadPerRecord: log.records.length === 0 ? 0 : (fileBytes - frameBytes - BINLOG_HEADER_BYTES - 1) / log.records.length,
    spanMs,
    fps: spanMs > 0 ? (log.records.length / spanMs) * 1000 : 0,
  };
}

/* ------------------------------------------------------------------ *
 * v1 .ndjson -> .bin
 * ------------------------------------------------------------------ */

export type NdjsonLine = { t: number; msg: ServerMsg };

export type NdjsonToBinResult = {
  log: BinLog;
  /** Byte cost of the source JSON, per frame kind. */
  jsonBytes: { welcome: number; snapshot: number; other: number; total: number };
  binBytes: { welcome: number; snapshot: number; other: number; total: number };
  counts: { welcome: number; snapshot: number; other: number; skipped: number };
  keyframes: number;
};

/** Parse an archived .ndjson recording. Malformed lines are skipped, not fatal. */
export function parseNdjson(text: string): { lines: NdjsonLine[]; skipped: number } {
  const lines: NdjsonLine[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const o = JSON.parse(raw) as NdjsonLine;
      if (!o || typeof o.t !== 'number' || !o.msg || typeof o.msg !== 'object') {
        skipped++;
        continue;
      }
      lines.push({ t: o.t, msg: o.msg });
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

/**
 * Convert a v1 recording into v2 frames.
 *
 * Welcome becomes a binary welcome (which seeds the delta baseline); every
 * snapshot after it goes through `P2SnapshotStream`, so the archive is already
 * delta-compressed and carries a keyframe every `keyframeEvery` snapshots.
 * Chat/event lines are re-encoded too; anything else is skipped.
 */
export function ndjsonToBin(lines: NdjsonLine[], opts: { keyframeEvery?: number; playerName?: string } = {}): NdjsonToBinResult {
  const stream = new P2SnapshotStream(opts.keyframeEvery);
  const records: BinRecord[] = [];
  const jsonBytes = { welcome: 0, snapshot: 0, other: 0, total: 0 };
  const binBytes = { welcome: 0, snapshot: 0, other: 0, total: 0 };
  const counts = { welcome: 0, snapshot: 0, other: 0, skipped: 0 };
  let keyframes = 0;
  let seeded = false;

  for (const line of lines) {
    const msg = line.msg;
    const jsonLen = Buffer.byteLength(JSON.stringify(msg), 'utf8');
    let frame: Uint8Array | null = null;
    if (msg.t === 'welcome') {
      if (seeded) {
        counts.skipped++;
        continue;
      }
      frame = encodeWelcomeBinary({
        t: 'welcome',
        proto: 2,
        id: msg.id,
        tick: msg.tick,
        name: opts.playerName ?? '',
        snapshot: (msg.snapshot as EntitySnapshot[]).map(toP2Entity),
      });
      // the welcome already told the client this state
      stream.seed((msg.snapshot as EntitySnapshot[]).map(toP2Entity), msg.tick);
      seeded = true;
      counts.welcome++;
      jsonBytes.welcome += jsonLen;
      binBytes.welcome += frame.length;
    } else if (msg.t === 'snapshot') {
      if (!seeded) {
        // a recording that starts mid-session: keyframe off an empty baseline
        frame = encodeWelcomeBinary({
          t: 'welcome',
          proto: 2,
          id: 0,
          tick: msg.tick,
          name: opts.playerName ?? '',
          snapshot: (msg.entities as EntitySnapshot[]).map(toP2Entity),
        });
        stream.seed((msg.entities as EntitySnapshot[]).map(toP2Entity), msg.tick);
        seeded = true;
        counts.welcome++;
      } else {
        frame = stream.encode(
          (msg.entities as EntitySnapshot[]).map(toP2Entity),
          msg.removed,
          msg.tick,
        );
        if (isKeyframeSeq(stream.seq - 1, stream.keyframeEvery)) keyframes++;
        counts.snapshot++;
        jsonBytes.snapshot += jsonLen;
        binBytes.snapshot += frame.length;
      }
      jsonBytes.total += jsonLen;
      binBytes.total += frame.length;
    } else if (msg.t === 'chat') {
      frame = encodeChatBinary({ t: 'chat', from: msg.from, text: msg.text, channel: msg.channel as P2Channel });
      counts.other++;
    } else if (msg.t === 'event') {
      frame = encodeEventBinary({ t: 'event', kind: msg.kind, payload: JSON.stringify(msg.payload ?? null) });
      counts.other++;
    } else {
      counts.skipped++;
      continue;
    }
    if (!frame) continue;
    if (msg.t === 'chat' || msg.t === 'event') {
      jsonBytes.other += jsonLen;
      binBytes.other += frame.length;
      jsonBytes.total += jsonLen;
      binBytes.total += frame.length;
    }
    records.push({ t: line.t, frame });
  }

  return {
    log: { version: BINLOG_VERSION, records },
    jsonBytes: { ...jsonBytes, total: jsonBytes.welcome + jsonBytes.snapshot + jsonBytes.other },
    binBytes: { ...binBytes, total: binBytes.welcome + binBytes.snapshot + binBytes.other },
    counts,
    keyframes,
  };
}

/**
 * Decode a recorded frame with the shared client-side decoder.
 */
export function decodeRecordedFrames(log: BinLog): { ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  let baseline = new Map<number, P2Quant>();
  let baseTick = 0;
  for (const rec of log.records) {
    if (rec.frame.length < 4 || rec.frame[1] !== PROTO2_VERSION) {
      failed++;
      continue;
    }
    try {
      const msg = decodeServerFrame(rec.frame, baseline);
      if (msg.t === 'snapshot') {
        const applied = applySnapshot(msg, baseline, baseTick);
        if (!applied.ok) {
          failed++;
          continue;
        }
        baseline = applied.baseline;
        baseTick = applied.baseTick;
      } else if (msg.t === 'welcome') {
        baseline = baselineFromEntities(msg.snapshot);
        baseTick = msg.tick;
      }
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}

/**
 * Export a .bin recording back to protocol v1 `.ndjson` lines.
 *
 * Deltas are resolved against the running baseline, so every snapshot line
 * carries the complete entity list — exactly what `viewer.html` expects. This
 * is the bridge that lets the existing v1 replay tool show a v2 session.
 */
export function binToNdjsonLines(log: BinLog): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let dropped = 0;
  let baseline = new Map<number, P2Quant>();
  let baseTick = 0;
  const push = (t: number, msg: ServerMsg) => lines.push(JSON.stringify({ t, msg }));
  for (const rec of log.records) {
    let msg;
    try {
      msg = decodeServerFrame(rec.frame, baseline);
    } catch {
      dropped++;
      continue;
    }
    if (msg.t === 'welcome') {
      baseline = baselineFromEntities(msg.snapshot);
      baseTick = msg.tick;
      push(rec.t, { t: 'welcome', id: msg.id, tick: msg.tick, snapshot: msg.snapshot.map(toEntitySnapshot) });
    } else if (msg.t === 'snapshot') {
      const applied = applySnapshot(msg, baseline, baseTick);
      if (!applied.ok) {
        dropped++;
        continue;
      }
      baseline = applied.baseline;
      baseTick = applied.baseTick;
      push(rec.t, {
        t: 'snapshot',
        tick: msg.tick,
        entities: [...applied.entities.values()].map(toEntitySnapshot),
        removed: applied.removed,
      });
    } else if (msg.t === 'chat') {
      push(rec.t, { t: 'chat', from: msg.from, text: msg.text, channel: msg.channel });
    } else if (msg.t === 'event') {
      let payload: unknown = null;
      try {
        payload = JSON.parse(msg.payload);
      } catch {
        payload = null;
      }
      push(rec.t, { t: 'event', kind: msg.kind, payload });
    } else if (msg.t === 'ack') {
      // v1 has no ack message; surface it as an event so nothing is lost
      push(rec.t, { t: 'event', kind: 'ack', payload: msg });
    }
  }
  return { lines, dropped };
}