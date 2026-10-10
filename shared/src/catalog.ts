// @aetherfall/shared — catalog: the ONE typed item/appearance registry.
//
// Inspiration: Tibia's appearances.dat maps an id to everything the client and
// server need to agree on (look, flags, behaviour). This is our own design for
// Aetherfall's needs — no Tibia schema or fields are copied. Every id used by
// loot tables, vendor stock and quest rewards must resolve here; see
// docs/CATALOG.md and tools/catalog/check.ts.
//
// Protocol-safe: plain data + pure helpers only. No I/O, no clocks, no RNG.

export const CATALOG_VERSION = 1;

// ---------------------------------------------------------------------------
// Sprite refs
// ---------------------------------------------------------------------------

/** Sprite sheets known to the asset pipeline. A ref to any other sheet is unknown. */
export const KNOWN_SPRITE_SHEETS = ['items.png', 'weapons.png', 'outfits.png', 'effects.png', 'missiles.png'] as const;
export type SpriteSheet = (typeof KNOWN_SPRITE_SHEETS)[number];

/** Pixel rectangle inside a sheet. x/y/w/h are in pixels. */
export interface SpriteRef {
  sheet: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function isWellFormedSprite(s: SpriteRef): boolean {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.sheet !== 'string' || s.sheet.length === 0 || s.sheet.length > 128) return false;
  if (/\s/.test(s.sheet)) return false;
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    if (!Number.isInteger(s[k]) || !Number.isFinite(s[k])) return false;
  }
  if (s.x < 0 || s.y < 0) return false;
  if (s.w < 1 || s.h < 1 || s.w > 512 || s.h > 512) return false;
  return true;
}

export function isKnownSheet(sheet: string): boolean {
  return (KNOWN_SPRITE_SHEETS as readonly string[]).includes(sheet);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Equip/use slot. Materials and quest tokens sit in the pack (`none`). */
export type CatalogSlot = 'none' | 'mainhand' | 'consumable';

/** Behaviour flags. Only these keys are legal — anything else is rejected. */
export interface CatalogFlags {
  walkable?: boolean;
  blocking?: boolean;
  pickupable?: boolean;
  stackable?: boolean;
  questItem?: boolean;
  tradeable?: boolean;
}

export const KNOWN_FLAG_KEYS = ['walkable', 'blocking', 'pickupable', 'stackable', 'questItem', 'tradeable'] as const;

/** Combat/use numbers. All optional; weapons need attack, potions need heal. */
export interface CatalogStats {
  attack?: number;
  defense?: number;
  heal?: number;
  levelReq?: number;
  weight?: number;
}

/**
 * Vendor prices in gold. `buy` is what the player pays (== the legacy base
 * price, so economy math is unchanged); `sell` is the vendor's payout,
 * derived once via the standard 35%-spread (floor(buy * 0.65)). Quest tokens
 * are { buy: 0, sell: 0 } and must be non-tradeable.
 */
export interface CatalogPrice {
  buy: number;
  sell: number;
}

export interface CatalogItemDef {
  id: string;
  name: string;
  description: string;
  slot: CatalogSlot;
  flags: CatalogFlags;
  stats: CatalogStats;
  sprite: SpriteRef;
  price: CatalogPrice;
  /** Home zone for drops/rewards (weapons only). Informational, not balance. */
  zone?: 'meadow' | 'dungeon' | 'volcano';
}

// ---------------------------------------------------------------------------
// Outfits / effects / missiles
// ---------------------------------------------------------------------------

export interface OutfitDef {
  id: string;
  name: string;
  description: string;
  sprite: SpriteRef;
  /** Animation frames in the sheet row (>= 1). */
  frames: number;
  /** Frames per second (optional, > 0). */
  fps?: number;
}

export interface EffectDef {
  id: string;
  name: string;
  description: string;
  /** Particle emitter ref, by name (e.g. 'sparkle'). */
  particles: string;
  /** Sound ref, by name (e.g. 'heal.ogg'). */
  sound: string;
  durationMs?: number;
  sprite?: SpriteRef;
}

export interface MissileDef {
  id: string;
  name: string;
  description: string;
  /** Tiles per second (> 0). */
  speed: number;
  sprite: SpriteRef;
  /** Impact trail, as an EffectDef id. */
  trail?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PARTICLE_RE = /^[a-z0-9][a-z0-9-]*$/;

function isId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

function checkSprite(out: string[], where: string, s: SpriteRef): void {
  if (!isWellFormedSprite(s)) {
    out.push(`${where}: malformed sprite ref ${JSON.stringify(s)}`);
    return;
  }
  if (!isKnownSheet(s.sheet)) out.push(`${where}: unknown sprite sheet "${s.sheet}"`);
}

function checkPrice(out: string[], where: string, price: CatalogPrice, flags: CatalogFlags): void {
  if (!price || typeof price !== 'object') {
    out.push(`${where}: price missing`);
    return;
  }
  if (!Number.isInteger(price.buy) || price.buy < 0) out.push(`${where}: bad buy price ${String(price.buy)}`);
  if (!Number.isInteger(price.sell) || price.sell < 0) out.push(`${where}: bad sell price ${String(price.sell)}`);
  if (!Number.isInteger(price.buy) || !Number.isInteger(price.sell)) return;
  if (price.buy === 0) {
    if (price.sell !== 0) out.push(`${where}: buy 0 must pair with sell 0`);
    if (flags.tradeable === true) out.push(`${where}: unsellable item must not be tradeable`);
    if (flags.questItem !== true) out.push(`${where}: unsellable item must be a questItem`);
  } else if (!(price.buy > price.sell)) {
    out.push(`${where}: price sanity failed (buy ${price.buy} must exceed sell ${price.sell})`);
  }
}

function checkFlags(out: string[], where: string, flags: CatalogFlags): void {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    out.push(`${where}: flags missing`);
    return;
  }
  for (const k of Object.keys(flags)) {
    if (!(KNOWN_FLAG_KEYS as readonly string[]).includes(k)) out.push(`${where}: unknown flag "${k}"`);
    else if (typeof (flags as Record<string, unknown>)[k] !== 'boolean') out.push(`${where}: flag "${k}" must be boolean`);
  }
}

function checkStats(out: string[], where: string, stats: CatalogStats, slot: CatalogSlot): void {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    out.push(`${where}: stats missing`);
    return;
  }
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) out.push(`${where}: stat "${k}" must be a finite number >= 0`);
  }
  if (slot === 'mainhand' && !(stats.attack !== undefined && stats.attack >= 1)) {
    out.push(`${where}: weapon needs stats.attack >= 1`);
  }
  if (slot === 'consumable' && !(stats.heal !== undefined && stats.heal >= 1)) {
    out.push(`${where}: consumable needs stats.heal >= 1`);
  }
}

export interface CatalogInput {
  items: CatalogItemDef[];
  outfits: OutfitDef[];
  effects: EffectDef[];
  missiles: MissileDef[];
}

/**
 * Validate a catalog input. Returns a list of human-readable errors (empty =
 * valid). Pure; never throws.
 */
export function validateCatalog(input: CatalogInput): string[] {
  const out: string[] = [];
  if (!input || typeof input !== 'object') return ['catalog: input missing'];
  const { items, outfits, effects, missiles } = input;
  if (!Array.isArray(items) || items.length === 0) out.push('catalog: items[] must be non-empty');
  for (const key of ['outfits', 'effects', 'missiles'] as const) {
    if (!Array.isArray(input[key])) out.push(`catalog: ${key}[] missing`);
  }

  const seenIds = new Map<string, string>(); // id -> where first seen
  const claimId = (where: string, id: unknown): void => {
    if (!isId(id)) {
      out.push(`${where}: bad id ${JSON.stringify(id)} (want kebab-case)`);
      return;
    }
    const prev = seenIds.get(id);
    if (prev) out.push(`${where}: duplicate id "${id}" (first in ${prev})`);
    else seenIds.set(id, where);
  };

  const seenNames = new Set<string>();
  for (const it of items ?? []) {
    const where = `item ${JSON.stringify((it as CatalogItemDef)?.id)}`;
    claimId(where, (it as CatalogItemDef)?.id);
    if (typeof it.name !== 'string' || it.name.trim().length === 0) out.push(`${where}: name missing`);
    else {
      const n = it.name.trim().toLowerCase();
      if (seenNames.has(n)) out.push(`${where}: duplicate name "${it.name}"`);
      else seenNames.add(n);
    }
    if (typeof it.description !== 'string' || it.description.trim().length < 8) {
      out.push(`${where}: description must be >= 8 chars`);
    }
    if (it.slot !== 'none' && it.slot !== 'mainhand' && it.slot !== 'consumable') {
      out.push(`${where}: bad slot ${JSON.stringify((it as CatalogItemDef)?.slot)}`);
    }
    checkFlags(out, where, it.flags);
    checkStats(out, where, it.stats, it.slot);
    checkSprite(out, where, it.sprite);
    checkPrice(out, where, it.price, it.flags ?? {});
    if (it.zone !== undefined && it.zone !== 'meadow' && it.zone !== 'dungeon' && it.zone !== 'volcano') {
      out.push(`${where}: bad zone ${JSON.stringify(it.zone)}`);
    }
    if (it.slot === 'mainhand' && it.flags?.stackable === true) {
      out.push(`${where}: weapons must not be stackable`);
    }
  }

  for (const o of outfits ?? []) {
    const where = `outfit ${JSON.stringify((o as OutfitDef)?.id)}`;
    claimId(where, (o as OutfitDef)?.id);
    if (typeof o.name !== 'string' || o.name.trim().length === 0) out.push(`${where}: name missing`);
    if (typeof o.description !== 'string' || o.description.trim().length === 0) out.push(`${where}: description missing`);
    checkSprite(out, where, o.sprite);
    if (!Number.isInteger(o.frames) || o.frames < 1) out.push(`${where}: frames must be an integer >= 1`);
    if (o.fps !== undefined && (!(typeof o.fps === 'number') || !Number.isFinite(o.fps) || o.fps <= 0)) {
      out.push(`${where}: fps must be > 0`);
    }
  }

  const effectIds = new Set<string>();
  for (const e of effects ?? []) {
    const where = `effect ${JSON.stringify((e as EffectDef)?.id)}`;
    claimId(where, (e as EffectDef)?.id);
    if (isId((e as EffectDef)?.id)) effectIds.add((e as EffectDef).id);
    if (typeof e.name !== 'string' || e.name.trim().length === 0) out.push(`${where}: name missing`);
    if (typeof e.description !== 'string' || e.description.trim().length === 0) out.push(`${where}: description missing`);
    if (typeof e.particles !== 'string' || !PARTICLE_RE.test(e.particles)) {
      out.push(`${where}: bad particles ref ${JSON.stringify((e as EffectDef)?.particles)}`);
    }
    if (typeof e.sound !== 'string' || e.sound.length === 0 || !e.sound.endsWith('.ogg') || /\s/.test(e.sound)) {
      out.push(`${where}: bad sound ref ${JSON.stringify((e as EffectDef)?.sound)} (want name.ogg)`);
    }
    if (e.durationMs !== undefined && (!Number.isInteger(e.durationMs) || e.durationMs < 1)) {
      out.push(`${where}: durationMs must be an integer >= 1`);
    }
    if (e.sprite !== undefined) checkSprite(out, where, e.sprite);
  }

  for (const m of missiles ?? []) {
    const where = `missile ${JSON.stringify((m as MissileDef)?.id)}`;
    claimId(where, (m as MissileDef)?.id);
    if (typeof m.name !== 'string' || m.name.trim().length === 0) out.push(`${where}: name missing`);
    if (typeof m.description !== 'string' || m.description.trim().length === 0) out.push(`${where}: description missing`);
    if (typeof m.speed !== 'number' || !Number.isFinite(m.speed) || m.speed <= 0) {
      out.push(`${where}: speed must be > 0`);
    }
    checkSprite(out, where, m.sprite);
    if (m.trail !== undefined && !effectIds.has(m.trail)) {
      out.push(`${where}: unknown trail effect "${m.trail}"`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builder + lookups
// ---------------------------------------------------------------------------

export class CatalogError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid catalog: ${errors[0] ?? 'unknown error'} (+${Math.max(0, errors.length - 1)} more)`);
    this.name = 'CatalogError';
    this.errors = [...errors];
  }
}

export interface BuiltCatalog extends CatalogInput {
  readonly version: number;
  itemById(id: string): CatalogItemDef | undefined;
  itemByName(name: string): CatalogItemDef | undefined;
  outfitById(id: string): OutfitDef | undefined;
  effectById(id: string): EffectDef | undefined;
  missileById(id: string): MissileDef | undefined;
  hasId(id: string): boolean;
}

/** Validate + freeze a catalog. Throws CatalogError on any problem. */
export function buildCatalog(input: CatalogInput): BuiltCatalog {
  const errors = validateCatalog(input);
  if (errors.length > 0) throw new CatalogError(errors);
  const items = input.items.map((i) => Object.freeze({ ...i, flags: { ...i.flags }, stats: { ...i.stats }, sprite: { ...i.sprite }, price: { ...i.price } }));
  const outfits = input.outfits.map((o) => Object.freeze({ ...o, sprite: { ...o.sprite } }));
  const effects = input.effects.map((e) => Object.freeze({ ...e, sprite: e.sprite ? { ...e.sprite } : undefined }));
  const missiles = input.missiles.map((m) => Object.freeze({ ...m, sprite: { ...m.sprite } }));
  const byId = new Map<string, CatalogItemDef>(items.map((i) => [i.id, i]));
  const byName = new Map<string, CatalogItemDef>(items.map((i) => [i.name.trim().toLowerCase(), i]));
  const outfitsById = new Map(outfits.map((o) => [o.id, o]));
  const effectsById = new Map(effects.map((e) => [e.id, e]));
  const missilesById = new Map(missiles.map((m) => [m.id, m]));
  const allIds = new Set<string>([...byId.keys(), ...outfitsById.keys(), ...effectsById.keys(), ...missilesById.keys()]);
  return Object.freeze({
    version: CATALOG_VERSION,
    items,
    outfits,
    effects,
    missiles,
    itemById: (id: string) => byId.get(id),
    itemByName: (name: string) => byName.get(name.trim().toLowerCase()),
    outfitById: (id: string) => outfitsById.get(id),
    effectById: (id: string) => effectsById.get(id),
    missileById: (id: string) => missilesById.get(id),
    hasId: (id: string) => allIds.has(id),
  });
}

// ---------------------------------------------------------------------------
// The game catalog (single source of truth for items, outfits, effects)
// ---------------------------------------------------------------------------
// Numbers (prices, attack, heal, levelReq) match the legacy content.ts tables
// exactly — no rebalance. Descriptions are original writing for this catalog.

const MAT = (flags: CatalogFlags = {}): CatalogFlags => ({
  pickupable: true,
  stackable: true,
  tradeable: true,
  ...flags,
});

function cell(sheet: SpriteSheet, col: number, row: number, size = 16): SpriteRef {
  return { sheet, x: col * size, y: row * size, w: size, h: size };
}

export const CATALOG_ITEMS: CatalogItemDef[] = [
  {
    id: 'ember-shard', name: 'Ember Shard',
    description: 'A warm sliver of ward-stone glass. It hums faintly near old roads and spends well at any market stall.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 0, 0), price: { buy: 5, sell: 3 },
  },
  {
    id: 'gloom-fang', name: 'Gloom Fang',
    description: 'A curved trophy tooth from a meadow gloomfang. Hunters string them as proof of a clean cull.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 1, 0), price: { buy: 4, sell: 2 },
  },
  {
    id: 'moss-cap', name: 'Moss Cap',
    description: 'A velvet fungus gathered above the highlands. Alchemists prize the deep-green caps for poultices.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 2, 0), price: { buy: 6, sell: 3 },
  },
  {
    id: 'healing-herb', name: 'Healing Herb',
    description: 'Chewy meadow greens with a peppery bite. Crush and eat to knit wounds shut. Restores 25 HP.',
    slot: 'consumable', flags: MAT(), stats: { heal: 25 }, sprite: cell('items.png', 3, 0), price: { buy: 8, sell: 5 },
  },
  {
    id: 'minor-potion', name: 'Minor Potion',
    description: 'Elder Maren\u2019s own brew, corked in blue wax. A single draught steadies the heart. Restores 50 HP.',
    slot: 'consumable', flags: MAT(), stats: { heal: 50 }, sprite: cell('items.png', 4, 0), price: { buy: 15, sell: 9 },
  },
  {
    id: 'mana-mote', name: 'Mana Mote',
    description: 'Wisp residue caught in a glass bead. It trembles and hums when spells are near.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 5, 0), price: { buy: 7, sell: 4 },
  },
  {
    id: 'iron-ore', name: 'Iron Ore',
    description: 'Honest highland ore, heavy in the hand. The smith pays steady coin for clean lumps.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 6, 0), price: { buy: 6, sell: 3 },
  },
  {
    id: 'ash-coal', name: 'Ash Coal',
    description: 'Caldera fuel that burns blue-white. A pocketful keeps a forge roaring past midnight.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 7, 0), price: { buy: 9, sell: 5 },
  },
  {
    id: 'obsidian-chip', name: 'Obsidian Chip',
    description: 'Volcano glass with a razor edge. Knappers say each chip still remembers the eruption.',
    slot: 'none', flags: MAT(), stats: {}, sprite: cell('items.png', 0, 1), price: { buy: 12, sell: 7 },
  },
  {
    id: 'ward-token', name: 'Ward Token',
    description: 'Elder Maren\u2019s mark, cut from pale ward-stone. No merchant will buy it; every merchant honors it.',
    slot: 'none', flags: MAT({ stackable: true, questItem: true, tradeable: false }), stats: {},
    sprite: cell('items.png', 1, 1), price: { buy: 0, sell: 0 },
  },
  {
    id: 'wisp-touched-dagger', name: 'Wisp-Touched Dagger',
    description: 'A quick starter sidearm with a faint wisp-glow along the fuller. Light, honest, +4 attack.',
    slot: 'mainhand', flags: MAT({ stackable: false }), stats: { attack: 4, levelReq: 1 },
    sprite: cell('weapons.png', 0, 0), price: { buy: 20, sell: 13 }, zone: 'meadow',
  },
  {
    id: 'ward-blade', name: 'Ward Blade',
    description: 'A blade from Maren\u2019s own armory, given for lighting the ward-stones. Steady and true, +6 attack.',
    slot: 'mainhand', flags: MAT({ stackable: false }), stats: { attack: 6, levelReq: 1 },
    sprite: cell('weapons.png', 1, 0), price: { buy: 40, sell: 26 }, zone: 'meadow',
  },
  {
    id: 'ember-axe', name: 'Ember Axe',
    description: 'Highland steel with a coal-red edge that never quite cools. Bites deep, +8 attack.',
    slot: 'mainhand', flags: MAT({ stackable: false }), stats: { attack: 8, levelReq: 3 },
    sprite: cell('weapons.png', 2, 0), price: { buy: 80, sell: 52 }, zone: 'dungeon',
  },
  {
    id: 'deep-halberd', name: 'Deep Halberd',
    description: 'A hollow-knight polearm cut down and reforged for living hands. Long reach, +10 attack.',
    slot: 'mainhand', flags: MAT({ stackable: false }), stats: { attack: 10, levelReq: 4 },
    sprite: cell('weapons.png', 3, 0), price: { buy: 120, sell: 78 }, zone: 'dungeon',
  },
  {
    id: 'caldera-greatsword', name: 'Caldera Greatsword',
    description: 'An obsidian-edged slab quenched in the volcano heart. Few can lift it; none forget it. +12 attack.',
    slot: 'mainhand', flags: MAT({ stackable: false }), stats: { attack: 12, levelReq: 5 },
    sprite: cell('weapons.png', 4, 0), price: { buy: 200, sell: 130 }, zone: 'volcano',
  },
];

export const CATALOG_OUTFITS: OutfitDef[] = [
  {
    id: 'adventurer', name: 'Adventurer',
    description: 'The default road-worn traveler\u2019s garb: cloak, satchel, and scuffed boots.',
    sprite: cell('outfits.png', 0, 0, 32), frames: 4, fps: 8,
  },
  {
    id: 'elder-maren', name: 'Elder Maren',
    description: 'Maren\u2019s layered ward-keeper robes, stitched with ember-shard thread.',
    sprite: cell('outfits.png', 4, 0, 32), frames: 2, fps: 4,
  },
  {
    id: 'gloomfang-hide', name: 'Gloomfang Hide',
    description: 'The low-slung, shadow-furred shape of a meadow gloomfang.',
    sprite: cell('outfits.png', 0, 1, 32), frames: 4, fps: 10,
  },
  {
    id: 'magma-golem-plate', name: 'Magma Golem Plate',
    description: 'Cracked basalt plates veined with living magma. Do not hug.',
    sprite: cell('outfits.png', 4, 1, 32), frames: 2, fps: 4,
  },
];

export const CATALOG_EFFECTS: EffectDef[] = [
  {
    id: 'heal-sparkle', name: 'Heal Sparkle',
    description: 'Soft green motes that rise from a fresh poultice or potion.',
    particles: 'sparkle', sound: 'heal.ogg', durationMs: 800, sprite: cell('effects.png', 0, 0),
  },
  {
    id: 'ember-burst', name: 'Ember Burst',
    description: 'A hot scatter of caldera sparks for impacts and forge-work.',
    particles: 'embers', sound: 'fire-burst.ogg', durationMs: 600, sprite: cell('effects.png', 1, 0),
  },
  {
    id: 'level-up', name: 'Level Up',
    description: 'Rising gold rings that mark a hard-earned level.',
    particles: 'rings', sound: 'level-up.ogg', durationMs: 1200, sprite: cell('effects.png', 2, 0),
  },
  {
    id: 'wisp-trail', name: 'Wisp Trail',
    description: 'The pale mote-drift left behind a wisp-touched missile.',
    particles: 'motes', sound: 'wisp-loop.ogg', durationMs: 400, sprite: cell('effects.png', 3, 0),
  },
];

export const CATALOG_MISSILES: MissileDef[] = [
  {
    id: 'wisp-bolt', name: 'Wisp Bolt',
    description: 'A hurled knot of wisp-light. Fast and faintly humming.',
    speed: 14, sprite: cell('missiles.png', 0, 0), trail: 'wisp-trail',
  },
  {
    id: 'ember-spit', name: 'Ember Spit',
    description: 'A glob of caldera heat, slower than a wisp-bolt and twice as rude.',
    speed: 10, sprite: cell('missiles.png', 1, 0), trail: 'ember-burst',
  },
];

export const CATALOG_SOURCES: CatalogInput = {
  items: CATALOG_ITEMS,
  outfits: CATALOG_OUTFITS,
  effects: CATALOG_EFFECTS,
  missiles: CATALOG_MISSILES,
};

/** The built, validated singleton. */
export const CATALOG: BuiltCatalog = buildCatalog(CATALOG_SOURCES);

/** All catalog item ids (vendor stock + loot + quest surface). */
export const ALL_CATALOG_ITEM_IDS: string[] = CATALOG.items.map((i) => i.id);

/** Item lookup by exact id. */
export function itemById(id: string): CatalogItemDef | undefined {
  return CATALOG.itemById(id);
}

/** Item lookup by display name (case-insensitive). */
export function itemByName(name: string): CatalogItemDef | undefined {
  return CATALOG.itemByName(name);
}

export function outfitById(id: string): OutfitDef | undefined {
  return CATALOG.outfitById(id);
}

export function effectById(id: string): EffectDef | undefined {
  return CATALOG.effectById(id);
}

export function missileById(id: string): MissileDef | undefined {
  return CATALOG.missileById(id);
}
