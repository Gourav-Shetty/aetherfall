// @aetherfall/server — dev auth: JWT-less HMAC tokens + guest identities.
// Token format: base64url(name).exp.hex(hmac_sha256(secret, "name.exp"))
// Hardened (security): strict name charset, server-side revoked-token
// blacklist (kick revocation), MAX_PLAYERS_PER_SHARD admission helper with
// queue-position event, and crash-safe hello validation for fuzz traffic.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ServerMsg } from '@aetherfall/shared';
import { extractRouteKey } from './router/hash.js';

const SECRET = process.env.AUTH_SECRET ?? 'aetherfall-dev-secret';
const TOKEN_TTL_MS = 24 * 3600 * 1000;

/** Default shard capacity when MAX_PLAYERS_PER_SHARD is unset/invalid. */
export const DEFAULT_MAX_PLAYERS_PER_SHARD = 500;
/** Max raw name length accepted before sanitize (DoS guard for fuzz/huge). */
export const MAX_RAW_NAME_LEN = 64;

function b64uEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64uDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('hex');
}

export type Identity = { name: string; guest: boolean };

// --- revoked-token blacklist (kick revocation) ---------------------------
// In-memory set of token strings revoked via revokeToken() (kick path).
// Single-process default; multi-shard deployments should back this with
// redis (see docs/SECURITY.md) — the verify() check stays the same.
const revokedTokens = new Set<string>();
const MAX_REVOKED = 10000;

/** Revoke a token server-side (call on kick/shadowban). Idempotent. */
export function revokeToken(token: string | undefined | null): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return false;
  if (revokedTokens.size >= MAX_REVOKED) {
    // Evict oldest (insertion-order) to bound memory under fuzz.
    const oldest = revokedTokens.values().next().value as string | undefined;
    if (oldest !== undefined) revokedTokens.delete(oldest);
  }
  revokedTokens.add(token);
  return true;
}

/** True when a token was revoked via revokeToken(). */
export function isTokenRevoked(token: string | undefined | null): boolean {
  if (typeof token !== 'string') return false;
  return revokedTokens.has(token);
}

/** Number of revoked tokens (health/metrics hook). */
export function revokedTokenCount(): number {
  return revokedTokens.size;
}

/** Test helper: clear the blacklist. */
export function clearRevokedTokens(): void {
  revokedTokens.clear();
}

export function issueToken(name: string, ttlMs: number = TOKEN_TTL_MS): string {
  const clean = sanitizeName(name);
  const exp = Date.now() + ttlMs;
  const payload = `${b64uEncode(clean)}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): Identity | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
  if (revokedTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [nameB64, expStr, sig] = parts as [string, string, string];
  if (nameB64.length > 64 || expStr.length > 20 || sig.length > 128) return null;
  const payload = `${nameB64}.${expStr}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  try {
    const name = sanitizeName(b64uDecode(nameB64));
    if (!name) return null;
    return { name, guest: false };
  } catch {
    return null;
  }
}

/** Guest login: no token, name is client-chosen (sanitized, capped). */
export function guestIdentity(name: string): Identity {
  // sanitizeName() always returns a non-empty string, so no extra fallback here.
  return { name: sanitizeName(name), guest: true };
}

/** Resolve hello credentials -> identity (token wins, else guest). */
export function resolveIdentity(name: string, token?: string): Identity {
  return verifyToken(token) ?? guestIdentity(name);
}

/**
 * Strict display-name sanitizer: 16 chars max, alnum + `_` + `-` only.
 * No spaces (prevents impersonation padding + chat-spoof alignment tricks).
 * Non-string/empty input falls back to 'hero'. Never throws.
 */
export function sanitizeName(name: unknown): string {
  let s: string;
  if (typeof name === 'string') s = name;
  else if (typeof name === 'number' && Number.isFinite(name)) s = String(name);
  else return 'hero';
  if (s.length > MAX_RAW_NAME_LEN) s = s.slice(0, MAX_RAW_NAME_LEN);
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'hero';
}

// --- shard admission -----------------------------------------------------

/**
 * Max players per shard from env (default 500). Invalid values
 * (NaN, <=0, Infinity handled as unlimited only when explicitly set to
 * "Infinity") fall back to the default so a typo can't open the floodgate
 * or lock the server.
 */
export function maxPlayersPerShard(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_PLAYERS_PER_SHARD;
  if (raw === undefined || raw === '') return DEFAULT_MAX_PLAYERS_PER_SHARD;
  if (raw === 'Infinity') return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PLAYERS_PER_SHARD;
  return Math.floor(n);
}

/** Queue-position event sent when a shard is full (protocol v1 `event`). */
export function queuePositionEvent(position: number, max: number): ServerMsg {
  const pos = Number.isFinite(position) && position > 0 ? Math.floor(position) : 1;
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_PLAYERS_PER_SHARD;
  return { t: 'event', kind: 'queue', payload: { position: pos, max: cap } };
}

// --- crash-safe hello validation (fuzz guard) ------------------------------

/** Minimal shape of a hello message after JSON parse (unknown trust). */
export type HelloMsg = {
  t: 'hello';
  name: string;
  token?: string;
  proto: number;
  /**
   * SHARDING: client-stable sticky-routing key, normalized from
   * `nonce` / `sid` / `clientId` / `routeKey` / `sessionId` (canonical
   * `nonce`; aliases accepted). Present only when the client sent a usable
   * key — absent means "route on `token ?? name`". Optional/additive.
   * The socket hello path keys sticky routing on `helloRouteKey(hm)` from
   * `router/hash.js` (single choke point; do not re-derive ad hoc).
   */
  nonce?: string;
};

/**
 * Validate an untrusted parsed hello body. Returns a sanitized copy or
 * null when the message must be dropped (bad proto, huge payload).
 * Never throws — safe for NaN/huge/null-proto fuzz traffic.
 */
export function validateHello(m: unknown): HelloMsg | null {
  try {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const o = m as Record<string, unknown>;
    if (o['t'] !== 'hello') return null;
    const proto = o['proto'];
    if (typeof proto !== 'number' || !Number.isFinite(proto)) return null;
    if (!Number.isInteger(proto)) return null;
    let name: string;
    if (typeof o['name'] === 'string') name = o['name'];
    else if (typeof o['name'] === 'number' && Number.isFinite(o['name'])) name = String(o['name']);
    else return null;
    if (name.length > MAX_RAW_NAME_LEN * 16) return null; // absurd payload
    let token: string | undefined;
    if (o['token'] !== undefined) {
      if (typeof o['token'] !== 'string') return null;
      if (o['token'].length > 512) return null;
      token = o['token'];
    }
    // SHARDING: preserve the client-stable routing key when usable.
    // Only attached when present (existing callers/tests that deep-equal a
    // keyless hello stay green); a malformed key never fails validation, it
    // just falls back to `token ?? name` at route time.
    const nonce = extractRouteKey(o);
    return { t: 'hello', name, token, proto, ...(nonce !== undefined ? { nonce } : {}) };
  } catch {
    return null;
  }
}
