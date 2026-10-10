// Client asset loader — content-addressed manifest + lazy art with placeholder fallback.
//
// The builder (tools/manifest/build.mjs, `npm run manifest`) scans
// client/public/shots + docs/screenshots + client/public/art and writes
// client/public/manifest.json:
//
//   { "version": "0.1.0", "files": [ { "file", "sha256", "bytes" }, ... ] }
//
// This module fetches that catalog, lazy-loads art by name with an in-memory
// cache, and never leaves a slot blank: any missing file, bad manifest, or
// failed fetch resolves to an inline SVG data-URI placeholder. It also exposes
// progress ({ loaded, total }) for the loading screen in main.ts.
//
// Boot contract: everything is best-effort. loadManifest() returns null (never
// throws) when the manifest is absent, and load() returns a placeholder (never
// throws) when the file is missing. The game boots identically with or without
// the manifest.

export interface ManifestEntry {
  file: string;
  sha256: string;
  bytes: number;
}

export interface AssetManifest {
  version: string;
  files: ManifestEntry[];
}

export interface AssetProgress {
  loaded: number;
  total: number;
  /** 0..1 (1 when total is 0). */
  frac: number;
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status?: number; text(): Promise<string>; json(): Promise<unknown> }>;

function defaultFetch(): FetchFn | null {
  try {
    const f = (globalThis as { fetch?: unknown }).fetch;
    if (typeof f === 'function') return f as FetchFn;
    return null;
  } catch {
    return null;
  }
}

/** Hash a name to a hue (deterministic, for placeholder tints). */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return ((h >>> 0) % 360 + 360) % 360;
}

/**
 * Inline SVG placeholder for an asset name. Always returns a non-empty
 * `data:image/svg+xml` URI, so a missing file never renders blank.
 * Pure (no DOM, no fetch) — safe in tests and headless.
 */
export function placeholderFor(name: string): string {
  const safe = String(name ?? 'asset').slice(0, 32) || 'asset';
  const hue = hueFor(safe);
  const label = safe.replace(/[<>&"']/g, '').slice(0, 24) || 'asset';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<rect width="256" height="256" fill="hsl(${hue},28%,12%)"/>` +
    `<rect x="10" y="10" width="236" height="236" rx="14" fill="none" stroke="hsl(${hue},60%,60%)" stroke-width="3"/>` +
    `<polygon points="128,52 164,128 128,204 92,128" fill="none" stroke="hsl(${hue},60%,60%)" stroke-width="5" stroke-linejoin="round"/>` +
    `<text x="128" y="232" font-family="system-ui,sans-serif" font-size="16" fill="hsl(${hue},60%,80%)" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** True when the value looks like a manifest entry. */
function isEntry(v: unknown): v is ManifestEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.file === 'string' && typeof o.sha256 === 'string' && typeof o.bytes === 'number';
}

/** Validate untrusted manifest JSON (fetched over HTTP). Returns null when bad. */
export function parseManifest(v: unknown): AssetManifest | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== 'string' || !Array.isArray(o.files)) return null;
  const files: ManifestEntry[] = [];
  for (const e of o.files) {
    if (!isEntry(e)) return null;
    files.push({ file: e.file, sha256: e.sha256, bytes: e.bytes });
  }
  return { version: o.version, files };
}

/** Strip the "client/public/" repo prefix to a vite-served public URL. */
export function publicUrlFor(repoFile: string): string {
  const f = String(repoFile).replace(/\\/g, '/');
  const prefix = 'client/public/';
  const rel = f.startsWith(prefix) ? f.slice(prefix.length) : f.replace(/^public\//, '');
  return '/' + rel.replace(/^\/+/, '');
}

export class AssetLoader {
  private fetchFn: FetchFn | null;
  readonly base: string;
  manifest: AssetManifest | null = null;
  private cache = new Map<string, string>();
  private loadedCount = 0;
  private totalCount = 0;

  constructor(opts: { base?: string; fetchFn?: FetchFn | null } = {}) {
    this.base = opts.base ?? '';
    this.fetchFn = opts.fetchFn !== undefined ? opts.fetchFn : defaultFetch();
  }

  /** Number of cached art URLs (placeholders included). */
  get size(): number {
    return this.cache.size;
  }

  /** Progress for the loading screen. */
  progress(): AssetProgress {
    const total = this.totalCount;
    const loaded = Math.min(this.loadedCount, total);
    return { loaded, total, frac: total === 0 ? 1 : loaded / total };
  }

  /** Find the manifest entry for an art name ("logo" matches ".../logo.svg"). */
  entryFor(name: string): ManifestEntry | null {
    const m = this.manifest;
    if (!m) return null;
    const n = String(name).replace(/^\/+/, '');
    // Exact repo path, public path, or basename-without-extension match.
    for (const e of m.files) {
      const f = e.file.replace(/\\/g, '/');
      if (f === n || f.endsWith('/' + n)) return e;
      const base = f.slice(f.lastIndexOf('/') + 1);
      const stem = base.replace(/\.[a-z0-9]+$/i, '');
      if (stem === n || base === n) return e;
    }
    return null;
  }

  /**
   * Fetch + validate the manifest catalog. Returns the manifest, or null when
   * missing/invalid/offline. Never throws — the boot continues without it.
   */
  async loadManifest(url?: string): Promise<AssetManifest | null> {
    const target = url ?? (this.base + '/manifest.json');
    try {
      if (!this.fetchFn) return null;
      const res = await this.fetchFn(target);
      if (!res || res.ok === false) return null;
      const json = await res.json();
      const parsed = parseManifest(json);
      if (!parsed) return null;
      this.manifest = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Lazy-load one art asset by name. Returns a public URL on success or an
   * inline SVG placeholder on any failure. Cached in memory. Never throws.
   */
  async load(name: string): Promise<string> {
    const key = String(name);
    try {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
      const entry = this.entryFor(key);
      const url = entry ? this.base + publicUrlFor(entry.file) : this.base + '/art/' + key + '.svg';
      let resolved: string = placeholderFor(key);
      try {
        if (this.fetchFn) {
          const res = await this.fetchFn(url);
          if (res && res.ok !== false) {
            // Drain the body so a 404-with-HTML still counts as a miss below;
            // any non-empty text body means the file exists on the server.
            const text = await res.text();
            if (typeof text === 'string' && text.length > 0) resolved = url;
          }
        }
      } catch {
        resolved = placeholderFor(key);
      }
      this.cache.set(key, resolved);
      return resolved;
    } catch {
      const fb = placeholderFor(key);
      this.cache.set(key, fb);
      return fb;
    }
  }

  /** Cached URL for a name, or undefined when not loaded yet. */
  cached(name: string): string | undefined {
    return this.cache.get(String(name));
  }

  /** Forget the in-memory cache (tests / quality switches). */
  clear(): void {
    this.cache.clear();
    this.loadedCount = 0;
    this.totalCount = 0;
  }

  /**
   * Preload a list of art names, reporting progress after each one.
   * Resolves to the URL list in input order. Never throws.
   */
  async preload(names: string[], onProgress?: (p: AssetProgress) => void): Promise<string[]> {
    const list = [...names];
    this.totalCount = list.length;
    this.loadedCount = 0;
    const out: string[] = [];
    for (const n of list) {
      try {
        out.push(await this.load(n));
      } catch {
        out.push(placeholderFor(n));
      }
      this.loadedCount++;
      try {
        onProgress?.(this.progress());
      } catch {
        /* progress callbacks must never break loading */
      }
    }
    return out;
  }
}

/** Default art set preloaded on the loading screen (must match client/public/art). */
export const DEFAULT_ART = ['logo', 'hero', 'zone-banner'] as const;
