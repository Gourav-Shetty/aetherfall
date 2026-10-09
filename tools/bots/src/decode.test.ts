import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySnapshot,
  baselineFromEntities,
  decodeSnapshotBinary,
  encodeSnapshotBinary,
  isPooledSnapshotCandidate,
  P2SnapshotDecoder,
  type P2Baseline,
  type P2Entity,
} from '@aetherfall/shared/dist/protocol2.js';

// Receive-path parity: the pooled lane in runBot (decodeSnapshot +
// applySnapshotInPlace, routed by isPooledSnapshotCandidate) must carry the
// same content as the classic safeDecodeServerFrame + applySnapshot path.
function ent(id: number, x: number, y: number, over: Partial<P2Entity> = {}): P2Entity {
  return { id, kind: 'mob', p: { x, y }, v: { x: 1, y: -1 }, hp: 90, maxHp: 100, ...over };
}

function baselineContent(b: P2Baseline): string {
  return JSON.stringify(
    [...b.entries()].map(([id, q]) => [id, q]).sort((a, z) => (a[0] as number) - (z[0] as number)),
  );
}

describe('bots pooled receive path', () => {
  it('routes well-formed snapshot frames to the pooled lane only', () => {
    const snap = encodeSnapshotBinary({ t: 'snapshot', tick: 4, baseTick: 3, keyframe: false, entities: [ent(1, 2, 3)], removed: [] });
    assert.equal(isPooledSnapshotCandidate(snap), true);
    assert.equal(isPooledSnapshotCandidate(Buffer.from(snap)), true);
    assert.equal(isPooledSnapshotCandidate(new Uint8Array(0)), false);
    assert.equal(isPooledSnapshotCandidate(Buffer.from('{"t":"snapshot"}')), false);
  });

  it('pooled receive flow matches the classic flow frame-for-frame', () => {
    const decoder = new P2SnapshotDecoder();
    // Welcome-equivalent seed on both lanes.
    const welcome = [ent(1, 1, 1, { name: 'a' }), ent(2, 2, 2), ent(3, 3, 3, { level: 5 })];
    let classicBase = baselineFromEntities(welcome);
    let classicTick = 0;
    const pooledBase = baselineFromEntities(welcome);
    let pooledTick = 0;

    const frames: Uint8Array[] = [
      // delta: one move, one brand-new id (full record), one removal.
      encodeSnapshotBinary(
        { t: 'snapshot', tick: 1, baseTick: 0, keyframe: false, entities: [{ ...ent(1, 2, 1), name: 'a' }, ent(9, 9, 9)], removed: [3] },
        classicBase,
      ),
      // delta: hp change + cleared name marker (keeps baseline name).
      encodeSnapshotBinary(
        { t: 'snapshot', tick: 2, baseTick: 1, keyframe: false, entities: [{ id: 1, hp: 41 }, { id: 9, name: '' }], removed: [] },
        baselineFromEntities([ent(1, 2, 1, { name: 'a' }), ent(2, 2, 2), ent(9, 9, 9)]),
      ),
      // keyframe: wholesale replacement.
      encodeSnapshotBinary({ t: 'snapshot', tick: 3, baseTick: 0, keyframe: true, entities: [ent(7, 7, 7, { kind: 'player' })], removed: [] }),
    ];

    for (const bytes of frames) {
      assert.equal(isPooledSnapshotCandidate(bytes), true);
      // Classic lane.
      const classic = decodeSnapshotBinary(bytes, classicBase);
      const a = applySnapshot(classic, classicBase, classicTick);
      assert.equal(a.ok, true);
      if (!a.ok) continue;
      // Pooled lane (the exact calls runBot makes, incl. Buffer input).
      const pooled = decoder.decodeSnapshot(Buffer.from(bytes), pooledBase);
      const p = decoder.applySnapshotInPlace(pooled, pooledBase, pooledTick);
      assert.equal(p.ok, true);
      if (!p.ok) continue;
      assert.equal(p.baseTick, a.baseTick);
      assert.equal(baselineContent(pooledBase), baselineContent(a.baseline));
      classicBase = a.baseline;
      classicTick = a.baseTick;
      pooledTick = p.baseTick;
    }
    assert.deepEqual([...pooledBase.keys()].sort((x, y) => x - y), [7]);
  });
});
