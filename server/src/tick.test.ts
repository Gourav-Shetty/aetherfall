// @aetherfall/server — drift-compensating tick scheduler tests.
//
// Covers the tick scheduler contract: the setTimeout chain holds ~20Hz on Windows
// (where setInterval(50) dilates to ~16Hz), catch-up is bounded at 2, deeper
// lag is skipped + counted, and the 10Hz halves stay aligned via sim.tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_CATCH_UP, TickScheduler, planTicks } from './tick.js';
import { Metrics } from './metrics.js';

test('planTicks: on-time wake runs exactly one tick', () => {
  const period = 50;
  const next = 1_000_000;
  const p = planTicks(next, next, period, 2);
  assert.equal(p.missed, 0);
  assert.equal(p.ticksToRun, 1);
  assert.equal(p.skipped, 0);
  assert.equal(p.nextTickMs, next + period);
});

test('planTicks: early wake keeps the absolute grid', () => {
  const period = 50;
  const next = 1_000_000;
  const p = planTicks(next - 5, next, period, 2);
  assert.equal(p.missed, 0);
  assert.equal(p.ticksToRun, 1);
  assert.equal(p.skipped, 0);
  assert.equal(p.nextTickMs, next + period);
});

test('planTicks: 1-2 periods behind runs bounded catch-up, no skips', () => {
  const period = 50;
  const next = 1_000_000;
  for (const missed of [1, 2]) {
    const p = planTicks(next + missed * period, next, period, 2);
    assert.equal(p.missed, missed);
    assert.equal(p.ticksToRun, 1 + missed);
    assert.equal(p.skipped, 0);
    assert.equal(p.nextTickMs, next + (1 + missed) * period);
    assert.ok(p.ticksToRun <= 1 + DEFAULT_MAX_CATCH_UP);
  }
});

test('planTicks: more than max behind skips and stays bounded at one tick', () => {
  const period = 50;
  const next = 1_000_000;
  for (const missed of [3, 5, 20]) {
    const p = planTicks(next + missed * period + 7, next, period, 2);
    assert.equal(p.missed, missed);
    assert.equal(p.ticksToRun, 1, `missed=${missed} must not run catch-up`);
    assert.equal(p.skipped, missed);
    assert.equal(p.nextTickMs, next + (1 + missed) * period);
  }
});

test('planTicks: partial-period lateness does not count as missed', () => {
  const period = 50;
  const next = 1_000_000;
  const p = planTicks(next + 49, next, period, 2);
  assert.equal(p.missed, 0);
  assert.equal(p.ticksToRun, 1);
  assert.equal(p.skipped, 0);
});

test('scheduler with fake timers: catch-up bounded, skips counted', () => {
  let now = 1_000_000;
  type H = { fn: () => void; at: number };
  const pending: H[] = [];
  const setTimer = (fn: () => void, ms: number): unknown => {
    const h: H = { fn, at: now + ms };
    pending.push(h);
    return h;
  };
  const clearTimer = (h: unknown): void => {
    const i = pending.indexOf(h as H);
    if (i >= 0) pending.splice(i, 1);
  };
  let ticks = 0;
  let skipped = 0;
  let caughtUp = 0;
  const s = new TickScheduler(
    () => {
      ticks++;
    },
    {
      periodMs: 50,
      maxCatchUp: 2,
      now: () => now,
      setTimer,
      clearTimer,
      onSkip: (n) => {
        skipped += n;
      },
      onCatchUp: (n) => {
        caughtUp += n;
      },
    },
  );
  s.start();
  assert.equal(pending.length, 1);
  // On-time wake: 1 tick.
  now += 50;
  pending.shift()!.fn();
  assert.equal(ticks, 1);
  assert.equal(skipped, 0);
  // 2 periods late: 3 ticks (1 + 2 catch-up), still no skip.
  now += 150;
  pending.shift()!.fn();
  assert.equal(ticks, 4);
  assert.equal(caughtUp, 2);
  assert.equal(skipped, 0);
  // 10 periods late: 1 tick + 9 skipped (bounded, no spiral).
  // next was 1_000_250, now jumps 500ms to 1_000_700: (700-250)/50 = 9 missed.
  now += 500;
  pending.shift()!.fn();
  assert.equal(ticks, 5);
  assert.equal(skipped, 9);
  s.stop();
  assert.equal(pending.length, 0);
});

test('metrics noteSkipped keeps drift bounded while tick_rate only counts executed ticks', () => {
  const m = new Metrics();
  const base = 1_700_000_040_000;
  for (let i = 0; i < 20; i++) m.observeSchedule(50, base + i * 50);
  // A 500ms stall = 10 missed periods. Real scheduler order: onSkip first
  // (accounts for the dropped wall-clock periods), then the single executed
  // tick records its schedule observation at the same wall time.
  const stallAt = base + 19 * 50 + 500;
  m.noteSkipped(10);
  m.observeSchedule(50, stallAt);
  assert.ok(m.tickLagMs > 100, `expected stall overshoot, got ${m.tickLagMs}`);
  assert.ok(Math.abs(m.tickDriftTicks) < 2, `drift ${m.tickDriftTicks}`);
  assert.equal(m.ticksSkippedTotal, 10);
  const out = m.render();
  assert.match(out, /^aetherfall_ticks_skipped_total 10$/m);
  assert.match(out, /^aetherfall_ticks_catchup_total 0$/m);
});

test('metrics catch-up counter renders', () => {
  const m = new Metrics();
  m.noteCatchUp(2);
  m.noteSkipped(0);
  assert.equal(m.tickCatchUpTotal, 2);
  assert.match(m.render(), /^aetherfall_ticks_catchup_total 2$/m);
});

test('scheduler holds 19-21Hz average over 2s on coarse Windows timers', async () => {
  let ticks = 0;
  const s = new TickScheduler(
    () => {
      ticks++;
    },
    { periodMs: 50, maxCatchUp: 2 },
  );
  const t0 = Date.now();
  s.start();
  await new Promise((r) => setTimeout(r, 2000));
  s.stop();
  const dtSec = (Date.now() - t0) / 1000;
  const hz = ticks / dtSec;
  assert.ok(ticks >= 38 && ticks <= 44, `expected ~40 ticks in 2s, got ${ticks} (${hz.toFixed(2)}Hz)`);
  assert.ok(hz >= 19 && hz <= 21, `expected 19-21Hz average, got ${hz.toFixed(2)}Hz`);
  // No skips on an idle box: the loop is on cadence, not shedding.
  assert.ok(s.ticksSkipped <= 2, `idle run should barely skip, skipped=${s.ticksSkipped}`);
});
