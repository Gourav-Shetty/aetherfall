// Damage-number pool mechanics: lifetime + culling, the fixed 24-slot cap,
// the fold-into-one merge window, and the labelled (finisher) slot. Pure
// preallocated containers — no DOM, no canvas, no WebGL.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DamageNumberPool,
  DMG_MAX,
  DMG_MERGE_DIST,
  DMG_MERGE_MS,
  DMG_RISE_PX,
  DMG_TTL_MS,
  DMG_TTL_REDUCED_MS,
  FINISHER_LABEL,
  KILL_FX_MAX,
  KillFxRing,
  damageNumberText,
  killBurstStyle,
} from './feedback.js';

/** Live slots as the renderers see them (index walk, no allocation). */
function liveTexts(pool: DamageNumberPool, nowMs: number): string[] {
  pool.step(nowMs);
  const out: string[] = [];
  for (let i = 0; i < pool.capacity; i++) {
    const d = pool.at(i);
    if (d.active) out.push(damageNumberText(d));
  }
  return out;
}

describe('DamageNumberPool: capacity', () => {
  it('is a fixed 24-slot ring', () => {
    const p = new DamageNumberPool();
    assert.equal(p.capacity, DMG_MAX);
    assert.equal(DMG_MAX, 24);
    assert.equal(p.liveCount, 0);
  });

  it('never exceeds the cap no matter how many hits land', () => {
    const p = new DamageNumberPool();
    // Spread the hits far apart (in space and time) so none of them merge.
    for (let i = 0; i < DMG_MAX * 5; i++) {
      assert.equal(p.spawn(i * 5, 0, 5, 'normal', 1000, 'full'), true);
    }
    p.step(1000);
    assert.equal(p.liveCount, DMG_MAX, 'hard cap holds');
    assert.equal(p.capacity, DMG_MAX, 'the pool itself never grew');
  });

  it('recycles the oldest slot rather than growing', () => {
    const p = new DamageNumberPool();
    for (let i = 0; i < DMG_MAX; i++) p.spawn(i * 5, 0, i + 1, 'normal', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, DMG_MAX);
    // One more hit evicts the first slot; the count is unchanged.
    p.spawn(999, 0, 42, 'normal', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, DMG_MAX);
    const texts = liveTexts(p, 1000);
    assert.ok(!texts.includes('1'), 'the oldest number was the one recycled');
    assert.ok(texts.includes('42'), 'the newest is present');
  });
});

describe('DamageNumberPool: lifetime + culling', () => {
  it('lives for the full 700ms then expires', () => {
    const p = new DamageNumberPool();
    p.spawn(10, 10, 12, 'normal', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, 1);
    assert.equal(p.at(0).alpha, 1, 'fully opaque at birth');
    p.step(1000 + DMG_TTL_MS - 1);
    assert.equal(p.liveCount, 1, 'alive right up to the lifetime');
    assert.ok(p.at(0).alpha > 0);
    p.step(1000 + DMG_TTL_MS);
    assert.equal(p.liveCount, 0, 'culled exactly at DMG_TTL_MS');
  });

  it('holds full opacity then fades out', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 1, 'normal', 0, 'full');
    p.step(DMG_TTL_MS * 0.34);
    assert.equal(p.at(0).alpha, 1, 'no fade in the first third');
    p.step(DMG_TTL_MS * 0.5);
    const mid = p.at(0).alpha;
    assert.ok(mid < 1 && mid > 0, `fading (${mid})`);
    p.step(DMG_TTL_MS * 0.99);
    assert.ok(p.at(0).alpha < mid);
  });

  it('rises monotonically from 0 to the full rise distance', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 1, 'normal', 0, 'full');
    let prev = -1;
    for (let t = 0; t <= DMG_TTL_MS; t += 50) {
      p.step(t);
      if (!p.at(0).active) break;
      assert.ok(p.at(0).offset > prev, `still rising at ${t}ms`);
      prev = p.at(0).offset;
    }
    assert.ok(prev > DMG_RISE_PX * 0.9, 'covered the full rise');
  });

  it('progress runs 0 -> 1 across the lifetime', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 1, 'normal', 0, 'full');
    p.step(0);
    assert.equal(p.at(0).progress, 0);
    p.step(DMG_TTL_MS / 2);
    assert.ok(Math.abs(p.at(0).progress - 0.5) < 1e-9);
  });

  it('a timestamp before the spawn does not resurrect an expired number', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 1, 'normal', 5000, 'full');
    p.step(5000 + DMG_TTL_MS);
    assert.equal(p.liveCount, 0);
    p.step(4000);
    assert.equal(p.liveCount, 0, 'clock going backwards does not revive it');
  });

  it('reduced motion shortens the lifetime and removes the rise', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 1, 'normal', 0, 'short');
    p.step(DMG_TTL_REDUCED_MS - 1);
    assert.equal(p.liveCount, 1, 'the text is still shown');
    assert.equal(p.at(0).offset, 0, 'it does not travel');
    p.step(DMG_TTL_REDUCED_MS);
    assert.equal(p.liveCount, 0);
  });

  it('"off" mode spawns nothing at all', () => {
    const p = new DamageNumberPool();
    assert.equal(p.spawn(0, 0, 100, 'crit', 0, 'off'), false);
    p.step(0);
    assert.equal(p.liveCount, 0);
  });

  it('clear() empties the pool and resets the ring cursor', () => {
    const p = new DamageNumberPool();
    for (let i = 0; i < 5; i++) p.spawn(i * 5, 0, 1, 'normal', 0, 'full');
    p.step(0);
    assert.equal(p.liveCount, 5);
    p.clear();
    p.step(0);
    assert.equal(p.liveCount, 0);
    assert.equal(p.count(0), 0);
  });

  it('count() agrees with a manual walk without stepping', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 1, 'normal', 1000, 'full');
    p.spawn(50, 0, 1, 'normal', 1000, 'full');
    assert.equal(p.count(1000), 2);
    assert.equal(p.count(1000 + DMG_TTL_MS), 0);
  });
});

describe('DamageNumberPool: input validation', () => {
  it('rejects non-finite positions, bad amounts and bad timestamps', () => {
    const p = new DamageNumberPool();
    assert.equal(p.spawn(NaN, 0, 5, 'normal', 0, 'full'), false);
    assert.equal(p.spawn(0, Infinity, 5, 'normal', 0, 'full'), false);
    assert.equal(p.spawn(0, 0, 0, 'normal', 0, 'full'), false);
    assert.equal(p.spawn(0, 0, -5, 'normal', 0, 'full'), false);
    assert.equal(p.spawn(0, 0, NaN, 'normal', 0, 'full'), false);
    assert.equal(p.spawn(0, 0, 5, 'normal', NaN, 'full'), false);
    p.step(0);
    assert.equal(p.liveCount, 0);
  });

  it('rejects an empty finisher label', () => {
    const p = new DamageNumberPool();
    assert.equal(p.spawnLabel(0, 0, '', 'finisher', 0, 'full'), false);
    assert.equal(p.spawnLabel(0, 0, FINISHER_LABEL, 'finisher', 0, 'full'), true);
    assert.equal(p.liveCount, 0, 'not stepped yet');
    p.step(0);
    assert.equal(p.liveCount, 1);
  });
});

describe('DamageNumberPool: merge window', () => {
  it('folds repeat hits on the same target into one rising total', () => {
    const p = new DamageNumberPool();
    const t0 = 1000;
    p.spawn(10, 10, 5, 'normal', t0, 'full');
    p.spawn(10.2, 10.1, 7, 'normal', t0 + DMG_MERGE_MS / 2, 'full');
    p.step(t0 + DMG_MERGE_MS / 2);
    assert.equal(p.liveCount, 1, 'no second number stacked on the first');
    assert.equal(damageNumberText(p.at(0)), '12');
  });

  it('does not merge past the time window', () => {
    const p = new DamageNumberPool();
    p.spawn(10, 10, 5, 'normal', 1000, 'full');
    p.spawn(10, 10, 7, 'normal', 1000 + DMG_MERGE_MS + 1, 'full');
    p.step(1000 + DMG_MERGE_MS + 1);
    assert.equal(p.liveCount, 2, 'a later swing gets its own number');
  });

  it('does not merge across a distance gap', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 5, 'normal', 1000, 'full');
    p.spawn(0, DMG_MERGE_DIST + 0.5, 5, 'normal', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, 2);
  });

  it('never merges across kinds (a crit stays its own number)', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 5, 'normal', 1000, 'full');
    p.spawn(0, 0, 5, 'crit', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, 2);
  });

  it('never merges a following number into an anchored one', () => {
    const p = new DamageNumberPool();
    p.spawn(50, 50, 3, 'taken', 1000, 'full', 1);
    p.spawn(50, 50, 3, 'taken', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, 2, 'the world-anchored hit is a different animal');
  });

  it('the merged slot restarts its timer so the total stays readable', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 5, 'normal', 1000, 'full');
    p.spawn(0, 0, 5, 'normal', 1000 + DMG_MERGE_MS - 1, 'full');
    p.step(1000 + DMG_MERGE_MS - 1 + DMG_TTL_MS - 1);
    assert.equal(p.liveCount, 1, 'still alive: the timer restarted on the merge');
    assert.equal(damageNumberText(p.at(0)), '10');
  });

  it('a labelled finisher slot is never merged into a plain hit', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 5, 'normal', 1000, 'full');
    p.spawnLabel(0, 0, FINISHER_LABEL, 'finisher', 1000, 'full');
    p.step(1000);
    assert.equal(p.liveCount, 2);
    const texts = liveTexts(p, 1000);
    assert.ok(texts.includes(FINISHER_LABEL));
    assert.ok(texts.includes('5'));
  });
});

describe('DamageNumberPool: anchoring', () => {
  it('remembers the follow id so the player damage tracks the player', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 9, 'taken', 0, 'full', 42);
    p.step(0);
    assert.equal(p.at(0).followId, 42);
  });

  it('an unanchored number reports -1', () => {
    const p = new DamageNumberPool();
    p.spawn(0, 0, 9, 'normal', 0, 'full');
    p.step(0);
    assert.equal(p.at(0).followId, -1);
  });
});

describe('KillFxRing', () => {
  it('is a fixed ring that expires and ignores junk', () => {
    const r = new KillFxRing();
    assert.equal(r.capacity, KILL_FX_MAX);
    assert.equal(r.spawn(NaN, 0, killBurstStyle(false), 0), false);
    assert.equal(r.spawn(0, 0, killBurstStyle(false), NaN), false);
    assert.equal(r.spawn(1, 2, killBurstStyle(false), 1000), true);
    r.step(1000 + killBurstStyle(false).lifeMs - 1);
    assert.equal(r.at(0).active, true);
    r.step(1000 + killBurstStyle(false).lifeMs);
    assert.equal(r.at(0).active, false);
  });

  it('holds at most KILL_FX_MAX rings and recycles them', () => {
    const r = new KillFxRing();
    for (let i = 0; i < KILL_FX_MAX * 3; i++) {
      r.spawn(i, 0, killBurstStyle(i % 2 === 0), i * 10_000);
    }
    let live = 0;
    r.step(0);
    for (let i = 0; i < r.capacity; i++) if (r.at(i).active) live++;
    assert.ok(live <= KILL_FX_MAX);
  });

  it('clear() empties it', () => {
    const r = new KillFxRing();
    r.spawn(1, 1, killBurstStyle(true), 0);
    r.clear();
    assert.equal(r.at(0).active, false);
  });
});