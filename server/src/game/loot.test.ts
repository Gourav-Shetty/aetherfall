// Loot: drop tables, pickup spawn, combat onKill wiring.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import { getZone } from '@aetherfall/engine';
import {
  LOOT_TABLE,
  applyKillRewards,
  dropsFor,
  pickupsForLoot,
  rollLootForKill,
} from './loot.js';
import { ALL_ITEM_IDS } from './content.js';
import { _resetPickupIds } from './inventory.js';
import { createQuestState } from './quests.js';
import { createGameState, ensurePlayer, onMobKilled, removePickup } from './index.js';

describe('loot drop tables', () => {
  it('every table entry references a known item id with sane odds', () => {
    for (const [mob, drops] of Object.entries(LOOT_TABLE)) {
      assert.ok(drops.length >= 1, `${mob} has no drops`);
      for (const d of drops) {
        assert.ok(ALL_ITEM_IDS.includes(d.itemId), `${mob}: unknown item ${d.itemId}`);
        assert.ok(d.chance > 0 && d.chance <= 1, `${mob}/${d.itemId}: bad chance`);
        assert.ok(d.min >= 1 && d.max >= d.min, `${mob}/${d.itemId}: bad count range`);
      }
    }
  });

  it('dropsFor falls back to the zone table for unknown mobs', () => {
    assert.deepEqual(dropsFor('gloomfang', 'meadow'), LOOT_TABLE['gloomfang']);
    assert.deepEqual(dropsFor('something-new', 'volcano'), LOOT_TABLE['zone:volcano']);
  });

  it('rollLootForKill deterministic for a seeded rand', () => {
    const a = rollLootForKill('gloomfang', 'meadow', 1, mulberry32(7));
    const b = rollLootForKill('gloomfang', 'meadow', 1, mulberry32(7));
    assert.deepEqual(a, b);
    for (const s of a) assert.ok(ALL_ITEM_IDS.includes(s.itemId));
  });
});

describe('loot pickups', () => {
  it('one pickup per drop stack, scattered near the corpse', () => {
    _resetPickupIds();
    const drops = [
      { itemId: 'ember-shard', count: 2 },
      { itemId: 'gloom-fang', count: 1 },
    ];
    const pks = pickupsForLoot(drops, 10, 20, mulberry32(3));
    assert.equal(pks.length, 2);
    assert.deepEqual(pks.map((p) => p.itemId), ['ember-shard', 'gloom-fang']);
    for (const p of pks) {
      assert.ok(Math.hypot(p.x - 10, p.y - 20) <= 2.5, `pickup too far: ${p.x},${p.y}`);
    }
  });
});

describe('loot combat onKill wiring', () => {
  it('applyKillRewards: quest hook + kill XP + drops + pickups', () => {
    _resetPickupIds();
    const s = createQuestState();
    const r = applyKillRewards(s, 'gloomfang', 'meadow', 1, 10, 20, mulberry32(11));
    assert.ok(r.xp > 0);
    assert.ok(r.questEvents.some((e) => e.type === 'progress'));
    assert.equal(r.pickups.length, r.drops.length);
    assert.deepEqual(
      r.pickups.map((p) => `${p.itemId}x${p.count}`).sort(),
      r.drops.map((d) => `${d.itemId}x${d.count}`).sort(),
    );
    // Kill XP landed in state (30 for meadow lvl1 + chain quest XP if completed).
    assert.ok(s.xp >= 30);
  });

  it('onMobKilled: mob dies, loot pickups stored, events emitted', () => {
    _resetPickupIds();
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    const fresh = game.spawner.ensureAround(16, 16, 0);
    assert.ok(fresh.length > 0);
    const mob = fresh[0]!;
    const zone = getZone(mob.pos.x, mob.pos.y, game.seed);
    assert.ok(zone);
    const evts = onMobKilled(game, 1, mob.id, 10_000, mulberry32(5));
    assert.equal(game.spawner.getMob(mob.id)?.alive, false);
    assert.ok(evts.some((e) => e.kind === 'mob-die'));
    assert.ok(evts.some((e) => e.kind === 'xp-gain'));
    const spawns = evts.filter((e) => e.kind === 'pickup-spawn');
    assert.equal(game.pickups.length, spawns.length);
    // Unknown mob / player: no-op, no events.
    assert.deepEqual(onMobKilled(game, 1, 999_999_999, 10_001), []);
    assert.deepEqual(onMobKilled(game, 999, mob.id, 10_001), []);
  });

  it('removePickup is idempotent', () => {
    _resetPickupIds();
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    const fresh = game.spawner.ensureAround(16, 16, 0);
    onMobKilled(game, 1, fresh[0]!.id, 20_000, mulberry32(9));
    if (game.pickups.length === 0) return; // roll produced no drops; nothing to remove
    const id = game.pickups[0]!.id;
    assert.equal(removePickup(game, id), true);
    assert.equal(removePickup(game, id), false);
  });
});
