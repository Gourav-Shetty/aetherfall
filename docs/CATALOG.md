# AETHERFALL Catalog

The catalog (`shared/src/catalog.ts`) is the **one typed registry** that maps an
item id to everything the game needs to agree on: name, description, equip
slot, behaviour flags, stats, sprite ref, and vendor prices. Outfits, particle/
sound effects and missiles live here too. Think of it as our version of the
*appearances* idea (one id -> look + flags + behaviour), designed from scratch
for Aetherfall — no external schema is used.

## Schema

```ts
ItemDef {
  id: string;            // kebab-case, globally unique: 'ember-shard'
  name: string;          // display name, unique (case-insensitive)
  description: string;   // >= 8 chars, original writing
  slot: 'none' | 'mainhand' | 'consumable';
  flags: {
    walkable?, blocking?, pickupable?,
    stackable?, questItem?, tradeable?   // ONLY these keys (booleans)
  };
  stats: { attack?, defense?, heal?, levelReq?, weight? };  // finite numbers >= 0
  sprite: { sheet, x, y, w, h };         // sheet must be a known sheet
  price: { buy, sell };                  // integers; sellable: buy > sell
  zone?: 'meadow' | 'dungeon' | 'volcano';  // weapon provenance (optional)
}

OutfitDef  { id, name, description, sprite, frames (>=1), fps? (>0) }
EffectDef  { id, name, description, particles (name), sound (name.ogg),
             durationMs?, sprite? }
MissileDef { id, name, description, speed (>0), sprite, trail? (EffectDef id) }
```

Sprite sheets known to the pipeline (`KNOWN_SPRITE_SHEETS`):
`items.png`, `weapons.png`, `outfits.png`, `effects.png`, `missiles.png`.
Refs are `{ sheet, x, y, w, h }` pixels: `x/y >= 0`, `1..512` for `w/h`,
no whitespace in the sheet name.

Prices: `buy` is what the player pays and **equals the legacy base price**, so
economy math is untouched. `sell` is derived once via the standard 35% spread
(`floor(buy * 0.65)`). Quest tokens are `{ buy: 0, sell: 0 }` and must carry
`questItem: true` with `tradeable` not `true`.

Ids share one global namespace across items, outfits, effects and missiles —
a duplicate id anywhere is an error.

## How to add an item

1. Append to `CATALOG_ITEMS` in `shared/src/catalog.ts` (items live before
   weapons; keep the order stable — tests snapshot counts, not order, but
   diffs stay readable):
   ```ts
   {
     id: 'frost-petal', name: 'Frost Petal',
     description: 'A petal that never melts. Smells faintly of winter rain.',
     slot: 'none',
     flags: { pickupable: true, stackable: true, tradeable: true },
     stats: {},
     sprite: { sheet: 'items.png', x: 32, y: 16, w: 16, h: 16 },
     price: { buy: 11, sell: 7 },   // 7 = floor(11 * 0.65), buy > sell
   },
   ```
   Weapons use `slot: 'mainhand'`, `stackable: false`,
   `stats: { attack: N, levelReq: M }`, sheet `weapons.png`, and `zone`.
   Consumables use `slot: 'consumable'` + `stats: { heal: N }`.
2. Run the checks:
   - `npm run typecheck --workspace=@aetherfall/shared`
   - `npm run check --workspace=@aetherfall/catalog`
   - `npm run test --workspace=@aetherfall/shared --workspace=@aetherfall/server --workspace=@aetherfall/catalog`
3. Reference the id from loot (`server/src/game/loot.ts`), quests
   (`QUEST_CHAIN` in `content.ts`) or vendor code — the checker asserts every
   referenced id resolves. Nothing else is needed: `ITEMS`/`WEAPONS` in
   `content.ts` are derived views over the catalog, so vendor stock, loot
   validation and quest rewards pick the item up automatically.

## Integrity

`tools/catalog/check.ts` (`npm run check --workspace=@aetherfall/catalog`):

- `validateCatalog()` is clean (unique ids, `buy > sell`, well-formed sprite
  refs on known sheets, known-only flags, missile trails resolve).
- Every `itemId: '...'` in `server/src/game/loot.ts` exists in the catalog.
- Every `rewardItem: '...'` in `server/src/game/content.ts` exists.
- The vendor surface (the whole catalog) resolves entry by entry.

Exit `0` + `catalog ok: 15 items, ...` on success, non-zero with one line per
error on failure.
