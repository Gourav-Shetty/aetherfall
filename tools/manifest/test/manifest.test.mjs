// tools/manifest determinism test: two builds over the same tree are byte-identical.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, writeManifest } from '../build.mjs';

describe('manifest determinism', () => {
  it('two builds are byte-identical (sorted keys, stable JSON)', () => {
    const a = JSON.stringify(buildManifest().doc);
    const b = JSON.stringify(buildManifest().doc);
    assert.equal(a, b);
  });

  it('files are sorted by path and entries carry file/sha256/bytes', () => {
    const { doc } = buildManifest();
    assert.ok(typeof doc.version === 'string' && doc.version.length > 0);
    assert.ok(Array.isArray(doc.files) && doc.files.length >= 9);
    const names = doc.files.map((f) => f.file);
    assert.deepEqual([...names].sort(), names);
    for (const f of doc.files) {
      assert.deepEqual(Object.keys(f), ['file', 'sha256', 'bytes']);
      assert.match(f.sha256, /^[0-9a-f]{16}$/);
      assert.ok(Number.isInteger(f.bytes) && f.bytes > 0);
    }
  });

  it('writeManifest round-trips byte-identical output to a temp dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-manifest-'));
    try {
      const out1 = join(dir, 'm1.json');
      const out2 = join(dir, 'm2.json');
      writeManifest({ outPath: out1 });
      writeManifest({ outPath: out2 });
      assert.equal(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
