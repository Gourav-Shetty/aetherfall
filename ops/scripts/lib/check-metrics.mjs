// ops/scripts/lib/check-metrics.mjs — validate a live /metrics exposition.
//
// Used by ops/scripts/smoke-test.ps1 and by the CI smoke job so both apply the
// same contract to a running server: every family has well-formed HELP/TYPE,
// every sample line parses, histograms are cumulative, and the gameplay /
// wire / schedule families the dashboards and alerts rely on are all present.
//
// Usage:
//   node ops/scripts/lib/check-metrics.mjs --url http://localhost:9090/metrics
//   node ops/scripts/lib/check-metrics.mjs --file server/metrics.txt
//   node ops/scripts/lib/check-metrics.mjs --url ... --require-active
//
// Exit code 0 when the exposition is valid and every required family is
// present (and, with --require-active, carries a non-zero value).

import { readFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const URL_ = arg('url', 'http://localhost:9090/metrics');
const FILE = arg('file', '');
const REQUIRE_ACTIVE = flag('require-active');

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?[ \t]+(.+?)[ \t]*$/;
const HELP_LINE = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*)[ \t]+(\S.*)$/;
const TYPE_LINE = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*)[ \t]+(counter|gauge|histogram|summary|untyped)$/;
const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped']);

/** Families the ops dashboards, alerts and smoke test depend on. */
const REQUIRED = [
  'aetherfall_info',
  'aetherfall_uptime_seconds',
  'aetherfall_ticks_total',
  'aetherfall_players',
  'aetherfall_players_alive',
  'aetherfall_player_hp_ratio',
  'aetherfall_mobs_alive',
  'aetherfall_mobs_killed_total',
  'aetherfall_mobs_killed_5m',
  'aetherfall_quests_active',
  'aetherfall_parties',
  'aetherfall_anticheat_rejects_total',
  'aetherfall_anticheat_strikes',
  'aetherfall_frames_json_total',
  'aetherfall_frames_binary_total',
  'aetherfall_wire_bytes_total',
  'aetherfall_wire_bytes_per_player_per_sec',
  'aetherfall_snapshot_encode_us_last',
  'aetherfall_tick_duration_histogram_ms',
  'aetherfall_snapshot_duration_histogram_ms',
  'aetherfall_tick_schedule_lag_ms',
  'aetherfall_tick_drift_ticks',
  'aetherfall_errors_total',
  'aetherfall_process_resident_memory_bytes',
  'aetherfall_shard_load_ratio',
  'aetherfall_draining',
];

/** Families that must carry a non-zero value on a healthy live server. */
const ACTIVE = ['aetherfall_ticks_total'];

const errors = [];
const help = new Map();
const type = new Map();
const samples = [];
const buckets = new Map();
const fail = (m) => errors.push(m);

function parseExposition(text) {
  lines(text).forEach((raw, i) => {
    const lineNo = i + 1;
    if (raw.trim() === '') return;
    if (/^#\s*(HELP|TYPE)\b/.test(raw)) {
      const h = HELP_LINE.exec(raw);
      if (h) {
        if (!METRIC_NAME.test(h[1])) fail(`L${lineNo}: bad HELP metric name ${h[1]}`);
        if (help.has(h[1])) fail(`L${lineNo}: duplicate HELP for ${h[1]}`);
        help.set(h[1], h[2]);
        return;
      }
      const t = TYPE_LINE.exec(raw);
      if (!t) { fail(`L${lineNo}: malformed HELP/TYPE line: ${JSON.stringify(raw)}`); return; }
      if (!METRIC_NAME.test(t[1])) fail(`L${lineNo}: bad TYPE metric name ${t[1]}`);
      if (type.has(t[1])) fail(`L${lineNo}: duplicate TYPE for ${t[1]}`);
      if (!TYPES.has(t[2])) fail(`L${lineNo}: invalid TYPE ${t[2]}`);
      if (!help.has(t[1])) fail(`L${lineNo}: TYPE for ${t[1]} without a preceding HELP`);
      type.set(t[1], t[2]);
      return;
    }
    if (raw.startsWith('#')) return;

    const m = SAMPLE.exec(raw);
    if (!m) { fail(`L${lineNo}: not a valid sample line: ${JSON.stringify(raw)}`); return; }
    const [, name, , labelPart, valueText] = m;
    const first = valueText.split(/\s+/)[0];
    const value = Number(first);
    if (!Number.isFinite(value) && !/^(NaN|[+-]Inf)$/.test(first)) {
      fail(`L${lineNo}: value is not a number on ${name}: ${JSON.stringify(valueText)}`);
    }
    const labels = {};
    if (labelPart !== undefined) {
      let k = 0;
      while (k < labelPart.length) {
        while (labelPart[k] === ' ') k++;
        let ln = '';
        while (k < labelPart.length && labelPart[k] !== '=' && labelPart[k] !== ' ') ln += labelPart[k++];
        if (!LABEL_NAME.test(ln)) { fail(`L${lineNo}: bad label name "${ln}" on ${name}`); break; }
        if (labelPart[k] !== '=') { fail(`L${lineNo}: label ${ln} on ${name} has no value`); break; }
        k++;
        while (labelPart[k] === ' ') k++;
        if (labelPart[k] !== '"') { fail(`L${lineNo}: label value must be quoted on ${name}`); break; }
        k++;
        let v = '';
        while (k < labelPart.length && labelPart[k] !== '"') {
          if (labelPart[k] === '\\') { v += labelPart[k + 1] ?? '\\'; k += 2; continue; }
          v += labelPart[k++];
        }
        if (labelPart[k] !== '"') { fail(`L${lineNo}: unterminated label value on ${name}`); break; }
        k++;
        if (ln in labels) fail(`L${lineNo}: duplicate label ${ln} on ${name}`);
        labels[ln] = v;
        while (labelPart[k] === ' ') k++;
        if (k < labelPart.length) {
          if (labelPart[k] !== ',') fail(`L${lineNo}: labels must be comma separated on ${name}`);
          k++;
        }
      }
    }
    samples.push({ name, labels, value, line: lineNo });
    if (labels.le !== undefined && name.endsWith('_bucket')) {
      const arr = buckets.get(name) ?? [];
      arr.push({ le: labels.le, value, line: lineNo });
      buckets.set(name, arr);
    }
  });
  return { help, type, samples, buckets };
}

const lines = (text) => text.split('\n');

async function load() {
  if (FILE) return readFileSync(FILE, 'utf8');
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`GET ${URL_} -> HTTP ${res.status}`);
  return res.text();
}

async function main() {
  let text;
  try {
    text = await load();
  } catch (e) {
    console.log(`not ok 1 - fetch metrics: ${String(e.message ?? e)}`);
    process.exit(1);
  }
  console.log(`# check-metrics source=${FILE || URL_} bytes=${text.length}`);

  const parsed = parseExposition(text);

  for (const family of REQUIRED) {
    if (!type.has(family)) fail(`missing TYPE for required family ${family}`);
    else if (!help.has(family)) fail(`missing HELP for required family ${family}`);
    else if (!parsed.samples.some((s) => s.name === family || s.name.startsWith(`${family}_`))) {
      fail(`required family ${family} emits no samples`);
    }
  }
  if (REQUIRE_ACTIVE) {
    for (const family of ACTIVE) {
      const s = parsed.samples.find((x) => x.name === family);
      if (!s || !(s.value > 0)) fail(`expected ${family} to be active (value > 0), got ${s ? s.value : 'missing'}`);
    }
  }
  for (const [family, t] of parsed.type) {
    if (t !== 'histogram') continue;
    const b = parsed.buckets.get(`${family}_bucket`) ?? [];
    if (b.length === 0) { fail(`histogram ${family} emits no _bucket samples`); continue; }
    if (b[b.length - 1].le !== '+Inf') fail(`histogram ${family} must end its buckets with +Inf`);
    for (let i = 1; i < b.length; i++) {
      const prev = b[i - 1];
      const cur = b[i];
      if (cur.value < prev.value) fail(`histogram ${family} not cumulative at le=${cur.le} (L${cur.line})`);
      if (cur.le !== '+Inf' && Number(cur.le) <= Number(prev.le)) {
        fail(`histogram ${family} buckets out of order at le=${cur.le} (L${cur.line})`);
      }
    }
    const count = parsed.samples.find((s) => s.name === `${family}_count`);
    if (!count) fail(`histogram ${family} is missing ${family}_count`);
    else if (count.value !== b[b.length - 1].value) {
      fail(`histogram ${family} _count (${count.value}) != +Inf bucket (${b[b.length - 1].value})`);
    }
    if (!parsed.samples.some((s) => s.name === `${family}_sum`)) fail(`histogram ${family} is missing ${family}_sum`);
  }

  const unique = [...new Set(errors)];
  if (unique.length === 0) {
    console.log(`ok 1 - exposition valid: ${parsed.type.size} typed families, ${parsed.samples.length} samples`);
    console.log(`# families: ${[...parsed.type.keys()].sort().join(' ')}`);
    process.exit(0);
  }
  console.log(`not ok 1 - ${unique.length} exposition problem(s):`);
  for (const e of unique) console.log(`#   ${e}`);
  process.exit(1);
}

await main();