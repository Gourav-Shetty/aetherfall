// combat_ext: damage types, resistances, crit, block, stagger/knockback, burn/HoT.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import {
  BLOCK_COOLDOWN_MS,
  BLOCK_REDUCTION,
  BURN_DAMAGE_PER_TICK,
  BURN_TICK_MS,
  CRIT_CHANCE,
  CRIT_MULTIPLIER,
  DAMAGE_TYPES,
  KNOCKBACK_UNITS,
  MOB_RESISTANCES,
  POISE_MAX,
  STAGGER_MS,
  applyBlock,
  applyBurn,
  applyCrit,
  applyResistance,
  canBlock,
  checkStagger,
  computeKnockback,
  isDamageType,
  makeBurn,
  makeCombatant,
  makeRegen,
  resistFactor,
  regenPoise,
  resistancesForMob,
  resolveHit,
  rollCrit,
  tickEffects,
  tickRoster,
  type CombatEvent,
  type CombatantState,
  type TimedEffect,
} from './combat_ext.js';

function roll(v: number): () => number {
  let used = false;
  return () => {
    if (used) return v;
    used = true;
    return v;
  };
}

/** Float-tolerant vector comparison (knockback maths produces long decimals). */
function approx(x: number, y: number, eps = 1e-9): boolean {
  return Math.abs(x - y) < eps;
}

describe('combat_ext damage types', () => {
  it('exposes exactly physical/fire/holy', () => {
    assert.deepEqual([...DAMAGE_TYPES], ['physical', 'fire', 'holy']);
    assert.equal(isDamageType('fire'), true);
    assert.equal(isDamageType('shadow'), false);
  });

  it('unresisted targets take full damage', () => {
    assert.equal(applyResistance(50, undefined, 'physical'), 50);
    assert.equal(applyResistance(50, {}, 'holy'), 50);
    assert.equal(resistFactor(undefined, 'fire'), 1);
  });

  it('resistance reduces, immunity zeroes, vulnerability amplifies (capped)', () => {
    assert.equal(applyResistance(100, { fire: 0.5 }, 'fire'), 50);
    assert.equal(applyResistance(100, { fire: 1 }, 'fire'), 0); // immune
    assert.equal(applyResistance(100, { fire: -0.25 }, 'fire'), 125); // -25% resist
    assert.equal(applyResistance(100, { fire: -5 }, 'fire'), 150); // capped at +50%
    assert.equal(applyResistance(100, { fire: 9 }, 'fire'), 0); // clamped, no negative HP
  });

  it('resistance is type-specific', () => {
    const res = resistancesForMob('magma-golem');
    assert.equal(res.fire, 0.6);
    assert.equal(res.physical, 0.25);
    assert.equal(applyResistance(100, res, 'fire'), 40);
    assert.equal(applyResistance(100, res, 'physical'), 75);
  });

  it('every mob resistance table is in range and unknown mobs resist nothing', () => {
    for (const [mob, res] of Object.entries(MOB_RESISTANCES)) {
      for (const type of DAMAGE_TYPES) {
        const v = res[type] ?? 0;
        assert.ok(v <= 1, `${mob}.${type} > 1`);
        assert.ok(v >= -0.5, `${mob}.${type} < -0.5`);
      }
    }
    assert.deepEqual(resistancesForMob('not-a-mob'), {});
  });

  it('resistance table returns a copy (callers cannot mutate the source)', () => {
    const r = resistancesForMob('gloomfang');
    r.fire = 0.99;
    assert.equal(MOB_RESISTANCES['gloomfang']!.fire, 0);
  });
});

describe('combat_ext crit', () => {
  it('base crit is 5% at x2', () => {
    assert.equal(CRIT_CHANCE, 0.05);
    assert.equal(CRIT_MULTIPLIER, 2);
  });

  it('rolls deterministically off the injected rand', () => {
    assert.equal(rollCrit(roll(0.04)), true);
    assert.equal(rollCrit(roll(0.0499)), true);
    assert.equal(rollCrit(roll(0.05)), false); // < is exclusive
    assert.equal(rollCrit(roll(0.9)), false);
  });

  it('clamps out-of-range chances', () => {
    assert.equal(rollCrit(roll(0.99), 0), false);
    assert.equal(rollCrit(roll(0.0), 1), true);
  });

  it('applyCrit doubles and rounds', () => {
    assert.equal(applyCrit(30, false), 30);
    assert.equal(applyCrit(30, true), 60);
    assert.equal(applyCrit(15, true), 30);
    assert.equal(applyCrit(0, true), 0);
  });
});

describe('combat_ext block', () => {
  it('block cuts 30% off the hit', () => {
    assert.equal(BLOCK_REDUCTION, 0.3);
    assert.equal(applyBlock(100), 70);
    assert.equal(applyBlock(37), 26); // 25.9 -> 26
    assert.equal(applyBlock(1), 1); // rounds to at least 1 point
  });

  it('gates on a 200ms cooldown', () => {
    assert.equal(BLOCK_COOLDOWN_MS, 200);
    const c = makeCombatant(2, 1, 0, { lastBlockAt: 1000 });
    assert.equal(canBlock(1000, c), false);
    assert.equal(canBlock(1199, c), false);
    assert.equal(canBlock(1200, c), true);
  });

  it('cannot block while dead, staggered or un-blockable', () => {
    const dead = { ...makeCombatant(2, 1, 0), dead: true, hp: 0 };
    assert.equal(canBlock(10_000, dead), false);
    const staggered = { ...makeCombatant(2, 1, 0), staggeredUntil: 5000 };
    assert.equal(canBlock(1000, staggered), false);
    assert.equal(canBlock(6000, staggered), true);
    const mob = makeCombatant(2, 1, 0, { blockable: false });
    assert.equal(canBlock(10_000, mob), false);
  });
});

describe('combat_ext stagger + knockback', () => {
  it('poise drains 1:1 and breaking it staggers', () => {
    const c = makeCombatant(2, 0, 0, { poise: 30 });
    const hit = checkStagger(c, 20, 1000);
    assert.equal(hit.staggered, false);
    assert.equal(hit.poiseLeft, 10);
    const broke = checkStagger(c, 40, 1000);
    assert.equal(broke.staggered, true);
    assert.equal(broke.poiseLeft, 0);
  });

  it('a >=25% maxHP hit staggers regardless of poise', () => {
    const boss = makeCombatant(2, 0, 0, { maxHp: 400, poise: POISE_MAX });
    assert.equal(checkStagger(boss, 99, 0).staggered, false);
    assert.equal(checkStagger(boss, 100, 0).staggered, true);
  });

  it('an already-staggered target cannot be re-staggered', () => {
    const c: CombatantState = { ...makeCombatant(2, 0, 0), staggeredUntil: 5000, poise: 0 };
    const r = checkStagger(c, 500, 1000);
    assert.equal(r.staggered, false);
    assert.equal(r.poiseLeft, 0);
  });

  it('knockback pushes away from the attacker along the axis', () => {
    const east = computeKnockback({ x: 5, y: 0 }, { x: 0, y: 0 });
    assert.ok(approx(east.x, 5 + KNOCKBACK_UNITS), `x=${east.x}`);
    assert.ok(approx(east.y, 0), `y=${east.y}`);
    const north = computeKnockback({ x: 0, y: -4 }, { x: 0, y: 0 });
    assert.ok(approx(north.x, 0), `x=${north.x}`);
    assert.ok(approx(north.y, -4 - KNOCKBACK_UNITS), `y=${north.y}`);
  });

  it('overlapping combatants push +X instead of NaN', () => {
    const r = computeKnockback({ x: 3, y: 3 }, { x: 3, y: 3 });
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
    assert.ok(approx(r.x, 3 + KNOCKBACK_UNITS));
    assert.equal(r.y, 3);
  });

  it('poise regenerates out of combat but not while staggered', () => {
    const c = makeCombatant(2, 0, 0, { poise: 0 });
    assert.equal(regenPoise(c, 2000, 1000).poise, 20);
    assert.equal(regenPoise(c, 60_000, 1000).poise, POISE_MAX);
    const staggered: CombatantState = { ...c, staggeredUntil: 9999 };
    assert.equal(regenPoise(staggered, 2000, 1000).poise, 0);
  });
});

describe('combat_ext resolveHit pipeline', () => {
  const atk = () => makeCombatant(1, 0, 0);

  it('deals resisted damage and returns a NEW state without mutating', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 200, resistances: { fire: 0.5 } });
    const r = resolveHit(atk(), target, { amount: 100, type: 'fire', now: 0 }, roll(0.99));
    assert.equal(r.dealt, 50);
    assert.equal(r.state.hp, 150);
    assert.equal(target.hp, 200, 'input must not be mutated');
    assert.deepEqual(r.events[0], { type: 'damage', targetId: 2, amount: 50, damageType: 'fire', crit: false, blocked: false });
  });

  it('immunised targets take nothing and emit immune', () => {
    const target = makeCombatant(2, 3, 0, { resistances: { holy: 1 } });
    const r = resolveHit(atk(), target, { amount: 999, type: 'holy', now: 0 }, roll(0.99));
    assert.equal(r.dealt, 0);
    assert.equal(r.state.hp, target.hp);
    assert.deepEqual(r.events, [{ type: 'immune', targetId: 2, damageType: 'holy' }]);
  });

  it('crit doubles post-resistance damage', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 500 });
    const r = resolveHit(atk(), target, { amount: 100, type: 'physical', now: 0, crit: true }, roll(0.99));
    assert.equal(r.crit, true);
    assert.equal(r.dealt, 200);
    assert.equal(r.state.hp, 300);
  });

  it('guard + cooldown = block, and blocking arms the 200ms cd', () => {
    // high poise so the stagger path cannot interfere with the block cooldown
    const target = makeCombatant(2, 3, 0, { maxHp: 500, poise: 1000 });
    const blocked = resolveHit(atk(), target, { amount: 100, type: 'physical', now: 1000, guard: true }, roll(0.99));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.dealt, 70);
    assert.equal(blocked.state.lastBlockAt, 1000);
    assert.ok(blocked.events.some((e) => e.type === 'block'));
  });

  it('a guarded target that just blocked cannot block again for 200ms', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 500, poise: 1000 });
    const first = resolveHit(atk(), target, { amount: 100, type: 'physical', now: 1000, guard: true }, roll(0.99));
    // threading the returned state is required: resolveHit never mutates its input
    const second = resolveHit(atk(), first.state, { amount: 100, type: 'physical', now: 1100, guard: true }, roll(0.99));
    assert.equal(second.blocked, false);
    assert.equal(second.dealt, 100);
    const third = resolveHit(atk(), second.state, { amount: 100, type: 'physical', now: 1200, guard: true }, roll(0.99));
    assert.equal(third.blocked, true);
    assert.equal(third.dealt, 70);
  });

  it('a staggered target cannot block at all', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 100 });
    const stag = resolveHit(atk(), target, { amount: 90, type: 'physical', now: 0 }, roll(0.99));
    assert.equal(stag.staggered, true);
    const guarded = resolveHit(atk(), stag.state, { amount: 10, type: 'physical', now: 100, guard: true }, roll(0.99));
    assert.equal(guarded.blocked, false);
  });

  it('a small hit staggers nothing; a big hit staggers + knocks back', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 100, poise: POISE_MAX });
    const small = resolveHit(atk(), target, { amount: 10, type: 'physical', now: 0 }, roll(0.99));
    assert.equal(small.staggered, false);

    const big = resolveHit(atk(), small.state, { amount: 50, type: 'physical', now: 0 }, roll(0.99));
    assert.equal(big.staggered, true);
    assert.equal(big.state.staggeredUntil, STAGGER_MS);
    const kb = big.events.find((e): e is Extract<CombatEvent, { type: 'knockback' }> => e.type === 'knockback');
    assert.ok(kb, 'knockback event emitted');
    assert.equal(kb.units, KNOCKBACK_UNITS);
    assert.ok(approx(big.state.pos.x, 3 + KNOCKBACK_UNITS));
  });

  it('a block does not prevent stagger on a big hit', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 100 });
    const r = resolveHit(atk(), target, { amount: 80, type: 'physical', now: 0, guard: true }, roll(0.99));
    assert.equal(r.blocked, true);
    assert.equal(r.staggered, true);
  });

  it('death clamps hp to 0 and emits once', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 40 });
    const dead = resolveHit(atk(), target, { amount: 1000, type: 'physical', now: 0 }, roll(0.99));
    assert.equal(dead.killed, true);
    assert.equal(dead.state.dead, true);
    assert.equal(dead.state.hp, 0);
    assert.equal(dead.events.filter((e) => e.type === 'death').length, 1);
    const again = resolveHit(atk(), dead.state, { amount: 100, type: 'physical', now: 1 }, roll(0.99));
    assert.equal(again.dealt, 0);
    assert.equal(again.events.length, 0);
  });

  it('zero-damage hits are a no-op', () => {
    const target = makeCombatant(2, 3, 0);
    const r = resolveHit(atk(), target, { amount: 0, type: 'fire', now: 0 }, roll(0.5));
    assert.equal(r.dealt, 0);
    assert.equal(r.state, target);
  });

  it('the same seed gives identical results (deterministic for replays)', () => {
    const target = makeCombatant(2, 3, 0, { maxHp: 500, resistances: { physical: 0.2 } });
    const a = resolveHit(atk(), target, { amount: 80, type: 'physical', now: 0 }, mulberry32(9));
    const b = resolveHit(atk(), target, { amount: 80, type: 'physical', now: 0 }, mulberry32(9));
    assert.deepEqual(a, b);
  });
});

describe('combat_ext burn (DoT)', () => {
  it('applies to a live target and rejects dead ones', () => {
    const target = makeCombatant(2, 0, 0);
    const burn = makeBurn('b1', 2, 0);
    const ok = applyBurn(target, burn, 10);
    assert.equal(ok.applied, true);
    assert.ok(ok.events.some((e) => e.type === 'dot-apply'));

    const dead = { ...target, dead: true, hp: 0 };
    assert.equal(applyBurn(dead, burn, 10).applied, false);
  });

  it('burn respects fire resistance and is rejected outright at 100%', () => {
    const warm = makeCombatant(2, 0, 0, { maxHp: 100, resistances: { fire: 0.5 } });
    const r = tickEffects(warm, [makeBurn('b1', 2, 0)], BURN_TICK_MS);
    assert.equal(r.dotDamage, BURN_DAMAGE_PER_TICK / 2);
    const frozen = makeCombatant(3, 0, 0, { resistances: { fire: 1 } });
    const immune = applyBurn(frozen, makeBurn('b2', 3, 0), 0);
    assert.equal(immune.applied, false);
    assert.deepEqual(immune.events, [{ type: 'immune', targetId: 3, damageType: 'fire' }]);
  });

  it('ticks once per second for four seconds then expires', () => {
    const target = makeCombatant(2, 0, 0, { maxHp: 1000 });
    let effects: TimedEffect[] = [makeBurn('b1', 2, 0)];
    let dmg = 0;
    for (let t = BURN_TICK_MS; t <= 4000; t += BURN_TICK_MS) {
      const r = tickEffects(target, effects, t);
      effects = r.effects;
      dmg += r.dotDamage;
    }
    assert.equal(dmg, BURN_DAMAGE_PER_TICK * 4);
    assert.equal(effects.length, 0, 'expired after 4s');
  });

  it('a late tick catches up (capped at 10 ticks)', () => {
    const target = makeCombatant(2, 0, 0, { maxHp: 1000 });
    const caughtUp = tickEffects(target, [makeBurn('b1', 2, 0)], 3000);
    assert.equal(caughtUp.dotDamage, BURN_DAMAGE_PER_TICK * 3);
    const expired = tickEffects(target, [makeBurn('b2', 2, 0)], 60_000);
    assert.equal(expired.dotDamage, 0);
    assert.equal(expired.effects.length, 0);
    const longBurn = tickEffects(target, [makeBurn('b3', 2, 0, { durationMs: 600_000, damagePerTick: 1 })], 60_000);
    assert.equal(longBurn.dotDamage, 10, 'never more than 10 catch-up ticks');
  });

  it('burn can kill and stops on a dead target', () => {
    const target = makeCombatant(2, 0, 0, { maxHp: 10 });
    const r = tickEffects(target, [makeBurn('b1', 2, 0, { damagePerTick: 25 })], BURN_TICK_MS);
    assert.equal(r.state.dead, true);
    assert.equal(r.state.hp, 0);
    assert.ok(r.events.some((e) => e.type === 'death'));
  });
});

describe('combat_ext regen (HoT)', () => {
  it('heals over time and never overheals', () => {
    const target = makeCombatant(2, 0, 0, { maxHp: 100 });
    const hurt = { ...target, hp: 90 };
    const one = tickEffects(hurt, [makeRegen('r1', 2, 0)], 1000);
    assert.equal(one.hotHealing, 8);
    assert.equal(one.state.hp, 98);

    const overheal = tickEffects({ ...target, hp: 97 }, [makeRegen('r2', 2, 0)], 1000);
    assert.equal(overheal.state.hp, 100);
    assert.equal(overheal.hotHealing, 3);
  });

  it('does not revive a dead target', () => {
    const dead = { ...makeCombatant(2, 0, 0), dead: true, hp: 0 };
    const r = tickEffects(dead, [makeRegen('r1', 2, 0)], 1000);
    assert.equal(r.hotHealing, 0);
    assert.equal(r.state.hp, 0);
  });

  it('no tick before the interval elapses', () => {
    const target = { ...makeCombatant(2, 0, 0), hp: 50 };
    const r = tickEffects(target, [makeRegen('r1', 2, 0)], 999);
    assert.equal(r.hotHealing, 0);
    assert.equal(r.effects.length, 1);
  });
});

describe('combat_ext roster batching', () => {
  it('ticks each combatant with its own effects and keeps the input pure', () => {
    const a = makeCombatant(1, 0, 0, { maxHp: 100 });
    const b = makeCombatant(2, 20, 0, { maxHp: 100 });
    const roster = new Map([[1, a], [2, b]]);
    const effects = [makeBurn('b1', 1, 0), makeRegen('r1', 2, 0)];
    const r = tickRoster(roster, effects, 1000);
    assert.equal(r.roster.get(1)!.hp, 100 - BURN_DAMAGE_PER_TICK);
    assert.equal(r.roster.get(2)!.hp, 100, 'already full hp');
    assert.equal(a.hp, 100, 'input map values untouched');
    assert.equal(roster.get(1)!.hp, 100);
    assert.equal(r.events.length, 1);
  });

  it('effects for unknown combatants are dropped', () => {
    const r = tickRoster(new Map(), [makeBurn('b1', 99, 0)], 1000);
    assert.equal(r.effects.length, 0);
  });
});