// @aetherfall/shared — protocol v1, types, seeded RNG, codec
export * from './catalog.js';
export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 20;
export const SNAPSHOT_HZ = 10;

export type Vec2 = { x: number; y: number };

export type EntitySnapshot = {
  id: number;
  kind: 'player' | 'npc' | 'mob' | 'pickup' | 'projectile';
  p: Vec2; v: Vec2; hp: number; maxHp: number;
  dir?: number; level?: number; name?: string;
  seq?: number;
  /**
   * TERRAIN: `heightAt()` of the tile the body stands on (0 = water line),
   * in world units. Optional and additive: shards running with TERRAIN=off
   * omit it, and clients fall back to sampling the field themselves.
   */
  z?: number;
};

export type ClientInput = {
  seq: number; dt: number;
  move: Vec2; attack?: boolean; skill?: number;
  chat?: string; targetId?: number;
};

export type ServerMsg =
  | { t: 'welcome'; id: number; tick: number; snapshot: EntitySnapshot[] }
  | { t: 'snapshot'; tick: number; entities: EntitySnapshot[]; removed: number[] }
  | { t: 'chat'; from: string; text: string; channel: 'global' | 'guild' | 'say' }
  | { t: 'event'; kind: string; payload: unknown };

export type ClientMsg =
  | {
      t: 'hello';
      name: string;
      token?: string;
      proto: number;
      /**
       * SHARDING: client-stable sticky-routing key (a per-install UUID the
       * client generates once and resends on every hello, including reconnects
       * after a `redirect`). The server routes on `nonce ?? token ?? name`, so
       * a client that keeps its nonce is always routed to the same shard and a
       * redirect costs at most 1 hop. Guests without a nonce fall back to
       * `token ?? name` (stable, but same-named players co-locate).
       * Aliases `sid` / `clientId` / `routeKey` / `sessionId` are honored the
       * same way; when several are present `nonce` wins. Optional and
       * additive: old clients that omit it still connect (v1 compatible).
       */
      nonce?: string;
      /** Alias of `nonce` (accepted, normalized to `nonce` server-side). */
      sid?: string;
      /** Alias of `nonce` (accepted, normalized to `nonce` server-side). */
      clientId?: string;
      /** Alias of `nonce` (accepted, normalized to `nonce` server-side). */
      routeKey?: string;
      /** Alias of `nonce` (accepted, normalized to `nonce` server-side). */
      sessionId?: string;
    }
  | { t: 'input'; input: ClientInput }
  | { t: 'chat'; text: string; channel: 'global' | 'guild' | 'say' };

// Seeded RNG (mulberry32) — deterministic world-gen
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function encodeMsg(m: unknown): string { return JSON.stringify(m); }
export function decodeMsg(s: string): ClientMsg | ServerMsg { return JSON.parse(s); }

// ---- walls (level editor + server collision) — additive, protocol v1 untouched ----
// Canonical file: { format:'aetherfall-walls/v1', tile:1, version:1, count, walls }
// where walls[] accepts WallRect objects {x,y,w,h} (canonical) and legacy
// [tx,ty] tuples from the original client-overlay editor export.
export const WALLS_VERSION = 1;
export const WALLS_FORMAT = 'aetherfall-walls/v1';
export const WALLS_TILE = 1;
/** Hard cap on wall entries per file (DoS guard for POST /walls). */
export const WALLS_MAX_COUNT = 10000;
/** Max coordinate value (arena is 100x100; headroom for future maps). */
export const WALLS_MAX_COORD = 1000;
/** Max w/h per rect (bounds total area per entry). */
export const WALLS_MAX_EXTENT = 128;
/** Authoritative body radius used for wall collision (sim + prediction). */
export const PLAYER_RADIUS = 0.4;

export type WallRect = { x: number; y: number; w: number; h: number };
export type WallsDoc = {
  format: string;
  tile: number;
  version: number;
  count: number;
  walls: WallRect[];
};

export type ValidateWallsOk = { ok: true; walls: WallRect[] };
export type ValidateWallsErr = { ok: false; error: string };
export type ValidateWallsResult = ValidateWallsOk | ValidateWallsErr;

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Normalize one walls[] entry to a WallRect, or null when invalid. */
function normalizeWallEntry(e: unknown): WallRect | null {
  if (Array.isArray(e)) {
    if (e.length !== 2 || !isFiniteNum(e[0]) || !isFiniteNum(e[1])) return null;
    const x = Math.floor(e[0] as number);
    const y = Math.floor(e[1] as number);
    if (x < 0 || y < 0 || x > WALLS_MAX_COORD || y > WALLS_MAX_COORD) return null;
    return { x, y, w: 1, h: 1 };
  }
  if (e !== null && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    // legacy {tx,ty} shape
    if ('tx' in o || 'ty' in o) {
      if (!isFiniteNum(o['tx']) || !isFiniteNum(o['ty'])) return null;
      const x = Math.floor(o['tx'] as number);
      const y = Math.floor(o['ty'] as number);
      if (x < 0 || y < 0 || x > WALLS_MAX_COORD || y > WALLS_MAX_COORD) return null;
      return { x, y, w: 1, h: 1 };
    }
    if (!isFiniteNum(o['x']) || !isFiniteNum(o['y'])) return null;
    const x = o['x'] as number;
    const y = o['y'] as number;
    let w = 1;
    let h = 1;
    if (o['w'] !== undefined) {
      if (!isFiniteNum(o['w'])) return null;
      w = o['w'] as number;
    }
    if (o['h'] !== undefined) {
      if (!isFiniteNum(o['h'])) return null;
      h = o['h'] as number;
    }
    if (x < 0 || y < 0 || x > WALLS_MAX_COORD || y > WALLS_MAX_COORD) return null;
    if (!(w >= 1 && w <= WALLS_MAX_EXTENT) || !(h >= 1 && h <= WALLS_MAX_EXTENT)) return null;
    if (!Number.isFinite(x + w) || !Number.isFinite(y + h)) return null;
    return { x, y, w, h };
  }
  return null;
}

/**
 * Validate an untrusted walls file (disk, POST body, editor import).
 * Accepts canonical {x,y,w,h} rects plus legacy [tx,ty] tuples / {tx,ty}.
 * Rejects NaN/Infinity, negatives, huge coords/extents, oversized files.
 */
export function validateWalls(doc: unknown): ValidateWallsResult {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'walls: document must be an object' };
  }
  const o = doc as Record<string, unknown>;
  if (o['format'] !== undefined && o['format'] !== WALLS_FORMAT) {
    return { ok: false, error: `walls: bad format (want ${WALLS_FORMAT})` };
  }
  if (o['tile'] !== undefined && o['tile'] !== WALLS_TILE) {
    return { ok: false, error: 'walls: bad tile (want 1)' };
  }
  if (o['version'] !== undefined && o['version'] !== WALLS_VERSION) {
    return { ok: false, error: 'walls: bad version (want 1)' };
  }
  const raw = o['walls'];
  if (!Array.isArray(raw)) return { ok: false, error: 'walls: walls[] missing' };
  if (raw.length > WALLS_MAX_COUNT) return { ok: false, error: `walls: too many (max ${WALLS_MAX_COUNT})` };
  const out: WallRect[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const n = normalizeWallEntry(raw[i]);
    if (!n) return { ok: false, error: `walls: invalid entry at index ${i}` };
    const k = `${n.x},${n.y},${n.w},${n.h}`;
    if (seen.has(k)) continue; // dedupe exact duplicates
    seen.add(k);
    out.push(n);
  }
  return { ok: true, walls: out };
}

/** Build a canonical file doc from validated rects. */
export function encodeWallsDoc(walls: WallRect[]): WallsDoc {
  return { format: WALLS_FORMAT, tile: WALLS_TILE, version: WALLS_VERSION, count: walls.length, walls: [...walls] };
}

/** Tile key helpers for the Set<string> tile model used by renderers/editors. */
export function wallKey(tx: number, ty: number): string {
  return tx + ',' + ty;
}

export function parseWallKey(k: string): [number, number] | null {
  const i = k.indexOf(',');
  if (i < 0) return null;
  const x = Number(k.slice(0, i));
  const y = Number(k.slice(i + 1));
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return [x, y];
}

/** Expand rects to unit tile keys (for renderers that draw per-tile). */
export function wallsToTileKeys(walls: WallRect[]): Set<string> {
  const s = new Set<string>();
  for (const r of walls) {
    const x0 = Math.floor(r.x);
    const y0 = Math.floor(r.y);
    const x1 = Math.ceil(r.x + r.w);
    const y1 = Math.ceil(r.y + r.h);
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) s.add(wallKey(tx, ty));
    }
  }
  return s;
}

/** Compact unit tile keys to 1x1 rects (client export / POST path). */
export function tileKeysToWalls(keys: Iterable<string>): WallRect[] {
  const out: WallRect[] = [];
  for (const k of keys) {
    const t = parseWallKey(k);
    if (!t) continue;
    out.push({ x: t[0], y: t[1], w: 1, h: 1 });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

/** Circle-vs-rect hit test (player body vs one wall set). */
export function circleHitsWalls(x: number, y: number, r: number, walls: WallRect[]): boolean {
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]!;
    if (x < w.x - r || x > w.x + w.w + r || y < w.y - r || y > w.y + w.h + r) continue;
    const cx = x < w.x ? w.x : x > w.x + w.w ? w.x + w.w : x;
    const cy = y < w.y ? w.y : y > w.y + w.h ? w.y + w.h : y;
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/**
 * Axis-separated move: X first, then Y at the new X. A blocked axis is
 * reverted while the other still applies, so bodies slide along walls
 * instead of sticking (e.g. diagonal into a vertical wall keeps Y motion).
 */
export function moveWithSlide(
  x: number,
  y: number,
  dx: number,
  dy: number,
  r: number,
  walls: WallRect[],
): { x: number; y: number } {
  let nx = x + dx;
  if (walls.length !== 0 && circleHitsWalls(nx, y, r, walls)) nx = x;
  let ny = y + dy;
  if (walls.length !== 0 && circleHitsWalls(nx, ny, r, walls)) ny = y;
  return { x: nx, y: ny };
}
