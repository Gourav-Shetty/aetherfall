// Replay analytics tests — determinism, metric math, container round-trip.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  parseNdjson,
  parseAnalyzeArgs,
  renderHeatmapSvg,
  renderTimelineSvg,
  reportToCsv,
  playersToCsv,
  round,
  stableStringify,
  summarize,
  CSV_HEADER,
  DEFAULT_OPTIONS,
  loadRecording,
  heatColor,
  fitArena,
} from './analyze.js';
import { decodeContainer, encodeContainer, isContainer } from './container.js';
import type { RecordingRecord } from './container.js';
import type { EntitySnapshot } from '@aetherfall/shared';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '..', 'fixtures', 'mini.ndjson');

/** Scratch dir for temp-file determinism checks; cleaned per test. */
const scratch = mkdtempSync(resolve(tmpdir(), 'aetherfall-analyze-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const tmpDir = (): string => scratch;

function fixtureText(): string {
  return readFileSync(FIXTURE, 'utf8');
}

function fixtureRecords(): RecordingRecord[] {
  return parseNdjson(fixtureText()).records;
}

describe('analyze args', () => {
  it('defaults and --flag=value forms', () => {
    const a = parseAnalyzeArgs(['--in', 'r.ndjson']);
    assert.equal(a.input, 'r.ndjson');
    assert.equal(a.cell, DEFAULT_OPTIONS.cell);
    assert.equal(a.bucketMs, DEFAULT_OPTIONS.bucketMs);
    assert.equal(a.quiet, false);
    const b = parseAnalyzeArgs(['--cell=8', '--bucket-ms=2500', 'positional.ndjson']);
    assert.equal(b.cell, 8);
    assert.equal(b.bucketMs, 2500);
    assert.equal(b.input, 'positional.ndjson');
  });

  it('clamps out-of-range options and honors env', () => {
    const a = parseAnalyzeArgs(['--in', 'x', '--cell', '0', '--bucket-ms', '-5'], {});
    assert.equal(a.cell, 1);
    assert.equal(a.bucketMs, 100);
    const e = parseAnalyzeArgs([], { REPLAY_IN: 'env.ndjson', REPLAY_QUIET: '1' });
    assert.equal(e.input, 'env.ndjson');
    assert.equal(e.quiet, true);
  });
});

describe('analyze ndjson parsing', () => {
  it('skips malformed lines instead of throwing', () => {
    const { records, malformedLines } = parseNdjson(
      '{"t":0,"msg":{"t":"snapshot","tick":1,"entities":[],"removed":[]}}\n' +
      'not json\n' +
      '\n' +
      '{"t":5,"msg":{"t":"chat","from":"a","text":"hi","channel":"say"}}\n',
    );
    assert.equal(records.length, 2);
    assert.equal(malformedLines, 1);
    assert.equal(records[0]!.t, 0);
    assert.equal(records[1]!.t, 5);
  });

  it('fixture is sorted and non-empty', () => {
    const recs = fixtureRecords();
    assert.ok(recs.length >= 10);
    for (let i = 1; i < recs.length; i++) {
      assert.ok(recs[i]!.t >= recs[i - 1]!.t, 'fixture must be time-ordered');
    }
  });
});

describe('analyze metrics', () => {
  const report = analyze(fixtureRecords(), {}, { source: 'mini.ndjson' });

  it('identifies the recording client from the welcome record', () => {
    assert.deepEqual(report.self, { id: 7, name: 'scout' });
    assert.equal(report.frames, 8);
    assert.equal(report.records, 14);
    assert.equal(report.events, 5);
    assert.equal(report.chats, 1);
    assert.equal(report.durationMs, 2400);
    assert.deepEqual(report.tick, { first: 100, last: 124 });
  });

  it('computes speed, distance and time-to-first-kill', () => {
    // Inter-frame speeds: 2.0u/100ms = 20u/s, sqrt(5)u/100ms = 22.36u/s, then
    // holds at 0. The 1200ms stall between t=400 and t=1600 is not a movement
    // sample (a stall would fake a speed), and the post-respawn jump to (50,50)
    // is a teleport, so both are excluded.
    assert.equal(report.movement.samples, 5);
    assert.equal(report.movement.excludedJumps, 0);
    assert.equal(report.movement.distanceUnits, round(2 + Math.sqrt(5)));
    assert.equal(report.movement.avgSpeed, round((20 + 10 * Math.sqrt(5)) / 5));
    assert.equal(report.movement.maxSpeed, round(10 * Math.sqrt(5)));
    assert.equal(report.movement.p95Speed, round(10 * Math.sqrt(5)));
    assert.equal(report.movement.movingFraction, round(2 / 5));
    assert.equal(report.combat.timeToFirstKillMs, 300);
    assert.equal(report.combat.firstKillAtMs, 300);
    assert.equal(report.combat.kills, 1);
  });

  it('tracks deaths and damage per player', () => {
    assert.equal(report.combat.deaths, 1);
    assert.equal(report.combat.damageDealt, 36);
    assert.equal(report.combat.damageTaken, 30);
    assert.equal(report.combat.uncreditedDamage, 0);
    const self = report.players.find((p) => p.id === 7);
    assert.ok(self);
    assert.equal(self.kills, 1);
    assert.equal(self.deaths, 1);
    assert.equal(self.damageDealt, 36);
    assert.equal(self.damageTaken, 30);
    assert.equal(self.self, true);
  });

  it('buckets mob density over time', () => {
    assert.equal(report.mobDensity.bucketMs, 1000);
    assert.equal(report.mobDensity.buckets.length, 3);
    assert.equal(report.mobDensity.peak, 1);
    assert.equal(report.mobDensity.peakAtMs, 0);
    // bucket 0: 4 frames, each with 1 mob visible -> avg 1
    assert.equal(report.mobDensity.buckets[0]!.frames, 4);
    assert.equal(report.mobDensity.buckets[0]!.mobs, 1);
    // bucket 1: 3 frames with 1/0/0 mobs -> avg 1/3
    assert.equal(report.mobDensity.buckets[1]!.frames, 3);
    assert.equal(report.mobDensity.buckets[1]!.mobs, round(1 / 3));
    assert.equal(report.mobDensity.buckets[1]!.peakMobs, 1);
    // bucket 2: the single post-respawn frame
    assert.equal(report.mobDensity.buckets[2]!.frames, 1);
    assert.equal(report.mobDensity.buckets[2]!.mobs, 1);
  });

  it('detects disconnect points from gaps and the client leaving', () => {
    const gap = report.disconnects.find((d) => d.reason === 'snapshot-gap');
    assert.ok(gap, 'expected a snapshot-gap disconnect');
    assert.equal(gap.gapMs, 1200);
    const left = report.disconnects.find((d) => d.reason === 'player-left');
    assert.ok(left, 'expected the client despawn to count as a disconnect');
    // Sorted by tMs.
    const times = report.disconnects.map((d) => d.tMs);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it('routes other players leaving to playerExits, not client disconnects', () => {
    const recs: RecordingRecord[] = [
      { t: 0, msg: { t: 'welcome', id: 7, tick: 1, snapshot: [] } },
      { t: 100, msg: { t: 'event', kind: 'despawn', payload: { id: 42 } } },
    ];
    const r = analyze(recs, {}, { source: 'other.ndjson' });
    assert.equal(r.disconnects.length, 0);
    assert.equal(r.playerExits.length, 1);
    assert.deepEqual(r.playerExits[0], { tMs: 100, id: 42, reason: 'despawn' });
  });

  it('excludes stall and teleport artifacts from speed stats', () => {
    const at = (x: number, y: number): EntitySnapshot => ({
      id: 1, kind: 'player', p: { x, y }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100,
    });
    const recs: RecordingRecord[] = [
      { t: 0, msg: { t: 'welcome', id: 1, tick: 1, snapshot: [at(10, 10)] } },
      { t: 100, msg: { t: 'snapshot', tick: 2, entities: [at(10.8, 10)], removed: [] } },
      { t: 200, msg: { t: 'snapshot', tick: 3, entities: [at(11.6, 10)], removed: [] } },
      // 5s stall: 0.8u over 5s would otherwise read as 0.16 u/s of drift.
      { t: 5200, msg: { t: 'snapshot', tick: 4, entities: [at(12.4, 10)], removed: [] } },
      { t: 5300, msg: { t: 'snapshot', tick: 5, entities: [at(90, 90)], removed: [] } },
    ];
    const r = analyze(recs, {}, { source: 'jumps.ndjson' });
    // Only the two 100ms intervals count; the stall and the 110u jump do not.
    assert.equal(r.movement.samples, 2);
    assert.equal(r.movement.excludedJumps, 1);
    assert.equal(r.movement.maxSpeed, 8);
    assert.equal(r.movement.distanceUnits, round(1.6));
  });

  it('drops a displacement that is inside one frame but absurdly fast', () => {
    const at = (x: number, y: number): EntitySnapshot => ({
      id: 1, kind: 'player', p: { x, y }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100,
    });
    const recs: RecordingRecord[] = [
      { t: 0, msg: { t: 'welcome', id: 1, tick: 1, snapshot: [at(10, 10)] } },
      { t: 100, msg: { t: 'snapshot', tick: 2, entities: [at(10.4, 10)], removed: [] } },
      // 20u in one 100ms frame = 200 u/s: under the 32u jump gate but way over
      // the speed band, so only the speed band catches this one.
      { t: 200, msg: { t: 'snapshot', tick: 3, entities: [at(30.4, 10)], removed: [] } },
      { t: 300, msg: { t: 'snapshot', tick: 4, entities: [at(30.8, 10)], removed: [] } },
    ];
    const r = analyze(recs, {}, { source: 'fast.ndjson' });
    assert.equal(r.movement.excludedJumps, 1);
    assert.equal(r.movement.samples, 2);
    assert.equal(r.movement.maxSpeed, 4);
    assert.equal(r.movement.distanceUnits, round(0.8));
  });

  it('auto-fits the heatmap grid to the recorded positions', () => {
    // Fixture spans x 20..50, y 20..50 -> floor/ceil to 4u cells: 8x8.
    assert.equal(report.heatmap.cols, 8);
    assert.equal(report.heatmap.rows, 8);
    assert.deepEqual(report.heatmap.origin, { x: 20, y: 20 });
    // One player sample per frame that contains the player.
    assert.equal(report.heatmap.playerGrid.reduce((a, b) => a + b, 0), 8);
    assert.equal(report.heatmap.totalPlayerSamples, 8);
    assert.ok(report.heatmap.occupiedCells <= 625);
    // topCells are ordered by player samples desc.
    const tots = report.heatmap.topCells.map((c) => c.players);
    assert.deepEqual(tots, [...tots].sort((a, b) => b - a));
  });

  it('counts event kinds and mob lifecycle', () => {
    assert.equal(report.eventCounts['mob-die'], 1);
    assert.equal(report.eventCounts['mob-spawn'], 1);
    assert.equal(report.eventCounts.respawn, 1);
    assert.equal(report.eventCounts.despawn, 1);
    assert.equal(report.eventCounts['mob-aggro'], 1);
    assert.equal(report.combat.mobSpawns, 1);
    assert.equal(report.combat.mobsKilled, 1);
  });

  it('infers a kill from a mob reaching 0 HP with no mob-die event', () => {
    // AI-NPC deaths broadcast no `mob-die`, so the snapshot HP drop is the only
    // evidence. The player is inside the credit radius, so the kill is credited.
    const at = (id: number, kind: 'player' | 'mob', x: number, hp: number, maxHp: number): EntitySnapshot => ({
      id, kind, p: { x, y: 0 }, v: { x: 0, y: 0 }, hp, maxHp,
    });
    const recs: RecordingRecord[] = [
      { t: 0, msg: { t: 'welcome', id: 1, tick: 1, snapshot: [at(1, 'player', 10, 100, 100), at(900, 'mob', 11, 12, 60)] } },
      { t: 100, msg: { t: 'snapshot', tick: 2, entities: [at(1, 'player', 10, 100, 100), at(900, 'mob', 11, 0, 60)], removed: [] } },
    ];
    const r = analyze(recs, {}, { source: 'nokill.ndjson' });
    assert.equal(r.combat.mobsKilled, 0); // no mob-die event
    assert.equal(r.combat.mobDeathsObserved, 1);
    assert.equal(r.combat.kills, 1); // inferred and credited
    assert.equal(r.combat.damageDealt, 12);
    assert.equal(r.combat.timeToFirstKillMs, 100);
  });

  it('leaves damage uncredited when no player is in range', () => {
    const at = (id: number, kind: 'player' | 'mob', x: number, hp: number, maxHp: number): EntitySnapshot => ({
      id, kind, p: { x, y: 0 }, v: { x: 0, y: 0 }, hp, maxHp,
    });
    const recs: RecordingRecord[] = [
      { t: 0, msg: { t: 'welcome', id: 1, tick: 1, snapshot: [at(1, 'player', 10, 100, 100), at(900, 'mob', 80, 60, 60)] } },
      { t: 100, msg: { t: 'snapshot', tick: 2, entities: [at(1, 'player', 10, 100, 100), at(900, 'mob', 80, 48, 60)], removed: [] } },
    ];
    const r = analyze(recs, {}, { source: 'far.ndjson' });
    assert.equal(r.combat.damageDealt, 0);
    assert.equal(r.combat.uncreditedDamage, 12);
    assert.equal(r.combat.kills, 0);
    assert.ok(r.warnings.some((w) => w.includes('could not be attributed')));
  });

  it('summarize renders without throwing', () => {
    const lines = summarize(report);
    assert.ok(lines.some((l) => l.includes('combat')));
    assert.ok(lines.every((l) => typeof l === 'string'));
  });
});

describe('analyze determinism', () => {
  it('same input -> byte-identical JSON and CSV', () => {
    const a = analyze(fixtureRecords(), {}, { source: 'mini.ndjson' });
    const b = analyze(fixtureRecords(), {}, { source: 'mini.ndjson' });
    assert.equal(stableStringify(a), stableStringify(b));
    assert.equal(reportToCsv(a), reportToCsv(b));
    assert.equal(playersToCsv(a), playersToCsv(b));
    assert.equal(renderHeatmapSvg(a), renderHeatmapSvg(b));
    assert.equal(renderTimelineSvg(a), renderTimelineSvg(b));
  });

  it('stableStringify sorts keys and formats deterministically', () => {
    const s = stableStringify({ b: 1, a: { d: 2, c: [3, 1] } });
    assert.equal(s, '{\n  "a": {\n    "c": [\n      3,\n      1\n    ],\n    "d": 2\n  },\n  "b": 1\n}\n');
    // Integral floats stay integral; non-integral round to fixed precision.
    assert.ok(!stableStringify({ v: 0.1 + 0.2 }).includes('3.0000'));
  });

  it('round() normalizes -0 and non-finite values', () => {
    assert.equal(round(-0), 0);
    assert.equal(round(NaN), 0);
    assert.equal(round(Infinity), 0);
    assert.equal(round(1.23456789, 2), 1.23);
  });

  it('loadRecording sorts records, so file order does not change the report', () => {
    const tmp = resolve(tmpDir(), 'shuffled.ndjson');
    const lines = fixtureText().trim().split('\n');
    writeFileSync(tmp, [...lines].reverse().join('\n') + '\n');
    const sorted = loadRecording(FIXTURE);
    const shuffled = loadRecording(tmp);
    rmSync(tmp, { force: true });
    assert.equal(stableStringify(analyze(sorted.records, {}, { source: 'mini.ndjson' })),
      stableStringify(analyze(shuffled.records, {}, { source: 'mini.ndjson' })));
  });

  it('cell size changes the grid but not the aggregates', () => {
    const fine = analyze(fixtureRecords(), { cell: 2 }, { source: 'mini.ndjson' });
    const coarse = analyze(fixtureRecords(), { cell: 4 }, { source: 'mini.ndjson' });
    assert.equal(fine.heatmap.cols, 15); // 30u span / 2u cells
    assert.equal(coarse.heatmap.cols, 8);
    assert.equal(fine.heatmap.totalPlayerSamples, coarse.heatmap.totalPlayerSamples);
    assert.equal(fine.movement.distanceUnits, coarse.movement.distanceUnits);
    assert.equal(fine.combat.damageDealt, coarse.combat.damageDealt);
  });

  it('an explicit --arena pins the grid and clips out-of-bounds samples', () => {
    const pinned = analyze(fixtureRecords(), { arena: { minX: 0, minY: 0, maxX: 100, maxY: 100 } },
      { source: 'mini.ndjson' });
    assert.equal(pinned.heatmap.cols, 25);
    assert.equal(pinned.heatmap.origin.x, 0);
    // Every fixture position is inside 0..100, so nothing is dropped.
    assert.equal(pinned.heatmap.totalPlayerSamples, 8);
    const tiny = analyze(fixtureRecords(), { arena: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { source: 'mini.ndjson' });
    assert.ok(tiny.warnings.some((w) => w.includes('outside arena bounds')));
    assert.ok(tiny.heatmap.totalPlayerSamples < 8);
  });

  it('fitArena is deterministic and cell-aligned', () => {
    const frames = [
      { entities: [{ id: 1, kind: 'player' as const, p: { x: 3.2, y: -1.5 }, v: { x: 0, y: 0 }, hp: 1, maxHp: 1 }] },
    ];
    // x 3.2 -> cells [0,4); y -1.5 -> cells [-4,0)
    assert.deepEqual(fitArena(frames, 4), { minX: 0, minY: -4, maxX: 4, maxY: 0 });
    assert.deepEqual(fitArena(frames, 4), fitArena(frames, 4));
    // Degenerate input still yields a 1x1 grid rather than NaN.
    assert.deepEqual(fitArena([], 4), { minX: 0, minY: 0, maxX: 4, maxY: 4 });
  });
});

describe('csv output', () => {
  const report = analyze(fixtureRecords(), {}, { source: 'mini.ndjson' });
  it('timeline CSV has a header and one row per timeline point', () => {
    const csv = reportToCsv(report);
    const lines = csv.trim().split('\n');
    assert.equal(lines[0], CSV_HEADER.join(','));
    assert.equal(lines.length - 1, report.timeline.length);
    assert.ok(csv.endsWith('\n'));
  });

  it('players CSV has one row per player', () => {
    const csv = playersToCsv(report);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length - 1, report.players.length);
    assert.ok(lines[1]!.startsWith('7,scout,1,'));
  });
});

describe('svg rendering', () => {
  const report = analyze(fixtureRecords(), {}, { source: 'mini.ndjson' });

  it('heatmap SVG is well-formed and contains cells', () => {
    const svg = renderHeatmapSvg(report, { value: 'players' });
    assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(svg.includes('<svg '));
    assert.ok(svg.trimEnd().endsWith('</svg>'));
    assert.ok(svg.includes('PLAYER PATH HEATMAP'));
    // Occupied cells produce rects beyond the background/legend frames.
    assert.ok((svg.match(/<rect /g) ?? []).length > 3);
  });

  it('mob density SVG is distinct from the player heatmap', () => {
    const players = renderHeatmapSvg(report, { value: 'players' });
    const mobs = renderHeatmapSvg(report, { value: 'mobs' });
    assert.notEqual(players, mobs);
    assert.ok(mobs.includes('MOB DENSITY HEATMAP'));
  });

  it('timeline SVG renders all series and axis labels', () => {
    const svg = renderTimelineSvg(report);
    assert.ok(svg.includes('REPLAY TIMELINE'));
    for (const label of ['mobs visible', 'players visible', 'player speed (u/s)', 'player HP']) {
      assert.ok(svg.includes(label), `missing series label ${label}`);
    }
  });

  it('heatColor quantizes into a fixed palette', () => {
    const palette = ['#0', '#1', '#2'];
    assert.equal(heatColor(0, 10, palette), '#0');
    assert.equal(heatColor(10, 10, palette), '#2');
    assert.equal(heatColor(5, 10, palette), '#1');
  });
});

describe('binary container', () => {
  it('round-trips records losslessly', () => {
    const recs = fixtureRecords();
    const buf = encodeContainer(recs);
    assert.ok(isContainer(buf));
    const back = decodeContainer(buf);
    assert.equal(back.length, recs.length);
    assert.equal(stableStringify(back), stableStringify(recs));
  });

  it('encoding is byte-deterministic', () => {
    const recs = fixtureRecords();
    assert.ok(encodeContainer(recs).equals(encodeContainer(recs)));
  });

  it('rejects non-container buffers', () => {
    assert.throws(() => decodeContainer(Buffer.from('not a container at all!!')));
  });

  it('a .bin recording yields the same metrics as its .ndjson source', () => {
    const recs = fixtureRecords();
    const fromNd = analyze(recs, {}, { source: 'mini.ndjson' });
    const fromBin = analyze(decodeContainer(encodeContainer(recs)), {}, { source: 'mini.ndjson' });
    assert.equal(stableStringify(fromNd), stableStringify(fromBin));
  });
});

describe('loadRecording from disk', () => {
  it('reads the fixture and reports a digest', () => {
    const rec = loadRecording(FIXTURE);
    assert.equal(rec.format, 'ndjson');
    assert.ok(rec.digest && rec.digest.length === 16);
    assert.equal(rec.records.length, fixtureRecords().length);
  });
});