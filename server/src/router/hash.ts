// @aetherfall/server — rendezvous (highest-random-weight) hashing for shard routing.
// Every shard scores itself per player: score = hash(playerId + shardId); the
// highest score owns the player. Deterministic, no ring to maintain, and
// membership changes only move players that mapped to the added/removed shard
// (~1/N each), which keeps rebalancing well under 30% for N >= 2.

/** cyrb53 string hash: strong avalanche, deterministic across platforms. */
export function hashStr(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

/** Rendezvous score for one (player, shard) pair. Higher wins. */
export function rendezvousScore(playerId: number | string, shardId: string): number {
  return hashStr(`${playerId}::${shardId}`);
}

/**
 * Sticky-route a player to one shard in `shardIds`.
 * Single entry (or empty) -> that entry / 'shard-0', so single-shard
 * deployments always stay local with zero config.
 */
export function routePlayer(playerId: number | string, shardIds: readonly string[]): string {
  if (shardIds.length === 0) return 'shard-0';
  if (shardIds.length === 1) return shardIds[0];
  let best = shardIds[0];
  let bestScore = -1;
  for (const id of shardIds) {
    const s = rendezvousScore(playerId, id);
    if (s > bestScore) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

/**
 * Fraction of `playerIds` whose route changes between two shard lists.
 * Used by tests to bound rebalancing churn on add/remove.
 */
export function churn(
  playerIds: readonly (number | string)[],
  before: readonly string[],
  after: readonly string[],
): number {
  if (playerIds.length === 0) return 0;
  let moved = 0;
  for (const p of playerIds) {
    if (routePlayer(p, before) !== routePlayer(p, after)) moved++;
  }
  return moved / playerIds.length;
}

// --- sticky-routing keys ---------------------------------
// The hello path used to route on the per-shard admit counter `nextId`, which
// only advances AFTER admission: a shard that did not own id 1 redirected
// every inbound hello forever and never admitted anyone (12 clients ->
// 67 hops -> 1 admitted cluster-wide). Routing must key on something the
// CLIENT holds stable across reconnects, never on server admit state.

/** Max client route-key length honored for sticky routing (longer => truncated). */
export const MAX_ROUTE_KEY_LEN = 128;

/**
 * Hello fields accepted as a client-provided sticky-routing key.
 * Canonical: `nonce`. The rest are aliases for clients (e.g. bot harnesses)
 * that already send one of these names; all normalize to the same key.
 */
const ROUTE_KEY_FIELDS = ['nonce', 'sid', 'clientId', 'routeKey', 'sessionId'] as const;

/**
 * Extract a client-provided sticky-routing key from an untrusted hello
 * object. Returns the first present alias (`nonce` first), truncated to
 * MAX_ROUTE_KEY_LEN, or undefined when none is usable. Never throws and never
 * rejects the hello: a bad key just falls back to `token ?? name`.
 */
export function extractRouteKey(o: unknown): string | undefined {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const r = o as Record<string, unknown>;
    for (const f of ROUTE_KEY_FIELDS) {
      const v = r[f];
      if (typeof v === 'string') {
        if (v.length === 0 || v.length > 256) continue;
        return v.slice(0, MAX_ROUTE_KEY_LEN);
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        return String(v).slice(0, MAX_ROUTE_KEY_LEN);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable sticky-routing key for one hello: client nonce first, then the auth
 * token (stable per login), then the display name (stable when the client
 * reconnects with the same hello, as redirect-followers do). Namespaced by
 * kind so a nonce can never collide with a token/name that hashes alike.
 * Never throws; always returns a non-empty string.
 */
export function helloRouteKey(h: unknown): string {
  try {
    const o = (h ?? {}) as Record<string, unknown>;
    const nonce = extractRouteKey(o);
    if (nonce !== undefined) return `nonce:${nonce}`;
    const tok = o['token'];
    if (typeof tok === 'string' && tok.length > 0 && tok.length <= 512) return `token:${tok}`;
    const nm = o['name'];
    if (typeof nm === 'string' && nm.length > 0) return `name:${nm.slice(0, 64)}`;
    if (typeof nm === 'number' && Number.isFinite(nm)) return `name:${nm}`;
    return 'name:hero';
  } catch {
    return 'name:hero';
  }
}
