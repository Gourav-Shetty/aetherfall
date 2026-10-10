// catalog integrity checker: green on real sources, red on bogus refs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSources, findRepoRoot, runCheck } from './check.js';

describe('catalog integrity check', () => {
  it('is green against the real server sources', () => {
    const root = findRepoRoot();
    const lootSrc = readFileSync(join(root, 'server', 'src', 'game', 'loot.ts'), 'utf8');
    const contentSrc = readFileSync(join(root, 'server', 'src', 'game', 'content.ts'), 'utf8');
    const r = checkSources(lootSrc, contentSrc);
    assert.deepEqual(r.errors, []);
    assert.equal(r.stats.items, 15);
    assert.ok(r.stats.lootRefs >= 10, `expected >= 10 distinct loot refs, got ${r.stats.lootRefs}`);
    assert.ok(r.stats.questRefs >= 1, `expected >= 1 quest ref, got ${r.stats.questRefs}`);
  });

  it('runCheck against the repo root is green', () => {
    const r = runCheck();
    assert.deepEqual(r.errors, []);
    assert.equal(r.stats.items, 15);
  });

  it('flags a loot ref to an unknown item', () => {
    const r = checkSources(`export const LOOT_TABLE = { x: [{ itemId: 'sword-of-doom', chance: 1, min: 1, max: 1 }] };`, '');
    assert.ok(r.errors.some((e) => e.includes('sword-of-doom')), r.errors.join('\n'));
  });

  it('flags a quest reward pointing at an unknown item', () => {
    const r = checkSources('', `rewardItem: 'crown-of-nowhere'`);
    assert.ok(r.errors.some((e) => e.includes('crown-of-nowhere')), r.errors.join('\n'));
  });

  it('ignores refs mentioned only in comments', () => {
    const src = `// itemId: 'sword-of-doom' is not a real drop\n/* rewardItem: 'crown-of-nowhere' */\nexport const x = 1;`;
    const r = checkSources(src, src);
    assert.ok(!r.errors.some((e) => e.includes('sword-of-doom')), r.errors.join('\n'));
    assert.ok(!r.errors.some((e) => e.includes('crown-of-nowhere')), r.errors.join('\n'));
  });
});
