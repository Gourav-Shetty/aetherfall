// Client asset-loader tests (DOM-free): placeholder fallback + progress.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AssetLoader,
  DEFAULT_ART,
  parseManifest,
  placeholderFor,
  publicUrlFor,
} from './assets.js';

describe('assets placeholder', () => {
  it('placeholderFor is a non-empty SVG data URI, never blank', () => {
    for (const n of ['logo', 'missing-file', '']) {
      const u = placeholderFor(n);
      assert.ok(u.startsWith('data:image/svg+xml,'), `not a data URI for ${n}`);
      assert.ok(u.length > 100);
      assert.ok(decodeURIComponent(u).includes('<svg'));
    }
  });

  it('placeholders differ per name (stable tint per asset)', () => {
    assert.notEqual(placeholderFor('logo'), placeholderFor('hero'));
    assert.equal(placeholderFor('logo'), placeholderFor('logo'));
  });

  it('publicUrlFor strips the client/public prefix', () => {
    assert.equal(publicUrlFor('client/public/art/logo.svg'), '/art/logo.svg');
    assert.equal(publicUrlFor('client/public/shots/a.svg'), '/shots/a.svg');
  });

  it('parseManifest rejects garbage, accepts the builder shape', () => {
    assert.equal(parseManifest(null), null);
    assert.equal(parseManifest({}), null);
    assert.equal(parseManifest({ version: 'x', files: [{ nope: 1 }] }), null);
    const good = parseManifest({
      version: '0.1.0',
      files: [{ file: 'client/public/art/logo.svg', sha256: 'abc123abc123abcd', bytes: 10 }],
    });
    assert.ok(good && good.files.length === 1);
  });
});

describe('assets loader fallback', () => {
  it('missing file -> placeholder, no throw', async () => {
    const failing = async (_url: string) => {
      throw new Error('offline');
    };
    const loader = new AssetLoader({ fetchFn: failing });
    const url = await loader.load('does-not-exist');
    assert.ok(url.startsWith('data:image/svg+xml,'));
    assert.equal(loader.cached('does-not-exist'), url);
  });

  it('missing manifest -> null, boot continues', async () => {
    const failing = async (_url: string) => {
      throw new Error('offline');
    };
    const loader = new AssetLoader({ fetchFn: failing });
    assert.equal(await loader.loadManifest('/manifest.json'), null);
    assert.equal(loader.manifest, null);
    // Art still resolves (to placeholders) without a manifest.
    const url = await loader.load('logo');
    assert.ok(url.startsWith('data:image/svg+xml,'));
  });

  it('http 404 -> placeholder, no throw', async () => {
    const notFound = async (_url: string) => ({ ok: false, status: 404, text: async () => '', json: async () => null });
    const loader = new AssetLoader({ fetchFn: notFound });
    const url = await loader.load('logo');
    assert.ok(url.startsWith('data:image/svg+xml,'));
  });

  it('preload reports monotonic progress for the loading screen', async () => {
    const ok = async (url: string) => ({ ok: true, status: 200, text: async () => '<svg/>', json: async () => ({ version: '0.1.0', files: [] }) });
    const loader = new AssetLoader({ fetchFn: ok });
    const seen: number[] = [];
    const out = await loader.preload([...DEFAULT_ART], (p) => {
      seen.push(p.loaded);
      assert.ok(p.total === DEFAULT_ART.length);
      assert.ok(p.frac >= 0 && p.frac <= 1);
    });
    assert.equal(out.length, DEFAULT_ART.length);
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(loader.progress(), { loaded: 3, total: 3, frac: 1 });
  });

  it('cache returns the same URL without refetching', async () => {
    let calls = 0;
    const ok = async (url: string) => {
      calls++;
      return { ok: true, status: 200, text: async () => '<svg/>', json: async () => ({}) };
    };
    const loader = new AssetLoader({ fetchFn: ok });
    const a = await loader.load('logo');
    const b = await loader.load('logo');
    assert.equal(a, b);
    assert.equal(calls, 1);
  });
});
