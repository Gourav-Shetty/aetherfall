// tools/manifest/build.mjs — content-addressed asset manifest (original design).
//
// Scans client/public/shots + docs/screenshots + client/public/art and writes
// client/public/manifest.json:
//
//   { "version": "0.1.0", "files": [ { "file", "sha256", "bytes" }, ... ] }
//
// - `file`   repo-root-relative posix path (e.g. "client/public/art/logo.svg")
// - `sha256` first 16 hex chars of the file's SHA-256 (content address)
// - `bytes`  file size in bytes
// - `version` root package.json version
//
// Deterministic: files sorted by `file`, JSON keys in fixed order, 2-space
// indent + trailing newline. Two runs over the same tree are byte-identical.
// No dependencies beyond node:fs / node:crypto / node:path.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function repoPosix(abs) {
  return relative(ROOT, abs).split(sep).join('/');
}

function listFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // Sorted entries => deterministic walk order.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

export function buildManifest(opts = {}) {
  const root = opts.root ? resolve(opts.root) : ROOT;
  const scanDirs = opts.scanDirs ?? [
    join(root, 'client', 'public', 'shots'),
    join(root, 'docs', 'screenshots'),
    join(root, 'client', 'public', 'art'),
  ];
  const outPath = opts.outPath ? resolve(opts.outPath) : join(root, 'client', 'public', 'manifest.json');
  let version = opts.version ?? null;
  if (version === null) {
    try {
      version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.1.0';
    } catch {
      version = '0.1.0';
    }
  }
  const seen = new Map();
  for (const dir of scanDirs) {
    for (const abs of listFiles(dir)) {
      const rel = relative(root, abs).split(sep).join('/');
      if (seen.has(rel)) continue;
      let buf;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      const sha256 = createHash('sha256').update(buf).digest('hex').slice(0, 16);
      seen.set(rel, { file: rel, sha256, bytes: buf.length });
    }
  }
  const files = [...seen.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // Fixed key order per entry + fixed top-level order => stable bytes.
  const doc = {
    version,
    files: files.map((f) => ({ file: f.file, sha256: f.sha256, bytes: f.bytes })),
  };
  return { doc, outPath };
}

export function writeManifest(opts = {}) {
  const { doc, outPath } = buildManifest(opts);
  mkdirSync(dirname(outPath), { recursive: true });
  const text = JSON.stringify(doc, null, 2) + '\n';
  writeFileSync(outPath, text, 'utf8');
  return { doc, outPath, bytes: Buffer.byteLength(text, 'utf8') };
}

// CLI: `node tools/manifest/build.mjs [--out <path>] [--root <path>]`
const isMain = resolve(process.argv[1] ?? '') === join(ROOT, 'tools', 'manifest', 'build.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) opts.outPath = args[++i];
    else if (args[i] === '--root' && args[i + 1]) opts.root = args[++i];
  }
  const { doc, outPath, bytes } = writeManifest(opts);
  console.log(`manifest: ${doc.files.length} files -> ${repoPosix(outPath)} (${bytes} bytes, v${doc.version})`);
}
