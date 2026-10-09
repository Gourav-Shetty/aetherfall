import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { churn, rendezvousScore, routePlayer as hashRoute } from './router/hash.js';
import { parseShardHosts } from './router/registry.js';
import { ShardNode, ShardRouter, routePlayer } from './shard.js';

const PLAYERS = Array.from({ length: 4000 }, (_, i) => i + 1);
const FIVE = ['shard-0', 'shard-1', 'shard-2', 'shard-3', 'shard-4'];

describe('rendezvous hashing', () => {
  it('is deterministic per (player, shard)', () => {
    assert.equal(rendezvousScore(42, 'shard-0'), rendezvousScore(42, 'shard-0'));
    assert.equal(hashRoute(7, FIVE), hashRoute(7, FIVE));
  });

  it('distributes players across shards (no shard starved or dominant)', () => {
    const counts = new Map<string, number>();
    for (const p of PLAYERS) {
      const s = hashRoute(p, FIVE);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    assert.equal(counts.size, FIVE.length);
    for (const s of FIVE) {
      const share = (counts.get(s) ?? 0) / PLAYERS.length;
      assert.ok(share > 0.1 && share < 0.4, `${s} share=${share}`);
    }
  });

  it('removing a shard moves <30% of players', () => {
    const before = FIVE;
    const after = FIVE.slice(0, 4);
    const moved = churn(PLAYERS, before, after);
    assert.ok(moved < 0.3, `moved=${moved}`);
    assert.ok(moved > 0, 'removal must move someone');
  });

  it('adding a shard moves <30% of players', () => {
    const before = FIVE.slice(0, 4);
    const after = FIVE;
    const moved = churn(PLAYERS, before, after);
    assert.ok(moved < 0.3, `moved=${moved}`);
  });

  it('single shard routes everyone locally', () => {
    for (const p of [1, 99, 12345]) assert.equal(hashRoute(p, ['shard-0']), 'shard-0');
    assert.equal(hashRoute(1, []), 'shard-0');
  });
});

describe('shard registry', () => {
  it('parses SHARDS env into stable ids', () => {
    const entries = parseShardHosts('ws://a:8081,ws://b:8081');
    assert.deepEqual(entries, [
      { shardId: 'shard-0', host: 'ws://a:8081' },
      { shardId: 'shard-1', host: 'ws://b:8081' },
    ]);
  });

  it('defaults to a single local shard', () => {
    const entries = parseShardHosts('');
    assert.equal(entries.length, 1);
    assert.ok(entries[0].host.includes('ws://'));
  });
});

describe('ShardRouter', () => {
  it('single-shard default pins locally (stub behavior preserved)', () => {
    const r = new ShardRouter('shard-0');
    assert.equal(r.routePlayer(1), 'shard-0');
    assert.equal(r.routePlayer(999), 'shard-0');
  });

  it('routes over the live registry with rendezvous', () => {
    const r = new ShardRouter('shard-0');
    r.register({ shardId: 'shard-1', host: 'ws://b:8081', players: 0 });
    // Route matches the standalone function over the same list.
    for (const p of [1, 2, 3, 50, 777]) {
      assert.equal(r.routePlayer(p), routePlayer(p, ['shard-0', 'shard-1']));
    }
  });

  it('leastLoaded picks fewest players, then lowest tickMs', () => {
    const r = new ShardRouter('shard-0');
    r.register({ shardId: 'shard-1', host: 'ws://b:8081', players: 2, tickMs: 9 });
    r.register({ shardId: 'shard-2', host: 'ws://c:8081', players: 2, tickMs: 3 });
    r.setLocalPlayers(10);
    assert.equal(r.leastLoaded().shardId, 'shard-2');
  });

  it('unregister protects the local shard', () => {
    const r = new ShardRouter('shard-0');
    r.register({ shardId: 'shard-1', host: 'ws://b:8081', players: 0 });
    r.unregister('shard-1');
    r.unregister('shard-0');
    assert.equal(r.list().length, 1);
    assert.equal(r.routePlayer(5), 'shard-0');
  });
});

describe('ShardNode', () => {
  it('reports players + tickMs to /healthz payload', () => {
    const node = new ShardNode('shard-0');
    node.setLoad(17, 2.5);
    const h = node.health(200);
    assert.equal(h.ok, true);
    assert.equal(h.shard, 'shard-0');
    assert.equal(h.players, 17);
    assert.equal(h.tickMs, 2.5);
    assert.equal(h.tick, 200);
    assert.ok(h.uptime >= 0);
  });
});
