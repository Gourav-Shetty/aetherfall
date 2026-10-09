import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySnapshot,
  baselineFromEntities,
  decodeServerFrame,
  decodeSnapshotBinary,
  encodeAckBinary,
  encodeChatBinary,
  encodeEventBinary,
  encodeSnapshotBinary,
  encodeWelcomeBinary,
  isPooledSnapshotCandidate,
  P2_MAX_STRINGS,
  P2SnapshotDecoder,
  P2Type,
  P2SnapshotStream,
  type P2Baseline,
  type P2Entity,
  type P2Snapshot,
} from './protocol2.js';

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
    out.push(
      ent(i + 1, 50 + Math.sin((tick + i) / 7) * 20, 50 + Math.cos((tick + i) / 5) * 20, {
        kind: i % 3 === 0 ? 'player' : 'mob',
        v: { x: Math.sin((tick + i) / 3) * 4, y: Math.cos((tick + i) / 3) * 4 },
        hp: 80 + ((tick + i) % 7),
        maxHp: 100,
        dir: (i % 8) * 0.78,
        level: 1 + (i % 20),
        name: i % 4 === 0 ? `mob-${i}` : undefined,
      }),
    );
  }
  return out;
}

/** Baseline contents as a comparable plain object (id -> quant). */
function snapBaseline(b: P2Baseline): Array<[number, object]> {
  return [...b.entries()].map(([id, qn]) => [id, { ...qn }] as [number, object]).sort((a, z) => a[0] - z[0]);
}

describe('P2SnapshotDecoder (pooled bot-side decode)', () => {
  it('decodes exactly what decodeSnapshotBinary decodes (keyframes, deltas, removals, unknown ids)', () => {
    const stream = new P2SnapshotStream(7);
    const decoder = new P2SnapshotDecoder();
    let classicBaseline: P2Baseline = new Map();
    let classicTick = -1;
    let pooledBaseline: P2Baseline = new Map();
    let pooledTick = -1;
    for (let t = 0; t < 30; t++) {
      const removed = t === 12 ? [2, 5] : t === 20 ? [9] : [];
      const bytes = stream.encode(world(12, t), removed, t);
      const classic = decodeSnapshotBinary(bytes, classicBaseline);
      const pooled = decoder.decodeSnapshot(bytes.slice(), pooledBaseline);
      // Same content (own-keys included — pooled records delete absents).
      assert.deepEqual(JSON.parse(JSON.stringify(pooled)), JSON.parse(JSON.stringify(classic)));
      // Re-encode byte-stability holds for the pooled message too.
      assert.deepEqual(
        Array.from(encodeSnapshotBinary(pooled, pooledBaseline)),
        Array.from(encodeSnapshotBinary(classic, classicBaseline)),
      );
      const a = applySnapshot(classic, classicBaseline, classicTick);
      const p = decoder.applySnapshotInPlace(pooled, pooledBaseline, pooledTick);
      assert.equal(a.ok, true, `classic tick ${t}`);
      assert.equal(p.ok, true, `pooled tick ${t}`);
      if (!a.ok || !p.ok) continue;
      assert.deepEqual(snapBaseline(pooledBaseline), snapBaseline(a.baseline), `baseline tick ${t}`);
      classicBaseline = a.baseline;
      classicTick = a.baseTick;
      pooledTick = p.baseTick;
    }
  });

  it('reuses scratch across frames (no per-frame entities/removed/table allocs)', () => {
    const decoder = new P2SnapshotDecoder();
    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: world(8, 1), removed: [] });
    const first = decoder.decodeSnapshot(bytes, new Map());
    const entitiesArr = first.entities;
    const removedArr = first.removed;
    const slots = first.entities.slice();
    const secondBytes = encodeSnapshotBinary({ t: 'snapshot', tick: 2, baseTick: 0, keyframe: true, entities: world(8, 2), removed: [3] });
    const second = decoder.decodeSnapshot(secondBytes, new Map());
    assert.equal(second.entities as unknown, entitiesArr as unknown, 'entities array reused');
    assert.equal(second.removed as unknown, removedArr as unknown, 'removed array reused');
    for (let i = 0; i < slots.length; i++) {
      assert.equal(second.entities[i] as unknown, slots[i] as unknown, `record slot ${i} reused`);
    }
    // p/v sub-objects ride along when a record carries them on both frames.
    assert.equal(second.entities[0]!.p as unknown, slots[0]!.p as unknown, 'p object reused');
    assert.deepEqual(second.removed, [3]);
  });

  it('mutates the baseline in place (same Map identity across a 120-tick stream)', () => {
    const stream = new P2SnapshotStream(50);
    const decoder = new P2SnapshotDecoder();
    const baseline: P2Baseline = new Map();
    const identity = baseline;
    let baseTick = -1;
    for (let t = 0; t < 120; t++) {
      const bytes = stream.encode(world(15, t), t === 60 ? [4, 7] : [], t);
      const pooled = decoder.decodeSnapshot(bytes, baseline);
      const applied = decoder.applySnapshotInPlace(pooled, baseline, baseTick);
      assert.equal(applied.ok, true, `tick ${t}`);
      if (!applied.ok) continue;
      baseTick = applied.baseTick;
    }
    assert.equal(baseline as unknown, identity as unknown, 'baseline map never replaced');
    // Spot-check content against one classic pass of the final state.
    const expect = baselineFromEntities(world(15, 119));
    assert.deepEqual(snapBaseline(baseline), snapBaseline(expect));
  });

  it('replaces baseline wholesale on keyframes (ids absent from the frame are swept)', () => {
    const decoder = new P2SnapshotDecoder();
    const baseline = baselineFromEntities(world(6, 1));
    assert.equal(baseline.size, 6);
    const key = encodeSnapshotBinary({ t: 'snapshot', tick: 9, baseTick: 0, keyframe: true, entities: world(6, 9).slice(0, 2), removed: [] });
    const msg = decoder.decodeSnapshot(key);
    const applied = decoder.applySnapshotInPlace(msg, baseline, 1);
    assert.equal(applied.ok, true);
    assert.deepEqual([...baseline.keys()].sort((a, b) => a - b), [1, 2]);
    // `removed` wins over entities in the same keyframe.
    const key2 = encodeSnapshotBinary({ t: 'snapshot', tick: 10, baseTick: 0, keyframe: true, entities: world(6, 10).slice(0, 3), removed: [2] });
    const msg2 = decoder.decodeSnapshot(key2);
    assert.equal(decoder.applySnapshotInPlace(msg2, baseline, 9).ok, true);
    assert.deepEqual([...baseline.keys()].sort((a, b) => a - b), [1, 3]);
  });

  it('reports need-keyframe exactly like applySnapshot', () => {
    const decoder = new P2SnapshotDecoder();
    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 9, baseTick: 8, keyframe: false, entities: [], removed: [] });
    const baseline: P2Baseline = new Map();
    const classic = applySnapshot(decodeSnapshotBinary(bytes, baseline), baseline, 3);
    const pooled = decoder.applySnapshotInPlace(decoder.decodeSnapshot(bytes.slice(), baseline), baseline, 3);
    assert.deepEqual(pooled, classic);
  });

  it('caps the decode string-intern cache and still decodes', () => {
    const decoder = new P2SnapshotDecoder();
    for (let f = 0; f < P2_MAX_STRINGS + 40; f++) {
      const entities = [ent(1, f, f, { name: `unique-name-${f}` })];
      const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: f + 1, baseTick: 0, keyframe: true, entities, removed: [] });
      const msg = decoder.decodeSnapshot(bytes);
      assert.equal(msg.entities[0]!.name, `unique-name-${f}`);
      assert.ok(decoder.internSize <= P2_MAX_STRINGS, `intern cache bounded (got ${decoder.internSize})`);
    }
    // Repeated names share one identity after interning.
    const a = encodeSnapshotBinary({ t: 'snapshot', tick: 9000, baseTick: 0, keyframe: true, entities: [ent(1, 1, 1, { name: 'same' })], removed: [] });
    const b = encodeSnapshotBinary({ t: 'snapshot', tick: 9001, baseTick: 0, keyframe: true, entities: [ent(2, 2, 2, { name: 'same' })], removed: [] });
    const ma = decoder.decodeSnapshot(a);
    const na = ma.entities[0]!.name;
    const mb = decoder.decodeSnapshot(b);
    assert.equal(mb.entities[0]!.name as unknown, na as unknown, 'interned identity reused');
  });

  it('rejects malformed frames with P2DecodeError (same messages as the classic path)', () => {
    const decoder = new P2SnapshotDecoder();
    const good = encodeSnapshotBinary({ t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [ent(1, 3, 4)], removed: [] });
    const cases: Array<[string, Uint8Array, RegExp]> = [
      ['bad magic', (() => { const c = good.slice(); c[0] = 0x00; return c; })(), /bad magic/],
      ['truncated', good.slice(0, good.length - 3), /does not match payload/],
      ['delta without baseline', good, /needs the receiver baseline/],
      ['trailing bytes', (() => { const c = good.slice(); c[c.length - 1] = (c[c.length - 1]! + 1) & 0xff; return c; })(), /protocol2: /],
    ];
    for (const [name, bytes, want] of cases) {
      if (name === 'delta without baseline') {
        assert.throws(() => decoder.decodeSnapshot(bytes), want, name);
        continue;
      }
      if (name === 'trailing bytes') {
        // A corrupted byte either still parses (different content) or throws P2DecodeError — never anything else.
        try {
          decoder.decodeSnapshot(bytes, new Map());
        } catch (err) {
          assert.match(String((err as Error).message), want, name);
        }
        continue;
      }
      assert.throws(() => decoder.decodeSnapshot(bytes, new Map()), want, name);
    }
    // Keyframe with an incomplete record.
    const incomplete: P2Snapshot = { t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [{ id: 42 }], removed: [] };
    assert.throws(() => decoder.applySnapshotInPlace(incomplete, new Map(), 1), /incomplete/);
  });

  it('isPooledSnapshotCandidate routes exactly the snapshot frames', () => {
    const snap = encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [], removed: [] });
    assert.equal(isPooledSnapshotCandidate(snap), true);
    assert.equal(snap[2], P2Type.Snapshot);
    assert.equal(isPooledSnapshotCandidate(new Uint8Array(0)), false);
    assert.equal(isPooledSnapshotCandidate(new Uint8Array([0xaf, 0x02, 0x02])), false);
    const notSnap = snap.slice();
    notSnap[2] = P2Type.Ack;
    assert.equal(isPooledSnapshotCandidate(notSnap), false);
  });

  it('decodeServerFrame matches the classic dispatch for every frame type', () => {
    const decoder = new P2SnapshotDecoder();
    const base = baselineFromEntities(world(4, 1));
    const delta = encodeSnapshotBinary(
      { t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [{ id: 1, hp: 41 }], removed: [4] },
      base,
    );
    const frames: Uint8Array[] = [
      encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 7, tick: 1, name: 'n', snapshot: world(3, 1) }),
      encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: world(4, 1), removed: [] }),
      delta,
      encodeChatBinary({ t: 'chat', from: 'a', text: 'héllo', channel: 'say' }),
      encodeEventBinary({ t: 'event', kind: 'k', payload: '{"x":1}' }),
      encodeAckBinary({ t: 'ack', tick: 5, baseTick: 4, lastInputSeq: 3, rttMs: 12 }),
    ];
    for (const bytes of frames) {
      const classic = decodeServerFrame(bytes, base);
      const pooled = decoder.decodeServerFrame(bytes, base);
      assert.deepEqual(JSON.parse(JSON.stringify(pooled)), JSON.parse(JSON.stringify(classic)));
    }
    // Unknown-type and malformed parity (same throws, never anything else).
    const unknown = frames[0]!.slice();
    unknown[2] = 99;
    assert.throws(() => decodeServerFrame(unknown, base), /unknown server msg type/);
    assert.throws(() => decoder.decodeServerFrame(unknown, base), /unknown server msg type/);
    const badMagic = frames[3]!.slice();
    badMagic[0] = 0x00;
    assert.throws(() => decodeServerFrame(badMagic, base), /bad magic/);
    assert.throws(() => decoder.decodeServerFrame(badMagic, base), /bad magic/);
  });

  it('does not retain one-shot chat/event text in the intern cache', () => {
    const decoder = new P2SnapshotDecoder();
    // Snapshot names intern (repeating table strings share identity).
    const snap = encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [ent(1, 1, 1, { name: 'same' })], removed: [] });
    const before = decoder.internSize;
    decoder.decodeServerFrame(snap);
    assert.ok(decoder.internSize > before, 'entity names interned');
    const pinned = decoder.internSize;
    // Unique chat text / event payloads must NOT accumulate: 500 distinct
    // payloads decode fine but pin nothing.
    for (let i = 0; i < 500; i++) {
      decoder.decodeServerFrame(encodeChatBinary({ t: 'chat', from: `bot-${i % 100}`, text: `msg-${i}-unique`, channel: 'say' }));
      decoder.decodeServerFrame(encodeEventBinary({ t: 'event', kind: 'mob-die', payload: JSON.stringify({ id: i, x: i * 1.5 }) }));
    }
    assert.equal(decoder.internSize, pinned, 'one-shot text is not retained');
  });

  it('reset() drops intern state and pooled capacity', () => {
    const decoder = new P2SnapshotDecoder();
    const bytes = encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [ent(1, 1, 1, { name: 'x' })], removed: [] });
    decoder.decodeSnapshot(bytes);
    assert.ok(decoder.internSize > 0);
    decoder.reset();
    assert.equal(decoder.internSize, 0);
    const msg: P2Snapshot = decoder.decodeSnapshot(bytes.slice(), new Map());
    assert.equal(msg.entities.length, 1);
  });
});
