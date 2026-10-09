import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTelegraph, telegraphFrac } from './telegraph.js';

describe('asTelegraph', () => {
  it('accepts a well-formed circle telegraph', () => {
    const t = asTelegraph({ shape: 'circle', x: 80, y: 80, r: 4.5, ttlMs: 900, label: 'golem-slam' });
    assert.ok(t);
    assert.deepEqual(t, { shape: 'circle', x: 80, y: 80, r: 4.5, ttlMs: 900, label: 'golem-slam' });
  });

  it('rounds ttlMs and tolerates integer-ish input', () => {
    const t = asTelegraph({ shape: 'circle', x: 0, y: 0, r: 1, ttlMs: 700.4, label: 'wisp-burst' });
    assert.equal(t!.ttlMs, 700);
  });

  it('rejects non-objects, unknown shapes and missing fields', () => {
    assert.equal(asTelegraph(null), null);
    assert.equal(asTelegraph(undefined), null);
    assert.equal(asTelegraph('circle'), null);
    assert.equal(asTelegraph(42), null);
    assert.equal(asTelegraph({ shape: 'square', x: 0, y: 0, r: 1, ttlMs: 100, label: 'a' }), null);
    assert.equal(asTelegraph({ shape: 'circle', y: 0, r: 1, ttlMs: 100, label: 'a' }), null);
    assert.equal(asTelegraph({ shape: 'circle', x: 0, y: 0, ttlMs: 100, label: 'a' }), null);
    assert.equal(asTelegraph({ shape: 'circle', x: 0, y: 0, r: 1, label: 'a' }), null);
    assert.equal(asTelegraph({ shape: 'circle', x: 0, y: 0, r: 1, ttlMs: 100 }), null);
  });

  it('rejects out-of-range or non-finite numbers', () => {
    const base = { shape: 'circle', x: 0, y: 0, r: 1, ttlMs: 100, label: 'a' };
    assert.equal(asTelegraph({ ...base, r: 0 }), null);
    assert.equal(asTelegraph({ ...base, r: -2 }), null);
    assert.equal(asTelegraph({ ...base, r: 1e9 }), null, 'radius cap guards render loops');
    assert.equal(asTelegraph({ ...base, ttlMs: 0 }), null);
    assert.equal(asTelegraph({ ...base, ttlMs: -5 }), null);
    assert.equal(asTelegraph({ ...base, ttlMs: 99_999 }), null);
    assert.equal(asTelegraph({ ...base, x: NaN }), null);
    assert.equal(asTelegraph({ ...base, y: Infinity }), null);
    assert.equal(asTelegraph({ ...base, x: '5' }), null, 'no string coercion');
  });

  it('rejects empty/oversized labels', () => {
    const base = { shape: 'circle', x: 0, y: 0, r: 1, ttlMs: 100 };
    assert.equal(asTelegraph({ ...base, label: '' }), null);
    assert.equal(asTelegraph({ ...base, label: 7 }), null);
    assert.equal(asTelegraph({ ...base, label: 'x'.repeat(65) }), null);
  });
});

describe('telegraphFrac', () => {
  it('reports elapsed windup as a 0..1+ fraction', () => {
    const t = { shape: 'circle' as const, x: 0, y: 0, r: 1, ttlMs: 1000, label: 'a', t0: 5000 };
    assert.equal(telegraphFrac(t, 5000), 0);
    assert.equal(telegraphFrac(t, 5500), 0.5);
    assert.equal(telegraphFrac(t, 6000), 1);
    assert.ok(telegraphFrac(t, 7000) > 1);
  });

  it('is fully elapsed when ttlMs is 0', () => {
    assert.equal(telegraphFrac({ shape: 'circle', x: 0, y: 0, r: 1, ttlMs: 0, label: 'a', t0: 0 }, 0), 1);
  });
});