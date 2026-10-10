// Catalog migration parity: legacy content.ts/loot.ts tables resolve onto the
// shared catalog with IDENTICAL numbers (no rebalance), and every loot/quest
// reference points at a real catalog entry.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CATALOG_ITEM_IDS, CATALOG, itemById, validateCatalog, CATALOG_SOURCES } from '@aetherfall/shared';
import {
  ALL_ITEM_IDS,
  ITEMS,
  QUEST_CHAIN,
  WEAPONS,
  itemDef,
  weaponDef,
} from './content.js';
import { MASK_IDS } from './masks.js';
import { LOOT_TABLE, lootItemExists } from './loot.js';

const OLD_ITEMS: Array<{ id: string; kind: string; price: number; heal?: number }> = [
  { id: 'ember-shard', kind: 'material', price: 5 },
  { id: 'gloom-fang', kind: 'material', price: 4 },
  { id: 'moss-cap', kind: 'material', price: 6 },
  { id: 'healing-herb', kind: 'consumable', price: 8, heal: 25 },
  { id: 'minor-potion', kind: 'consumable', price: 15, heal: 50 },
  { id: 'mana-mote', kind: 'material', price: 7 },
  { id: 'iron-ore', kind: 'material', price: 6 },
  { id: 'ash-coal', kind: 'material', price: 9 },
  { id: 'obsidian-chip', kind: 'material', price: 12 },
  { id: 'ward-token', kind: 'quest', price: 0 },
];

const OLD_WEAPONS: Array<{ id: string; price: number; damage: number; levelReq: number; zone: string }> = [
  { id: 'wisp-touched-dagger', price: 20, damage: 4, levelReq: 1, zone: 'meadow' },
  { id: 'ward-blade', price: 40, damage: 6, levelReq: 1, zone: 'meadow' },
  { id: 'ember-axe', price: 80, damage: 8, levelReq: 3, zone: 'dungeon' },
  { id: 'deep-halberd', price: 120, damage: 10, levelReq: 4, zone: 'dungeon' },
  { id: 'caldera-greatsword', price: 200, damage: 12, levelReq: 5, zone: 'volcano' },
];

describe('catalog migration parity', () => {
  it('migrated ITEMS keep every old id with identical kind/price/heal', () => {
    assert.equal(ITEMS.length, 10);
    assert.equal(WEAPONS.length, 5);
    for (const old of OLD_ITEMS) {
      const def = itemDef(old.id);
      assert.ok(def, `missing migrated item ${old.id}`);
      assert.equal(def.kind, old.kind, `${old.id} kind`);
      assert.equal(def.price, old.price, `${old.id} price`);
      assert.equal(def.heal, old.heal, `${old.id} heal`);
      assert.ok(def.name.length > 0 && def.description.length >= 8, `${old.id} needs name + description`);
      // Same numbers live in the catalog itself.
      const cat = itemById(old.id)!;
      assert.ok(cat, `${old.id} must resolve in the catalog`);
      assert.equal(cat.price.buy, old.price, `${old.id} catalog buy`);
      assert.equal(cat.name, def.name, `${old.id} name drift`);
      assert.equal(cat.description, def.description, `${old.id} description drift`);
    }
  });

  it('migrated WEAPONS keep identical damage/levelReq/zone/price', () => {
    for (const old of OLD_WEAPONS) {
      const w = weaponDef(old.id);
      assert.ok(w, `missing migrated weapon ${old.id}`);
      assert.equal(w.damage, old.damage, `${old.id} damage`);
      assert.equal(w.levelReq, old.levelReq, `${old.id} levelReq`);
      assert.equal(w.zone, old.zone, `${old.id} zone`);
      assert.equal(w.price, old.price, `${old.id} price`);
      const cat = itemById(old.id)!;
      assert.equal(cat.stats.attack, old.damage, `${old.id} catalog attack`);
      assert.equal(cat.stats.levelReq, old.levelReq, `${old.id} catalog levelReq`);
    }
  });

  it('legacy id surface matches the catalog id surface (+ masks)', () => {
    // ALL_ITEM_IDS = the 15 catalog ids + the 8 wearable masks, which live in
    // game/masks.ts by design (see masks.ts header) and resolve via itemDef().
    assert.deepEqual([...ALL_ITEM_IDS].sort(), [...ALL_CATALOG_ITEM_IDS, ...MASK_IDS].sort());
    for (const id of MASK_IDS) assert.ok(itemDef(id), `mask ${id} must resolve via itemDef`);
    assert.equal(CATALOG.items.length, 15);
    assert.deepEqual(validateCatalog(CATALOG_SOURCES), []);
  });

  it('every loot table item exists in the catalog', () => {
    let refs = 0;
    for (const [mob, drops] of Object.entries(LOOT_TABLE)) {
      for (const d of drops) {
        refs++;
        assert.ok(lootItemExists(d.itemId), `${mob}: unknown catalog item ${d.itemId}`);
        assert.ok(itemById(d.itemId), `${mob}: unknown catalog item ${d.itemId}`);
      }
    }
    assert.ok(refs >= 20, `expected >= 20 loot refs, got ${refs}`);
  });

  it('every quest reward item exists in the catalog', () => {
    for (const q of QUEST_CHAIN) {
      if (q.rewardItem === undefined) continue;
      assert.ok(itemById(q.rewardItem), `${q.id}: unknown reward item ${q.rewardItem}`);
    }
  });
});
