// @aetherfall/server — wall map persistence + admin HTTP surface (additive).
// The sim stays authoritative: this module only loads/saves/validates the
// wall set that Sim.setWalls() installs. Wired in index.ts:
//   boot  -> loadWallsFile() (./data/walls.json when present, else open arena)
//   GET  /walls (metrics port, public, CORS-open for the ?editormode client)
//   POST /walls (metrics port, ADMIN_TOKEN bearer required, persists to disk)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeWallsDoc,
  validateWalls,
  type WallRect,
  type WallsDoc,
} from '@aetherfall/shared';

export type { WallRect };

/** Simple shared-secret for POST /walls. Default matches docs (dev). */
export function adminToken(): string {
  return process.env.ADMIN_TOKEN ?? 'dev';
}

/** True when ADMIN_TOKEN is unset (dev default). Never use in prod. */
export function adminTokenIsDefault(): boolean {
  return adminToken() === 'dev';
}

/** True in production (NODE_ENV=production). */
export function isProd(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Admin auth is allowed unless prod is running on the dev default token.
 * In prod + default token every admin request is denied (misconfiguration
 * fail-closed); elsewhere the bearer check in isAdminRequest() applies.
 */
export function isAdminAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProd(env) && (env.ADMIN_TOKEN ?? 'dev') === 'dev') return false;
  return true;
}

/** Warn once when the dev default admin token is in use. Returns true when default. */
let warnedDefaultAdmin = false;
export function warnIfDefaultAdmin(): boolean {
  if (!adminTokenIsDefault()) return false;
  if (warnedDefaultAdmin) return true;
  warnedDefaultAdmin = true;
  console.warn('[server] walls: ADMIN_TOKEN is the dev default — set a secret (prod refuses admin auth until you do)');
  return true;
}

/** Test helper: reset the warn-once flag. */
export function _resetAdminWarn(): void {
  warnedDefaultAdmin = false;
}

// --- POST /walls rate limit: 10 req/min per IP (sliding window) -------------

export const WALLS_RATE_LIMIT = 10;
export const WALLS_RATE_WINDOW_MS = 60_000;

const wallsHits = new Map<string, number[]>();

function normIp(ip: unknown): string {
  if (typeof ip === 'string' && ip.length > 0 && ip.length <= 64) return ip;
  return 'unknown';
}

/**
 * Sliding-window rate check: max 10 POST /walls per IP per 60s.
 * Returns true when allowed (and records the hit), false when limited.
 * Never throws; unknown IPs share one bucket (fail-closed-ish).
 */
export function checkWallsRateLimit(ip: unknown, now: number = Date.now()): boolean {
  try {
    const key = normIp(ip);
    const win = WALLS_RATE_WINDOW_MS;
    const arr = wallsHits.get(key) ?? [];
    while (arr.length > 0 && now - arr[0]! > win) arr.shift();
    if (arr.length >= WALLS_RATE_LIMIT) {
      wallsHits.set(key, arr);
      return false;
    }
    arr.push(now);
    wallsHits.set(key, arr);
    // Bound memory: drop buckets idle > 2 windows on this hit's pass.
    if (wallsHits.size > 10000) {
      for (const [k, v] of wallsHits) {
        if (v.length === 0 || now - v[v.length - 1]! > win * 2) wallsHits.delete(k);
        if (wallsHits.size <= 5000) break;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Test helper: clear all rate-limit buckets. */
export function resetWallsRateLimit(): void {
  wallsHits.clear();
}

/** Candidate walls.json locations (first hit wins for load). */
export function wallsCandidates(): string[] {
  const list: string[] = [];
  if (process.env.WALLS_PATH) list.push(resolve(process.env.WALLS_PATH));
  list.push(resolve(process.cwd(), 'data/walls.json'));
  list.push(resolve(process.cwd(), 'server/data/walls.json'));
  list.push(resolve(process.cwd(), '../data/walls.json'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    list.push(resolve(here, '../data/walls.json'));
    list.push(resolve(here, '../../data/walls.json'));
  } catch {
    /* ignore */
  }
  return [...new Set(list)];
}

/** Existing walls file, or null when the arena should stay open. */
export function findWallsFile(): string | null {
  for (const c of wallsCandidates()) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Where POST /walls persists (WALLS_PATH > existing file > cwd/data). */
export function wallsSavePath(): string {
  if (process.env.WALLS_PATH) return resolve(process.env.WALLS_PATH);
  return findWallsFile() ?? resolve(process.cwd(), 'data/walls.json');
}

/** Load + validate walls.json. Returns [] when absent/invalid (open arena). */
export function loadWallsFile(from?: string): WallRect[] {
  const path = from ?? findWallsFile();
  if (!path) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const v = validateWalls(JSON.parse(raw));
    if (!v.ok) {
      console.warn(`[server] walls: ${path} invalid (${v.error}), using open arena`);
      return [];
    }
    return v.walls;
  } catch (err) {
    console.warn(`[server] walls: failed to load ${path} (${String(err)}), using open arena`);
    return [];
  }
}

/** Validate + persist a wall set. Returns the file path written. */
export function saveWallsFile(walls: WallRect[], to?: string): string {
  const v = validateWalls(encodeWallsDoc(walls));
  if (!v.ok) throw new Error(`walls: refusing to save invalid set (${v.error})`);
  const path = to ?? wallsSavePath();
  mkdirSync(dirname(path), { recursive: true });
  const doc: WallsDoc = encodeWallsDoc(v.walls);
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return path;
}

/** Canonical GET /walls payload for the current sim wall set. */
export function wallsToDoc(walls: WallRect[]): WallsDoc {
  return encodeWallsDoc(walls);
}

/**
 * Admin check: `Authorization: Bearer <ADMIN_TOKEN>` or `x-admin-token`.
 * The `?token=`/`?adminToken=` query fallback is DEV-ONLY (default): query
 * strings leak the secret into access logs, proxies, Referer and history, so
 * prod requires the header forms. Pass `allowQueryToken` to override.
 */
export function isAdminRequest(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
  opts: { allowQueryToken?: boolean } = {},
): boolean {
  const token = adminToken();
  const auth = headers['authorization'];
  if (typeof auth === 'string' && secretEq(auth, `Bearer ${token}`)) return true;
  const hdr = headers['x-admin-token'];
  if (typeof hdr === 'string' && secretEq(hdr, token)) return true;
  const allowQuery = opts.allowQueryToken ?? !isProd();
  if (url && allowQuery) {
    const q = url.indexOf('?');
    if (q >= 0) {
      const params = new URLSearchParams(url.slice(q + 1));
      const qt = params.get('token') ?? params.get('adminToken');
      if (qt !== null && secretEq(qt, token)) return true;
    }
  }
  return false;
}

/** Constant-time secret compare (digest-then-compare keeps lengths equal). */
function secretEq(a: string, b: string): boolean {
  try {
    const ha = createHash('sha256').update(a, 'utf8').digest();
    const hb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

/** Max POST /walls body bytes (1MB). Larger bodies are rejected (413). */
export const MAX_WALLS_BODY_BYTES = 1_000_000;

/** Throw a 413 when the body exceeds the 1MB cap. */
export function assertWallsBodySize(body: string | Buffer | unknown): void {
  const len = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : Buffer.isBuffer(body) ? body.length : 0;
  if (len > MAX_WALLS_BODY_BYTES) {
    const err = new Error(`walls body too large (${len} > ${MAX_WALLS_BODY_BYTES})`) as Error & { status?: number };
    err.status = 413;
    throw err;
  }
}

/** Parse + validate a POST /walls body. Throws with status-coded message. */
export function parseWallsBody(body: string): WallRect[] {
  assertWallsBodySize(body);
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    const err = new Error('invalid JSON') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const v = validateWalls(doc);
  if (!v.ok) {
    const err = new Error(v.error) as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  return v.walls;
}
