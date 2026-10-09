import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, chunkBatchSizes, parseRedirectUrl, isNpmMangledArgs } from './index.js';

// runBot/chaos/anticheat probes need a live server (covered by the QA load
// trial); these unit tests pin the CLI contract instead.
describe('bots parseArgs', () => {
  it('defaults: 20 bots, localhost:8081, 30s, probes on', () => {
    const a = parseArgs([]);
    assert.equal(a.bots, 20);
    assert.equal(a.server, 'ws://localhost:8081');
    assert.equal(a.duration, 30);
    assert.equal(a.chaos, true);
    assert.equal(a.anticheat, true);
    assert.equal(a.inputHz, 20);
  });

  it('supports --flag value and --flag=value forms', () => {
    const a = parseArgs(['--bots', '50', '--server=ws://example:9999', '--duration', '15']);
    assert.equal(a.bots, 50);
    assert.equal(a.server, 'ws://example:9999');
    assert.equal(a.duration, 15);
  });

  it('clamps invalid counts instead of crashing the swarm', () => {
    assert.equal(parseArgs(['--bots', '-5']).bots, 0);
    assert.equal(parseArgs(['--bots', 'abc']).bots, 20);
    assert.equal(parseArgs(['--duration', '0']).duration, 1);
    assert.ok(parseArgs(['--input-hz', '999']).inputHz <= 66);
  });

  it('--no-chaos / --no-anticheat opt out of probes', () => {
    assert.equal(parseArgs(['--no-chaos']).chaos, false);
    assert.equal(parseArgs(['--no-anticheat']).anticheat, false);
    assert.equal(parseArgs(['--chaos', '--no-chaos']).chaos, false);
  });

  it('--proto selects the wire format, defaulting to v1', () => {
    assert.equal(parseArgs([]).proto, 1);
    assert.equal(parseArgs(['--proto', '2']).proto, 2);
    assert.equal(parseArgs(['--proto=2']).proto, 2);
    assert.equal(parseArgs(['--proto', 'v2']).proto, 2);
    assert.equal(parseArgs(['--proto', 'binary']).proto, 2);
    for (const p of ['1', 'v1', 'json', 'yes', '']) {
      assert.equal(parseArgs(['--proto', p]).proto, 1, `--proto ${p}`);
    }
  });

  it('--chunk caps concurrency, defaulting to fully-concurrent', () => {
    assert.equal(parseArgs([]).chunk, 0);
    assert.equal(parseArgs(['--chunk', '100']).chunk, 100);
    assert.equal(parseArgs(['--chunk=50']).chunk, 50);
    assert.equal(parseArgs(['--chunk', '-3']).chunk, 0);
  });

  it('chunkBatchSizes: 0 = one concurrent batch, N = sequential batches', () => {
    assert.deepEqual(chunkBatchSizes(150, 0), [150]);
    assert.deepEqual(chunkBatchSizes(150, 200), [150]);
    assert.deepEqual(chunkBatchSizes(150, 100), [100, 50]);
    assert.deepEqual(chunkBatchSizes(0, 0), []);
    assert.deepEqual(chunkBatchSizes(200, 100), [100, 100]);
  });

  it('parseRedirectUrl extracts payload.url from redirect events only', () => {
    assert.equal(
      parseRedirectUrl({ t: 'event', kind: 'redirect', payload: { url: 'ws://localhost:8282', shard: 's' } }),
      'ws://localhost:8282',
    );
    assert.equal(parseRedirectUrl({ t: 'event', kind: 'redirect', payload: '{"url":"ws://x:1"}' }), 'ws://x:1');
    assert.equal(parseRedirectUrl({ t: 'event', kind: 'redirect', payload: 'ws://y:2' }), 'ws://y:2');
    assert.equal(parseRedirectUrl({ t: 'event', kind: 'kicked' }), null);
    assert.equal(parseRedirectUrl({ t: 'snapshot' }), null);
    assert.equal(parseRedirectUrl(null), null);
  });

  it('isNpmMangledArgs detects npm-swallowed flags', () => {
    const savedEvent = process.env.npm_lifecycle_event;
    process.env.npm_lifecycle_event = 'start';
    try {
      assert.equal(isNpmMangledArgs(['150', '20']), true);
      assert.equal(isNpmMangledArgs(['--bots', '150']), false);
      assert.equal(isNpmMangledArgs([]), false);
    } finally {
      if (savedEvent === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = savedEvent;
    }
    assert.equal(isNpmMangledArgs(['--bots', '150']), false);
  });
});
