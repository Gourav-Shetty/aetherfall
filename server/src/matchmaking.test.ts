import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaker, applyTransfer, redirectTo, transferIn, transferOut } from './matchmaking.js';
import { ShardRouter } from './shard.js';
import { InMemoryChatBus, isRemote } from './router/pubsub.js';
import { addItem, createInventory } from './game/inventory.js';
import { addXp, createQuestState, onCollect, onKill } from './game/quests.js';
import { createGameState, ensurePlayer } from './game/index.js';

function threeShardRouter(): ShardRouter {
  const r = new ShardRouter('shard-0');
  r.setLocalPlayers(10);
  r.updateLoad('shard-0', 10, 4);
  r.register({ shardId: 'shard-1', host: 'ws://b:8081', players: 2, tickMs: 3 });
  r.register({ shardId: 'shard-2', host: 'ws://c:8081', players: 5, tickMs: 2 });
  return r;
}

describe('matchmaking', () => {
  it('queue join is FIFO and idempotent', () => {
    const mm = new Matchmaker(new ShardRouter('shard-0'));
    assert.equal(mm.join(1, 'a'), 1);
    assert.equal(mm.join(2, 'b'), 2);
    assert.equal(mm.join(1, 'a'), 1); // rejoin -> same position
    assert.equal(mm.size, 2);
    assert.equal(mm.leave(1), true);
    assert.equal(mm.leave(1), false);
    assert.equal(mm.size, 1);
  });

  it('assigns the least-loaded shard', () => {
    const mm = new Matchmaker(threeShardRouter());
    assert.equal(mm.assign().shardId, 'shard-1');
  });

  it('redirect event shape is protocol-v1 safe', () => {
    const evt = redirectTo({ shardId: 'shard-1', host: 'ws://b:8081' });
    assert.deepEqual(evt, {
      t: 'event',
      kind: 'redirect',
      payload: { url: 'ws://b:8081', shard: 'shard-1' },
    });
  });

  it('assignNext pops the head and redirects to least-loaded', () => {
    const mm = new Matchmaker(threeShardRouter());
    mm.join(11, 'a');
    mm.join(12, 'b');
    const first = mm.assignNext();
    assert.ok(first);
    assert.equal(first.request.playerId, 11);
    assert.equal(first.shard.shardId, 'shard-1');
    assert.deepEqual(first.event, {
      t: 'event',
      kind: 'redirect',
      payload: { url: 'ws://b:8081', shard: 'shard-1' },
    });
    assert.equal(mm.size, 1);
  });

  it('assignNext on empty queue returns null', () => {
    const mm = new Matchmaker(new ShardRouter('shard-0'));
    assert.equal(mm.assignNext(), null);
  });
});

describe('player transfer', () => {
  it('round-trips pos/hp/inv/quests', () => {
    const inv = createInventory();
    assert.equal(addItem(inv, 'iron-sword', 1), true);
    assert.equal(addItem(inv, 'ember-shard', 37), true);
    const quests = createQuestState();
    onKill(quests, 3);
    onCollect(quests, 7);
    addXp(quests, 50);

    const json = transferOut({
      id: 42,
      name: 'hero',
      x: 61.5,
      y: 12.25,
      hp: 73,
      maxHp: 100,
      inv,
      quests,
    });
    const snap = transferIn(json);
    assert.equal(snap.v, 1);
    assert.equal(snap.id, 42);
    assert.equal(snap.name, 'hero');
    assert.deepEqual([snap.x, snap.y, snap.hp, snap.maxHp], [61.5, 12.25, 73, 100]);
    assert.deepEqual(snap.inv, inv);
    assert.deepEqual(snap.quests, quests);
  });

  it('applyTransfer restores gameplay state on the destination shard', () => {
    const inv = createInventory();
    addItem(inv, 'ember-shard', 5);
    const quests = createQuestState();
    onKill(quests, 2);
    const snap = transferIn(transferOut({ id: 9, name: 'm', x: 3, y: 4, hp: 90, maxHp: 100, inv, quests }));

    const game = createGameState(1337);
    applyTransfer(game, snap);
    const p = game.players.get(9);
    assert.ok(p);
    assert.deepEqual([p.x, p.y], [3, 4]);
    assert.deepEqual(p.inv, inv);
    assert.deepEqual(p.quests, quests);
    void ensurePlayer;
  });

  it('rejects malformed payloads', () => {
    assert.throws(() => transferIn('not json'), /invalid JSON/);
    assert.throws(() => transferIn('{"v":999}'), /unsupported version/);
    const good = JSON.parse(
      transferOut({
        id: 1, name: 'n', x: 0, y: 0, hp: 100, maxHp: 100,
        inv: createInventory(), quests: createQuestState(),
      }),
    ) as Record<string, unknown>;
    assert.throws(() => transferIn(JSON.stringify({ ...good, x: 'far' })), /bad x/);
    assert.throws(() => transferIn(JSON.stringify({ ...good, inv: { slots: [{ itemId: 'x', count: 500 }] } })), /bad inventory/);
    assert.throws(() => transferIn(JSON.stringify({ ...good, quests: { level: 1 } })), /bad quests/);
  });
});

describe('global chat bus', () => {
  it('delivers published messages in-process', () => {
    const bus = new InMemoryChatBus();
    const received: string[] = [];
    const unsub = bus.subscribe((m) => {
      received.push(`${m.from}:${m.text}`);
    });
    bus.publish({ from: 'a', text: 'hi', channel: 'global', origin: 'shard-1' });
    assert.deepEqual(received, ['a:hi']);
    unsub();
    bus.publish({ from: 'a', text: 'again', channel: 'global', origin: 'shard-1' });
    assert.deepEqual(received, ['a:hi']);
    bus.close();
  });

  it('origin marks echo suppression (isRemote)', () => {
    assert.equal(isRemote({ from: 'a', text: 'x', channel: 'global', origin: 'shard-0' }, 'shard-0'), false);
    assert.equal(isRemote({ from: 'a', text: 'x', channel: 'global', origin: 'shard-1' }, 'shard-0'), true);
  });

  it('drops invalid payloads without throwing subscribers', () => {
    const bus = new InMemoryChatBus();
    let calls = 0;
    bus.subscribe(() => {
      calls++;
    });
    bus.publish({ from: 'a', text: '   ', channel: 'global', origin: 'shard-1' });
    bus.publish({ from: 'a', text: 'ok', channel: 'global', origin: 'shard-1' });
    assert.equal(calls, 1);
    bus.close();
  });
});
