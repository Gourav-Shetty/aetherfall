// @aetherfall/server — perf instrumentation tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIST_BOUNDS_MS, PERF_SECTIONS, Perf, SLOW_TICK_MS, formatSlowTick } from './perf.js';

const secs = (n: number): Record<(typeof PERF_SECTIONS)[number], number> => ({
  sim: n, gameplay: n, npc: n, snapshot: n, db: n,
});

test('records every tick and reports avg/max', () => {
  const p = new Perf({ maxRecent: 0, logEveryMs: 0 });
  p.record(1, 10, secs(0), 100);
  p.record(2, 30, secs(0), 100);
  assert.equal(p.ticks, 2);
  assert.equal(p.maxMs, 30);
  assert.equal(p.totalMs, 40);
  assert.equal(p.slowTicks, 0);
});

test('counts ticks over the slow threshold and logs with section breakdown', () => {
  const lines: string[] = [];
  const p = new Perf({ logEveryMs: 0, log: (l) => lines.push(l) });
  p.record(7, SLOW_TICK_MS - 0.01, secs(0), 300);
  assert.equal(lines.length, 0, 'just-under-budget tick must not log');

  p.record(8, 61.5, { sim: 0.07, gameplay: 7.68, npc: 0.15, snapshot: 53.5, db: 0 }, 300);
  assert.equal(p.slowTicks, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /slow tick 8 total=61\.50ms/);
  assert.match(lines[0]!, /snapshot=53\.50/);
  assert.match(lines[0]!, /players=300/);
});

test('rate-limits the slow-tick log but keeps counting', () => {
  let n = 0;
  const p = new Perf({ logEveryMs: 1000, log: () => n++ });
  p.record(1, 80, secs(1), 10, 0);
  p.record(2, 90, secs(1), 10, 100);
  p.record(3, 70, secs(1), 10, 200);
  assert.equal(n, 1, 'only the first slow tick logs inside the window');
  assert.equal(p.slowTicks, 3);
  assert.equal(p.slowLogsSuppressed, 2);
  p.record(4, 70, secs(1), 10, 2000);
  assert.equal(n, 2, 'logs again once the window elapses');
});

test('histogram is cumulative with a +Inf catch-all', () => {
  const p = new Perf({ maxRecent: 0 });
  for (const ms of [0.5, 1.5, 4, 9, 20, 40, 60, 90, 500]) p.record(1, ms, secs(0), 1);
  const h = p.histogram();
  assert.equal(h['1'], 1);
  assert.equal(h['2'], 2);
  assert.equal(h['5'], 3);
  assert.equal(h['10'], 4);
  assert.equal(h['25'], 5);
  assert.equal(h['50'], 6);
  assert.equal(h['100'], 8);
  assert.equal(h['+Inf'], 9, 'the 500ms sample lands in the overflow bucket');
  assert.equal(HIST_BOUNDS_MS.length + 1, Object.keys(h).length);
});

test('retains a bounded tail of recent slow ticks (oldest first)', () => {
  const p = new Perf({ maxRecent: 2, logEveryMs: 0 });
  for (let i = 1; i <= 5; i++) p.record(i, 60 + i, secs(0), 1);
  const recent = p.recentSlowTicks();
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.tick, 4);
  assert.equal(recent[1]!.tick, 5);
  assert.equal(p.slowTicks, 5, 'retention cap does not affect the counter');
});

test('section breakdown is copied, not aliased', () => {
  const p = new Perf({ maxRecent: 1, logEveryMs: 0 });
  const s = secs(1);
  p.record(1, 99, s, 1);
  s.snapshot = 999;
  assert.equal(p.recentSlowTicks()[0]!.sections.snapshot, 1);
});

test('render exposes histogram, slow-tick counters and recent breakdown', () => {
  const p = new Perf({ maxRecent: 1, logEveryMs: 0 });
  p.record(11, 5, secs(0), 100);
  p.record(12, 75, { sim: 1, gameplay: 2, npc: 3, snapshot: 4, db: 5 }, 250);
  const out = p.render();
  assert.match(out, /aetherfall_tick_ms_count 2/);
  assert.match(out, /aetherfall_tick_ms_sum 80\.000/);
  assert.match(out, /aetherfall_slow_ticks_total 1/);
  assert.match(out, /aetherfall_slow_ticks_ratio 0\.500000/);
  assert.match(out, /aetherfall_slow_tick_ms_avg 75\.000/);
  assert.match(out, /aetherfall_tick_ms_max 75\.000/);
  assert.match(out, /aetherfall_recent_slow_tick_ms\{tick="12",players="250"\} 75\.000/);
  assert.match(out, /aetherfall_recent_slow_tick_section_ms\{tick="12",section="snapshot"\} 4\.000/);
});

test('reset clears counters, histogram and recent tail', () => {
  const p = new Perf({ maxRecent: 1, logEveryMs: 0 });
  p.record(1, 99, secs(0), 1);
  p.reset();
  assert.equal(p.ticks, 0);
  assert.equal(p.slowTicks, 0);
  assert.equal(p.maxMs, 0);
  assert.equal(p.recentSlowTicks().length, 0);
  assert.equal(p.histogram()['+Inf'], 0);
});

test('snap split tracks collect/encode/send averages, maxima and exposition', () => {
  const p = new Perf({ maxRecent: 0, logEveryMs: 0 });
  assert.deepEqual(p.snapAvg(), { collect: 0, encode: 0, send: 0 });
  p.observeSnapSplit(2, 1, 4);
  p.observeSnapSplit(4, 1, 2);
  assert.equal(p.snapTicks, 2);
  assert.deepEqual(p.snapAvg(), { collect: 3, encode: 1, send: 3 });
  assert.deepEqual({ ...p.snapMax }, { collect: 4, encode: 1, send: 4 });
  const out = p.render();
  assert.match(out, /aetherfall_snapshot_split_ticks_total 2/);
  assert.match(out, /aetherfall_snapshot_split_ms_avg\{stage="collect"\} 3\.000/);
  assert.match(out, /aetherfall_snapshot_split_ms_max\{stage="send"\} 4\.000/);
  p.reset();
  assert.equal(p.snapTicks, 0);
  assert.deepEqual(p.snapAvg(), { collect: 0, encode: 0, send: 0 });
});

test('formatSlowTick lists every section in pipeline order', () => {
  const line = formatSlowTick({
    tick: 3,
    totalMs: 61,
    players: 12,
    sections: { sim: 1, gameplay: 2, npc: 3, snapshot: 4, db: 5 },
  });
  assert.equal(
    line,
    '[perf] slow tick 3 total=61.00ms (sim=1.00 gameplay=2.00 npc=3.00 snapshot=4.00 db=5.00) players=12',
  );
});
