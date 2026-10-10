// catalog: validation, price sanity, sprite refs, lookups.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CATALOG_ITEM_IDS,
  CATALOG,
  CATALOG_EFFECTS,
  CATALOG_ITEMS,
  CATALOG_MISSILES,
  CATALOG_OUTFITS,
  CatalogError,
  buildCatalog,
  effectById,
  itemById,
  itemByName,
  missileById,
  outfitById,
  validateCatalog,
  type CatalogInput,
} from './catalog.js';

function inputWith(over: Partial<CatalogInput>): CatalogInput {
  return {
    items: CATALOG_ITEMS.map((i) => ({ ...i, flags: { ...i.flags }, stats: { ...i.stats }, sprite: { ...i.sprite }, price: { ...i.price } })),
    outfits: CATALOG_OUTFITS.map((o) => ({ ...o, sprite: { ...o.sprite } })),
    effects: CATALOG_EFFECTS.map((e) => ({ ...e, sprite: e.sprite ? { ...e.sprite } : undefined })),
    missiles: CATALOG_MISSILES.map((m) => ({ ...m, sprite: { ...m.sprite } })),
    ...over,
  };
}

describe('catalog validation', () => {
  it('the shipped catalog validates clean', () => {
    assert.deepEqual(validateCatalog({ items: CATALOG_ITEMS, outfits: CATALOG_OUTFITS, effects: CATALOG_EFFECTS, missiles: CATALOG_MISSILES }), []);
    assert.equal(CATALOG.items.length, 15);
    assert.equal(ALL_CATALOG_ITEM_IDS.length, 15);
  });

  it('duplicate item id is rejected', () => {
    const items = [...inputWith({}).items, { ...inputWith({}).items[0]! }];
    const errors = validateCatalog(inputWith({ items }));
    assert.ok(errors.some((e) => e.includes('duplicate id')), errors.join('\n'));
    assert.throws(() => buildCatalog(inputWith({ items })), CatalogError);
  });

  it('duplicate id across tables is rejected', () => {
    const missiles = [{ ...CATALOG_MISSILES[0]!, id: 'ember-shard' }];
    const errors = validateCatalog(inputWith({ missiles }));
    assert.ok(errors.some((e) => e.includes('duplicate id')), errors.join('\n'));
  });

  it('bad price is rejected (buy must exceed sell)', () => {
    const items = inputWith({}).items.map((i) => (i.id === 'iron-ore' ? { ...i, price: { buy: 6, sell: 6 } } : i));
    assert.ok(validateCatalog(inputWith({ items })).some((e) => e.includes('price sanity')));
    const inverted = inputWith({}).items.map((i) => (i.id === 'iron-ore' ? { ...i, price: { buy: 3, sell: 6 } } : i));
    assert.ok(validateCatalog(inputWith({ items: inverted })).some((e) => e.includes('price sanity')));
    assert.throws(() => buildCatalog(inputWith({ items })), CatalogError);
  });

  it('unsellable items must be quest tokens (buy 0 / sell 0 / not tradeable)', () => {
    const items = inputWith({}).items.map((i) => (i.id === 'iron-ore' ? { ...i, price: { buy: 0, sell: 0 } } : i));
    assert.ok(validateCatalog(inputWith({ items })).some((e) => e.includes('questItem')));
  });

  it('unknown sprite sheet is rejected', () => {
    const items = inputWith({}).items.map((i) =>
      i.id === 'iron-ore' ? { ...i, sprite: { sheet: 'nope.png', x: 0, y: 0, w: 16, h: 16 } } : i,
    );
    const errors = validateCatalog(inputWith({ items }));
    assert.ok(errors.some((e) => e.includes('unknown sprite sheet')), errors.join('\n'));
    assert.throws(() => buildCatalog(inputWith({ items })), CatalogError);
  });

  it('malformed sprite refs are rejected', () => {
    const items = inputWith({}).items.map((i) =>
      i.id === 'iron-ore' ? { ...i, sprite: { sheet: 'items.png', x: -1, y: 0, w: 0, h: 16 } } : i,
    );
    assert.ok(validateCatalog(inputWith({ items })).some((e) => e.includes('malformed sprite')));
  });

  it('unknown flag keys are rejected', () => {
    const items = inputWith({}).items.map((i) =>
      i.id === 'iron-ore' ? { ...i, flags: { ...i.flags, flyable: true } as unknown as typeof i.flags } : i,
    );
    assert.ok(validateCatalog(inputWith({ items })).some((e) => e.includes('unknown flag')));
  });

  it('missile trails must reference a known effect', () => {
    const missiles = [{ ...CATALOG_MISSILES[0]!, trail: 'no-such-effect' }];
    assert.ok(validateCatalog(inputWith({ missiles })).some((e) => e.includes('unknown trail')));
  });

  it('weapons need attack, consumables need heal', () => {
    const items = inputWith({}).items.map((i) => (i.id === 'ember-axe' ? { ...i, stats: {} } : i));
    assert.ok(validateCatalog(inputWith({ items })).some((e) => e.includes('stats.attack')));
    const items2 = inputWith({}).items.map((i) => (i.id === 'healing-herb' ? { ...i, stats: {} } : i));
    assert.ok(validateCatalog(inputWith({ items: items2 })).some((e) => e.includes('stats.heal')));
  });
});

describe('catalog lookups', () => {
  it('resolves items by id and by name (case-insensitive)', () => {
    assert.equal(itemById('ward-blade')?.name, 'Ward Blade');
    assert.equal(itemByName('ward blade')?.id, 'ward-blade');
    assert.equal(itemByName('  cAlDeRa GrEaTsWoRd ')?.id, 'caldera-greatsword');
    assert.equal(itemById('nope'), undefined);
    assert.equal(itemByName('nope'), undefined);
  });

  it('resolves outfits, effects and missiles by id', () => {
    assert.equal(outfitById('adventurer')?.frames, 4);
    assert.equal(effectById('heal-sparkle')?.sound, 'heal.ogg');
    assert.equal(missileById('wisp-bolt')?.trail, 'wisp-trail');
    assert.equal(outfitById('nope'), undefined);
    assert.equal(missileById('nope'), undefined);
  });

  it('quest token is unsellable and non-tradeable', () => {
    const tok = itemById('ward-token')!;
    assert.deepEqual(tok.price, { buy: 0, sell: 0 });
    assert.equal(tok.flags.questItem, true);
    assert.equal(tok.flags.tradeable, false);
  });

  it('every sellable item has buy > sell', () => {
    for (const i of CATALOG.items) {
      if (i.price.buy === 0) continue;
      assert.ok(i.price.buy > i.price.sell, `${i.id}: buy ${i.price.buy} vs sell ${i.price.sell}`);
    }
  });
});
