import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeWelcomeBinary,
  encodeSnapshotBinary,
  encodeAckBinary,
  decodeWelcomeBinary,
  decodeServerFrame,
  applySnapshot,
  toP2Entity,
  P2SnapshotStream,
  type P2Entity,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';
import {
  BINLOG_HEADER_BYTES,
  BINLOG_MAGIC,
  BINLOG_VERSION,
  BinLogError,
  binLogStats,
  binToNdjsonLines,
  decodeBinLog,
  encodeBinLog,
  isBinLog,
  ndjsonToBin,
  parseNdjson,
  readBinLog,
  writeBinLog,
  decodeRecordedFrames,
  type BinLog,
} from './binlog.js';

function ent(id: number, x: number, y: number, over: Partial<P2Entity> = {}): P2Entity {
  return { id, kind: 'mob', p: { x, y }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100, ...over };
}

function world(n: number, tick: number): EntitySnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    kind: (i % 3 === 0 ? 'player' : 'mob') as EntitySnapshot['kind'],
    p: { x: 50 + Math.sin((tick + i) / 7) * 20, y: 50 + Math.cos((tick + i) / 5) * 20 },
    v: { x: Math.sin((tick + i) / 3) * 4, y: Math.cos((tick + i) / 3) * 4 },
    hp: 80 + (i % 7),
    maxHp: 100,
    name: i % 4 === 0 ? `mob-${i}` : undefined,
  }));
}

function sampleLog(frames = 20): BinLog {
  const records: BinLog['records'] = [];
  const stream = new P2SnapshotStream(10);
  records.push({ t: 0, frame: encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 0, name: 'hero', snapshot: world(8, 0).map(toP2Entity) }) });
  stream.seed(world(8, 0).map(toP2Entity), 0);
  for (let i = 1; i <= frames; i++) {
    records.push({ t: i * 100, frame: stream.encode(world(8, i).map(toP2Entity), [], i) });
  }
  return { version: BINLOG_VERSION, records };
}

/** A 62-record v1 session: welcome + 60 snapshots (with removals) + chat + event. */
function linesFixture(): Array<{ t: number; msg: ServerMsg }> {
  const out: Array<{ t: number; msg: ServerMsg }> = [];
  out.push({ t: 0, msg: { t: 'welcome', id: 4, tick: 0, snapshot: world(10, 0) } });
  for (let i = 1; i <= 60; i++) {
    // mirrors server interest filtering: a despawned id leaves `entities`
    // at the same time it shows up in `removed`
    const gone = i % 7 === 0;
    const all = world(10, i);
    out.push({
      t: i * 100,
      msg: { t: 'snapshot', tick: i, entities: gone ? all.filter((e) => e.id !== 10) : all, removed: gone ? [10] : [] },
    });
  }
  out.push({ t: 6100, msg: { t: 'chat', from: 'Elder Maren', text: 'hi', channel: 'global' } });
  out.push({ t: 6200, msg: { t: 'event', kind: 'despawn', payload: { id: 4 } } });
  return out;
}

describe('binlog container', () => {
  it('round-trips frames and timestamps byte-for-byte', () => {
    const log = sampleLog();
    const bytes = encodeBinLog(log);
    const back = decodeBinLog(bytes);
    assert.equal(back.version, BINLOG_VERSION);
    assert.equal(back.records.length, log.records.length);
    for (let i = 0; i < log.records.length; i++) {
      assert.equal(back.records[i]!.t, log.records[i]!.t);
      assert.deepEqual(Array.from(back.records[i]!.frame), Array.from(log.records[i]!.frame));
    }
    assert.deepEqual(Array.from(encodeBinLog(back)), Array.from(bytes), 're-encoding is stable');
  });

  it('writes the documented header', () => {
    const bytes = encodeBinLog(sampleLog(1));
    for (let i = 0; i < BINLOG_MAGIC.length; i++) assert.equal(bytes[i], BINLOG_MAGIC.charCodeAt(i));
    assert.equal(bytes[6], BINLOG_VERSION);
    assert.equal(bytes[7], 0);
    assert.equal(bytes.length > BINLOG_HEADER_BYTES, true);
  });

  it('is recognizable and rejects corrupt files', () => {
    const bytes = encodeBinLog(sampleLog(2));
    assert.equal(isBinLog(bytes), true);
    assert.equal(isBinLog(new Uint8Array(4)), false);
    assert.equal(isBinLog(encodeBinLog({ version: 2, records: [] }).slice(2)), false);

    const bad = bytes.slice();
    bad[0] = 0x00;
    assert.throws(() => decodeBinLog(bad), /bad magic/);
    const short = bytes.slice(0, 5);
    assert.throws(() => decodeBinLog(short), /too short/);
    const wrongVersion = bytes.slice();
    wrongVersion[6] = 9;
    assert.throws(() => decodeBinLog(wrongVersion), /unsupported version 9/);
    const truncated = bytes.slice(0, bytes.length - 4);
    assert.throws(() => decodeBinLog(truncated), /truncated|EOF/);
    const garbage = new Uint8Array(BINLOG_HEADER_BYTES + 4);
    garbage.set([...BINLOG_MAGIC].map((c) => c.charCodeAt(0)), 0);
    garbage[6] = BINLOG_VERSION;
    garbage[8] = 0x42;
    assert.throws(() => decodeBinLog(garbage), /unknown record type/);
  });

  it('refuses to encode empty frames and bad timestamps', () => {
    assert.throws(() => encodeBinLog({ version: 2, records: [{ t: 0, frame: new Uint8Array(0) }] }), /empty frame/);
    assert.throws(() => encodeBinLog({ version: 2, records: [{ t: -1, frame: new Uint8Array([1]) }] }), /bad timestamp/);
    assert.throws(() => encodeBinLog({ version: 2, records: [{ t: 1.5, frame: new Uint8Array([1]) }] }), /bad timestamp/);
  });

  it('handles an empty log', () => {
    const bytes = encodeBinLog({ version: 2, records: [] });
    const back = decodeBinLog(bytes);
    assert.deepEqual(back.records, []);
    const stats = binLogStats(back);
    assert.equal(stats.records, 0);
    assert.equal(stats.frameBytes, 0);
    assert.equal(stats.fileBytes, BINLOG_HEADER_BYTES + 1);
  });

  it('reports container overhead', () => {
    const log = sampleLog(50);
    const stats = binLogStats(log);
    assert.equal(stats.records, log.records.length);
    const summed = log.records.reduce((a, r) => a + r.frame.length, 0);
    assert.equal(stats.frameBytes, summed);
    assert.equal(stats.fileBytes, encodeBinLog(log).length);
    assert.ok(stats.containerBytes > 0);
    assert.ok(stats.overheadPerRecord > 1 && stats.overheadPerRecord < 8, `per-record overhead=${stats.overheadPerRecord}`);
    assert.equal(stats.spanMs, 5000);
    assert.ok(stats.fps > 10);
  });

  it('writes and reads a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aetherfall-bin-'));
    const path = join(dir, 'nested', 'session.bin');
    const log = sampleLog(5);
    const res = writeBinLog(path, log);
    assert.equal(res.records, log.records.length);
    assert.equal(res.fileBytes, readFileSync(path).length);
    const back = readBinLog(path);
    assert.equal(back.records.length, log.records.length);
    assert.deepEqual(Array.from(back.records[1]!.frame), Array.from(log.records[1]!.frame));
  });

  it('replays every recorded frame the way a client would', () => {
    const log = sampleLog(30);
    const res = decodeRecordedFrames(log);
    assert.equal(res.failed, 0, 'no baseline drift inside a well-formed recording');
    assert.equal(res.ok, log.records.length);
  });

  it('counts undecodable frames instead of throwing', () => {
    const log: BinLog = {
      version: 2,
      records: [
        { t: 0, frame: new Uint8Array([1, 2, 3, 4, 5]) },
        { t: 1, frame: new Uint8Array(0) },
        ...sampleLog(2).records,
      ],
    };
    const res = decodeRecordedFrames(log);
    assert.ok(res.failed >= 1);
    assert.ok(res.ok >= 3);
  });
});

describe('ndjson -> bin conversion', () => {
  const lines = linesFixture();

  it('re-encodes a whole session and shrinks it', () => {
    const res = ndjsonToBin(lines);
    assert.equal(res.counts.welcome, 1);
    assert.equal(res.counts.snapshot, 60);
    assert.equal(res.counts.other, 2);
    assert.equal(res.counts.skipped, 0);
    assert.equal(res.log.records.length, 63);
    assert.ok(res.keyframes >= 1, 'a 60-frame session needs at least one keyframe');
    assert.ok(res.binBytes.total < res.jsonBytes.total / 5, `bin=${res.binBytes.total} json=${res.jsonBytes.total}`);
    assert.ok(res.binBytes.welcome < res.jsonBytes.welcome, 'welcome shrinks too');
    assert.ok(res.binBytes.other < res.jsonBytes.other, 'chat/event shrink too');
  });

  it('produces a log a client can replay without dropping frames', () => {
    const res = ndjsonToBin(lines);
    const replay = decodeRecordedFrames(res.log);
    assert.equal(replay.failed, 0, 'baseline drift means the encoder and decoder disagree');
    assert.equal(replay.ok, res.log.records.length);
    const welcome = decodeWelcomeBinary(res.log.records[0]!.frame);
    assert.equal(welcome.id, 4);
    assert.equal(welcome.snapshot.length, 10);
  });

  it('keyframes on the configured interval', () => {
    const res = ndjsonToBin(lines, { keyframeEvery: 10 });
    assert.equal(res.keyframes, 6);
    const every = ndjsonToBin(lines, { keyframeEvery: 1 });
    assert.equal(every.keyframes, 60);
    assert.ok(every.binBytes.total > res.binBytes.total, 'more keyframes cost more bytes');
  });

  it('seeds a keyframe when the recording starts mid-session', () => {
    const mid = lines.filter((l) => l.msg.t !== 'welcome');
    const res = ndjsonToBin(mid);
    assert.equal(res.counts.welcome, 1);
    assert.equal(res.counts.snapshot, 59);
    assert.equal(decodeRecordedFrames(res.log).failed, 0);
  });

  it('keeps only the first welcome and skips unknown messages', () => {
    const dup = [
      { t: 0, msg: { t: 'welcome', id: 1, tick: 0, snapshot: [] } as ServerMsg },
      ...lines,
      { t: 9999, msg: { t: 'nope' } as unknown as ServerMsg },
    ];
    const res = ndjsonToBin(dup);
    assert.equal(res.counts.welcome, 1);
    // one duplicate welcome + the unknown message kind
    assert.equal(res.counts.skipped, 2);
    assert.equal(decodeRecordedFrames(res.log).failed, 0);
  });

  it('parses ndjson defensively', () => {
    const text = [
      JSON.stringify({ t: 0, msg: { t: 'welcome', id: 1, tick: 0, snapshot: [] } }),
      '',
      'not json',
      JSON.stringify({ t: 100, msg: { t: 'snapshot', tick: 1, entities: [], removed: [] } }),
      JSON.stringify({ nope: true }),
      JSON.stringify({ t: 'x', msg: {} }),
      '   ',
    ].join('\n');
    const parsed = parseNdjson(text);
    assert.equal(parsed.lines.length, 2);
    assert.equal(parsed.skipped, 3);
    assert.equal(ndjsonToBin(parsed.lines).counts.snapshot, 1);
  });

  it('honours an explicit keyframe interval in the doc generator', () => {
    const res = ndjsonToBin(lines, { keyframeEvery: 25, playerName: 'hero' });
    const welcome = decodeWelcomeBinary(res.log.records[0]!.frame);
    assert.equal(welcome.name, 'hero');
    assert.equal(res.keyframes, 2);
  });
});

describe('binlog interop with the shared decoder', () => {
  it('exports a .bin back to v1 ndjson that re-converts to the same bytes', () => {
    const res = ndjsonToBin(linesFixture());
    const back = binToNdjsonLines(res.log);
    assert.equal(back.dropped, 0, 'no frame may be lost exporting to ndjson');
    assert.equal(back.lines.length, res.log.records.length);
    const reparsed = parseNdjson(back.lines.join('\n'));
    assert.equal(reparsed.skipped, 0);
    const again = ndjsonToBin(reparsed.lines, { keyframeEvery: 50 });
    assert.deepEqual(Array.from(encodeBinLog(again.log)), Array.from(encodeBinLog(res.log)), 'export -> re-import is byte-stable');
  });

  it('exports full entity lists so the v1 viewer has everything it needs', () => {
    const res = ndjsonToBin(linesFixture());
    const back = binToNdjsonLines(res.log);
    const snapshots = back.lines.map((l) => JSON.parse(l) as { msg: ServerMsg }).filter((l) => l.msg.t === 'snapshot');
    assert.equal(snapshots.length, 60);
    for (const s of snapshots) {
      if (s.msg.t !== 'snapshot') continue;
      assert.ok(s.msg.entities.length >= 9, `tick ${s.msg.tick}: ${s.msg.entities.length} entities`);
      for (const gone of s.msg.removed) {
        assert.equal(s.msg.entities.some((e) => e.id === gone), false, 'removed ids must not linger in the export');
      }
    }
  });

  it('maps ack frames onto a v1 event so nothing is dropped', () => {
    const log: BinLog = {
      version: 2,
      records: [
        ...sampleLog(2).records,
        { t: 9999, frame: encodeAckBinary({ t: 'ack', tick: 10, baseTick: 10, lastInputSeq: 5, rttMs: 12 }) },
      ],
    };
    const back = binToNdjsonLines(log);
    const last = JSON.parse(back.lines[back.lines.length - 1]!) as { msg: ServerMsg };
    assert.equal(last.msg.t, 'event');
    if (last.msg.t !== 'event') return;
    assert.equal(last.msg.kind, 'ack');
    assert.equal((last.msg.payload as { lastInputSeq: number }).lastInputSeq, 5);
  });

  it('a recorded keyframe frame decodes through the shared entry point', () => {
    const log = sampleLog(3);
    const frame = log.records[0]!.frame;
    const msg = decodeServerFrame(frame);
    assert.equal(msg.t, 'welcome');
    if (msg.t !== 'welcome') return;
    assert.equal(msg.proto, 2);
    assert.equal(msg.snapshot.length, 8);
  });

  it('re-encodes a standalone snapshot frame identically', () => {
    const frame = encodeSnapshotBinary({ t: 'snapshot', tick: 3, baseTick: 0, keyframe: true, entities: world(5, 3).map(toP2Entity), removed: [] });
    const msg = decodeServerFrame(frame);
    assert.equal(msg.t, 'snapshot');
    if (msg.t !== 'snapshot') return;
    assert.deepEqual(
      Array.from(encodeSnapshotBinary(msg)),
      Array.from(frame),
    );
    const applied = applySnapshot(msg, new Map(), -1);
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.entities.size, 5);
  });

  it('surfaces BinLogError as a real Error subclass', () => {
    const e = new BinLogError('x');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'BinLogError');
    assert.equal(e.message, 'binlog: x');
  });
});

// tiny local helper so the file also exercises raw writing
export function writeRaw(path: string, log: BinLog): number {
  writeFileSync(path, encodeBinLog(log));
  return encodeBinLog(log).length;
}