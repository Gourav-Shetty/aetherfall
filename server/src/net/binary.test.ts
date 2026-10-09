import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySnapshot,
  decodeAckBinary,
  decodeChatBinary,
  decodeEventBinary,
  decodeInputBinary as decodeP2Input,
  decodeSnapshotBinary,
  decodeWelcomeBinary,
  encodeInputBinary,
  isKeyframeSeq,
  prequantizeSnapshot,
  type P2Baseline,
} from '@aetherfall/shared/dist/protocol2.js';
import type { EntitySnapshot, ServerMsg } from '@aetherfall/shared';
import {
  BinarySession,
  PROTO_ENV_VAR,
  asBytes,
  baselineOf,
  binaryProtocolEnabled,
  createSession,
  decodeInputBinary,
  dropSession,
  encodeHelloProbe,
  encodeSnapshotBinary,
  keyframeEveryFromEnv,
  negotiateInbound,
  shouldKeyframe,
  v1Forced,
  v2Forced,
} from './binary.js';

const EPS = 1e-3;

function ent(id: number, x: number, y: number, over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return { id, kind: 'mob', p: { x, y }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100, ...over };
}

function world(n: number, tick: number): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      ent(i + 1, 50 + Math.sin((tick + i) / 7) * 20, 50 + Math.cos((tick + i) / 5) * 20, {
        kind: i % 3 === 0 ? 'player' : 'mob',
        v: { x: Math.sin((tick + i) / 3) * 4, y: Math.cos((tick + i) / 3) * 4 },
        hp: 80 + (i % 7),
        maxHp: 100,
        dir: (i % 8) * 0.78,
        level: 1 + (i % 20),
        ...(i % 4 === 0 ? { name: `mob-${i}` } : {}),
      }),
    );
  }
  return out;
}

const snap = (tick: number, entities: EntitySnapshot[], removed: number[] = []): ServerMsg => ({
  t: 'snapshot',
  tick,
  entities,
  removed,
});

describe('PROTO env switch (v2 default, PROTO=1 pins v1)', () => {
  it('offers v2 by default; only PROTO=1 disables it', () => {
    assert.equal(PROTO_ENV_VAR, 'PROTO');
    assert.equal(binaryProtocolEnabled({}), true, 'default on');
    assert.equal(binaryProtocolEnabled({ PROTO: '2' }), true);
    assert.equal(binaryProtocolEnabled({ PROTO: ' v2 ' }), true);
    assert.equal(binaryProtocolEnabled({ PROTO: 'BINARY' }), true);
    // Unset-like / garbage values keep the default offer: a v1-only client
    // never offers proto:2, so it stays on JSON regardless.
    for (const v of ['', ' ', '0', '3', 'true', 'yes', 'on', 'proto2', 'undefined']) {
      assert.equal(binaryProtocolEnabled({ PROTO: v }), true, `PROTO=${JSON.stringify(v)} must stay v2-default`);
    }
    for (const v of ['1', 'v1', 'json', ' V1 ', 'JSON']) {
      assert.equal(binaryProtocolEnabled({ PROTO: v }), false, `PROTO=${JSON.stringify(v)} must pin v1`);
    }
  });

  it('v2Forced marks only the explicit PROTO=2 opt-in (caps bypass)', () => {
    assert.equal(v2Forced({}), false);
    assert.equal(v2Forced({ PROTO: '2' }), true);
    assert.equal(v2Forced({ PROTO: ' v2 ' }), true);
    assert.equal(v2Forced({ PROTO: 'BINARY' }), true);
    assert.equal(v2Forced({ PROTO: '1' }), false);
    assert.equal(v2Forced({ PROTO: 'garbage' }), false);
  });

  it('clamps PROTO_KEYFRAME to 1..255 with a 50 default', () => {
    assert.equal(keyframeEveryFromEnv({}), 50);
    assert.equal(keyframeEveryFromEnv({ PROTO_KEYFRAME: '25' }), 25);
    assert.equal(keyframeEveryFromEnv({ PROTO_KEYFRAME: '1' }), 1);
    assert.equal(keyframeEveryFromEnv({ PROTO_KEYFRAME: '255' }), 255);
    for (const v of ['0', '256', '-3', 'abc', '', '2.5']) {
      assert.equal(keyframeEveryFromEnv({ PROTO_KEYFRAME: v }), 50, `PROTO_KEYFRAME=${v}`);
    }
  });
});

describe('encodeSnapshotBinary (free function)', () => {
  it('defaults to a keyframe and switches to deltas on demand', () => {
    const a = encodeSnapshotBinary(snap(1, world(20, 1)));
    assert.equal(a.keyframe, true);
    assert.equal(a.bytes[3] & 1, 1, 'keyframe flag set in the frame header');

    const b = encodeSnapshotBinary(snap(2, world(20, 2)), a.baseline, { keyframe: false });
    assert.equal(b.keyframe, false);
    assert.equal(b.bytes[3] & 1, 0);
    assert.ok(b.bytes.length < a.bytes.length / 2, `delta=${b.bytes.length} keyframe=${a.bytes.length}`);
    assert.equal(b.baseTick, 1);

    // and the receiver rebuilds the exact same state from both frames
    const kf = decodeSnapshotBinary(a.bytes);
    const first = applySnapshot(kf, new Map(), -1);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const delta = decodeSnapshotBinary(b.bytes, first.baseline);
    const second = applySnapshot(delta, first.baseline, first.baseTick);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.entities.size, 20);
    const truth = world(20, 2);
    for (const e of truth) {
      const got = second.entities.get(e.id);
      assert.ok(got, `missing entity ${e.id}`);
      if (!got) continue;
      assert.ok(Math.abs(got.p.x - e.p.x) <= 1 / 16 + EPS, `p.x #${e.id}`);
      assert.ok(Math.abs(got.p.y - e.p.y) <= 1 / 16 + EPS, `p.y #${e.id}`);
      assert.equal(got.kind, e.kind);
      assert.equal(got.level, e.level);
      assert.equal(got.name, e.name);
    }
  });

  it('forgets removed ids so they do not resurface in the next delta', () => {
    const w = world(6, 1);
    const first = encodeSnapshotBinary(snap(1, w));
    const second = encodeSnapshotBinary(snap(2, w, [3, 4]), first.baseline, { keyframe: false });
    assert.equal(second.baseline.has(3), false);
    assert.equal(second.baseline.has(4), false);
    assert.deepEqual(decodeSnapshotBinary(second.bytes, first.baseline).removed, [3, 4]);
    // a third tick with the removals already applied produces no records for them
    const third = encodeSnapshotBinary(snap(3, w.filter((e) => e.id !== 3 && e.id !== 4)), second.baseline, {
      keyframe: false,
    });
    assert.equal(third.baseline.size, 4);
  });

  it('promotes to a keyframe when a delta cannot express a cleared field', () => {
    const named = [ent(1, 1, 1, { name: 'boss' })];
    const first = encodeSnapshotBinary(snap(1, named));
    const second = encodeSnapshotBinary(snap(2, [ent(1, 1, 1)]), first.baseline, { keyframe: false });
    assert.equal(second.keyframe, true);
    const applied = applySnapshot(decodeSnapshotBinary(second.bytes), new Map(), -1);
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.entities.get(1)!.name, undefined);
  });

  it('treats welcome as a keyframe regardless of options', () => {
    const msg: ServerMsg = { t: 'welcome', id: 7, tick: 3, snapshot: world(4, 3) };
    const out = encodeSnapshotBinary(msg, new Map(), { keyframe: false });
    assert.equal(out.keyframe, true);
    assert.equal(out.baseTick, 0);
  });

  it('rejects messages that are not snapshots and impossible baseTicks', () => {
    assert.throws(() => encodeSnapshotBinary({ t: 'chat', from: 'a', text: 'b', channel: 'say' } as ServerMsg), /snapshot\|welcome/);
    assert.throws(() => encodeSnapshotBinary(snap(5, []), new Map(), { keyframe: false, baseTick: 9 }), /baseTick/);
  });

  it('is pure — the caller baseline is untouched', () => {
    const prev: P2Baseline = baselineOf(world(3, 1));
    const before = prev.size;
    encodeSnapshotBinary(snap(2, world(3, 2)), prev, { keyframe: false });
    assert.equal(prev.size, before);
    assert.equal(prev.get(1)!.qx, baselineOf(world(3, 1)).get(1)!.qx);
  });
});

describe('decodeInputBinary (free function)', () => {
  it('decodes what the shared encoder produced', () => {
    const frame = encodeInputBinary({
      t: 'input',
      input: { seq: 12, dt: 0.05, move: { x: -0.5, y: 0.25 }, attack: true, chat: 'hi' },
    });
    const out = decodeInputBinary(frame);
    assert.equal(out.input.seq, 12);
    assert.ok(Math.abs(out.input.move.x + 0.5) < 1e-6);
    assert.equal(out.input.attack, true);
    assert.equal(out.input.chat, 'hi');
    assert.deepEqual(out, decodeP2Input(asBytes(frame)));
  });

  it('accepts Buffer / ArrayBuffer / typed array views', () => {
    const frame = encodeInputBinary({ t: 'input', input: { seq: 3, dt: 0.05, move: { x: 0, y: 0 } } });
    assert.equal(decodeInputBinary(Buffer.from(frame)).input.seq, 3);
    assert.equal(decodeInputBinary(frame.buffer.slice(0) as ArrayBuffer).input.seq, 3);
    // a frame embedded in a larger buffer must still decode from its offset
    const padded = new Uint8Array(2 + frame.length);
    padded.set(frame, 2);
    assert.equal(decodeInputBinary(padded.subarray(2)).input.seq, 3);
    assert.equal(decodeInputBinary(Buffer.from(padded.buffer, 2, frame.length)).input.seq, 3);
    // ...but leading padding is not part of the frame: magic must be at offset 0
    assert.throws(() => decodeInputBinary(padded), /bad magic/);
  });

  it('throws on JSON text and on malformed frames', () => {
    assert.throws(() => decodeInputBinary('{"t":"input"}'), /binary frame expected/);
    const bad = encodeInputBinary({ t: 'input', input: { seq: 3, dt: 0.05, move: { x: 0, y: 0 } } });
    bad[0] = 0x00;
    assert.throws(() => decodeInputBinary(bad), /protocol2: bad magic/);
    assert.throws(() => asBytes(42), /binary frame expected/);
  });
});

describe('BinarySession handshake', () => {
  it('declines everything while the switch is off', () => {
    const s = createSession({ enabled: false });
    const hello = JSON.stringify({ t: 'hello', name: 'x', proto: 2, caps: { binary: true, deltas: true, keyframe: 50 } });
    assert.equal(s.peekHello(hello), true);
    assert.equal(s.negotiate(s.hello(hello)!).proto, 1);
    assert.equal(s.negotiate(s.hello(hello)!).reason, 'server-disabled');
    assert.equal(s.isUpgraded, false);
  });

  it('accepts the JSON proto:2 probe and upgrades', () => {
    const s = createSession({ enabled: true });
    const hello = JSON.stringify({
      t: 'hello',
      name: 'hero',
      token: 'tok',
      proto: 2,
      caps: { binary: true, deltas: true, keyframe: 25, chat: true, event: true },
    });
    assert.equal(s.peekHello(hello), true);
    const parsed = s.hello(hello);
    assert.equal(parsed?.name, 'hero');
    assert.equal(parsed?.token, 'tok');
    const decision = s.negotiate(parsed);
    assert.deepEqual(decision, { proto: 2, reason: 'accepted' });
    assert.equal(s.resolveKeyframeEvery(parsed), 25);
    s.upgrade();
    assert.equal(s.isUpgraded, true);
  });

  it('falls back to v1 for a proto:1 hello', () => {
    const s = createSession({ enabled: true });
    const raw = { t: 'hello', name: 'old', proto: 1 };
    assert.deepEqual(s.negotiate(raw), { proto: 1, reason: 'older-proto' });
    // hello() only ever returns proto-2 hellos; a v1 hello stays on the v1 path
    assert.equal(s.hello(JSON.stringify(raw)), null);
  });

  it('also accepts a binary P2Hello frame', () => {
    const s = createSession({ enabled: true });
    const probe = encodeHelloProbe('bin-hero', 'tk', 30);
    assert.equal(s.peekHello(probe), true);
    const parsed = s.hello(probe);
    assert.equal(parsed?.name, 'bin-hero');
    assert.equal(parsed?.token, 'tk');
    assert.equal(s.resolveKeyframeEvery(parsed), 30);
    assert.equal(s.negotiate(parsed).proto, 2);
    const viaDecodeClient = s.decodeClient(probe);
    assert.equal(viaDecodeClient?.t, 'hello');
  });

  it('never throws on junk', () => {
    const s = createSession({ enabled: true });
    for (const junk of ['', 'not json', '{"t":"input"}', '[]', 'null', 42, null, undefined, {}, new Uint8Array(0), new Uint8Array([1, 2, 3, 4, 5])]) {
      assert.doesNotThrow(() => s.peekHello(junk));
      assert.doesNotThrow(() => s.hello(junk));
      assert.doesNotThrow(() => s.decodeClient(junk));
    }
    assert.equal(s.peekHello('[]'), false);
    assert.equal(s.hello('null'), null);
    assert.equal(s.decodeClient(new Uint8Array(0)), null);
    assert.equal(s.decodeClient('{'), null);
    assert.equal(BinarySession.isBinaryFrame('{}'), false);
    assert.equal(BinarySession.isBinaryFrame(Buffer.alloc(2)), true);
  });

  it('decodes client input frames after the upgrade', () => {
    const s = createSession({ enabled: true });
    s.upgrade();
    const frame = encodeInputBinary({ t: 'input', input: { seq: 99, dt: 0.05, move: { x: 1, y: -1 } } });
    const f = s.decodeClient(frame);
    assert.equal(f?.t, 'input');
    if (f?.t === 'input') {
      assert.equal(f.input.seq, 99);
      s.noteInputSeq(f.input.seq);
    }
    assert.equal(s.lastInputSeq, 99);
    const broken = frame.slice();
    broken[1] = 9;
    assert.equal(s.decodeClient(broken), null);
  });
});

describe('BinarySession outbound encoding', () => {
  it('keyframes on schedule and deltas in between', () => {
    const s = createSession({ enabled: true, keyframeEvery: 5 });
    const flags: number[] = [];
    const sizes: number[] = [];
    for (let t = 1; t <= 12; t++) {
      const bytes = s.encode(snap(t, world(20, t)));
      flags.push(bytes[3]! & 1);
      sizes.push(bytes.length);
      s.noteInputSeq(t);
    }
    assert.deepEqual(flags, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    assert.deepEqual(sizes.map((n, i) => (flags[i] === 1)), [true, false, false, false, false, true, false, false, false, false, true, false]);
    assert.ok(sizes[1]! < sizes[0]!, 'a delta is smaller than a keyframe');
    assert.equal(s.seq, 12);
    assert.equal(s.baseTick, 12);
  });

  it('round-trips a 60-snapshot stream through a real client baseline', () => {
    const s = createSession({ enabled: true, keyframeEvery: 50 });
    let baseline = new Map<number, never>();
    let baseTick = 0;
    for (let t = 1; t <= 60; t++) {
      const bytes = s.encode(snap(t, world(15, t)));
      const decoded = decodeSnapshotBinary(bytes, baseline as P2Baseline);
      const applied = applySnapshot(decoded, baseline as P2Baseline, baseTick);
      assert.equal(applied.ok, true, `tick ${t}`);
      if (!applied.ok) continue;
      baseline = applied.baseline as unknown as Map<number, never>;
      baseTick = applied.baseTick;
      assert.equal(applied.entities.size, 15);
      assert.equal(applied.baseTick, t);
      const truth = world(15, t);
      const e = truth[7]!;
      const got = applied.entities.get(e.id)!;
      assert.ok(Math.abs(got.p.x - e.p.x) <= 1 / 16 + EPS);
      assert.equal(got.name, e.name);
      assert.equal(got.level, e.level);
    }
    // tick 50 forced a keyframe (50 % 50 === 0)
    assert.equal(isKeyframeSeq(50, 50), true);
    assert.equal(shouldKeyframe(50, 50), true);
    assert.equal(shouldKeyframe(49, 50), false);
  });

  it('encodes welcome, chat, event and ack with v1 parity', () => {
    const s = createSession({ enabled: true });
    const welcome = decodeWelcomeBinary(s.encode({ t: 'welcome', id: 42, tick: 5, snapshot: world(3, 5) }));
    assert.equal(welcome.proto, 2);
    assert.equal(welcome.id, 42);
    assert.equal(welcome.snapshot.length, 3);
    assert.equal(s.baseTick, 5);

    const chat = decodeChatBinary(s.encode({ t: 'chat', from: 'Elder Maren', text: 'welcome', channel: 'global' }));
    assert.deepEqual(chat, { t: 'chat', from: 'Elder Maren', text: 'welcome', channel: 'global' });

    const event = decodeEventBinary(s.encode({ t: 'event', kind: 'despawn', payload: { id: 9 } }));
    assert.equal(event.kind, 'despawn');
    assert.deepEqual(JSON.parse(event.payload), { id: 9 });

    s.noteInputSeq(77);
    const ack = decodeAckBinary(s.encodeAck(12));
    assert.equal(ack.lastInputSeq, 77);
    assert.equal(ack.baseTick, 5);
    assert.equal(ack.rttMs, 12);
  });

  it('reset() drops the baseline and the upgrade flag', () => {
    const s = createSession({ enabled: true, keyframeEvery: 50 });
    s.upgrade();
    s.encode(snap(1, world(4, 1)));
    s.reset();
    assert.equal(s.isUpgraded, false);
    assert.equal(s.seq, 0);
    assert.equal(s.baseTick, 0);
    assert.equal(s.lastInputSeq, 0);
    // after a reset the next frame is a keyframe again even though seq is 1
    const bytes = s.encode(snap(2, world(4, 2)));
    assert.equal(bytes[3]! & 1, 1);
  });

  it('dropSession forgets the socket without throwing', () => {
    const sessions = new WeakMap<object, BinarySession>();
    const ws = {};
    const s = createSession({ enabled: true });
    s.upgrade();
    sessions.set(ws, s);
    assert.equal(sessions.get(ws), s);
    dropSession(sessions, ws);
    assert.equal(sessions.get(ws), undefined);
    assert.equal(s.isUpgraded, false);
    assert.doesNotThrow(() => dropSession(sessions, {}));
  });

  it('sends deltas far smaller than the v1 JSON for the same state', () => {
    const s = createSession({ enabled: true, keyframeEvery: 50 });
    const w = world(30, 10);
    const first = s.encode(snap(10, w));
    const second = s.encode(snap(11, w.map((e, i) => (i % 2 === 0 ? e : { ...e, p: { x: e.p.x + 0.05, y: e.p.y } }))));
    const json = Buffer.byteLength(JSON.stringify(snap(11, w)));
    assert.ok(first.length < json / 4, `keyframe ${first.length} vs json ${json}`);
    assert.ok(second.length < json / 12, `delta ${second.length} vs json ${json}`);
  });
});
/* ------------------------------------------------------------------ *
 * negotiated policy + serialize-once broadcast (PROTO2)
 * ------------------------------------------------------------------ */

describe('negotiateInbound (server policy)', () => {
  const offer = JSON.stringify({
    t: 'hello',
    name: 'hero',
    proto: 2,
    caps: { binary: true, deltas: true, keyframe: 25, chat: true, event: true },
  });

  it('accepts a capability offer by default (PROTO unset)', () => {
    const s = createSession({ enabled: false });
    const hello = s.hello(offer)!;
    assert.equal(s.peekHello(offer), true);
    assert.deepEqual(negotiateInbound(hello, {}), { proto: 2, reason: 'accepted', keyframeEvery: 25 });
  });

  it('declines anything that is not a proto-2 offer', () => {
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 1 }, {}).proto, 1);
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 3 }, {}).proto, 1);
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 2 }, {}).reason, 'server-disabled');
    assert.equal(
      negotiateInbound({ t: 'hello', name: 'a', proto: 2, caps: { binary: false } }, {}).reason,
      'server-disabled',
    );
    assert.equal(negotiateInbound(null, {}).proto, 1);
    assert.equal(negotiateInbound('garbage', {}).proto, 1);
  });

  it('PROTO=2 forces v2 for proto-2 clients, including a caps-less probe', () => {
    const forced = { PROTO: '2' };
    assert.deepEqual(negotiateInbound({ t: 'hello', name: 'a', proto: 2, caps: { binary: true, keyframe: 10 } }, forced), {
      proto: 2,
      reason: 'accepted-forced',
      keyframeEvery: 10,
    });
    assert.deepEqual(negotiateInbound({ t: 'hello', name: 'a', proto: 2 }, forced), {
      proto: 2,
      reason: 'accepted-forced-no-caps',
      keyframeEvery: 50,
    });
    // a v1 client is still refused: capability negotiation never rewrites v1
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 1 }, forced).proto, 1);
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 1 }, forced).reason, 'older-proto');
  });

  it('PROTO=1 pins v1 even for a valid offer (rollback valve)', () => {
    const pinned = { PROTO: '1' };
    const hello = { t: 'hello', name: 'a', proto: 2, caps: { binary: true } };
    assert.deepEqual(negotiateInbound(hello, pinned), { proto: 1, reason: 'server-v1-forced', keyframeEvery: 50 });
    assert.deepEqual(negotiateInbound(hello, { PROTO: 'v1' }), { proto: 1, reason: 'server-v1-forced', keyframeEvery: 50 });
    assert.equal(v1Forced({}), false);
    assert.equal(v1Forced({ PROTO: '2' }), false);
    assert.equal(binaryProtocolEnabled({ PROTO: '1' }), false);
  });

  it('honours PROTO_KEYFRAME and clamps the client request', () => {
    const caps = (keyframe: number) => ({ t: 'hello', name: 'a', proto: 2, caps: { binary: true, keyframe } });
    assert.equal(negotiateInbound(caps(9999), { PROTO_KEYFRAME: '30' }).keyframeEvery, 30);
    assert.equal(negotiateInbound(caps(7), {}).keyframeEvery, 7);
    assert.equal(negotiateInbound(caps(0), {}).keyframeEvery, 50);
    assert.equal(negotiateInbound(caps(25), { PROTO_KEYFRAME: '0' }).keyframeEvery, 25);
  });

  it('hello() rejects the junk safeParseClientMsg would drop', () => {
    const s = createSession({ enabled: true });
    assert.equal(s.hello(JSON.stringify({ t: 'hello', name: 42, proto: 2, caps: { binary: true } })), null);
    assert.equal(s.hello(JSON.stringify({ t: 'hello', name: 'x'.repeat(2000), proto: 2, caps: { binary: true } })), null);
    assert.equal(s.hello(JSON.stringify({ t: 'hello', name: 'ok', proto: 2, token: 't'.repeat(600), caps: { binary: true } })), null);
    // exactly at the bound it still parses
    assert.equal(s.hello(JSON.stringify({ t: 'hello', name: 'x'.repeat(1024), proto: 2, caps: { binary: true } }))?.name.length, 1024);
  });

  it('enableBinary flips the gate and honours a client keyframe interval', () => {
    const s = createSession({ enabled: false });
    assert.equal(s.enabled, false);
    s.enableBinary(11);
    assert.equal(s.enabled, true);
    assert.equal(s.resolveKeyframeEvery({ t: 'hello', name: 'a', proto: 2, caps: { binary: true, keyframe: 11 } }), 11);
    const raw = s.encode(snap(1, world(3, 1)));
    assert.equal(raw[3]! & 1, 1, 'first frame after an upgrade is a keyframe');
  });
});

describe('BinarySession.encodeView (serialize-once broadcast)', () => {
  it('is byte-identical to encode() for the same viewer state', () => {
    const refS = createSession({ enabled: true, keyframeEvery: 5 });
    const fastS = createSession({ enabled: true, keyframeEvery: 5 });
    for (let tick = 1; tick <= 40; tick++) {
      const w = world(24, tick);
      const visible = [0, 1, 2, 5, 9, 17, 23];
      const removed = tick % 11 === 0 ? [9] : [];
      const idx = visible.filter((i) => !removed.includes(i + 1));
      const quant = prequantizeSnapshot(w);
      const expected = refS.encode({
        t: 'snapshot',
        tick,
        entities: idx.map((i) => w[i]!),
        removed,
      });
      const got = fastS.encodeView(quant, idx, removed, tick);
      assert.deepEqual(Array.from(got), Array.from(expected), `tick ${tick}: ${got.length}B vs ${expected.length}B`);
      assert.equal(fastS.seq, refS.seq);
      assert.equal(fastS.baseTick, refS.baseTick);
    }
  });

  it('reconstructs the world from a 120-tick view stream (client side)', () => {
    const s = createSession({ enabled: true, keyframeEvery: 50 });
    s.upgrade();
    const idx = Array.from({ length: 20 }, (_, i) => i);
    let baseline: P2Baseline = new Map();
    let baseTick = 0;
    for (let tick = 1; tick <= 120; tick++) {
      const w = world(20, tick);
      const bytes = s.encodeView(prequantizeSnapshot(w), idx, [], tick);
      const applied = applySnapshot(decodeSnapshotBinary(bytes, baseline), baseline, baseTick);
      assert.equal(applied.ok, true, `tick ${tick}`);
      if (!applied.ok) return;
      baseline = applied.baseline;
      baseTick = applied.baseTick;
      assert.equal(applied.entities.size, 20);
      if (tick % 37 === 0) {
        const truth = world(20, tick)[11]!;
        const got = applied.entities.get(truth.id)!;
        assert.ok(Math.abs(got.p.x - truth.p.x) <= 1 / 16 + EPS);
        assert.ok(Math.abs(got.p.y - truth.p.y) <= 1 / 16 + EPS);
        assert.equal(got.name, truth.name);
      }
    }
  });

  it('the welcome seeds the view stream so the first snapshot is a delta', () => {
    const s = createSession({ enabled: true, keyframeEvery: 50 });
    s.upgrade();
    s.encode({ t: 'welcome', id: 3, tick: 20, snapshot: world(6, 20) });
    const quant = prequantizeSnapshot(world(6, 20));
    const bytes = s.encodeView(quant, [0, 1, 2, 3, 4, 5], [], 22);
    assert.equal(bytes[3]! & 1, 0, 'delta, not a redundant keyframe');
    const decoded = decodeSnapshotBinary(bytes, baselineOf(world(6, 20)));
    assert.equal(decoded.baseTick, 20);
    assert.equal(decoded.entities.length, 0, 'nothing moved between the welcome and tick 22');
  });
});

describe('v2 default negotiation matrix', () => {
  const offer2 = { t: 'hello', name: 'hero', proto: 2, caps: { binary: true, deltas: true, keyframe: 50, chat: true, event: true } };
  const offer1 = { t: 'hello', name: 'old', proto: 1 };

  it('2->2: a proto:2 offer is accepted on the default server', () => {
    assert.deepEqual(negotiateInbound(offer2, {}), { proto: 2, reason: 'accepted', keyframeEvery: 50 });
    const s = createSession();
    assert.equal(s.enabled, true, 'session default is v2-enabled');
    assert.deepEqual(s.negotiate(s.hello(JSON.stringify(offer2))!), { proto: 2, reason: 'accepted' });
  });

  it('2->1 fallback: PROTO=1 admits a proto:2 hello on v1 JSON', () => {
    assert.deepEqual(negotiateInbound(offer2, { PROTO: '1' }), {
      proto: 1,
      reason: 'server-v1-forced',
      keyframeEvery: 50,
    });
    // the same handshake is still a usable v1 hello (graceful degradation)
    const s = createSession({ enabled: false });
    assert.equal(s.hello(JSON.stringify(offer2))?.proto, 2, 'probe still parses');
  });

  it('1->1: a v1 hello never upgrades, on any server policy', () => {
    for (const env of [{}, { PROTO: '2' }, { PROTO: '1' }, { PROTO: 'garbage' }]) {
      assert.equal(negotiateInbound(offer1, env).proto, 1, JSON.stringify(env));
    }
    const s = createSession();
    assert.equal(s.hello(JSON.stringify(offer1)), null, 'v1 hello stays on the v1 path');
  });

  it('forced flags: PROTO=1 pins v1, PROTO=2 keeps the caps bypass', () => {
    assert.equal(v1Forced({ PROTO: '1' }), true);
    assert.equal(v1Forced({}), false);
    assert.equal(v2Forced({ PROTO: '2' }), true);
    assert.equal(v2Forced({}), false);
    // caps-less proto:2: declined by default, accepted under PROTO=2
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 2 }, {}).proto, 1);
    assert.deepEqual(negotiateInbound({ t: 'hello', name: 'a', proto: 2 }, { PROTO: '2' }), {
      proto: 2,
      reason: 'accepted-forced-no-caps',
      keyframeEvery: 50,
    });
    // unknown/future protos never upgrade, even when forced
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 3 }, { PROTO: '2' }).proto, 1);
    assert.equal(negotiateInbound({ t: 'hello', name: 'a', proto: 1 }, { PROTO: '2' }).proto, 1);
  });
});

describe('v2/v1 byte-parity on the same sim', () => {
  it('binary decodes to the same world the v1 JSON describes, at far fewer bytes', () => {
    const s = createSession({ enabled: true, keyframeEvery: 50 });
    let baseline: P2Baseline = new Map();
    let baseTick = 0;
    let jsonTotal = 0;
    let v2Total = 0;
    for (let tick = 1; tick <= 30; tick++) {
      const w = world(20, tick);
      const msg = snap(tick, w);
      const json = Buffer.byteLength(JSON.stringify(msg));
      const bytes = s.encode(msg);
      jsonTotal += json;
      v2Total += bytes.length;
      const decoded = decodeSnapshotBinary(bytes, baseline);
      const applied = applySnapshot(decoded, baseline, baseTick);
      assert.equal(applied.ok, true, `tick ${tick}`);
      if (!applied.ok) continue;
      baseline = applied.baseline;
      baseTick = applied.baseTick;
      // parity: every entity the JSON carries, the binary stream reconstructs
      for (const e of w) {
        const got = applied.entities.get(e.id);
        assert.ok(got, `tick ${tick} missing ${e.id}`);
        if (!got) continue;
        assert.ok(Math.abs(got.p.x - e.p.x) <= 1 / 16 + EPS, `t${tick} p.x #${e.id}`);
        assert.ok(Math.abs(got.p.y - e.p.y) <= 1 / 16 + EPS, `t${tick} p.y #${e.id}`);
        assert.equal(got.hp, e.hp);
        assert.equal(got.maxHp, e.maxHp);
        assert.equal(got.kind, e.kind);
      }
    }
    assert.ok(v2Total < jsonTotal / 4, `v2 ${v2Total}B vs v1 JSON ${jsonTotal}B on the same 30-tick sim`);
  });
});
