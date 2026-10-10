// Masks: 8 original relics, one perk each, one equip slot. Drop odds
// (bosses 25%, elites 5%), vendor purchase, and every perk flipping on
// equip/unequip through the session's aggregation + event lanes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import {
  ALL_ITEM_IDS,
  ITEMS,
  WEAPONS,
  isMaskItem,
  itemDef,
  weaponDef,
} from './content.js';
import { createGameSession, type GameSession, type IntegratedOut } from './integrated.js';
import { countOf } from './inventory.js';
import {
  ELITE_MIN_LEVEL,
  FINISH_REACH_BASE,
  MASK_DROP_BOSS,
  MASK_DROP_ELITE,
  MASK_EXTRA_ROLLS,
  MASK_FINISH_BONUS,
  MASK_HAZARD_MULT,
  MASK_MELEE_MULT,
  MASK_TALENT_POINTS,
  MASKS,
  THROW_RANGE_BASE,
  WALL_PING_INTERVAL_MS,
  extraLootRolls,
  finishReach,
  hazardDamageTaken,
  isEliteLevel,
  isMaskId,
  maskDef,
  maskMeleeMult,
  maskMuffles,
  maskPrice,
  rollMaskDrop,
  talentBoon,
  throwRange,
  wallPingDue,
  wallPingIntervalMs,
} from './masks.js';
import { rollLootForKill } from './loot.js';

function ofKind(out: IntegratedOut[], kind: string): Array<Record<string, unknown>> {
  const acc: Array<Record<string, unknown>> = [];
  for (const o of out) if (o.type === 'event' && o.kind === kind) acc.push(o.payload);
  return acc;
}

function text(out: IntegratedOut[]): string[] {
  return ofKind(out, 'sys-msg').map((p) => String(p.text));
}

function newSession(): GameSession {
  return createGameSession({ enabled: true, startGold: 5000 });
}

/** Player stocked with every mask, bare-faced. */
function maskedSession(): { s: GameSession; c: { now: () => number } } {
  const s = newSession();
  let t = 1_000_000;
  const c = { now: () => (t += 10_000) };
  s.addPlayer(1, 'ash', 0, 0);
  for (const m of MASKS) s.buy(1, m.id, 1, c.now());
  for (const m of MASKS) assert.equal(countOf(s.inventory(1), m.id), 1, `bag holds ${m.id}`);
  return { s, c };
}

function wear(s: GameSession, c: { now: () => number }, maskId: string): IntegratedOut[] {
  return s.equipMask(1, maskId);
}

describe('masks: 8 original defs, one perk each', () => {
  it('has exactly 8 masks with unique ids, names, perks and glyphs', () => {
    assert.equal(MASKS.length, 8);
    assert.equal(new Set(MASKS.map((m) => m.id)).size, 8);
    assert.equal(new Set(MASKS.map((m) => m.name)).size, 8);
    assert.equal(new Set(MASKS.map((m) => m.perk)).size, 8, 'one perk per mask, no repeats');
    assert.equal(new Set(MASKS.map((m) => m.glyph)).size, 8);
    for (const m of MASKS) {
      assert.ok(m.description.length >= 8, `${m.id} needs a real description`);
      assert.ok(m.price > 0, `${m.id} must be vendor-priced`);
      assert.equal(maskDef(m.id)?.perk, m.perk);
      assert.equal(maskPrice(m.id), m.price);
      assert.ok(isMaskId(m.id));
    }
    assert.equal(maskDef('nope'), undefined);
    assert.equal(isMaskId('ward-blade'), false);
  });

  it('covers autor, beast, bird, horn and scale themes', () => {
    const themes = new Set(MASKS.map((m) => m.theme));
    for (const t of ['autor', 'beast', 'bird', 'horn', 'scale'] as const) {
      assert.ok(themes.has(t), `missing ${t}-themed mask`);
    }
  });

  it('resolves through the content item tables without disturbing them', () => {
    assert.equal(ITEMS.length, 10, 'legacy items untouched');
    assert.equal(WEAPONS.length, 5, 'legacy weapons untouched');
    for (const m of MASKS) {
      assert.ok(ALL_ITEM_IDS.includes(m.id), `${m.id} is lootable`);
      const def = itemDef(m.id)!;
      assert.equal(def.kind, 'mask');
      assert.equal(def.price, m.price);
      assert.ok(isMaskItem(m.id));
      assert.equal(weaponDef(m.id), undefined, 'masks are not weapons');
    }
    assert.equal(isMaskItem('ember-shard'), false);
  });
});

describe('masks: perk math with no mask worn', () => {
  it('every perk is off for a bare face or an unknown id', () => {
    for (const bare of [null, undefined, 'nope'] as const) {
      assert.equal(maskMeleeMult(bare), 1);
      assert.equal(maskMuffles(bare), false);
      assert.equal(finishReach(FINISH_REACH_BASE, bare), FINISH_REACH_BASE);
      assert.equal(throwRange(THROW_RANGE_BASE, bare), THROW_RANGE_BASE);
      assert.equal(wallPingIntervalMs(bare), 0);
      assert.equal(wallPingDue(-Infinity, 1_000_000, bare), false);
      assert.equal(extraLootRolls(bare), 0);
      assert.equal(hazardDamageTaken(20, bare), 20);
      assert.equal(talentBoon(bare), 0);
    }
  });

  it('tuning constants match the documented shapes', () => {
    assert.equal(MASK_MELEE_MULT, 1.15);
    assert.equal(MASK_FINISH_BONUS, 1.0);
    assert.equal(MASK_EXTRA_ROLLS, 1);
    assert.equal(MASK_HAZARD_MULT, 0.7);
    assert.equal(MASK_TALENT_POINTS, 1);
    assert.equal(WALL_PING_INTERVAL_MS, 1000);
    assert.equal(MASK_DROP_BOSS, 0.25);
    assert.equal(MASK_DROP_ELITE, 0.05);
    assert.equal(ELITE_MIN_LEVEL, 6);
  });
});

describe('masks: all 8 perks activate/deactivate on equip/unequip', () => {
  it('seraph-shard: +15% melee damage', () => {
    const { s, c } = maskedSession();
    assert.equal(s.meleeDamage(1), 12);
    wear(s, c, 'seraph-shard');
    assert.equal(s.meleeDamage(1), Math.round(12 * 1.15));
    s.unequipMask(1);
    assert.equal(s.meleeDamage(1), 12);
  });

  it('dusk-maw: silent footsteps', () => {
    const { s, c } = maskedSession();
    assert.equal(s.muffles(1), false);
    wear(s, c, 'dusk-maw');
    assert.equal(s.muffles(1), true);
    s.unequipMask(1);
    assert.equal(s.muffles(1), false);
  });

  it('gallow-beak: faster executions (finish reach +1u)', () => {
    const { s, c } = maskedSession();
    assert.equal(s.finishBonus(1), 0);
    wear(s, c, 'gallow-beak');
    assert.equal(s.finishBonus(1), MASK_FINISH_BONUS);
    assert.equal(finishReach(FINISH_REACH_BASE, 'gallow-beak'), FINISH_REACH_BASE + 1);
    s.unequipMask(1);
    assert.equal(s.finishBonus(1), 0);
  });

  it('choir-horn: longer throw range (+4u)', () => {
    const { s, c } = maskedSession();
    assert.equal(s.throwReach(1), THROW_RANGE_BASE);
    wear(s, c, 'choir-horn');
    assert.equal(s.throwReach(1), THROW_RANGE_BASE + 4);
    s.unequipMask(1);
    assert.equal(s.throwReach(1), THROW_RANGE_BASE);
  });

  it('vesper-plume: see-through-walls ping 1/s on the tick', () => {
    const { s } = maskedSession();
    assert.deepEqual(ofKind(s.tick(1_000_000, []), 'wall-ping'), [], 'bare face pings nothing');
    s.equipMask(1, 'vesper-plume');
    const first = ofKind(s.tick(2_000_000, []), 'wall-ping');
    assert.equal(first.length, 1);
    assert.equal(first[0]!['maskId'], 'vesper-plume');
    // Same instant: throttled to one ping per second.
    assert.deepEqual(ofKind(s.tick(2_000_500, []), 'wall-ping'), []);
    const later = ofKind(s.tick(2_001_000, []), 'wall-ping');
    assert.equal(later.length, 1, 'a second later the ping fires again');
    s.unequipMask(1);
    assert.deepEqual(ofKind(s.tick(9_000_000, []), 'wall-ping'), [], 'doffed plume goes quiet');
  });

  it('tithe-scale: one extra loot roll', () => {
    const { s, c } = maskedSession();
    assert.equal(s.extraLootRolls(1), 0);
    wear(s, c, 'tithe-scale');
    assert.equal(s.extraLootRolls(1), 1);
    // A rigged rand (always hits) doubles every gloomfang stack with the roll.
    const base = rollLootForKill('gloomfang', 'meadow', 1, () => 0, 0);
    const bonused = rollLootForKill('gloomfang', 'meadow', 1, () => 0, s.extraLootRolls(1));
    const sum = (rows: { count: number }[]): number => rows.reduce((n, r) => n + r.count, 0);
    assert.ok(sum(bonused) > sum(base), 'the extra roll adds loot');
    assert.deepEqual(
      bonused.map((d) => d.itemId).sort(),
      base.map((d) => d.itemId).sort(),
      'same table, re-rolled',
    );
    s.unequipMask(1);
    assert.equal(s.extraLootRolls(1), 0);
  });

  it('cinder-hide: -30% hazard damage', () => {
    const { s, c } = maskedSession();
    assert.equal(s.hazardTaken(1, 20), 20);
    wear(s, c, 'cinder-hide');
    assert.equal(s.hazardTaken(1, 20), 14);
    s.unequipMask(1);
    assert.equal(s.hazardTaken(1, 20), 20);
  });

  it('halo-rind: +1 talent point, spent from the boon first, no farming', () => {
    const { s, c } = maskedSession();
    assert.equal(s.talentPoints(1), 1);
    wear(s, c, 'halo-rind');
    assert.equal(s.talentPoints(1), 2, 'boon adds a point while worn');
    s.spendTalent(1, 'might-1');
    assert.equal(s.talentPoints(1), 1, 'the boon point is spent first');
    assert.equal(s.progression(1)!.talents['might-1'], 1);
    assert.equal(s.progression(1)!.spentPoints, 0, 'free points never enter the respec ledger');
    s.unequipMask(1);
    assert.equal(s.talentPoints(1), 1, 'doffing drops the (consumed) grant');
    wear(s, c, 'halo-rind');
    assert.equal(s.talentPoints(1), 1, 're-wearing cannot mint the point again');
  });
});

describe('masks: exactly one equip slot', () => {
  it('wearing a second mask replaces the first', () => {
    const { s, c } = maskedSession();
    wear(s, c, 'seraph-shard');
    assert.equal(s.meleeDamage(1), Math.round(12 * 1.15));
    const out = wear(s, c, 'dusk-maw');
    const ev = ofKind(out, 'mask-equipped')[0]!;
    assert.equal(ev['maskId'], 'dusk-maw');
    assert.equal(ev['replaced'], 'seraph-shard');
    assert.equal(s.activeMask(1), 'dusk-maw');
    assert.equal(s.meleeDamage(1), 12, 'the fury perk deactivates with the old mask');
    assert.equal(s.muffles(1), true, 'and the silence perk activates');
  });

  it('refuses unknown masks, bare inventory and double wear', () => {
    const s = newSession();
    s.addPlayer(1, 'ash', 0, 0);
    assert.match(text(s.equipMask(1, 'sword-of-doom'))[0]!, /not a mask/);
    assert.match(text(s.equipMask(1, 'seraph-shard'))[0]!, /do not carry/);
    assert.match(text(s.unequipMask(1))[0]!, /no mask/);
    s.buy(1, 'seraph-shard', 1, 1000);
    s.equipMask(1, 'seraph-shard');
    assert.match(text(s.equipMask(1, 'seraph-shard'))[0]!, /already worn/);
  });

  it('emits mask-equipped / mask-unequipped with perk + glyph', () => {
    const { s, c } = maskedSession();
    const on = ofKind(wear(s, c, 'tithe-scale'), 'mask-equipped')[0]!;
    assert.equal(on['perk'], 'extra-loot');
    assert.ok(typeof on['glyph'] === 'string' && (on['glyph'] as string).length > 0);
    const off = ofKind(s.unequipMask(1), 'mask-unequipped')[0]!;
    assert.equal(off['maskId'], 'tithe-scale');
    assert.equal(off['perk'], 'extra-loot');
  });

  it('leaving the world drops the mask and its bonus', () => {
    const { s, c } = maskedSession();
    wear(s, c, 'halo-rind');
    assert.equal(s.talentPoints(1), 2);
    s.removePlayer(1);
    assert.equal(s.activeMask(1), null);
    assert.equal(s.talentPoints(1), 0, 'unknown player holds no points');
  });
});

describe('masks: loot drops (bosses 25%, elites 5%) + vendor purchase', () => {
  it('elites are level 6+ mobs', () => {
    assert.equal(isEliteLevel(5), false);
    assert.equal(isEliteLevel(6), true);
    assert.equal(isEliteLevel(8), true);
    assert.equal(isEliteLevel(0), false);
  });

  it('bosses drop at 25%, elites at 5%, rabble never', () => {
    const boss = { n: 0, hit: 0 };
    const r1 = mulberry32(4242);
    for (let i = 0; i < 4000; i++) {
      boss.n++;
      if (rollMaskDrop(r1, { boss: true })) boss.hit++;
    }
    const bossRate = boss.hit / boss.n;
    assert.ok(bossRate > 0.2 && bossRate < 0.3, `boss rate ${bossRate} ~= 0.25`);

    const elite = { n: 0, hit: 0 };
    const r2 = mulberry32(777);
    for (let i = 0; i < 20000; i++) {
      elite.n++;
      if (rollMaskDrop(r2, { elite: true })) elite.hit++;
    }
    const eliteRate = elite.hit / elite.n;
    assert.ok(eliteRate > 0.03 && eliteRate < 0.07, `elite rate ${eliteRate} ~= 0.05`);

    const r3 = mulberry32(9);
    for (let i = 0; i < 200; i++) assert.equal(rollMaskDrop(r3, {}), null, 'normal kills never drop');
    for (let i = 0; i < 200; i++) assert.equal(rollMaskDrop(r3, { elite: false }), null);
  });

  it('drops span all 8 masks', () => {
    const seen = new Set<string>();
    const r = mulberry32(31337);
    for (let i = 0; i < 400 && seen.size < 8; i++) {
      const id = rollMaskDrop(r, { boss: true });
      if (id) seen.add(id);
    }
    assert.equal(seen.size, 8, 'every mask drops eventually');
  });

  it('the vendor sells every mask (and buys them back)', () => {
    const s = newSession();
    s.addPlayer(1, 'ash', 0, 0);
    const stock = s.vendorStock(1000);
    assert.equal(stock.length, 23, '10 items + 5 weapons + 8 masks');
    for (const m of MASKS) {
      const row = stock.find((r) => r.itemId === m.id)!;
      assert.ok(row, `${m.id} stocked`);
      assert.equal(row.basePrice, m.price);
      assert.ok(row.buy > 0 && row.sell > 0 && row.sell <= row.buy);
      const before = s.gold(1);
      const out = s.buy(1, m.id, 1, 2000 + MASKS.indexOf(m));
      assert.equal(ofKind(out, 'vendor-trade')[0]!['ok'], true, `bought ${m.id}`);
      assert.ok(s.gold(1) < before);
      assert.equal(countOf(s.inventory(1), m.id), 1);
      const back = s.sell(1, m.id, 1, 3000 + MASKS.indexOf(m));
      assert.equal(ofKind(back, 'vendor-trade')[0]!['ok'], true, `sold ${m.id}`);
    }
  });
});
