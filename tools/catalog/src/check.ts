// @aetherfall/catalog — integrity CLI: the shared catalog must validate clean
// and every item referenced by loot tables, vendor stock and quest rewards
// must resolve in it. Exit 0 = green, 1 = errors (printed to stderr).
//
// Loot/quest refs are read from the server SOURCES (not built output) so the
// check never depends on build ordering: `npm run check` works on a fresh
// checkout after only the shared workspace is built.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG,
  CATALOG_SOURCES,
  itemById,
  validateCatalog,
} from '@aetherfall/shared';

export interface CheckStats {
  items: number;
  outfits: number;
  effects: number;
  missiles: number;
  lootRefs: number;
  questRefs: number;
}

export interface CheckResult {
  errors: string[];
  stats: CheckStats;
}

function stripComments(src: string): string {
  // Line comments (loot.ts documents the scan pattern itself in prose, which
  // must not be mistaken for a ref) and block comments. String literals are
  // left intact — refs live in code, prose lives in comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function lootItemIdsIn(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/itemId\s*:\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

function questRewardIdsIn(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/rewardItem\s*:\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

/**
 * Check catalog integrity against loot/quest SOURCE text. Pure; used by the
 * CLI and the test suite alike.
 */
export function checkSources(lootSrc: string, contentSrc: string): CheckResult {
  const errors: string[] = [...validateCatalog(CATALOG_SOURCES)];

  const lootIds = lootItemIdsIn(lootSrc);
  for (const id of new Set(lootIds)) {
    if (!itemById(id)) errors.push(`loot: unknown catalog item "${id}"`);
  }

  const questIds = questRewardIdsIn(contentSrc);
  for (const id of new Set(questIds)) {
    if (!itemById(id)) errors.push(`quest: unknown reward item "${id}"`);
  }

  // Vendor/stock readiness: the vendor lists the whole catalog, so every entry
  // must itself be stockable (well-formed sprite + sane price — enforced above)
  // and the catalogue must be non-trivial.
  if (CATALOG.items.length < 1) errors.push('vendor: catalog has no items to stock');
  for (const it of CATALOG.items) {
    if (!itemById(it.id)) errors.push(`vendor: catalog item "${it.id}" does not resolve`);
  }

  return {
    errors,
    stats: {
      items: CATALOG.items.length,
      outfits: CATALOG.outfits.length,
      effects: CATALOG.effects.length,
      missiles: CATALOG.missiles.length,
      lootRefs: new Set(lootIds).size,
      questRefs: new Set(questIds).size,
    },
  };
}

/** Walk up from here to the repo root (package.json with name 'aetherfall'). */
export function findRepoRoot(startDir?: string): string {
  let dir = resolve(startDir ?? dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
        if (name === 'aetherfall') return dir;
      } catch {
        // unreadable package.json — keep climbing
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('catalog check: repo root not found (no parent package.json with name "aetherfall")');
}

/** Load sources from disk and run the full check. */
export function runCheck(repoRoot?: string): CheckResult {
  const root = resolve(repoRoot ?? findRepoRoot());
  const lootPath = join(root, 'server', 'src', 'game', 'loot.ts');
  const contentPath = join(root, 'server', 'src', 'game', 'content.ts');
  const errors: string[] = [];
  let lootSrc = '';
  let contentSrc = '';
  for (const [label, path] of [['loot', lootPath], ['content', contentPath]] as const) {
    if (!existsSync(path)) errors.push(`sources: missing ${label} file ${path}`);
    else {
      const text = readFileSync(path, 'utf8');
      if (label === 'loot') lootSrc = text;
      else contentSrc = text;
    }
  }
  if (errors.length > 0) {
    return { errors, stats: { items: 0, outfits: 0, effects: 0, missiles: 0, lootRefs: 0, questRefs: 0 } };
  }
  return checkSources(lootSrc, contentSrc);
}

function main(): void {
  let result: CheckResult;
  try {
    result = runCheck();
  } catch (err) {
    console.error(`catalog check FAILED: ${(err as Error).message}`);
    process.exit(1);
  }
  const s = result.stats;
  console.log(
    `catalog ok: ${s.items} items, ${s.outfits} outfits, ${s.effects} effects, ${s.missiles} missiles; ` +
      `${s.lootRefs} loot refs, ${s.questRefs} quest refs`,
  );
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`catalog check FAILED: ${e}`);
    process.exit(1);
  }
}

// Run as a CLI, but stay import-safe for tests.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
