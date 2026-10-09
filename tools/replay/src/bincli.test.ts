import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWelcomeBinary, encodeSnapshotBinary, encodeInputBinary, encodeAckBinary, encodeChatBinary, encodeEventBinary, P2SnapshotStream, toP2Entity, type P2Entity } from '@aetherfall/shared/dist/protocol2.js';
import { describeFrame, parseCliArgs } from './bincli.js';
import { parseRecorder2Args, recorder2Hello, toBinRecord } from './recorder2.js';
import { BINLOG_VERSION, encodeBinLog, decodeBinLog } from './binlog.js';

function ent(id: number, over: Partial<P2Entity> = {}): P2Entity {
  return { id, kind: id % 2 === 0 ? 'player' : 'mob', p: { x: 1, y: 2 }, v: { x: 0, y: 0 }, hp: 10, maxHp: 10, ...over };
}

describe('bincli args', () => {
  it('parses commands, flags and --flag=value forms', () => {
    const a = parseCliArgs(['convert', 'in.ndjson', 'out.bin']);
    assert.equal(a.command, 'convert');
    assert.deepEqual(a.positional, ['in.ndjson', 'out.bin']);
    assert.equal(a.keyframeEvery, 50);
    assert.equal(a.frames, 5);
    assert.equal(a.json, false);

    const b = parseCliArgs(['inspect', '--frames=3', '--keyframe-every', '10', '--json', 'x.bin']);
    assert.equal(b.command, 'inspect');
    assert.equal(b.frames, 3);
    assert.equal(b.keyframeEvery, 10);
    assert.equal(b.json, true);
    assert.deepEqual(b.positional, ['x.bin']);
  });

  it('rejects nonsense intervals instead of dividing by zero', () => {
    for (const v of ['0', '-1', 'abc', '2.5', '9999']) {
      assert.equal(parseCliArgs(['convert', '--keyframe-every', v]).keyframeEvery, 50, v);
    }
    assert.equal(parseCliArgs(['convert', '--frames', '-4']).frames, 5);
    assert.equal(parseCliArgs(['convert', '--frames', '0']).frames, 0);
  });

  it('defaults to help with no arguments', () => {
    assert.equal(parseCliArgs([]).command, 'help');
  });
});

describe('bincli describeFrame', () => {
  it('summarizes every frame type without throwing', () => {
    const cases: Array<[string, Uint8Array]> = [
      ['welcome', encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 3, tick: 9, name: 'hero', snapshot: [ent(1), ent(2)] })],
      ['snapshot kf', encodeSnapshotBinary({ t: 'snapshot', tick: 9, baseTick: 0, keyframe: true, entities: [ent(1)], removed: [4] })],
      ['snapshot delta', encodeSnapshotBinary({ t: 'snapshot', tick: 9, baseTick: 8, keyframe: false, entities: [], removed: [] })],
      ['chat', encodeChatBinary({ t: 'chat', from: 'a', text: 'b', channel: 'global' })],
      ['event', encodeEventBinary({ t: 'event', kind: 'despawn', payload: '{"id":1}' })],
      ['ack', encodeAckBinary({ t: 'ack', tick: 3, baseTick: 3, lastInputSeq: 9 })],
    ];
    for (const [name, frame] of cases) {
      const text = describeFrame(frame);
      assert.ok(text.includes(frame.length + ' B'), `${name}: ${text}`);
      assert.equal(text.includes('UNDECODABLE'), name === 'snapshot delta' ? false : false, name);
    }
    assert.match(describeFrame(cases[0]![1]), /^welcome id=3 tick=9 entities=2/);
    assert.match(describeFrame(cases[1]![1]), /KEYFRAME entities=1 removed=1/);
    assert.match(describeFrame(cases[2]![1]), /delta entities=0 removed=0/);
    assert.match(describeFrame(cases[5]![1]), /lastInputSeq=9/);
  });

  it('labels short, unknown and corrupt frames', () => {
    assert.match(describeFrame(new Uint8Array(0)), /short frame \(0 B\)/);
    const bad = encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 1, name: '', snapshot: [ent(1)] });
    bad[0] = 0x00;
    assert.match(describeFrame(bad), /UNDECODABLE: protocol2: bad magic/);
    const unknownType = encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 1, name: '', snapshot: [ent(1)] });
    unknownType[2] = 77;
    assert.match(describeFrame(unknownType), /unknown\(77\)/);
  });
});

describe('recorder2', () => {
  it('parses args like the v1 recorder', () => {
    const a = parseRecorder2Args([], {}, 'default.bin');
    assert.equal(a.server, 'ws://localhost:8081');
    assert.equal(a.duration, 30);
    assert.equal(a.out, 'default.bin');
    const b = parseRecorder2Args(['--server', 'ws://x:1', '--duration=5', '--out', 'r.bin'], {});
    assert.equal(b.server, 'ws://x:1');
    assert.equal(b.duration, 5);
    assert.equal(b.out, 'r.bin');
    const e = parseRecorder2Args([], { SERVER: 'ws://env:2', DURATION: '7' }, 'd.bin');
    assert.equal(e.server, 'ws://env:2');
    assert.equal(e.duration, 7);
    assert.equal(parseRecorder2Args(['--duration', '-3'], {}, 'o').duration, 1);
    assert.equal(parseRecorder2Args(['--duration', 'abc'], {}, 'o').duration, 30);
  });

  it('sends the same capability probe as the browser client', () => {
    const hello = JSON.parse(recorder2Hello('recorder2', 25)) as { t: string; proto: number; caps: Record<string, unknown> };
    assert.equal(hello.t, 'hello');
    assert.equal(hello.proto, 2);
    assert.equal(hello.caps['binary'], true);
    assert.equal(hello.caps['deltas'], true);
    assert.equal(hello.caps['keyframe'], 25);
    assert.equal((JSON.parse(recorder2Hello()) as { caps: Record<string, unknown> }).caps['keyframe'], 50);
  });

  it('normalizes ws payloads into bin records', () => {
    const frame = encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 1, name: '', snapshot: [ent(1)] });
    assert.deepEqual(Array.from(toBinRecord(frame, 5)!.frame), Array.from(frame));
    assert.equal(toBinRecord(frame, 5)!.t, 5);
    assert.deepEqual(Array.from(toBinRecord(Buffer.from(frame), 6)!.frame), Array.from(frame));
    assert.deepEqual(Array.from(toBinRecord([...frame], 7)!.frame), Array.from(frame));
    assert.equal(toBinRecord('{"t":"welcome"}', 8), null);
    assert.equal(toBinRecord(42, 9), null);
  });

  it('records a whole session into a readable container', () => {
    const stream = new P2SnapshotStream(5);
    const records: Array<{ t: number; frame: Uint8Array }> = [];
    stream.seed([ent(1), ent(2)], 0);
    for (let t = 1; t <= 12; t++) {
      records.push({ t: t * 100, frame: stream.encode([ent(1, { p: { x: t, y: 2 } }), ent(2)], [], t) });
    }
    const log = decodeBinLog(encodeBinLog({ version: BINLOG_VERSION, records }));
    assert.equal(log.records.length, 12);
    assert.equal(log.records[11]!.t, 1200);
    // the first snapshot after seeding is a delta, tick 5 is a keyframe
    assert.equal(log.records[0]!.frame[3]! & 1, 0);
    assert.equal(log.records[4]!.frame[3]! & 1, 1);
    assert.equal(log.records[9]!.frame[3]! & 1, 1);
  });

  it('a recorder input frame is a valid client frame', () => {
    const frame = encodeInputBinary({ t: 'input', input: { seq: 1, dt: 0.05, move: { x: 0.5, y: 0.5 }, chat: 'hey' } });
    const rec = toBinRecord(frame, 0)!;
    const back = decodeBinLog(encodeBinLog({ version: BINLOG_VERSION, records: [rec] }));
    assert.equal(back.records[0]!.frame[2], 17, 'client frames are msg type 17');
  });
});