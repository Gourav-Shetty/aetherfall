// Combat feedback layer: damage-number pooling + lifetime, the HP-bar
// visibility predicate, crit / finisher style selection, the a11y mode gate,
// hit-flash timing, the 800ms swing cadence and the kill-burst styles.
//
// Headless and pure: everything asserted here is either a function of its
// arguments or a preallocated pool stepped in place. The renderer-level tests
// live in feedback_render.test.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAMAGE_STYLES,
  DMG_MAX,
  DMG_MERGE_DIST,
  DMG_MERGE_MS,
  DMG_RISE_PX,
  DMG_TTL_MS,
  DMG_TTL_REDUCED_MS,
  FINISHER_LABEL,
  FLASH_MAX,
  HEAVY_HIT_MIN_SAMPLES,
  HEAVY_HIT_RATIO,
  HIT_FLASH_MOB,
  HIT_FLASH_MS,
  HIT_FLASH_PLAYER,
  HeavyHitTracker,
  HitFlashRing,
  KILL_FX_MAX,
  MELEE_REACH,
  MOB_BAR_RECENT_MS,
  RECENT_MAX,
  RecentDamageRing,
  SWING_COOLDOWN_MS,
  SWING_LUNGE,
  SWING_MS,
  SwingState,
  damageNumberMode,
  damageNumberRise,
  damageNumberText,
  damageNumberTtl,
  formatDamage,
  killBurstStyle,
  mobBarScratch,
  mobBarVisible,
  mobBarVisibleInto,
  pickMeleeTarget,
  swingEnvelope,
  type MobBarInput,
} from './feedback.js';

// ---------------------------------------------------------------------------
// Damage-number presentation
// ---------------------------------------------------------------------------

describe('feedback: damage-number styles', () => {
  it('white and small for a normal hit, gold and larger for a crit', () => {
    assert.equal(DAMAGE_STYLES.normal.color, '#f2f5ff');
    assert.equal(DAMAGE_STYLES.crit.color, '#ffd24a');
    assert.ok(DAMAGE_STYLES.crit.size > DAMAGE_STYLES.normal.size, 'a crit reads bigger too');
    assert.ok(DAMAGE_STYLES.crit.rise > DAMAGE_STYLES.normal.rise, 'a crit travels further');
  });

  it('player damage is red, larger than a normal hit and signed', () => {
    assert.equal(DAMAGE_STYLES.taken.color, '#ff4d5e');
    assert.ok(DAMAGE_STYLES.taken.size > DAMAGE_STYLES.normal.size);
    assert.equal(formatDamage(12, 'taken'), '-12');
  });

  it('never relies on colour alone: crit, taken and finisher all carry a marker', () => {
    assert.notEqual(DAMAGE_STYLES.crit.prefix, '', 'crit marker');
    assert.notEqual(DAMAGE_STYLES.finisher.prefix, '', 'finisher marker');
    // Taken damage's marker is its sign; a crit, a plain hit, a hit taken and a
    // finisher are all distinguishable with colour and size stripped away.
    assert.notEqual(formatDamage(20, 'crit'), formatDamage(20, 'normal'));
    assert.notEqual(formatDamage(20, 'taken'), formatDamage(20, 'normal'));
    assert.notEqual(formatDamage(20, 'finisher'), formatDamage(20, 'crit'));
    assert.notEqual(formatDamage(20, 'taken'), formatDamage(20, 'finisher'));
  });

  it('finisher style is the biggest and the most emphatic', () => {
    assert.ok(DAMAGE_STYLES.finisher.size > DAMAGE_STYLES.crit.size);
    assert.ok(DAMAGE_STYLES.finisher.rise > DAMAGE_STYLES.crit.rise);
  });

  it('formatDamage rounds, clamps and drops a bad kind', () => {
    assert.equal(formatDamage(7.6, 'normal'), '8');
    assert.equal(formatDamage(-4, 'normal'), '0');
    assert.equal(formatDamage(NaN, 'normal'), '0');
    assert.equal(formatDamage(9, 'nope' as never), '9');
  });

  it('a labelled slot prints its label verbatim', () => {
    const d = { label: FINISHER_LABEL, amount: 0, kind: 'finisher' } as never;
    assert.equal(damageNumberText(d), '✖ FINISH');
    const v = { label: '', amount: 5, kind: 'normal' } as never;
    assert.equal(damageNumberText(v), '5');
  });
});

// ---------------------------------------------------------------------------
// a11y mode gate
// ---------------------------------------------------------------------------

describe('feedback: a11y damage-number mode', () => {
  it('full motion by default', () => {
    assert.equal(damageNumberMode({ reducedMotion: false, highContrast: false }), 'full');
  });

  it('reduced motion keeps the text but kills the rise', () => {
    const mode = damageNumberMode({ reducedMotion: true, highContrast: false });
    assert.equal(mode, 'short');
    assert.equal(damageNumberRise(mode), 0, 'no travel under reduced motion');
    assert.equal(damageNumberTtl(mode), DMG_TTL_REDUCED_MS);
    assert.ok(DMG_TTL_REDUCED_MS > 0, 'the number is still shown');
    assert.ok(DMG_TTL_REDUCED_MS < DMG_TTL_MS);
  });

  it('high contrast removes the numbers outright', () => {
    for (const reducedMotion of [false, true]) {
      const mode = damageNumberMode({ reducedMotion, highContrast: true });
      assert.equal(mode, 'off', `high contrast wins (reducedMotion=${reducedMotion})`);
      assert.equal(damageNumberTtl(mode), 0);
      assert.equal(damageNumberRise(mode), 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Mob HP bar visibility
// ---------------------------------------------------------------------------

describe('feedback: mob HP bar visibility', () => {
  const base = { hp: 80, maxHp: 100, lastHitAt: 0, targeted: false, nowMs: 10_000 };

  it('a quiet mob wears no bar', () => {
    assert.equal(mobBarVisible(base), false);
  });

  it('a mob that took damage recently wears one', () => {
    assert.equal(mobBarVisible({ ...base, lastHitAt: base.nowMs - 10 }), true);
    assert.equal(mobBarVisible({ ...base, lastHitAt: base.nowMs - (MOB_BAR_RECENT_MS - 1) }), true);
  });

  it('the bar drops once the mob has been quiet long enough', () => {
    assert.equal(mobBarVisible({ ...base, lastHitAt: base.nowMs - MOB_BAR_RECENT_MS }), false);
    assert.equal(mobBarVisible({ ...base, lastHitAt: base.nowMs - MOB_BAR_RECENT_MS * 2 }), false);
  });

  it('the current target wears one even before the first hit', () => {
    assert.equal(mobBarVisible({ ...base, targeted: true }), true);
    assert.equal(mobBarVisible({ ...base, lastHitAt: 0, targeted: true }), true);
  });

  it('corpses and broken stats never show a bar', () => {
    assert.equal(mobBarVisible({ ...base, hp: 0, lastHitAt: base.nowMs, targeted: true }), false);
    assert.equal(mobBarVisible({ ...base, maxHp: 0 }), false);
    assert.equal(mobBarVisible({ ...base, hp: NaN }), false);
    assert.equal(mobBarVisible({ ...base, lastHitAt: NaN }), false);
  });

  it('the local player always keeps their own bar', () => {
    assert.equal(mobBarVisible({ ...base, always: true }), true);
    assert.equal(mobBarVisible({ hp: 0, maxHp: 100, lastHitAt: 0, targeted: false, nowMs: 0, always: true }), true);
  });

  it('the allocation-free form agrees with the object form', () => {
    const scratch = mobBarScratch();
    const cases: MobBarInput[] = [
      base,
      { ...base, lastHitAt: base.nowMs - 10 },
      { ...base, targeted: true },
      { ...base, hp: 0, lastHitAt: base.nowMs, targeted: true },
      { ...base, always: true },
      { ...base, maxHp: 0 },
      { ...base, lastHitAt: base.nowMs - MOB_BAR_RECENT_MS },
    ];
    for (const c of cases) {
      const direct = mobBarVisible(c);
      const scratchy = mobBarVisibleInto(
        scratch, c.hp, c.maxHp, c.lastHitAt, c.targeted, c.nowMs, c.always,
      );
      assert.equal(scratchy, direct, `same answer for ${JSON.stringify(c)}`);
    }
  });

  it('the scratch record is reused, not reallocated', () => {
    const scratch = mobBarScratch();
    assert.equal(scratch.hp, 0);
    mobBarVisibleInto(scratch, 42, 99, 5, true, 10, false);
    assert.equal(scratch.hp, 42);
    assert.equal(scratch.always, false, 'an omitted flag clears the previous value');
    mobBarVisibleInto(scratch, 1, 1, 0, false, 2);
    assert.equal(scratch.maxHp, 1);
    assert.equal(scratch.targeted, false);
  });
});

describe('feedback: RecentDamageRing', () => {
  it('records, queries and expires', () => {
    const r = new RecentDamageRing();
    assert.equal(r.lastAt(5), 0, 'never hit');
    r.mark(5, 1000);
    assert.equal(r.lastAt(5), 1000);
    r.mark(5, 1200);
    assert.equal(r.lastAt(5), 1200, 'repeat hits move the same slot');
    r.step(1200 + MOB_BAR_RECENT_MS - 1);
    assert.equal(r.lastAt(5), 1200, 'still inside the window');
    r.step(1200 + MOB_BAR_RECENT_MS);
    assert.equal(r.lastAt(5), 0, 'expired');
  });

  it('never grows past its fixed capacity', () => {
    const r = new RecentDamageRing();
    for (let i = 0; i < RECENT_MAX * 3; i++) r.mark(i, 1000 + i);
    assert.equal(r.capacity, RECENT_MAX);
    assert.equal(r.lastAt(0), 0, 'the oldest marker was recycled away');
    assert.equal(r.lastAt(RECENT_MAX * 3 - 1), 1000 + RECENT_MAX * 3 - 1, 'the newest survives');
  });

  it('ignores junk ids and timestamps', () => {
    const r = new RecentDamageRing();
    r.mark(-1, 1000);
    r.mark(1.5, 1000);
    r.mark(7, NaN);
    assert.equal(r.lastAt(7), 0);
  });
});

// ---------------------------------------------------------------------------
// Hit flash
// ---------------------------------------------------------------------------

describe('feedback: hit flash ring', () => {
  it('a struck mob flares white, the player flares red, both for 100ms', () => {
    const r = new HitFlashRing();
    r.flash(1, HIT_FLASH_MOB, 1000);
    r.flash(2, HIT_FLASH_PLAYER, 1000);
    assert.equal(r.tintFor(1), HIT_FLASH_MOB);
    assert.equal(r.tintFor(2), HIT_FLASH_PLAYER);
    assert.notEqual(HIT_FLASH_MOB, HIT_FLASH_PLAYER, 'the two reads differ');
    assert.equal(HIT_FLASH_MS, 100);
    assert.equal(r.strengthFor(1, 1000), 1, 'full strength at the moment of the hit');
    assert.equal(r.strengthFor(1, 1000 + HIT_FLASH_MS - 1) > 0, true);
    assert.equal(r.strengthFor(1, 1000 + HIT_FLASH_MS), 0, 'exactly 100ms');
    assert.equal(r.strengthFor(99, 1000), 0, 'untouched entity never flashes');
  });

  it('a repeat hit extends rather than stacking', () => {
    const r = new HitFlashRing();
    r.flash(1, HIT_FLASH_MOB, 1000);
    r.flash(1, HIT_FLASH_MOB, 1060);
    assert.equal(r.strengthFor(1, 1060), 1, 'the second hit restarts the flare');
    assert.equal(r.strengthFor(1, 1060 + HIT_FLASH_MS), 0);
  });

  it('reuses one slot per entity and expires idle ones', () => {
    const r = new HitFlashRing();
    r.flash(1, HIT_FLASH_MOB, 1000);
    r.flash(2, HIT_FLASH_MOB, 1000);
    r.step(1000 + HIT_FLASH_MS);
    assert.equal(r.strengthFor(1, 1000 + HIT_FLASH_MS), 0);
    assert.equal(r.strengthFor(2, 1000 + HIT_FLASH_MS), 0);
    // Slots freed, so a long fight never exhausts the ring.
    for (let i = 0; i < FLASH_MAX * 3; i++) {
      r.flash(i, HIT_FLASH_MOB, 2000 + i * HIT_FLASH_MS * 2);
      r.step(2000 + i * HIT_FLASH_MS * 2 + HIT_FLASH_MS);
    }
    assert.equal(r.capacity, FLASH_MAX);
  });

  it('ignores bad ids and non-finite timestamps', () => {
    const r = new HitFlashRing();
    r.flash(-1, HIT_FLASH_MOB, 1000);
    r.flash(1.5, HIT_FLASH_MOB, 1000);
    r.flash(3, HIT_FLASH_MOB, NaN);
    assert.equal(r.strengthFor(3, 1000), 0);
  });
});

// ---------------------------------------------------------------------------
// Swing cadence
// ---------------------------------------------------------------------------

describe('feedback: swing cadence', () => {
  it('the envelope opens and closes across SWING_MS', () => {
    assert.equal(swingEnvelope(0), 0);
    assert.equal(swingEnvelope(-5), 0, 'never negative');
    assert.equal(swingEnvelope(SWING_MS), 0);
    assert.equal(swingEnvelope(SWING_MS + 100), 0);
    assert.equal(swingEnvelope(NaN), 0);
    const mid = swingEnvelope(SWING_MS / 2);
    assert.ok(mid > 0.99, `peaks in the middle (${mid})`);
  });

  it('only one swing animation per server cooldown window', () => {
    const s = new SwingState();
    assert.equal(s.swing(1, 0, 1000), true, 'first swing plays');
    assert.equal(s.swing(1, 0, 1100), false, 'still cooling down');
    assert.equal(s.swing(1, 0, 1799), false, 'still inside 800ms');
    assert.equal(s.swing(1, 0, 1800), true, '800ms cadence reached');
    assert.equal(SWING_COOLDOWN_MS, 800);
  });

  it('the direction is normalised so a diagonal stick still lunges the same distance', () => {
    const a = new SwingState();
    const b = new SwingState();
    a.swing(3, 4, 1000);
    b.swing(-1, 0, 1000);
    assert.ok(Math.abs(a.dirX - 0.6) < 1e-9);
    assert.ok(Math.abs(a.dirY - 0.8) < 1e-9);
    assert.equal(b.dirX, -1);
    assert.equal(b.dirY, 0);
  });

  it('a zero-length stick keeps the previous facing instead of NaN', () => {
    const s = new SwingState();
    s.swing(1, 0, 0);
    s.swing(0, 0, 10_000);
    assert.equal(s.dirX, 1);
    assert.equal(s.dirY, 0);
  });

  it('is active only inside the animation window', () => {
    const s = new SwingState();
    s.swing(1, 0, 1000);
    assert.equal(s.isActive(1000), true);
    assert.equal(s.isActive(1000 + SWING_MS - 1), true);
    assert.equal(s.isActive(1000 + SWING_MS), false);
    assert.ok(s.envelope(1000 + SWING_MS / 2) > 0);
    assert.equal(s.envelope(1000 + SWING_MS), 0);
  });

  it('the lunge is a real offset, not a no-op', () => {
    assert.ok(SWING_LUNGE > 0);
  });
});

// ---------------------------------------------------------------------------
// Kill confirmation
// ---------------------------------------------------------------------------

describe('feedback: kill burst styles', () => {
  it('a finisher differs from a plain kill in four non-colour ways', () => {
    const plain = killBurstStyle(false);
    const fin = killBurstStyle(true);
    assert.ok(fin.particles > plain.particles, 'more particles');
    assert.ok(fin.ringScale > plain.ringScale, 'bigger ring');
    assert.ok(fin.rings > plain.rings, 'double ring');
    assert.ok(fin.shake > plain.shake, 'harder shake');
    assert.notEqual(fin.color, plain.color);
  });

  it('both styles are renderable', () => {
    for (const fin of [false, true]) {
      const s = killBurstStyle(fin);
      assert.match(s.color, /^#[0-9a-f]{6}$/);
      assert.ok(s.particles > 0 && s.ringScale > 0 && s.lifeMs > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Heavy-hit tracking (client-side stand-in for the crit roll)
// ---------------------------------------------------------------------------

describe('feedback: HeavyHitTracker', () => {
  it('says nothing until it has enough history', () => {
    const t = new HeavyHitTracker();
    for (let i = 0; i < HEAVY_HIT_MIN_SAMPLES; i++) {
      assert.equal(t.observe(999), false, `sample ${i + 1} is too early to judge`);
    }
    assert.equal(t.samples, HEAVY_HIT_MIN_SAMPLES);
  });

  it('flags a hit well above the running average', () => {
    const t = new HeavyHitTracker();
    for (let i = 0; i < HEAVY_HIT_MIN_SAMPLES; i++) t.observe(10);
    assert.equal(t.observe(10), false, 'a normal hit stays quiet');
    assert.equal(t.observe(10 * HEAVY_HIT_RATIO + 5), true, 'a big spike reads as heavy');
  });

  it('ignores junk amounts', () => {
    const t = new HeavyHitTracker();
    assert.equal(t.observe(0), false);
    assert.equal(t.observe(-5), false);
    assert.equal(t.observe(NaN), false);
    assert.equal(t.samples, 0);
  });

  it('reset() clears the history', () => {
    const t = new HeavyHitTracker();
    for (let i = 0; i < 5; i++) t.observe(10);
    t.reset();
    assert.equal(t.samples, 0);
    assert.equal(t.average, 0);
    assert.equal(t.observe(500), false);
  });
});

// ---------------------------------------------------------------------------
// Target prediction
// ---------------------------------------------------------------------------

describe('feedback: pickMeleeTarget', () => {
  const near = { id: 2, kind: 'mob', x: 52, y: 50, hp: 30 };
  const far = { id: 3, kind: 'mob', x: 70, y: 50, hp: 30 };
  const dead = { id: 4, kind: 'mob', x: 50.5, y: 50, hp: 0 };
  const npc = { id: 5, kind: 'npc', x: 51, y: 51, hp: 10 };
  const player = { id: 1, kind: 'player', x: 50.2, y: 50, hp: 100 };

  it('picks the nearest living hostile inside reach', () => {
    assert.equal(pickMeleeTarget([near, far, player], 50, 50), near.id);
    assert.equal(pickMeleeTarget([far, near], 50, 50), near.id, 'order does not matter');
  });

  it('returns -1 when nothing is in reach', () => {
    assert.equal(pickMeleeTarget([far], 50, 50), -1);
    assert.equal(pickMeleeTarget([], 50, 50), -1);
  });

  it('skips corpses, pickups, projectiles and other players', () => {
    assert.equal(pickMeleeTarget([dead, player], 50, 50), -1);
    assert.equal(pickMeleeTarget([{ id: 9, kind: 'pickup', x: 50.5, y: 50, hp: 1 }], 50, 50), -1);
    assert.equal(pickMeleeTarget([{ id: 9, kind: 'projectile', x: 50.5, y: 50, hp: 1 }], 50, 50), -1);
  });

  it('NPC minions are valid targets', () => {
    assert.equal(pickMeleeTarget([npc], 50, 50), npc.id);
  });

  it('honours the reach boundary exactly', () => {
    const edge = { id: 7, kind: 'mob', x: 50 + MELEE_REACH, y: 50, hp: 10 };
    assert.equal(pickMeleeTarget([edge], 50, 50), edge.id, 'exactly at reach counts');
    const past = { id: 8, kind: 'mob', x: 50 + MELEE_REACH + 0.01, y: 50, hp: 10 };
    assert.equal(pickMeleeTarget([past], 50, 50), -1);
  });

  it('the closest wins over a bigger one that is further out', () => {
    const close = { id: 10, kind: 'mob', x: 51, y: 50, hp: 10 };
    const alsoClose = { id: 11, kind: 'mob', x: 50.9, y: 50.2, hp: 10 };
    assert.equal(pickMeleeTarget([close, alsoClose], 50, 50), alsoClose.id);
  });
});

// ---------------------------------------------------------------------------
// Constants the renderers rely on
// ---------------------------------------------------------------------------

describe('feedback: shared tuning constants', () => {
  it('lifetime is ~700ms and the pool caps at 24', () => {
    assert.equal(DMG_TTL_MS, 700);
    assert.equal(DMG_MAX, 24);
    assert.ok(DMG_RISE_PX > 0);
  });

  it('the merge window is short enough not to swallow a second swing', () => {
    assert.ok(DMG_MERGE_MS <= 200, 'only near-simultaneous hits fold together');
    assert.ok(DMG_MERGE_DIST > 0);
  });

  it('the kill ring pool is bounded', () => {
    assert.ok(KILL_FX_MAX > 0 && KILL_FX_MAX <= 32);
  });
});