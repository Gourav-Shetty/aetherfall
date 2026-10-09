import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRouteKey, helloRouteKey } from './router/hash.js';
import { ShardRouter } from './shard.js';

// Sticky routing: the hello path used to route on the per-shard admit counter
// `nextId`, which never advanced on a redirecting shard — the cluster admitted
// exactly 1 player ever (12 clients -> 67 hops -> 1 admitted). Routing now
// keys on the client-stable identity (`nonce ?? token ?? name`), so every
// shard agrees on the owner and a redirect-following client lands fast.
// These tests simulate the multi-process cluster in-process: one ShardRouter
// per shard, all sharing the same 3-shard registry.

const SHARDS = ['shard-0', 'shard-1', 'shard-2'] as const;
const HOSTS = ['ws://localhost:8281', 'ws://localhost:8282', 'ws://localhost:8283'] as const;

function cluster(): ShardRouter[] {
  return SHARDS.map((id, i) => {
    const r = new ShardRouter(id);
    // Pin this router's own host (constructor guesses from PORT env).
    r.register({ shardId: id, host: HOSTS[i]!, players: 0 });
    for (let j = 0; j < SHARDS.length; j++) {
      if (j === i) continue;
      r.register({ shardId: SHARDS[j]!, host: HOSTS[j]!, players: 0 });
    }
    return r;
  });
}

/** Follow redirects exactly like a redirect-following client: same hello every hop. */
function admit(
  routers: ShardRouter[],
  hello: unknown,
  entry: number,
): { shard: string; hops: number } {
  let cur = entry;
  let hops = 0;
  for (let guard = 0; guard < 10; guard++) {
    const owner = routers[cur]!.routeHello(hello);
    if (owner === SHARDS[cur]) return { shard: owner, hops };
    hops++;
    const next = SHARDS.indexOf(owner as (typeof SHARDS)[number]);
    assert.ok(next >= 0, `unknown owner shard ${owner}`);
    cur = next;
  }
  throw new Error(`redirect loop for ${JSON.stringify(hello)}`);
}

describe('shard admission: stable-key routing admits across the cluster', () => {
  it('12 nonce clients across 3 shards admit 12 with <=36 total hops', () => {
    const routers = cluster();
    let totalHops = 0;
    const perShard = new Map<string, number>();
    for (let i = 0; i < 12; i++) {
      const hello = { t: 'hello', name: `client-${i}`, nonce: `uuid-${i}`, proto: 1 };
      const { shard, hops } = admit(routers, hello, i % 3);
      assert.ok(hops <= 3, `client ${i} took ${hops} hops (bound is 3)`);
      totalHops += hops;
      perShard.set(shard, (perShard.get(shard) ?? 0) + 1);
    }
    assert.equal(
      [...perShard.values()].reduce((a, b) => a + b, 0),
      12,
      'all 12 clients admitted',
    );
    assert.ok(totalHops <= 36, `total hops ${totalHops} exceeds 36`);
    // The point of sticky routing: the load actually spreads.
    assert.equal(perShard.size, 3, `all 3 shards admit someone (got ${JSON.stringify([...perShard])})`);
  });

  it('12 nameless-fallback (name-only) clients still admit 12 with <=36 hops', () => {
    const routers = cluster();
    let totalHops = 0;
    for (let i = 0; i < 12; i++) {
      const hello = { t: 'hello', name: `legacy-bot-${i}`, proto: 1 };
      const { hops } = admit(routers, hello, i % 3);
      assert.ok(hops <= 3, `client ${i} took ${hops} hops`);
      totalHops += hops;
    }
    assert.ok(totalHops <= 36, `total hops ${totalHops} exceeds 36`);
  });

  it('every shard agrees on the owner (no redirect ping-pong)', () => {
    const routers = cluster();
    const hellos: unknown[] = [
      { t: 'hello', name: 'alice', nonce: 'uuid-alice', proto: 1 },
      { t: 'hello', name: 'bob', proto: 1 },
      { t: 'hello', name: 'carol', token: 'tok.123.abc', proto: 1 },
      { t: 'hello', name: 'dave', sid: 'sess-dave', proto: 1 },
    ];
    for (const h of hellos) {
      const owners = new Set(routers.map((r) => r.routeHello(h)));
      assert.equal(owners.size, 1, `shards disagree on ${JSON.stringify(h)}: ${[...owners]}`);
    }
  });

  it('routing is deterministic per hello (reconnect lands on the same shard)', () => {
    const routers = cluster();
    const h = { t: 'hello', name: 'reconnector', nonce: 'stable-uuid-7', proto: 1 };
    const first = routers[0]!.routeHello(h);
    for (let k = 0; k < 5; k++) {
      assert.equal(routers[k % 3]!.routeHello(h), first);
    }
  });

  it('nonce aliases (sid/clientId/routeKey/sessionId) route identically', () => {
    assert.equal(helloRouteKey({ name: 'n', sid: 'k1' }), helloRouteKey({ name: 'n', nonce: 'k1' }));
    assert.equal(helloRouteKey({ name: 'n', clientId: 'k1' }), helloRouteKey({ name: 'n', nonce: 'k1' }));
    assert.equal(helloRouteKey({ name: 'n', routeKey: 'k1' }), helloRouteKey({ name: 'n', nonce: 'k1' }));
    assert.equal(helloRouteKey({ name: 'n', sessionId: 'k1' }), helloRouteKey({ name: 'n', nonce: 'k1' }));
    // Canonical `nonce` wins over aliases.
    assert.equal(
      helloRouteKey({ name: 'n', nonce: 'a', sid: 'b' }),
      helloRouteKey({ name: 'n', nonce: 'a' }),
    );
  });

  it('malformed keys fall back without throwing (token, then name)', () => {
    assert.equal(extractRouteKey({ nonce: '' }), undefined);
    assert.equal(extractRouteKey({ nonce: 'x'.repeat(500) }), undefined);
    assert.equal(extractRouteKey({ nonce: null }), undefined);
    assert.equal(extractRouteKey(null), undefined);
    assert.equal(helloRouteKey({ name: 'bob', nonce: '' }), helloRouteKey({ name: 'bob' }));
    assert.equal(helloRouteKey({ name: 'bob', token: 'T' }), 'token:T');
    assert.equal(helloRouteKey({ name: 'bob' }), 'name:bob');
    assert.equal(helloRouteKey(null), 'name:hero');
  });
});
