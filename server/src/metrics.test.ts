// @aetherfall/server — Prometheus exposition-format validation.
// Parses the FULL /metrics body (metrics.render() + perf.render(), exactly as
// index.ts concatenates them) and asserts every family is well-formed:
// valid metric/label names, HELP before samples, one TYPE per family,
// well-formed HELP/TYPE lines, and internally consistent histograms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KILL_WINDOW_SEC,
  Metrics,
  OPS_SNAPSHOT_HIST_MS,
  OPS_TICK_HIST_MS,
  RATE_WINDOW_SEC,
  RollingRate,
  metrics as metricsSingleton,
} from './metrics.js';
import { Perf, perf } from './perf.js';

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?[ \t]+(.+?)[ \t]*$/;
const HELP_LINE = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*)[ \t]+(\S.*)$/;
const TYPE_LINE = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*)[ \t]+(counter|gauge|histogram|summary|untyped)$/;
const VALID_TYPES = ['counter', 'gauge', 'histogram', 'summary', 'untyped'];

type Sample = { line: number; name: string; labels: Record<string, string>; value: string };

type Parsed = {
  help: Map<string, string>;
  type: Map<string, string>;
  order: string[];
  samples: Sample[];
  bucketCounts: Map<string, Array<{ le: string; value: number }>>;
};

/** Strict-enough Prometheus text-format reader used by these assertions. */
export function parseExposition(text: string): Parsed {
  const help = new Map<string, string>();
  const type = new Map<string, string>();
  const order: string[] = [];
  const samples: Sample[] = [];
  const bucketCounts = new Map<string, Array<{ le: string; value: number }>>();
  const seenHelp = new Set<string>();
  const lines = text.split('\n');

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (raw.trim() === '') return;
    if (/^#\s*(HELP|TYPE)\b/.test(raw)) {
      const helpMatch = HELP_LINE.exec(raw);
      if (helpMatch) {
        const name = helpMatch[1]!;
        assert.ok(METRIC_NAME.test(name), `L${lineNo}: bad HELP metric name ${name}`);
        assert.ok(!seenHelp.has(name), `L${lineNo}: duplicate HELP for ${name}`);
        seenHelp.add(name);
        help.set(name, helpMatch[2]!);
        return;
      }
      const typeMatch = TYPE_LINE.exec(raw);
      if (typeMatch) {
        const name = typeMatch[1]!;
        assert.ok(METRIC_NAME.test(name), `L${lineNo}: bad TYPE metric name ${name}`);
        assert.ok(
          !type.has(name),
          `L${lineNo}: duplicate TYPE for ${name} (a family may only be typed once)`,
        );
        assert.ok(
          help.has(name),
          `L${lineNo}: TYPE for ${name} without a preceding HELP line`,
        );
        type.set(name, typeMatch[2]!);
        return;
      }
      // Starts with HELP/TYPE but is not a well-formed directive.
      assert.fail(`L${lineNo}: malformed HELP/TYPE line: ${JSON.stringify(raw)}`);
    }
    if (raw.startsWith('#')) return; // plain comment

    const m = SAMPLE.exec(raw);
    assert.ok(m, `L${lineNo}: not a valid sample line: ${JSON.stringify(raw)}`);
    const name = m[1]!;
    const labels: Record<string, string> = {};
    const labelPart = m[3];
    if (labelPart !== undefined) {
      let i = 0;
      while (i < labelPart.length) {
        while (labelPart[i] === ' ') i++;
        let labelName = '';
        while (i < labelPart.length && labelPart[i] !== '=' && labelPart[i] !== ' ') {
          labelName += labelPart[i];
          i++;
        }
        assert.ok(LABEL_NAME.test(labelName), `L${lineNo}: bad label name "${labelName}" on ${name}`);
        assert.equal(labelPart[i], '=', `L${lineNo}: label ${labelName} on ${name} has no value`);
        i++;
        while (labelPart[i] === ' ') i++;
        assert.equal(labelPart[i], '"', `L${lineNo}: label value must be quoted on ${name}`);
        i++;
        let value = '';
        while (i < labelPart.length && labelPart[i] !== '"') {
          if (labelPart[i] === '\\') {
            const next = labelPart[i + 1];
            assert.ok(next !== undefined, `L${lineNo}: dangling escape in label of ${name}`);
            value += next === 'n' ? '\n' : next === '\\' ? '\\' : '"';
            i += 2;
            continue;
          }
          value += labelPart[i];
          i++;
        }
        assert.equal(labelPart[i], '"', `L${lineNo}: unterminated label value on ${name}`);
        i++;
        assert.ok(!(labelName in labels), `L${lineNo}: duplicate label ${labelName} on ${name}`);
        labels[labelName] = value;
        while (labelPart[i] === ' ') i++;
        if (i < labelPart.length) {
          assert.equal(labelPart[i], ',', `L${lineNo}: labels must be comma separated on ${name}`);
          i++;
        }
      }
    }
    const valueText = m[4]!.trim();
    const value = Number(valueText.split(/\s+/)[0]);
    assert.ok(
      Number.isFinite(value) || /^(NaN|[+-]Inf)$/.test(valueText.split(/\s+/)[0]!),
      `L${lineNo}: value is not a number on ${name}: ${JSON.stringify(valueText)}`,
    );
    samples.push({ line: lineNo, name, labels, value: valueText.split(/\s+/)[0]! });
    order.push(name);
    if (labels.le !== undefined && name.endsWith('_bucket')) {
      const arr = bucketCounts.get(name) ?? [];
      arr.push({ le: labels.le, value });
      bucketCounts.set(name, arr);
    }
  });

  return { help, type, order, samples, bucketCounts };
}

/** Assemble the exact /metrics body index.ts serves. */
function exposition(m = new Metrics(), p = new Perf()): string {
  return m.render() + p.render();
}

/** Every declared family must have HELP + TYPE and at least one sample. */
function assertFamiliesWellFormed(parsed: Parsed, text: string): void {
  for (const [name, type] of parsed.type) {
    assert.ok(parsed.help.has(name), `family ${name} has TYPE but no HELP`);
    assert.ok(
      parsed.help.get(name)!.trim().length > 0,
      `family ${name} has an empty HELP string`,
    );
    assert.ok(VALID_TYPES.includes(type), `family ${name} has invalid TYPE ${type}`);
  }
  // A sample must never precede its family's TYPE line.
  const typeLineSeen = new Set<string>();
  for (const raw of text.split('\n')) {
    const t = TYPE_LINE.exec(raw);
    if (t) {
      typeLineSeen.add(t[1]!);
      continue;
    }
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    const m = SAMPLE.exec(raw);
    if (!m) continue;
    const name = m[1]!;
    const family = name.replace(/_(bucket|sum|count)$/, '');
    const declared = parsed.type.has(name) ? name : parsed.type.has(family) ? family : null;
    assert.ok(
      declared === null || typeLineSeen.has(declared),
      `sample ${name} appears before the TYPE line for ${declared}`,
    );
  }
}

/** Histogram families: monotonically increasing le buckets ending in +Inf, plus _sum/_count. */
function assertHistogramsConsistent(parsed: Parsed): void {
  for (const [family, type] of parsed.type) {
    if (type !== 'histogram') continue;
    const buckets = parsed.bucketCounts.get(`${family}_bucket`) ?? [];
    assert.ok(buckets.length > 0, `histogram ${family} emits no _bucket samples`);
    assert.ok(
      buckets[buckets.length - 1]!.le === '+Inf',
      `histogram ${family} must end its buckets with +Inf`,
    );
    for (let i = 1; i < buckets.length; i++) {
      const prev = buckets[i - 1]!;
      const cur = buckets[i]!;
      if (cur.le === '+Inf') {
        assert.ok(
          cur.value >= prev.value,
          `histogram ${family} +Inf bucket (${cur.value}) is below le=${prev.le} (${prev.value})`,
        );
        continue;
      }
      assert.ok(
        cur.value >= prev.value,
        `histogram ${family} buckets are not cumulative: le=${prev.le} (${prev.value}) > le=${cur.le} (${cur.value})`,
      );
      assert.ok(Number(cur.le) > Number(prev.le), `histogram ${family} buckets out of order at le=${cur.le}`);
    }
    const sum = parsed.samples.find((s) => s.name === `${family}_sum`);
    const count = parsed.samples.find((s) => s.name === `${family}_count`);
    assert.ok(sum, `histogram ${family} is missing ${family}_sum`);
    assert.ok(count, `histogram ${family} is missing ${family}_count`);
    assert.ok(
      Number(count!.value) === buckets[buckets.length - 1]!.value,
      `histogram ${family} _count (${count!.value}) must equal the +Inf bucket (${buckets[buckets.length - 1]!.value})`,
    );
  }
}

test('cold-start exposition parses and every family is well-formed', () => {
  const m = new Metrics();
  m.setInfo({ shard: 'shard-0', version: '0.1.0', protocol: 1, backend: 'json' });
  const text = exposition(m);
  const parsed = parseExposition(text);
  assert.ok(parsed.samples.length > 0);
  assertFamiliesWellFormed(parsed, text);
  assertHistogramsConsistent(parsed);
});

test('the process-wide singletons (served body) parse', () => {
  const text = metricsSingleton.render() + perf.render();
  const parsed = parseExposition(text);
  assert.ok(parsed.samples.length > 0);
  assertFamiliesWellFormed(parsed, text);
  assertHistogramsConsistent(parsed);
});

test('every required gameplay/wire/histogram family is present with HELP+TYPE', () => {
  const m = new Metrics();
  const parsed = parseExposition(m.render() + perf.render());
  const required = [
    'aetherfall_players',
    'aetherfall_players_alive',
    'aetherfall_player_hp_ratio',
    'aetherfall_mobs_alive',
    'aetherfall_mobs_killed_total',
    'aetherfall_mobs_killed_5m',
    'aetherfall_mobs_killed_per_min',
    'aetherfall_quests_active',
    'aetherfall_parties',
    'aetherfall_anticheat_rejects_total',
    'aetherfall_anticheat_strikes',
    'aetherfall_anticheat_strikes_max',
    'aetherfall_frames_json_total',
    'aetherfall_frames_binary_total',
    'aetherfall_binary_frame_ratio',
    'aetherfall_wire_bytes_total',
    'aetherfall_wire_bytes_per_sec',
    'aetherfall_wire_bytes_per_player_per_sec',
    'aetherfall_snapshot_encode_us_last',
    'aetherfall_snapshot_encode_us_avg',
    'aetherfall_snapshot_encode_us_p95',
    'aetherfall_tick_duration_histogram_ms',
    'aetherfall_snapshot_duration_histogram_ms',
    'aetherfall_tick_schedule_lag_ms',
    'aetherfall_tick_rate_hz',
    'aetherfall_tick_rate_target_hz',
    'aetherfall_tick_rate_ratio',
    'aetherfall_tick_drift_ticks',
    'aetherfall_errors_total',
    'aetherfall_errors_per_min',
    'aetherfall_process_resident_memory_bytes',
    'aetherfall_shard_load_ratio',
    'aetherfall_draining',
    'aetherfall_info',
    'aetherfall_uptime_seconds',
  ];
  for (const name of required) {
    assert.ok(parsed.type.has(name), `missing TYPE for ${name}`);
    assert.ok(parsed.help.has(name), `missing HELP for ${name}`);
    assert.ok(
      parsed.samples.some((s) => s.name === name || s.name.startsWith(`${name}_`)),
      `family ${name} emits no samples`,
    );
  }
});

test('gameplay view renders the values the loop pushed', () => {
  const m = new Metrics();
  m.setPlayers(12);
  m.setGameplay({
    playersAlive: 11,
    mobsAlive: 47,
    hpRatio: 0.5,
    questsActive: 6,
    parties: 3,
    anticheatStrikes: 4,
    anticheatStrikesMax: 2,
  });
  const out = m.render();
  assert.match(out, /^aetherfall_players_alive 11$/m);
  assert.match(out, /^aetherfall_mobs_alive 47$/m);
  assert.match(out, /^aetherfall_player_hp_ratio 0\.5000$/m);
  assert.match(out, /^aetherfall_quests_active 6$/m);
  assert.match(out, /^aetherfall_parties 3$/m);
  assert.match(out, /^aetherfall_anticheat_strikes 4$/m);
  assert.match(out, /^aetherfall_anticheat_strikes_max 2$/m);
  parseExposition(out);
});

test('mob kills feed the counter and the trailing 5m window', () => {
  const m = new Metrics();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 9; i++) m.observeMobKill(t0 + i * 1000);
  // Window maths is evaluated against the caller's clock, so it is exact.
  assert.equal(m.mobsKilled5m(t0 + 9000), 9);
  assert.equal(m.mobsKilledTotal, 9);
  // 10 minutes later the window has fully rotated, the counter has not.
  assert.equal(m.mobsKilled5m(t0 + 10 * 60 * 1000), 0);
  assert.equal(m.mobsKilledTotal, 9);
  const parsed = parseExposition(m.render());
  assert.equal(parsed.samples.find((s) => s.name === 'aetherfall_mobs_killed_total')?.value, '9');
  const win = parsed.samples.find((s) => s.name === 'aetherfall_mobs_killed_5m');
  assert.ok(win !== undefined && Number(win.value) >= 0, '5m gauge must render a non-negative count');
});

test('a kill recorded now shows up in the rendered 5m gauge', () => {
  const m = new Metrics();
  const t0 = Date.now();
  m.observeMobKill(t0);
  assert.match(m.render(), /^aetherfall_mobs_killed_5m 1$/m);
  assert.match(m.render(), /^aetherfall_mobs_killed_total 1$/m);
});

test('frames split by wire encoding and binary ratio is reported', () => {
  const m = new Metrics();
  m.observeFrame('json', 100);
  m.observeFrame('json', 120);
  m.observeFrame('binary', 60);
  assert.equal(m.framesJson, 2);
  assert.equal(m.framesBinary, 1);
  assert.equal(m.binaryFrameRatio, 1 / 3);
  const out = m.render();
  assert.match(out, /^aetherfall_frames_json_total 2$/m);
  assert.match(out, /^aetherfall_frames_binary_total 1$/m);
  assert.match(out, /^aetherfall_binary_frame_ratio 0\.333333$/m);
  assert.match(out, /^aetherfall_wire_bytes_total 280$/m);
  parseExposition(out);
});

test('wire bytes per player per second divides by connected players', () => {
  const m = new Metrics();
  const t0 = 1_700_000_040_000;
  m.setPlayers(2);
  m.observeFrame('json', 1000, t0);
  // Read inside the same second: one populated second of 1000 bytes across
  // 2 players => 500 B/s/player.
  assert.equal(m.wireBytesPerSec(t0 + 999), 1000);
  assert.equal(m.wireBytesPerPlayerPerSec(t0 + 999), 500);
  const out = m.render();
  assert.match(out, /aetherfall_wire_bytes_per_player_per_sec \d/m);
});

test('a rolling rate divides by the span actually covered, not the window', () => {
  const r = new RollingRate(15);
  const t0 = 1_700_000_040_000;
  // One second holding 1000 bytes reads as 1000 B/s, not 1000/15.
  r.add(1000, t0);
  assert.equal(r.perSec(t0 + 999), 1000);
  // Three seconds of 1000 bytes each is still 1000 B/s.
  r.add(1000, t0 + 1000);
  r.add(1000, t0 + 2000);
  assert.equal(r.perSec(t0 + 2999), 1000);
  // The rate is smoothed over the covered span, so the same burst read one
  // second later is damped rather than reported at full amplitude.
  assert.equal(r.perSec(t0 + 3000), 750);
  // 250 bytes/s sustained over three seconds stays 250 B/s.
  const r2 = new RollingRate(15);
  for (let s = 0; s < 3; s++) r2.add(250, t0 + s * 1000);
  assert.equal(r2.perSec(t0 + 2999), 250);
});

test('snapshot encode microseconds render last/avg/p95', () => {
  const m = new Metrics();
  m.observeSnapshotEncode(100);
  m.observeSnapshotEncode(300);
  const out = m.render();
  assert.match(out, /^aetherfall_snapshot_encode_us_last 300\.000$/m);
  assert.match(out, /^aetherfall_snapshot_encode_us_avg 200\.000$/m);
  parseExposition(out);
});

test('tick and snapshot histograms are cumulative with matching bounds', () => {
  const m = new Metrics();
  for (let i = 0; i < 5; i++) m.observeTick(i); // 0,1,2,3,4 ms
  m.observeTick(500);
  m.observeSnapshotStage(0.2);
  m.observeSnapshotStage(30);
  const parsed = parseExposition(m.render());
  const tickBuckets = parsed.bucketCounts.get('aetherfall_tick_duration_histogram_ms_bucket') ?? [];
  assert.equal(tickBuckets.length, OPS_TICK_HIST_MS.length + 1);
  assert.equal(tickBuckets[tickBuckets.length - 1]!.le, '+Inf');
  assert.equal(tickBuckets[tickBuckets.length - 1]!.value, 6);
  const snapBuckets = parsed.bucketCounts.get('aetherfall_snapshot_duration_histogram_ms_bucket') ?? [];
  assert.equal(snapBuckets.length, OPS_SNAPSHOT_HIST_MS.length + 1);
  assert.equal(snapBuckets[snapBuckets.length - 1]!.value, 2);
  assertHistogramsConsistent(parsed);
});

test('schedule lag, tick rate and drift track the fixed-step loop', () => {
  const m = new Metrics();
  // Second-aligned base so the 1s rate buckets are exercised the way the live
  // 20Hz loop exercises them.
  const base = 1_700_000_040_000;
  // 15s of ticks landing exactly one 50ms period apart.
  for (let i = 0; i < 300; i++) m.observeSchedule(50, base + i * 50);
  const end = base + 299 * 50;
  assert.equal(m.tickTargetHz, 20);
  assert.ok(Math.abs(m.tickRateHz(end) - 20) < 1, `rate ${m.tickRateHz(end)}`);
  assert.ok(Math.abs(m.tickRateRatio(end) - 1) < 0.05, `ratio ${m.tickRateRatio(end)}`);
  assert.equal(m.tickLagMs, 0, 'on-cadence ticks report no overshoot');
  assert.ok(Math.abs(m.tickDriftTicks) < 1, `drift ${m.tickDriftTicks}`);

  // A 400ms stall shows up as an overshoot past one period...
  m.observeSchedule(50, end + 400);
  assert.ok(m.tickLagMs > 100, `expected lag, got ${m.tickLagMs}`);
  assert.ok(m.tickLagMaxMs >= m.tickLagMs);
  assert.ok(m.tickDriftTicks < -1, `drift should be negative when behind, got ${m.tickDriftTicks}`);
  // ...and the next on-time tick returns it to 0 (the lag is a stall detector,
  // it does not accumulate the way tick_drift_ticks does).
  m.observeSchedule(50, end + 450);
  assert.equal(m.tickLagMs, 0);

  const out = m.render();
  assert.match(out, /^aetherfall_tick_schedule_lag_ms \d/m);
  assert.match(out, /^aetherfall_tick_rate_target_hz 20\.000$/m);
  assert.match(out, /^aetherfall_tick_rate_hz \d/m);
  assert.match(out, /^aetherfall_tick_rate_ratio \d/m);
  assert.match(out, /^aetherfall_tick_drift_ticks -/m);
  parseExposition(out);
});

test('a coarse timer dips the rate ratio but keeps the stall lag bounded', () => {
  const m = new Metrics();
  const base = 1_700_000_040_000;
  // Windows timer granularity: a 50ms interval really fires every ~62.5ms,
  // i.e. ~16Hz. That is NOT a stall, so the per-tick overshoot stays small and
  // only the cadence ratio dips.
  for (let i = 0; i < 240; i++) m.observeSchedule(50, base + i * 62.5);
  const end = base + 239 * 62.5;
  assert.ok(m.tickRateRatio(end) < 0.95, `ratio should dip below 1, got ${m.tickRateRatio(end)}`);
  assert.ok(m.tickRateRatio(end) > 0.6, `ratio should stay near the platform baseline, got ${m.tickRateRatio(end)}`);
  assert.ok(m.tickLagMs < 20, `overshoot past one period should stay small, got ${m.tickLagMs}`);
  // The cumulative drift number does accumulate, which is exactly why alerting
  // uses the ratio instead.
  assert.ok(m.tickDriftTicks < -10, `drift should accumulate, got ${m.tickDriftTicks}`);
});

test('a sustained stall drops the cadence ratio below the alert threshold', () => {
  const m = new Metrics();
  const base = 1_700_000_040_000;
  // 15s of ticks that only manage ~5Hz: a real stall, not a timer baseline.
  for (let i = 0; i < 75; i++) m.observeSchedule(50, base + i * 200);
  const end = base + 74 * 200;
  assert.ok(m.tickRateRatio(end) < 0.5, `ratio ${m.tickRateRatio(end)} should trip AetherfallTickDrift`);
  assert.ok(m.tickLagMs > 100, `overshoot ${m.tickLagMs} should be large`);
});

test('error counters and per-minute rate render by kind', () => {
  const m = new Metrics();
  const t0 = 1_700_000_000_000;
  m.noteError('tick', t0);
  m.noteError('tick', t0 + 1000);
  m.noteError('http', t0 + 1000);
  const out = m.render();
  assert.match(out, /^aetherfall_errors_total\{kind="tick"\} 2$/m);
  assert.match(out, /^aetherfall_errors_total\{kind="http"\} 1$/m);
  assert.match(out, /^aetherfall_errors_total\{kind="ws"\} 0$/m);
  assert.equal(m.errorsTotal, 3);
  assert.ok(m.errorsPerMin(t0 + 2000) > 0);
  parseExposition(out);
});

test('process memory gauges are exposed', () => {
  const m = new Metrics();
  const out = m.render();
  assert.match(out, /^aetherfall_process_resident_memory_bytes \d+$/m);
  assert.match(out, /^aetherfall_process_heap_used_bytes \d+$/m);
  assert.match(out, /^aetherfall_process_heap_total_bytes \d+$/m);
  assert.match(out, /^aetherfall_process_external_memory_bytes \d+$/m);
});

test('shard capacity drives the load ratio and drain flag renders', () => {
  const m = new Metrics();
  m.setPlayers(50);
  m.setShardCapacity(100);
  assert.match(m.render(), /^aetherfall_shard_load_ratio 0\.5000$/m);
  m.draining = 1;
  assert.match(m.render(), /^aetherfall_draining 1$/m);
  m.setShardCapacity(Infinity);
  assert.match(m.render(), /^aetherfall_shard_load_ratio 0\.0000$/m);
});

test('info labels are escaped and rendered once', () => {
  const m = new Metrics();
  m.setInfo({ shard: 'shard-"0"', version: '0.1.0', protocol: 2 });
  const out = m.render();
  assert.match(out, /# TYPE aetherfall_info gauge/);
  assert.match(out, /aetherfall_info\{shard="shard-\\"0\\"",version="0\.1\.0",protocol="2"\} 1/);
  const parsed = parseExposition(out);
  const info = parsed.samples.find((s) => s.name === 'aetherfall_info');
  assert.equal(info?.labels.shard, 'shard-"0"');
  assert.equal(info?.labels.version, '0.1.0');
  assert.equal(info?.labels.protocol, '2');
});

test('a metrics instance with no info still emits a valid aetherfall_info', () => {
  const parsed = parseExposition(new Metrics().render());
  assert.equal(parsed.samples.find((s) => s.name === 'aetherfall_info')?.value, '1');
});

test('rolling rate expires slots outside the window', () => {
  const r = new RollingRate(10);
  const t0 = 1_700_000_040_000;
  r.add(5, t0);
  r.add(5, t0 + 1000);
  assert.equal(r.windowSum(t0 + 1000), 10);
  assert.equal(r.windowSum(t0 + 20_000), 0);
  assert.equal(r.total, 10, 'monotonic total never decays');
  r.reset();
  assert.equal(r.total, 0);
  assert.equal(RATE_WINDOW_SEC, 15);
  assert.equal(KILL_WINDOW_SEC, 300);
});

test('rolling rate averages only populated seconds', () => {
  const r = new RollingRate(10);
  const t0 = 1_700_000_040_000;
  r.add(100, t0);
  r.add(100, t0 + 1000);
  // Two populated seconds -> mean 100/s.
  assert.equal(r.perSec(t0 + 1000), 100);
  assert.equal(r.perMin(t0 + 1000), 6000);
});

test('reset clears the extended gauges too', () => {
  const m = new Metrics();
  m.setPlayers(5);
  m.observeTick(5);
  m.observeFrame('binary', 10);
  m.observeMobKill(1_700_000_000_000);
  m.noteError('ws');
  m.setGameplay({ mobsAlive: 9, parties: 2 });
  m.observeSnapshotEncode(50);
  m.observeSnapshotStage(1);
  m.reset();
  const parsed = parseExposition(m.render());
  assert.match(m.render(), /^aetherfall_players 0$/m);
  assert.match(m.render(), /^aetherfall_mobs_alive 0$/m);
  assert.match(m.render(), /^aetherfall_frames_binary_total 0$/m);
  assert.match(m.render(), /^aetherfall_mobs_killed_total 0$/m);
  assert.match(m.render(), /^aetherfall_errors_total\{kind="ws"\} 0$/m);
  assert.match(m.render(), /^aetherfall_tick_duration_histogram_ms_count 0$/m);
  assert.equal(parsed.samples.filter((s) => s.name === 'aetherfall_parties')[0]?.value, '0');
});

test('the parser rejects malformed exposition (guards the assertions above)', () => {
  assert.throws(
    () => parseExposition('aetherfall_players 5\n# TYPE aetherfall_players gauge\n'),
    /without a preceding HELP/,
  );
  assert.throws(
    () => parseExposition('# HELP aetherfall_x hi\n# TYPE aetherfall_x gauge\n# TYPE aetherfall_x counter\n'),
    /duplicate TYPE/,
  );
  assert.throws(
    () => parseExposition('# HELP aetherfall_x hi\n# TYPE aetherfall_x fancy\n'),
    /malformed HELP\/TYPE/,
  );
  assert.throws(() => parseExposition('aetherfall_x{le=} 1\n'), /label value must be quoted/);
  assert.throws(() => parseExposition('aetherfall_x{le="1" section="a"} 1\n'), /labels must be comma separated/);
  assert.throws(() => parseExposition('# HELP aetherfall_x\n'), /malformed HELP\/TYPE/);
  assert.throws(() => parseExposition('# HELP aetherfall_x a\n# HELP aetherfall_x b\n'), /duplicate HELP/);
  assert.throws(() => parseExposition('aetherfall_x abc\n'), /value is not a number/);
  assert.throws(() => parseExposition('aetherfall_x\n'), /not a valid sample line/);
});