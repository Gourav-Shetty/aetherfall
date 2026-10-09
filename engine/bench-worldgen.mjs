// AETHERFALL worldgen benchmark — real numbers for the streaming world.
//
// Run (after `npm run build --workspace=@aetherfall/engine`):
//   node engine/bench-worldgen.mjs
//   node engine/bench-worldgen.mjs --repeats 9 --seed 1337
//
// Targets (see docs/WORLDGEN.md):
//   * 32x32 chunk generation            < 1 ms
//   * 10k WorldStream tile queries     < 5 ms  (resident working set)
//
// Exits non-zero when a target is missed, so it can gate CI.

import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
if (!existsSync(path.join(DIST, 'worldstream.js'))) {
  console.error('engine/dist missing — run: npm run build --workspace=@aetherfall/engine');
  process.exit(2);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
};

const REPEATS = Math.max(3, arg('repeats', 7));
const SEED = arg('seed', 1337) >>> 0;

const load = async (file) => import(pathToFileURL(path.join(DIST, file)).href);
const { DEFAULT_CHUNK_SIZE } = await load('worldgen.js');
const { genChunk, genZonedChunk, getBiome, getZone, DEFAULT_WORLD_SEED } = await load('worldgen.js');
const { WorldStream, DEFAULT_MAX_CHUNKS } = await load('worldstream.js');
const { heightAt, slopeAt, hazardAt, terrainAt, WALKABLE_MAX_SLOPE, LAVA_LEVEL } = await load('terrain.js');
const { findLandmarks, landmarkInCell, LANDMARK_CELL, LandmarkIndex } = await load('landmarks.js');

const TARGET_CHUNK_MS = 1;
const TARGET_TILES_MS = 5;

// -- tiny harness ----------------------------------------------------------------

function timeIt(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/** warmup + repeats -> { min, median, p95, mean, samples } */
function measure(fn, { warmup = 3, repeats = REPEATS } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < repeats; i++) samples.push(timeIt(fn));
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    mean,
    max: sorted[sorted.length - 1],
    samples,
  };
}

/** Deterministic LCG so every run walks the same ground. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const rows = [];
let failures = 0;
function row(name, metric, result, perOp, target, note = '') {
  const pass = target === null ? null : result <= target;
  if (pass === false) failures++;
  rows.push({ name, metric, result, perOp, target, pass, note });
}

// -- 1. stateless chunk generation -------------------------------------------------

const CHUNKS_PER_BATCH = 500;
{
  let i = 0;
  const run = () => {
    for (let k = 0; k < CHUNKS_PER_BATCH; k++, i++) genChunk(i, 1, DEFAULT_CHUNK_SIZE, SEED);
  };
  const m = measure(run);
  const per = m.min / CHUNKS_PER_BATCH;
  row('genChunk 32x32', 'per chunk', per, per, TARGET_CHUNK_MS, `${CHUNKS_PER_BATCH} chunks/batch`);
  row('genChunk 32x32 (batch)', `${CHUNKS_PER_BATCH} chunks`, m.min, null, null, `median ${m.median.toFixed(2)}ms`);
}

{
  const rnd = lcg(99);
  const run = () => {
    for (let k = 0; k < 50; k++) genChunk(Math.floor(rnd() * 100000), Math.floor(rnd() * 100000), DEFAULT_CHUNK_SIZE, SEED);
  };
  const m = measure(run);
  row('genChunk 32x32 random coords', 'per chunk', m.min / 50, null, null, 'negative + far coords');
}

{
  let i = 0;
  const run = () => {
    for (let k = 0; k < 100; k++, i++) genZonedChunk(i, 2, DEFAULT_CHUNK_SIZE, SEED);
  };
  const m = measure(run);
  row('genZonedChunk 32x32', 'per chunk', m.min / 100, null, null, 'tiles + decoration variants');
}

// -- 2. WorldStream ---------------------------------------------------------------

{
  // Cold single miss (prefetch off) — the pure generation cost through the
  // stream API.
  let i = 0;
  const stream = new WorldStream({ seed: SEED, prefetch: 0, maxChunks: DEFAULT_MAX_CHUNKS });
  const run = () => {
    for (let k = 0; k < 200; k++, i++) stream.getChunk(i * 7, 3);
  };
  const m = measure(run);
  row('WorldStream.getChunk (cold, prefetch 0)', 'per chunk', m.min / 200, null, TARGET_CHUNK_MS, `200 chunks/batch`);
}

{
  // Miss + full 8-chunk neighbor ring: what a player stepping into new ground
  // costs in the worst case.
  let i = 0;
  const run = () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 1, maxChunks: DEFAULT_MAX_CHUNKS });
    for (let k = 0; k < 40; k++, i += 8) stream.getChunk(i * 5, -2);
  };
  const m = measure(run, { repeats: Math.max(3, Math.min(REPEATS, 4)) });
  const s = new WorldStream({ seed: SEED, prefetch: 1, maxChunks: DEFAULT_MAX_CHUNKS });
  for (let k = 0; k < 40; k++) s.getChunk(k * 40, -2);
  const st = s.stats();
  row(
    'WorldStream.getChunk + prefetch ring(1)',
    'per miss (+8 chunks)',
    m.min / 40,
    null,
    null,
    `${st.generated} generated for 40 steps`,
  );
}

{
  // TARGET: 10k tile queries against a resident working set (7x7 chunks).
  const block = 7;
  const span = block * DEFAULT_CHUNK_SIZE;
  const rnd = lcg(4242);
  const xs = [];
  const ys = [];
  for (let i = 0; i < 10000; i++) {
    xs.push(Math.floor(rnd() * span) - Math.floor(span / 2));
    ys.push(Math.floor(rnd() * span) - Math.floor(span / 2));
  }
  const stream = new WorldStream({ seed: SEED, prefetch: 0, maxChunks: DEFAULT_MAX_CHUNKS });
  for (let cx = -4; cx <= 4; cx++) for (let cy = -4; cy <= 4; cy++) stream.getChunk(cx, cy);
  let acc = 0;
  const run = () => {
    acc = 0;
    for (let i = 0; i < xs.length; i++) acc += stream.tileAt(xs[i], ys[i]);
  };
  const m = measure(run);
  row(
    'WorldStream.tileAt x10k (hot cache)',
    '10k tile reads',
    m.min,
    (m.min * 1e3) / 10000,
    TARGET_TILES_MS,
    `${block}x${block} resident chunks, acc=${acc}`,
  );
}

{
  // Same 10k queries scattered over a 64x64 chunk region: every query lands in
  // a different chunk, so this measures the generation-bound worst case.
  const rnd = lcg(777);
  const xs = [];
  const ys = [];
  for (let i = 0; i < 10000; i++) {
    xs.push(Math.floor(rnd() * 64 * DEFAULT_CHUNK_SIZE));
    ys.push(Math.floor(rnd() * 64 * DEFAULT_CHUNK_SIZE));
  }
  const stream = new WorldStream({ seed: SEED, prefetch: 0, maxChunks: DEFAULT_MAX_CHUNKS });
  let acc = 0;
  const run = () => {
    acc = 0;
    for (let i = 0; i < xs.length; i++) acc += stream.tileAt(xs[i], ys[i]);
  };
  const m = measure(run, { warmup: 1, repeats: 3 });
  const st = stream.stats();
  row(
    'WorldStream.tileAt x10k (cold, 64x64 chunks)',
    '10k tile reads',
    m.min,
    null,
    null,
    `${st.generated} chunks generated, acc=${acc} (generation bound)`,
  );
}

{
  // Streaming walk: player crosses 400 chunks; cache churn + prefetch.
  const run = () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 1, maxChunks: 128 });
    for (let k = 0; k < 400; k++) stream.getChunk(k, 0);
    return stream;
  };
  const m = measure(run, { warmup: 1, repeats: 3 });
  const s = run();
  row(
    'WorldStream walk 400 chunks',
    '400 steps',
    m.min,
    null,
    null,
    `evicted ${s.stats().evicted}, resident ${s.size}`,
  );
}

for (const r of [48, 96, 192]) {
  let visited = 0;
  let resident = 0;
  const run = () => {
    const stream = new WorldStream({ seed: SEED, prefetch: 0, maxChunks: DEFAULT_MAX_CHUNKS });
    let seen = 0;
    stream.forEachInRadius(0, 0, r, () => seen++);
    visited = seen;
    resident = stream.size;
  };
  const m = measure(run, { warmup: 1, repeats: 3 });
  row(
    `WorldStream.forEachInRadius r=${r}`,
    `${visited} chunks`,
    m.min,
    m.min / visited,
    null,
    `${resident} chunks resident after the walk`,
  );
}

// -- 3. terrain field --------------------------------------------------------------

for (const [name, fn] of [
  ['heightAt', (x, y) => heightAt(x, y, SEED)],
  ['slopeAt', (x, y) => slopeAt(x, y, SEED)],
  ['hazardAt', (x, y) => hazardAt(x, y, SEED)],
  ['terrainAt', (x, y) => terrainAt(x, y, SEED)],
  ['getBiome', (x, y) => getBiome(x, y, SEED)],
  ['getZone', (x, y) => getZone(x, y, SEED)],
]) {
  const rnd = lcg(31337);
  const pts = [];
  for (let i = 0; i < 10000; i++) {
    pts.push([Math.floor(rnd() * 4096) - 2048, Math.floor(rnd() * 4096) - 2048]);
  }
  let acc = 0;
  const run = () => {
    acc = 0;
    for (const [x, y] of pts) {
      const v = fn(x, y);
      acc += typeof v === 'number' ? (v > 0 ? 1 : 0) : 1;
    }
  };
  const m = measure(run);
  row(`${name} x10k`, '10k samples', m.min, (m.min * 1e3) / 10000, null, `per-sample us, acc=${acc}`);
}

// -- 4. landmarks -------------------------------------------------------------------

{
  const rnd = lcg(5150);
  const run = () => {
    let found = 0;
    for (let i = 0; i < 2000; i++) {
      found += findLandmarks(Math.floor(rnd() * 400) - 200, Math.floor(rnd() * 400) - 200, 6, { seed: SEED }).length;
    }
    return found;
  };
  const m = measure(run, { repeats: Math.max(3, Math.min(REPEATS, 5)) });
  const found = run();
  row('findLandmarks r=6 chunks', '2000 queries', m.min, m.min / 2000, null, `${found} landmarks found`);
}

{
  const run = () => {
    let n = 0;
    for (let gy = -60; gy < 60; gy++) for (let gx = -60; gx < 60; gx++) if (landmarkInCell(gx, gy, SEED)) n++;
    return n;
  };
  const m = measure(run, { warmup: 1, repeats: 3 });
  const n = run();
  row('landmarkInCell 120x120 cells', '14400 cells', m.min, m.min / 14400, null, `${n} landmarks`);
}

{
  const idx = new LandmarkIndex(SEED, 256);
  const run = () => {
    let n = 0;
    for (let i = 0; i < 2000; i++) n += idx.findAroundChunk(i % 100, i % 60, 5).length;
    return n;
  };
  const m = measure(run);
  row('LandmarkIndex.findAroundChunk r=5', '2000 queries', m.min, m.min / 2000, null, 'cell-cached');
}

// -- 5. world statistics (context for the numbers above) ------------------------------

const stats = (() => {
  let water = 0;
  let lava = 0;
  let steep = 0;
  let total = 0;
  for (let x = -512; x <= 512; x += 4) {
    for (let y = -512; y <= 512; y += 4) {
      total++;
      const hz = hazardAt(x, y, SEED);
      if (hz.type === 'water') water++;
      else if (hz.type === 'lava') lava++;
      if (slopeAt(x, y, SEED) > WALKABLE_MAX_SLOPE) steep++;
    }
  }
  let lm = 0;
  let cells = 0;
  for (let gy = -40; gy < 40; gy++) {
    for (let gx = -40; gx < 40; gx++) {
      cells++;
      if (landmarkInCell(gx, gy, SEED)) lm++;
    }
  }
  return {
    total,
    water: (100 * water) / total,
    lava: (100 * lava) / total,
    steep: (100 * steep) / total,
    lm,
    cells,
    lmDensity: lm / cells,
  };
})();

// -- report ---------------------------------------------------------------------------

const cpu = os.cpus()[0];
const f2 = (v) => (v === null ? '—' : v.toFixed(3));
const pad = (s, n) => String(s).padEnd(n);
console.log(`AETHERFALL worldgen bench — node ${process.version} ${process.platform}/${process.arch}`);
console.log(`cpu ${cpu ? cpu.model.trim() : 'unknown'} | seed ${SEED} (default ${DEFAULT_WORLD_SEED}) | repeats ${REPEATS}`);
console.log(
  `sample world: water ${stats.water.toFixed(1)}% | lava ${stats.lava.toFixed(1)}% | steep>${WALKABLE_MAX_SLOPE} ${stats.steep.toFixed(1)}% | landmarks ${stats.lm}/${stats.cells} cells (${(stats.lmDensity * 100).toFixed(1)}%, cell=${LANDMARK_CELL}u, lava<=${LAVA_LEVEL})`,
);
console.log('');
console.log(`${pad('scenario', 40)} ${pad('metric', 22)} ${pad('min ms', 10)} ${pad('per op us', 10)} ${pad('target ms', 10)} result`);
console.log('-'.repeat(104));
for (const r of rows) {
  const result = r.target === null ? 'info' : r.pass ? 'PASS' : 'FAIL';
  console.log(
    pad(r.name, 40) +
      pad(r.metric, 22) +
      pad(f2(r.result), 10) +
      pad(r.perOp === null ? '—' : r.perOp.toFixed(3), 10) +
      pad(r.target === null ? '—' : String(r.target), 10) +
      `${result}${r.note ? `  (${r.note})` : ''}`,
  );
}
console.log('');
console.log(`targets: chunk gen < ${TARGET_CHUNK_MS} ms | 10k cached tile queries < ${TARGET_TILES_MS} ms`);
console.log(failures === 0 ? 'ALL TARGETS MET' : `${failures} TARGET(S) MISSED`);
process.exit(failures === 0 ? 0 : 1);