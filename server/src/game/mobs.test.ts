import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOB_ID_MAX,
  MOB_ID_MIN,
  NPC_ID_MAX,
  NPC_ID_MIN,
  PICKUP_ID_MIN,
  PLAYER_ID_MAX,
  assertUniqueSnapshotIds,
  isNpcId,
  isPickupId,
  isPlayerId,
  isSpawnerMobId,
  spawnerSnapshot,
  unifiedMobSnapshot,
} from './mobs.js';
import { chunkIdBase, Spawner } from './spawner.js';
import { NPCManager, _resetNpcIds } from '../ai/npc.js';
import { _resetPickupIds, makePickup } from './inventory.js';
import { createGameState, ensurePlayer, tickGameplay } from './index.js';

describe('mob id namespaces', () => {
  it('ranges are disjoint and ordered: players < npcs < spawner mobs < pickups', () => {
    assert.ok(PLAYER_ID_MAX < NPC_ID_MIN);
    assert.ok(NPC_ID_MAX < MOB_ID_MIN);
    assert.ok(MOB_ID_MAX < PICKUP_ID_MIN);
  });

  it('classifiers agree on every boundary', () => {
    assert.equal(isPlayerId(1), true);
    assert.equal(isPlayerId(PLAYER_ID_MAX), true);
    assert.equal(isPlayerId(NPC_ID_MIN), false);
    assert.equal(isNpcId(NPC_ID_MIN + 1), true);
    assert.equal(isNpcId(NPC_ID_MAX), true);
    assert.equal(isNpcId(MOB_ID_MIN), false);
    assert.equal(isSpawnerMobId(MOB_ID_MIN), true);
    assert.equal(isSpawnerMobId(MOB_ID_MAX), true);
    assert.equal(isSpawnerMobId(PICKUP_ID_MIN), false);
    assert.equal(isPickupId(PICKUP_ID_MIN), true);
  });

  it('chunkIdBase stays inside the spawner namespace across a wide chunk grid', () => {
    for (let cx = -50; cx <= 50; cx++) {
      for (let cy = -50; cy <= 50; cy++) {
        const base = chunkIdBase(cx, cy);
        assert.ok(isSpawnerMobId(base), `chunk (${cx},${cy}) base ${base} out of range`);
      }
    }
  });

  it('pickup ids live in the pickup namespace (no collision with players)', () => {
    _resetPickupIds();
    const a = makePickup('ember-shard', 1, 0, 0);
    const b = makePickup('ember-shard', 1, 1, 1);
    assert.ok(isPickupId(a.id));
    assert.ok(isPickupId(b.id));
    assert.notEqual(a.id, b.id);
    assert.equal(isPlayerId(a.id), false);
  });
});

describe('spawner snapshot + unified merge', () => {
  it('spawnerSnapshot exposes live mobs as kind:mob with positions', () => {
    const sp = new Spawner(1337);
    sp.spawnChunk(0, 0);
    assert.ok(sp.mobCount() > 0);
    const snaps = spawnerSnapshot(sp);
    assert.equal(snaps.length, sp.mobCount());
    for (const s of snaps) {
      assert.equal(s.kind, 'mob');
      assert.ok(isSpawnerMobId(s.id));
      assert.ok(Number.isFinite(s.p.x) && Number.isFinite(s.p.y));
    }
  });

  it('dead spawner mobs are hidden until respawn', () => {
    const sp = new Spawner(1337);
    const fresh = sp.spawnChunk(0, 0);
    assert.ok(fresh.length > 0);
    const before = spawnerSnapshot(sp).length;
    sp.killMob(fresh[0]!.id, 1000);
    assert.equal(spawnerSnapshot(sp).length, before - 1);
  });

  it('spawnChunk is idempotent and collision-safe under hash-base pileups', () => {
    const sp = new Spawner(1337);
    const a = sp.spawnChunk(0, 0);
    assert.equal(sp.spawnChunk(0, 0).length, 0); // idempotent
    assert.ok(a.length > 0);
    // Find two distinct chunks whose deterministic bases collide (birthday search),
    // then prove the spawner probes forward instead of overwriting.
    let pair: [number, number, number, number] | null = null;
    const seenBases = new Map<number, [number, number]>();
    outer: for (let cx = 0; cx < 200; cx++) {
      for (let cy = 0; cy < 200; cy++) {
        const b = chunkIdBase(cx, cy);
        const prev = seenBases.get(b);
        if (prev && (prev[0] !== cx || prev[1] !== cy)) {
          pair = [prev[0], prev[1], cx, cy];
          break outer;
        }
        seenBases.set(b, [cx, cy]);
      }
    }
    if (!pair) throw new Error('expected a base collision in a 200x200 grid');
    {
      const sp2 = new Spawner(4242);
      const [ax, ay, bx, by] = pair;
      const first = sp2.spawnChunk(ax, ay);
      const second = sp2.spawnChunk(bx, by);
      assert.ok(first.length > 0 && second.length > 0);
      // No overwrite: total stored equals total spawned.
      assert.equal(sp2.mobCount(), first.length + second.length);
      assertUniqueSnapshotIds(spawnerSnapshot(sp2));
    }
  });

  it('unifiedMobSnapshot merges spawner + NPC ids with no collision', () => {
    _resetNpcIds();
    const sp = new Spawner(1337);
    sp.spawnChunk(0, 0);
    sp.spawnChunk(1, 0);
    const npcs = new NPCManager();
    const merged = unifiedMobSnapshot(sp, npcs);
    // 2 chunks x 4 mobs + 3 minions + 2 bosses
    assert.equal(merged.length, sp.mobCount() + npcs.snapshot().length);
    const n = assertUniqueSnapshotIds(merged);
    assert.equal(n, merged.length);
    assert.ok(merged.every((e) => e.kind === 'mob'));
    assert.ok(merged.some((e) => isSpawnerMobId(e.id)));
    assert.ok(merged.some((e) => isNpcId(e.id)));
  });

  it('full gameplay tick exposes spawner mobs around players (no silent mob loss)', () => {
    _resetNpcIds();
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    const npcs = new NPCManager();
    const events = tickGameplay(game, Date.now());
    assert.ok(events.some((e) => e.kind === 'mob-spawn'));
    const merged = unifiedMobSnapshot(game.spawner, npcs);
    assert.ok(merged.filter((e) => isSpawnerMobId(e.id)).length > 0);
    assertUniqueSnapshotIds(merged);
  });
});
