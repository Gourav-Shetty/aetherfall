import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EntitySnapshot } from './index.js';
import {
  P2Type,
  P2_KEYFRAME_INTERVAL,
  P2_MAGIC,
  P2_POS_SCALE,
  PROTO2_VERSION,
  P2DecodeError,
  P2SnapshotStream,
  P2ViewStream,
  applySnapshot,
  baselineFromEntities,
  decodeAckBinary,
  decodeChatBinary,
  decodeClientFrame,
  decodeEventBinary,
  decodeFrame,
  decodeHelloBinary,
  decodeInputBinary,
  decodeServerFrame,
  decodeSnapshotBinary,
  decodeWelcomeBinary,
  diffSnapshot,
  encodeAckBinary,
  encodeChatBinary,
  encodeEventBinary,
  encodeHelloBinary,
  encodeInputBinary,
  encodeSnapshotBinary,
  encodeSnapshotAgainst,
  encodeWelcomeBinary,
  isKeyframeSeq,
  needsKeyframe,
  negotiateProto,
  prequantizeSnapshot,
  quantizeEntity,
  dequantizeEntity,
  quantizeSnapshot,
  resolveKeyframeEvery,
  safeDecodeClientFrame,
  safeDecodeServerFrame,
  toEntitySnapshot,
  toP2Entity,
  unzigzag,
  varintSize,
  zigzag,
  P2Reader,
  P2StringTableWriter,
  P2Writer,
  type P2Baseline,
  type P2Entity,
  type P2Quant,
  type P2Snapshot,
} from './protocol2.js';

const EPS = 1e-3;

function ent(id: number, x: number, y: number, over: Partial<P2Entity> = {}): P2Entity {
  return {
    id,
    kind: 'mob',
    p: { x, y },
    v: { x: 0, y: 0 },
    hp: 100,
    maxHp: 100,
    ...over,
  };
}

function world(n: number, tick: number): P2Entity[] {
  const out: P2Entity[] = [];
  for (let i = 0; i < n; i++) {
    // deterministic pseudo-walk so ticks are comparable across runs
    const x = 50 + Math.sin((tick + i) / 7) * 20;
    const y = 50 + Math.cos((tick + i) / 5) * 20;
    out.push(
      ent(i + 1, x, y, {
        kind: i % 3 === 0 ? 'player' : 'mob',
        v: { x: Math.sin((tick + i) / 3) * 4, y: Math.cos((tick + i) / 3) * 4 },
        hp: 80 + (i % 7),
        maxHp: 100,
        dir: (i % 8) * 0.78,
        level: 1 + (i % 20),
        name: i % 4 === 0 ? `mob-${i}` : undefined,
      }),
    );
  }
  return out;
}

function closeEnt(actual: P2Entity, expect: P2Entity, label: string): void {
  assert.equal(actual.id, expect.id, `${label} id`);
  assert.equal(actual.kind, expect.kind, `${label} kind`);
  assert.ok(Math.abs(actual.p.x - expect.p.x) <= 1 / 16 + EPS, `${label} p.x ${actual.p.x} vs ${expect.p.x}`);
  assert.ok(Math.abs(actual.p.y - expect.p.y) <= 1 / 16 + EPS, `${label} p.y`);
  assert.ok(Math.abs(actual.v.x - expect.v.x) <= 1 / 256 + EPS, `${label} v.x`);
  assert.ok(Math.abs(actual.v.y - expect.v.y) <= 1 / 256 + EPS, `${label} v.y`);
  assert.ok(Math.abs(actual.hp - expect.hp) <= 0.5, `${label} hp ${actual.hp} vs ${expect.hp}`);
  assert.ok(Math.abs(actual.maxHp - expect.maxHp) <= 0.5, `${label} maxHp`);
  if (expect.dir !== undefined) {
    assert.ok(Math.abs((actual.dir ?? 0) - expect.dir) <= 1 / 1024 + EPS, `${label} dir`);
  }
  assert.equal(actual.level, expect.level, `${label} level`);
  assert.equal(actual.name, expect.name, `${label} name`);
}

function flipFirstByte(b: Uint8Array): Uint8Array {
  const c = b.slice();
  c[0] = (c[0]! + 1) & 0xff;
  return c;
}

describe('varint / zigzag / float32 primitives', () => {
  it('round-trips the full non-negative integer range', () => {
    const values = [0, 1, 2, 126, 127, 128, 129, 255, 16383, 16384, 0xffffff, 0xffffffff, 0x100000000, 2 ** 53 - 1];
    for (const v of values) {
      const w = new P2Writer();
      w.varint(v);
      assert.equal(w.length, varintSize(v), `varintSize(${v})`);
      const r = new P2Reader(w.toBytes());
      assert.equal(r.varint(), v, `varint ${v}`);
      assert.equal(r.remaining, 0);
    }
  });

  it('varintSize agrees with encoded length for powers of two', () => {
    for (let i = 0; i < 53; i++) {
      const v = 2 ** i;
      const w = new P2Writer();
      w.varint(v);
      assert.equal(w.length, varintSize(v), `2^${i}`);
      assert.equal(new P2Reader(w.toBytes()).varint(), v);
    }
  });

  it('zigzag is a lossless signed mapping', () => {
    for (const n of [0, -1, 1, -2, 2, -64, 63, 127, -128, 4095, -4096, 1e6, -1e6]) {
      assert.equal(unzigzag(zigzag(n)), n, `zigzag ${n}`);
      assert.ok(zigzag(n) >= 0);
    }
    const w = new P2Writer();
    for (const n of [-5, 0, 5, -1000, 1000]) w.svarint(n);
    const r = new P2Reader(w.toBytes());
    assert.deepEqual([-5, 0, 5, -1000, 1000].map(() => r.svarint()), [-5, 0, 5, -1000, 1000]);
  });

  it('float32 keeps ~7 significant digits and rejects non-finite on read', () => {
    const w = new P2Writer();
    w.f32(12.3456789);
    w.f32(-0.0009765625);
    assert.ok(Math.abs(new P2Reader(w.toBytes()).f32() - 12.3456789) < 1e-5);
    const r = new P2Reader(w.toBytes());
    r.f32();
    assert.equal(r.f32(), -0.0009765625);
    const nan = new P2Writer();
    nan.f32(Number.NaN);
    assert.throws(() => new P2Reader(nan.toBytes()).f32(), /non-finite/);
  });

  it('rejects out-of-domain writes and truncated reads', () => {
    const w = new P2Writer();
    assert.throws(() => w.varint(-1), /non-negative integer/);
    assert.throws(() => w.varint(1.5), /non-negative integer/);
    assert.throws(() => w.varint(Number.NaN), /non-negative integer/);
    assert.throws(() => new P2Reader(new Uint8Array([0x80, 0x80])).varint(), /truncated varint/);
    assert.throws(() => new P2Reader(new Uint8Array(12).fill(0x80)).varint(), /too long/);
    assert.throws(() => new P2Reader(new Uint8Array(10).fill(0xff)).varint(), /exceeds 2\^53/);
    assert.throws(() => new P2Reader(new Uint8Array([])).bytes(4), /truncated payload/);
  });
});

describe('string table', () => {
  it('index 0 is the implicit empty string and repeats are free', () => {
    const st = new P2StringTableWriter();
    assert.equal(st.index(undefined), 0);
    assert.equal(st.index(''), 0);
    assert.equal(st.index('mob-7'), 1);
    assert.equal(st.index('mob-7'), 1);
    assert.equal(st.index('boss'), 2);
    assert.equal(st.count, 3);

    const w = new P2Writer();
    st.write(w);
    const bytes = w.toBytes();
    const r = new P2Reader(bytes);
    const extra = r.varint();
    assert.equal(extra, 2);
    const len1 = r.varint();
    assert.equal(new TextDecoder().decode(r.bytes(len1)), 'mob-7');
    const len2 = r.varint();
    assert.equal(new TextDecoder().decode(r.bytes(len2)), 'boss');
    assert.equal(r.remaining, 0);
  });

  it('refuses oversized strings at encode time', () => {
    const st = new P2StringTableWriter();
    st.index('x'.repeat(600));
    assert.throws(() => st.write(new P2Writer()), /string longer than/);
  });
});

describe('P2Welcome round-trip', () => {
  it('preserves every field, including all optionals', () => {
    const msg = {
      t: 'welcome' as const,
      proto: 2 as const,
      id: 4242,
      tick: 1234,
      name: 'ünïcodé-hero',
      snapshot: [
        ent(1, 1.5, -2.25, { kind: 'player', name: 'ünïcodé-hero', level: 7, dir: 3.14, hp: 42, maxHp: 55 }),
        ent(2, 100, 100, { kind: 'pickup' }),
        ent(3, -0.0625, 0.0625, { kind: 'projectile', v: { x: -8, y: 8 }, seq: 999 }),
      ],
    };
    const out = decodeWelcomeBinary(encodeWelcomeBinary(msg));
    assert.equal(out.t, 'welcome');
    assert.equal(out.proto, PROTO2_VERSION);
    assert.equal(out.id, 4242);
    assert.equal(out.tick, 1234);
    assert.equal(out.name, 'ünïcodé-hero');
    assert.equal(out.snapshot.length, 3);
    msg.snapshot.forEach((e, i) => closeEnt(out.snapshot[i]!, e, `welcome[${i}]`));
    assert.equal(out.snapshot[1]!.name, undefined);
    assert.equal(out.snapshot[1]!.level, undefined);
  });

  it('re-encodes to identical bytes', () => {
    const msg = { t: 'welcome' as const, proto: 2 as const, id: 1, tick: 7, name: 'a', snapshot: world(6, 7) };
    const once = encodeWelcomeBinary(msg);
    assert.deepEqual(Array.from(encodeWelcomeBinary(decodeWelcomeBinary(once))), Array.from(once));
  });

  it('is byte-identical to a v1-compatible entity shape', () => {
    // P2Entity must slot into v1 client code untouched.
    const v1: EntitySnapshot = { id: 3, kind: 'npc', p: { x: 1, y: 2 }, v: { x: 0, y: 0 }, hp: 5, maxHp: 5 };
    const asV1: EntitySnapshot = toEntitySnapshot(toP2Entity(v1));
    assert.deepEqual(asV1, v1);
  });
});

describe('P2Snapshot delta correctness', () => {
  it('applies a 120-tick delta stream to the exact same state', () => {
    const ticks = 120;
    const full: P2Entity[][] = [];
    for (let t = 0; t < ticks; t++) full.push(world(12, t));

    // tick 0 goes out as a welcome (keyframe baseline)
    let clientBaseline = baselineFromEntities(full[0]!);
    let clientBaseTick = 0;
    let serverBaseline = new Map(clientBaseline);

    const applied0 = applySnapshot(
      { t: 'snapshot', tick: 0, baseTick: 0, keyframe: true, entities: full[0]!, removed: [] },
      new Map(),
      -1,
    );
    assert.equal(applied0.ok, true);

    for (let t = 1; t < ticks; t++) {
      const keyframe = isKeyframeSeq(t, P2_KEYFRAME_INTERVAL);
      const { updates, next, needsKeyframe } = diffSnapshot(serverBaseline, full[t]!);
      assert.equal(needsKeyframe, false);
      const wire: P2Snapshot = { t: 'snapshot', tick: t, baseTick: keyframe ? 0 : t - 1, keyframe, entities: keyframe ? full[t]! : updates, removed: [] };
      const bytes = encodeSnapshotBinary(wire, serverBaseline);
      const decoded = decodeSnapshotBinary(bytes, serverBaseline);
      // wire -> wire must be byte-stable
      assert.deepEqual(Array.from(encodeSnapshotBinary(decoded, serverBaseline)), Array.from(bytes));
      const applied = applySnapshot(decoded, clientBaseline, clientBaseTick);
      assert.equal(applied.ok, true, `tick ${t} should apply`);
      if (!applied.ok) continue;
      assert.equal(applied.entities.size, full[t]!.length, `tick ${t} entity count`);
      for (const e of full[t]!) closeEnt(applied.entities.get(e.id)!, e, `tick ${t} #${e.id}`);
      clientBaseline = applied.baseline;
      clientBaseTick = applied.baseTick;
      serverBaseline = next;
    }
  });

  it('drops no-op deltas and reports removals', () => {
    const base = world(4, 1);
    const first = diffSnapshot(new Map(), base);
    assert.equal(first.updates.length, 4);
    const still = diffSnapshot(first.next, base);
    assert.equal(still.updates.length, 0, 'identical state must produce zero records');
    assert.equal(still.next.size, 4, 'baseline still tracks every entity');

    // one entity moves, one leaves interest
    const next = base.slice(0, 3).map((e, i) => (i === 0 ? { ...e, p: { x: e.p.x + 1, y: e.p.y } } : e));
    const removed = [base[3]!.id];
    const d = diffSnapshot(first.next, next);
    assert.deepEqual(d.updates.map((u) => u.id), [1]);
    assert.equal(d.updates[0]!.p !== undefined, true);

    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: d.updates, removed }, first.next);
    const applied = applySnapshot(decodeSnapshotBinary(bytes, first.next), first.next, 1);
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.entities.size, 3);
      assert.equal(applied.entities.has(4), false);
      assert.deepEqual(applied.removed, [4]);
    }
  });

  it('flags a keyframe when a delta cannot express a cleared field', () => {
    const a = baselineFromEntities([ent(1, 5, 5, { name: 'boss', dir: 1 })]);
    const d = diffSnapshot(a, [ent(1, 5, 5)]);
    assert.equal(d.needsKeyframe, true);
  });

  it('refuses a delta whose baseline tick does not match', () => {
    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 9, baseTick: 8, keyframe: false, entities: [], removed: [] });
    const msg = decodeSnapshotBinary(bytes, new Map());
    assert.equal(needsKeyframe(msg, 3), true);
    const applied = applySnapshot(msg, new Map(), 3);
    assert.equal(applied.ok, false);
    if (!applied.ok) assert.equal(applied.reason, 'need-keyframe');
  });

  it('writes a full record for an id the receiver has never seen', () => {
    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 4, baseTick: 3, keyframe: false, entities: [ent(77, 2, 3)], removed: [] });
    const applied = applySnapshot(decodeSnapshotBinary(bytes, new Map()), new Map(), 3);
    assert.equal(applied.ok, true);
    if (applied.ok) closeEnt(applied.entities.get(77)!, ent(77, 2, 3), 'respawned');
  });

  it('clears a name with the empty-string index', () => {
    const base = baselineFromEntities([ent(1, 1, 1, { name: 'named' })]);
    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [{ id: 1, name: '' }], removed: [] }, base);
    const msg = decodeSnapshotBinary(bytes, base);
    assert.equal(msg.entities[0]!.name, '');
    const applied = applySnapshot(msg, base, 1);
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.entities.get(1)!.name, 'named', 'empty name keeps the baseline name (deltas cannot clear)');
  });

  it('a keyframe every 50 snapshots bounds re-sync cost', () => {
    let keyframes = 0;
    for (let t = 0; t < 500; t++) if (isKeyframeSeq(t, P2_KEYFRAME_INTERVAL)) keyframes++;
    assert.equal(keyframes, 10);
    assert.equal(isKeyframeSeq(0), true);
    assert.equal(isKeyframeSeq(49), false);
    assert.equal(isKeyframeSeq(50), true);
    assert.equal(isKeyframeSeq(3, 1), true);
  });

  it('deltas are dramatically smaller than keyframes for the same state', () => {
    const k = encodeSnapshotBinary({ t: 'snapshot', tick: 100, baseTick: 0, keyframe: true, entities: world(40, 100), removed: [] });
    const a = baselineFromEntities(world(40, 99));
    const b = world(40, 100);
    const d = diffSnapshot(a, b);
    const delta = encodeSnapshotBinary({ t: 'snapshot', tick: 100, baseTick: 99, keyframe: false, entities: d.updates, removed: [] }, a);
    assert.ok(delta.length < k.length / 2, `delta=${delta.length} keyframe=${k.length}`);
  });
});

describe('P2Input round-trip', () => {
  it('preserves all optional fields', () => {
    const msg = {
      t: 'input' as const,
      input: { seq: 987654, dt: 1 / 20, move: { x: -0.5234375, y: 0.99609375 }, attack: true, skill: 3, targetId: 512, chat: 'héllo 🎉' },
    };
    const out = decodeInputBinary(encodeInputBinary(msg));
    assert.equal(out.t, 'input');
    assert.equal(out.input.seq, 987654);
    assert.ok(Math.abs(out.input.dt - 0.05) < 1e-6);
    assert.ok(Math.abs(out.input.move.x + 0.5234375) < 1e-6);
    assert.ok(Math.abs(out.input.move.y - 0.99609375) < 1e-6);
    assert.equal(out.input.attack, true);
    assert.equal(out.input.skill, 3);
    assert.equal(out.input.targetId, 512);
    assert.equal(out.input.chat, 'héllo 🎉');
  });

  it('omits absent optionals and keeps re-encode byte-stable', () => {
    const msg = { t: 'input' as const, input: { seq: 1, dt: 0.05, move: { x: 0, y: 0 } } };
    const once = encodeInputBinary(msg);
    const out = decodeInputBinary(once);
    assert.deepEqual(out, msg);
    assert.deepEqual(Array.from(encodeInputBinary(out)), Array.from(once));
  });

  it('is byte-stable with an empty-string chat', () => {
    const msg = { t: 'input' as const, input: { seq: 2, dt: 0.05, move: { x: 1, y: -1 }, chat: '' } };
    const out = decodeInputBinary(encodeInputBinary(msg));
    assert.equal(out.input.chat, '');
  });

  it('refuses impossible inputs at encode time', () => {
    const base = { t: 'input' as const, input: { seq: 1, dt: 0.05, move: { x: 0, y: 0 } } };
    assert.throws(() => encodeInputBinary({ t: 'input', input: { ...base.input, seq: 0 } }), /seq/);
    assert.throws(() => encodeInputBinary({ t: 'input', input: { ...base.input, dt: 0 } }), /dt/);
    assert.throws(() => encodeInputBinary({ t: 'input', input: { ...base.input, chat: 'x'.repeat(600) } }), /too long/);
    assert.throws(() => encodeInputBinary({ t: 'input', input: { ...base.input, skill: 1.5 } }), /integer/);
  });
});

describe('P2Ack / chat / event / hello round-trips', () => {
  it('ack keeps tick, baseline and last seq', () => {
    const msg = { t: 'ack' as const, tick: 900, baseTick: 850, lastInputSeq: 4242, rttMs: 37 };
    assert.deepEqual(decodeAckBinary(encodeAckBinary(msg)), msg);
    const bare = { t: 'ack' as const, tick: 9, baseTick: 9, lastInputSeq: 1 };
    assert.deepEqual(decodeAckBinary(encodeAckBinary(bare)), bare);
  });

  it('chat keeps from/text/channel for every channel', () => {
    for (const channel of ['global', 'say', 'guild'] as const) {
      const msg = { t: 'chat' as const, from: 'Elder Maren', text: 'welcome, traveller', channel };
      assert.deepEqual(decodeChatBinary(encodeChatBinary(msg)), msg);
    }
    assert.throws(() => encodeChatBinary({ t: 'chat', from: 'a', text: 'b', channel: 'nope' as never }), /channel/);
  });

  it('event keeps kind + JSON payload text', () => {
    const msg = { t: 'event' as const, kind: 'telegraph', payload: JSON.stringify({ shape: 'circle', x: 1, y: 2, r: 3 }) };
    const out = decodeEventBinary(encodeEventBinary(msg));
    assert.deepEqual(out, msg);
    assert.deepEqual(JSON.parse(out.payload), JSON.parse(msg.payload));
  });

  it('hello carries the proto-2 capability set', () => {
    const msg = {
      t: 'hello' as const,
      proto: 2 as const,
      name: 'probe',
      token: 'tok',
      caps: { binary: true as const, deltas: true, keyframe: 50, chat: true, event: true },
    };
    assert.deepEqual(decodeHelloBinary(encodeHelloBinary(msg)), msg);
    const noCaps = { t: 'hello' as const, proto: 2 as const, name: 'probe', caps: { ...msg.caps, deltas: false, chat: false, event: false, keyframe: 200 } };
    assert.deepEqual(decodeHelloBinary(encodeHelloBinary(noCaps)), noCaps);
    assert.throws(() => encodeHelloBinary({ ...msg, proto: 1 as never }), /proto 2/);
    assert.throws(() => encodeHelloBinary({ ...msg, caps: { ...msg.caps, binary: false as never } }), /caps.binary/);
  });
});

describe('P2SnapshotStream', () => {
  it('keyframes on schedule and deltas in between', () => {
    const stream = new P2SnapshotStream(5);
    const flags: number[] = [];
    for (let t = 1; t <= 12; t++) flags.push(stream.encode(world(6, t), [], t)[3]! & 1);
    assert.deepEqual(flags, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    assert.equal(stream.seq, 12);
    assert.equal(stream.baseTick, 12);
  });

  it('seed() adopts a welcome state so the next frame is a delta', () => {
    const stream = new P2SnapshotStream(50);
    stream.seed(world(4, 7), 7);
    assert.equal(stream.seq, 1);
    assert.equal(stream.baseTick, 7);
    const bytes = stream.encode(world(4, 8), [], 8);
    assert.equal(bytes[3]! & 1, 0, 'no redundant keyframe right after a welcome');
    assert.deepEqual(decodeSnapshotBinary(bytes, stream.current).baseTick, 7);
  });

  it('clamps a bogus keyframe interval instead of dividing by zero', () => {
    assert.equal(new P2SnapshotStream(0).keyframeEvery, 1);
    assert.equal(new P2SnapshotStream(-5).keyframeEvery, 1);
    assert.equal(new P2SnapshotStream(9999).keyframeEvery, 255);
    assert.equal(new P2SnapshotStream(1.9).keyframeEvery, 1);
    assert.equal(new P2SnapshotStream().keyframeEvery, P2_KEYFRAME_INTERVAL);
  });

  it('drives a receiver baseline through the whole stream', () => {
    const stream = new P2SnapshotStream(4);
    let baseline = new Map<number, ReturnType<typeof baselineFromEntities> extends Map<number, infer V> ? V : never>();
    let baseTick = -1;
    for (let t = 0; t < 12; t++) {
      const bytes = stream.encode(world(8, t), [], t);
      const decoded = decodeSnapshotBinary(bytes, baseline);
      const applied = applySnapshot(decoded, baseline, baseTick);
      assert.equal(applied.ok, true, `tick ${t}`);
      if (!applied.ok) continue;
      baseline = applied.baseline as typeof baseline;
      baseTick = applied.baseTick;
      assert.equal(applied.entities.size, 8);
      for (const e of world(8, t)) {
        const got = applied.entities.get(e.id)!;
        assert.ok(Math.abs(got.p.x - e.p.x) <= 1 / 16 + EPS, `t${t} #${e.id}`);
      }
    }
    stream.reset();
    assert.equal(stream.seq, 0);
    assert.equal(stream.baseTick, 0);
    assert.equal(stream.current.size, 0);
  });

  it('reset() forces a keyframe on the next frame', () => {
    const stream = new P2SnapshotStream(50);
    stream.encode(world(4, 1), [], 1);
    assert.equal(stream.encode(world(4, 2), [], 2)[3]! & 1, 0);
    stream.reset();
    assert.equal(stream.encode(world(4, 3), [], 3)[3]! & 1, 1);
  });
});

describe('encodeSnapshotAgainst', () => {
  it('promotes to a keyframe when a field is cleared', () => {
    const first = encodeSnapshotAgainst([ent(1, 1, 1, { name: 'boss', level: 3 })], [], 1, new Map(), { keyframe: true });
    const second = encodeSnapshotAgainst([ent(1, 1, 1)], [], 2, first.baseline, { keyframe: false });
    assert.equal(second.keyframe, true);
    assert.equal(second.baseTick, 0);
  });

  it('drops removed ids from the returned baseline and stays pure', () => {
    const first = encodeSnapshotAgainst(world(5, 1), [], 1, new Map(), { keyframe: true });
    assert.equal(first.baseline.size, 5);
    const second = encodeSnapshotAgainst(world(5, 2), [2, 3], 2, first.baseline, { keyframe: false });
    assert.equal(second.baseline.size, 3);
    assert.equal(second.baseline.has(2), false);
    assert.equal(first.baseline.size, 5, 'input baseline untouched');
  });

  it('rejects a baseTick after the frame tick', () => {
    assert.throws(() => encodeSnapshotAgainst([], [], 5, new Map(), { keyframe: false, baseTick: 6 }), /baseTick/);
  });

  it('defaults the baseline tick to the previous tick', () => {
    const first = encodeSnapshotAgainst(world(3, 10), [], 10, new Map(), { keyframe: true });
    const second = encodeSnapshotAgainst(world(3, 11), [], 11, first.baseline, { keyframe: false });
    assert.equal(second.baseTick, 10);
  });
});

describe('negotiation', () => {
  it('accepts a proto-2 JSON hello that advertises the binary capability', () => {
    const hello = { t: 'hello', name: 'x', proto: 2, caps: { binary: true, deltas: true, keyframe: 50, chat: true, event: true } };
    assert.deepEqual(negotiateProto(hello), { proto: 2, reason: 'accepted' });
    assert.equal(resolveKeyframeEvery(hello), 50);
    assert.equal(resolveKeyframeEvery({ ...hello, caps: { ...hello.caps, keyframe: 7 } }), 7);
    assert.equal(resolveKeyframeEvery({ ...hello, caps: { ...hello.caps, keyframe: 9999 } }), P2_KEYFRAME_INTERVAL);
    assert.equal(resolveKeyframeEvery({ ...hello, caps: { ...hello.caps, keyframe: 1.5 } }), P2_KEYFRAME_INTERVAL);
  });

  it('falls back to v1 for every non-2 / non-binary hello', () => {
    const cases: Array<[unknown, string]> = [
      [{ t: 'hello', name: 'x', proto: 1 }, 'older-proto'],
      [{ t: 'hello', name: 'x', proto: 3 }, 'future-proto'],
      [{ t: 'hello', name: 'x', proto: 2 }, 'no-caps'],
      [{ t: 'hello', name: 'x', proto: 2, caps: {} }, 'no-binary-capability'],
      [{ t: 'hello', name: 'x', proto: 2, caps: null }, 'no-caps'],
      [{ t: 'hello', name: 'x', proto: 2.5 }, 'bad-proto'],
      [{ t: 'hello', name: 'x', proto: '2' }, 'bad-proto'],
      [{ t: 'input' }, 'not-a-hello'],
      [null, 'not-a-hello'],
      [[], 'not-a-hello'],
      ['hello', 'not-a-hello'],
    ];
    for (const [hello, reason] of cases) {
      assert.deepEqual(negotiateProto(hello), { proto: 1, reason }, JSON.stringify(hello));
    }
  });

  it('falls back to v1 when the server switch is off', () => {
    const hello = { t: 'hello', name: 'x', proto: 2, caps: { binary: true, deltas: true, keyframe: 50 } };
    assert.deepEqual(negotiateProto(hello, { enabled: false }), { proto: 1, reason: 'server-disabled' });
  });

  it('also negotiates from a decoded binary hello', () => {
    const hello = decodeHelloBinary(
      encodeHelloBinary({ t: 'hello', proto: 2, name: 'n', caps: { binary: true, deltas: true, keyframe: 10, chat: true, event: true } }),
    );
    assert.equal(negotiateProto(hello).proto, 2);
  });
});

describe('malformed input rejection', () => {
  const goodWelcome = () => encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 1, name: 'a', snapshot: world(3, 1) });
  const goodSnapshot = () => encodeSnapshotBinary({ t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [ent(1, 3, 4)], removed: [9] });
  const goodInput = () => encodeInputBinary({ t: 'input', input: { seq: 5, dt: 0.05, move: { x: 0.5, y: 0.5 }, attack: true } });
  const goodAck = () => encodeAckBinary({ t: 'ack', tick: 5, baseTick: 4, lastInputSeq: 3, rttMs: 12 });
  const goodChat = () => encodeChatBinary({ t: 'chat', from: 'a', text: 'b', channel: 'say' });
  const goodEvent = () => encodeEventBinary({ t: 'event', kind: 'k', payload: '{}' });
  const goodHello = () => encodeHelloBinary({ t: 'hello', proto: 2, name: 'n', caps: { binary: true, deltas: true, keyframe: 50, chat: true, event: true } });

  it('rejects the container layer', () => {
    assert.throws(() => decodeFrame(new Uint8Array([1, 2, 3])), /too short/);
    assert.throws(() => decodeFrame(flipFirstByte(goodWelcome())), /bad magic/);
    assert.throws(() => decodeFrame('not bytes' as never), /Uint8Array/);

    const badVersion = goodWelcome().slice();
    badVersion[1] = 1;
    assert.throws(() => decodeFrame(badVersion), /unsupported version/);

    const badLen = goodWelcome().slice();
    badLen[4] = badLen[4]! + 3;
    assert.throws(() => decodeFrame(badLen), /does not match payload/);

    const truncated = goodWelcome().slice(0, goodWelcome().length - 3);
    assert.throws(() => decodeFrame(truncated), /does not match payload/);

    const huge = goodWelcome().slice();
    huge[4] = 0xff;
    huge[5] = 0xff;
    huge[6] = 0xff;
    huge[7] = 0x7f;
    assert.throws(() => decodeFrame(huge), /too large/);
  });

  it('rejects cross-type confusion', () => {
    assert.throws(() => decodeSnapshotBinary(goodWelcome()), /expected msg type/);
    assert.throws(() => decodeWelcomeBinary(goodSnapshot()), /expected msg type/);
    assert.throws(() => decodeInputBinary(goodWelcome()), /expected msg type/);
    assert.throws(() => decodeAckBinary(goodSnapshot()), /expected msg type/);
    assert.throws(() => decodeChatBinary(goodAck()), /expected msg type/);
    assert.throws(() => decodeEventBinary(goodChat()), /expected msg type/);
    assert.throws(() => decodeHelloBinary(goodEvent()), /expected msg type/);
  });

  it('rejects corrupted bodies', () => {
    // flip a byte in the middle of the frame: must never throw anything but P2DecodeError
    let rejected = 0;
    for (const frame of [goodWelcome(), goodSnapshot(), goodInput(), goodAck(), goodChat(), goodEvent(), goodHello()]) {
      for (let i = 5; i < frame.length; i++) {
        const bad = frame.slice();
        bad[i] = (bad[i]! + 0x5a) & 0xff;
        const res = safeDecodeServerFrame(bad);
        if (!res.ok) {
          rejected++;
          assert.match(res.error, /^protocol2: /, `frame byte ${i}: ${res.error}`);
        }
      }
    }
    assert.ok(rejected > 20, `expected broad rejection, got ${rejected}`);
  });

  it('rejects structural nonsense in specific fields', () => {
    // ack frame layout: [4]=payloadLen [5]=tableCount(0) [6]=bodyLen [7..]=body
    const ack = goodAck();
    assert.equal(ack[5], 0, 'ack has an empty string table');
    const shortBody = ack.slice();
    shortBody[6] = ack[6]! - 1;
    assert.throws(() => decodeAckBinary(shortBody), /body length does not match/);
    const longBody = ack.slice();
    longBody[6] = ack[6]! + 1;
    assert.throws(() => decodeAckBinary(longBody), /body length does not match/);

    // chat frame layout: [5]=tableCount(2) [6]=len [7]='a' [8]=len [9]='b' [10]=bodyLen
    const chat = goodChat();
    const badUtf8 = chat.slice();
    badUtf8[9] = 0xff;
    assert.throws(() => decodeChatBinary(badUtf8), /invalid utf-8/);
    const badChannel = chat.slice();
    badChannel[11] = 9;
    assert.throws(() => decodeChatBinary(badChannel), /unknown channel code/);
    const badStrIdx = chat.slice();
    badStrIdx[13] = 40; // text index far past the 3-entry table
    assert.throws(() => decodeChatBinary(badStrIdx), /bad string index/);

    // input frame layout: [5]=tableCount(0) [6]=bodyLen [7]=flags ...
    const input = goodInput();
    const badFlags = input.slice();
    badFlags[7] = 0x40;
    assert.throws(() => decodeInputBinary(badFlags), /unknown input flag bits/);
    const badSeq = input.slice();
    badSeq[8] = 0; // seq 0 is illegal
    assert.throws(() => decodeInputBinary(badSeq), /seq must be > 0/);

    // welcome frame layout: [4]=payloadLen [6]=tableCount [7]=len [8]='a' [9]=bodyLen
    const welcome = goodWelcome();
    const head = new P2Reader(welcome, 4);
    head.varint();
    assert.equal(head.varint(), 2, 'welcome interns the player name + one entity name');
    assert.ok(welcome.length > head.pos, 'welcome carries a body');
  });

  it('interns repeated names once per frame', () => {
    const tableCount = (bytes: Uint8Array): number => {
      const r = new P2Reader(bytes, 4);
      r.varint(); // payload length (1 or 2 bytes depending on frame size)
      return r.varint();
    };
    const many = Array.from({ length: 40 }, (_, i) => ent(i + 1, i, i, { name: 'same-mob' }));
    const frame = encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 1, name: 'same-mob', snapshot: many });
    const wide = encodeWelcomeBinary({
      t: 'welcome',
      proto: 2,
      id: 1,
      tick: 1,
      name: 'same-mob',
      snapshot: Array.from({ length: 5 }, (_, i) => ent(i + 1, i, i, { name: `mob-${i}` })),
    });
    assert.equal(tableCount(frame), 1, 'player name doubles as the entity name: one table entry');
    assert.equal(tableCount(wide), 6, 'player name is entry 1, then five distinct mob names');
    assert.ok(frame.length - wide.length > 40 * 4, '40 duplicate names cost less than 5 distinct ones');
  });

  it('rejects impossible encode-time values', () => {
    assert.throws(() => encodeSnapshotBinary({ t: 'snapshot', tick: 5, baseTick: 3, keyframe: true, entities: [], removed: [] }), /baseTick 0/);
    assert.throws(() => encodeSnapshotBinary({ t: 'snapshot', tick: 5, baseTick: 9, keyframe: false, entities: [], removed: [] }), /baseTick/);
    assert.throws(() => encodeSnapshotBinary({ t: 'snapshot', tick: 1.5, baseTick: 0, keyframe: true, entities: [], removed: [] }), /tick/);
    assert.throws(() => encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [ent(-1, 0, 0)], removed: [] }), /id/);
    assert.throws(
      () => encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [ent(1, 0, 0, { kind: 'dragon' as never })], removed: [] }),
      /kind/,
    );
    assert.throws(
      () => encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: new Array(9000).fill(ent(1, 0, 0)), removed: [] }),
      /too many entities/,
    );
    assert.throws(() => encodeAckBinary({ t: 'ack', tick: 1, baseTick: 2, lastInputSeq: 1 }), /baseTick/);
    assert.throws(() => encodeAckBinary({ t: 'ack', tick: -1, baseTick: 0, lastInputSeq: 1 }), /tick/);
    assert.throws(() => encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 1, tick: 1, name: 'a', snapshot: [ent(1, Number.NaN, 0)] }), /finite/);
    assert.throws(() => encodeInputBinary({ t: 'input', input: { seq: 1, dt: 0.05, move: { x: Number.NaN, y: 0 } } }), /finite/);
    assert.throws(() => quantizeEntity(ent(1, 0, 0, { level: Number.POSITIVE_INFINITY })), /finite/);
  });

  it('clamps quantized magnitudes instead of wrapping', () => {
    const huge = ent(1, 1e12, -1e12, { v: { x: 1e9, y: -1e9 }, dir: 1e6, hp: 1e9, maxHp: -5 });
    const qn = quantizeEntity(huge);
    assert.equal(qn.hp, 65535);
    assert.equal(qn.maxHp, 0);
    assert.ok(Math.abs(qn.qx) > 0);
    const back = dequantizeEntity(qn);
    assert.ok(Number.isFinite(back.p.x) && Number.isFinite(back.v.x));
  });

  it('rejects apply() of a delta that is missing required fields', () => {
    const msg: P2Snapshot = { t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [{ id: 42 }], removed: [] };
    assert.throws(() => applySnapshot(msg, new Map(), 1), /incomplete/);
  });

  it('safeDecode wrappers never throw and always explain themselves', () => {
    for (const [name, fn] of [
      ['server', () => safeDecodeServerFrame(goodWelcome())],
      ['server-bad', () => safeDecodeServerFrame(flipFirstByte(goodWelcome()))],
      ['client', () => safeDecodeClientFrame(goodInput())],
      ['client-hello', () => safeDecodeClientFrame(goodHello())],
      ['client-wrong-direction', () => safeDecodeClientFrame(goodWelcome())],
      ['empty', () => safeDecodeClientFrame(new Uint8Array())],
    ] as Array<[string, () => { ok: boolean; error?: string }]>) {
      const res = fn();
      assert.equal(typeof res.ok, 'boolean', name);
      if (!res.ok) assert.ok(res.error && res.error.length > 0, name);
    }
    assert.equal(safeDecodeServerFrame(goodWelcome()).ok, true);
    assert.equal(safeDecodeClientFrame(goodWelcome()).ok, false, 'server frame as client frame');
    assert.equal(safeDecodeServerFrame(goodAck()).ok, true);
    assert.equal(safeDecodeClientFrame(goodHello()).ok, true);
    assert.equal(safeDecodeServerFrame(goodInput()).ok, false, 'client frame as server frame');
  });

  it('dispatches every frame type by code', () => {
    assert.equal(decodeServerFrame(goodWelcome()).t, 'welcome');
    assert.equal(decodeServerFrame(goodSnapshot(), new Map()).t, 'snapshot');
    assert.equal(decodeServerFrame(goodAck()).t, 'ack');
    assert.equal(decodeServerFrame(goodChat()).t, 'chat');
    assert.equal(decodeServerFrame(goodEvent()).t, 'event');
    assert.equal(decodeClientFrame(goodInput()).t, 'input');
    assert.equal(decodeClientFrame(goodHello()).t, 'hello');
    const unknownType = goodWelcome().slice();
    unknownType[2] = 99;
    assert.throws(() => decodeServerFrame(unknownType), /unknown server msg type/);
    assert.throws(() => decodeClientFrame(unknownType), /unknown client msg type/);
  });

  it('exposes stable frame constants', () => {
    assert.equal(P2_MAGIC, 0xaf);
    assert.equal(PROTO2_VERSION, 2);
    assert.equal(P2_KEYFRAME_INTERVAL, 50);
    assert.equal(P2Type.Snapshot, 2);
    assert.throws(() => {
      throw new P2DecodeError('x');
    }, /protocol2: x/);
  });
});
/* ------------------------------------------------------------------ *
 * P2ViewStream � serialize-once per-viewer encoder
 * ------------------------------------------------------------------ */

describe('P2ViewStream (serialize-once)', () => {
  /** Same content, two shapes: v1 snapshots and the v2 entities they map to. */
  function tickWorld(n: number, tick: number): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (let i = 0; i < n; i++) {
      out.push(
        ent(i + 1, 50 + Math.sin((tick + i) / 7) * 20, 50 + Math.cos((tick + i) / 5) * 20, {
          kind: i % 3 === 0 ? 'player' : 'mob',
          v: { x: Math.sin((tick + i) / 3) * 4, y: Math.cos((tick + i) / 3) * 4 },
          hp: 80 + ((tick + i) % 7),
          maxHp: 100,
          dir: (i % 8) * 0.78,
          level: 1 + (i % 20),
          name: i % 4 === 0 ? `mob-${i}` : undefined,
          seq: i % 3 === 0 ? tick : undefined,
        }),
      );
    }
    return out;
  }

  it('prequantizeSnapshot matches quantizeEntity(toP2Entity(e)) exactly', () => {
    const world = tickWorld(12, 3);
    const fast = prequantizeSnapshot(world);
    assert.equal(fast.length, world.length);
    for (let i = 0; i < world.length; i++) {
      assert.deepEqual(fast[i], quantizeEntity(toP2Entity(world[i]!)), `entity ${world[i]!.id}`);
    }
  });

  it('reuses the caller array so the tick loop does not churn', () => {
    const out: P2Quant[] = [];
    prequantizeSnapshot(tickWorld(5, 1), out);
    prequantizeSnapshot(tickWorld(3, 2), out);
    assert.equal(out.length, 3);
  });

  it('is byte-identical to P2SnapshotStream for every viewer of a 60-tick stream', () => {
    const N = 40;
    const keyframeEvery = 7;
    // Three viewers with different (overlapping) interest sets + removals.
    const viewers = [
      { idx: Array.from({ length: N }, (_, i) => i), stream: new P2SnapshotStream(keyframeEvery), view: new P2ViewStream(keyframeEvery) },
      { idx: Array.from({ length: N }, (_, i) => (i * 3) % N).filter((v, i, a) => a.indexOf(v) === i), stream: new P2SnapshotStream(keyframeEvery), view: new P2ViewStream(keyframeEvery) },
      { idx: [0, 1, N - 1, 7], stream: new P2SnapshotStream(keyframeEvery), view: new P2ViewStream(keyframeEvery) },
    ];
    const ref = new P2ViewStream(keyframeEvery); // unused parity guard below
    assert.equal(ref.seq, 0);

    for (let tick = 1; tick <= 60; tick++) {
      const world = tickWorld(N, tick);
      const quant = prequantizeSnapshot(world);
      // viewer 0 loses entity 5 at tick 30, viewer 2 loses everything at 45
      const removedFor = (vi: number): number[] => {
        if (vi === 0 && tick === 30) return [5];
        if (vi === 2 && tick === 45) return viewers[2]!.idx.slice();
        return [];
      };
      for (let vi = 0; vi < viewers.length; vi++) {
        const v = viewers[vi]!;
        const removed = removedFor(vi);
        const idx = v.idx.filter((i) => !removed.includes(i + 1));
        const subset = idx.map((i) => toP2Entity(world[i]!));
        const expected = v.stream.encode(subset, removed, tick * 2);
        const got = v.view.encodeView(quant, idx, removed, tick * 2);
        assert.deepEqual(
          Array.from(got),
          Array.from(expected),
          `viewer ${vi} tick ${tick}: ${got.length}B fast vs ${expected.length}B reference`,
        );
        assert.equal(v.view.seq, v.stream.seq, `seq parity at tick ${tick}`);
        assert.equal(v.view.baseTick, v.stream.baseTick, `baseTick parity at tick ${tick}`);
      }
    }
  });

  it('keeps the keyframe schedule and promotes on a cleared field', () => {
    const quantA = prequantizeSnapshot([ent(1, 1, 1, { name: 'boss' }), ent(2, 2, 2)]);
    const ref = new P2SnapshotStream(50);
    const view = new P2ViewStream(50);
    // seed both the way a welcome does, so the first snapshot is a delta
    ref.seed(quantA.map(dequantizeEntity), 4);
    view.seedQuants(quantA, 4);
    assert.equal(view.seq, 1);
    assert.equal(view.baseTick, 4);

    const moved = prequantizeSnapshot([ent(1, 1, 1, { name: 'boss' }), ent(2, 3, 2)]);
    const a = ref.encode(moved.map(dequantizeEntity), [], 6);
    const b = view.encodeView(moved, [0, 1], [], 6);
    assert.deepEqual(Array.from(b), Array.from(a));
    assert.equal(b[3]! & 1, 0, 'delta, not keyframe');

    // the name disappears: a delta cannot express that, so both promote
    const cleared = prequantizeSnapshot([ent(1, 1, 1), ent(2, 3, 2)]);
    const c = ref.encode(cleared.map(dequantizeEntity), [], 8);
    const d = view.encodeView(cleared, [0, 1], [], 8);
    assert.equal(c[3]! & 1, 1, 'reference promoted to a keyframe');
    assert.deepEqual(Array.from(d), Array.from(c));
  });

  it('decodes to the same state as the reference stream (real client baseline)', () => {
    const world = (tick: number): EntitySnapshot[] => tickWorld(15, tick);
    const stream = new P2SnapshotStream(5);
    const view = new P2ViewStream(5);
    const idx = Array.from({ length: 15 }, (_, i) => i);
    let baseline = new Map<number, never>();
    let baseTick = 0;
    let refBaseline = new Map<number, never>();
    let refBaseTick = 0;
    for (let tick = 1; tick <= 30; tick++) {
      const w = world(tick);
      const fast = view.encodeView(prequantizeSnapshot(w), idx, [], tick);
      const slow = stream.encode(w.map(toP2Entity), [], tick);
      const a = applySnapshot(decodeSnapshotBinary(fast, baseline as P2Baseline), baseline as P2Baseline, baseTick);
      const b = applySnapshot(decodeSnapshotBinary(slow, refBaseline as P2Baseline), refBaseline as P2Baseline, refBaseTick);
      assert.equal(a.ok, true, `fast tick ${tick}`);
      assert.equal(b.ok, true, `ref tick ${tick}`);
      if (!a.ok || !b.ok) return;
      assert.deepEqual(Array.from(a.entities.keys()), Array.from(b.entities.keys()));
      for (const [id, e] of a.entities) {
        const g = b.entities.get(id) as P2Entity;
        assert.ok(Math.abs(e.p.x - g.p.x) < 1e-9, `p.x ${id}`);
        assert.ok(Math.abs(e.p.y - g.p.y) < 1e-9, `p.y ${id}`);
        assert.ok(Math.abs(e.v.x - g.v.x) < 1e-9, `v.x ${id}`);
        assert.equal(e.hp, g.hp);
        assert.equal(e.maxHp, g.maxHp);
        assert.equal(e.kind, g.kind);
        assert.equal(e.name, g.name);
        assert.equal(e.level, g.level);
        assert.equal(e.dir, g.dir);
        assert.equal(e.seq, g.seq);
      }
      baseline = a.baseline as unknown as Map<number, never>;
      baseTick = a.baseTick;
      refBaseline = b.baseline as unknown as Map<number, never>;
      refBaseTick = b.baseTick;
    }
  });

  it('handles empty views, removal-only frames and ids the receiver never saw', () => {
    const view = new P2ViewStream(50);
    const quant = prequantizeSnapshot(tickWorld(4, 1));
    const first = view.encodeView(quant, [], [], 1);
    assert.deepEqual(decodeSnapshotBinary(first).entities, []);
    const removal = view.encodeView(quant, [], [1, 2], 3);
    assert.deepEqual(decodeSnapshotBinary(removal, new Map()).removed, [1, 2]);

    // ids the receiver has never seen (a shard teleport, a late interest entry):
    // a delta cannot describe them, so they ride as full records
    const stale = new P2ViewStream(50);
    stale.seedQuants(prequantizeSnapshot([ent(9, 9, 9)]), 0);
    const receiverHad = new Map(stale.current);
    const bytes = stale.encodeView(quant, [3, 0], [], 1);
    const decoded = decodeSnapshotBinary(bytes, receiverHad);
    assert.equal(decoded.keyframe, false, 'not a scheduled keyframe, but full records');
    assert.equal(decoded.entities.length, 2);
    assert.equal(decoded.entities[0]!.p!.x, quant[3]!.qx / P2_POS_SCALE);
    assert.equal(decoded.entities[0]!.id, quant[3]!.id);
    assert.equal(decoded.entities[1]!.p!.y, quant[0]!.qy / P2_POS_SCALE);
  });

  it('memoizes utf-8 names without changing the table', () => {
    const table = new P2StringTableWriter();
    table.index('alpha');
    const a = new P2Writer(64);
    table.write(a);
    const utf8 = new Map<string, Uint8Array>();
    const cached = new P2StringTableWriter(utf8);
    assert.equal(cached.index(''), 0);
    assert.equal(cached.index('alpha'), 1);
    const b = new P2Writer(64);
    cached.write(b);
    assert.deepEqual(Array.from(b.bytes()), Array.from(a.bytes()), 'same bytes with and without the memo');
    assert.ok(utf8.has('alpha'), 'memo populated');
    cached.reset();
    assert.equal(cached.index('alpha'), 1, 'index restarts after reset');
  });
});
