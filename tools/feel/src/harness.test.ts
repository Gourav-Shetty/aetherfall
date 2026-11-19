import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  measureTimeToFullSpeed,
  measureStopDistance,
  measureKnockback,
  measureJump,
  measureTtkPerWeapon,
  measureCancelWindow,
  measureDashIFrames,
  measureSdiNudge,
  measureTimeToFirstEnemy,
  measureMobsInSight,
  measureClientServerParity,
  measureAiWeaponBehaviors,
  runFullFeelAudit,
} from './harness.js';

describe('Headless Feel Harness (Phase 0, Phase 1, Phase 2, and Phase 3)', () => {
  it('time-to-full-speed: achieves 0 -> full in ~80ms with a smooth curve', () => {
    const m = measureTimeToFullSpeed();
    assert.ok(m.timeToFullSpeedMs >= 75 && m.timeToFullSpeedMs <= 85, `timeToFull=${m.timeToFullSpeedMs}ms`);
    assert.equal(m.isSmooth, true, 'accel curve must be smooth and monotonic');
    assert.ok(m.samples.length > 10, 'samples recorded');
  });

  it('stop-distance: is distinctly non-zero and brings body to full rest', () => {
    const s = measureStopDistance();
    assert.ok(s.stopDistanceUnits > 0.75 && s.stopDistanceUnits < 0.85, `stopDistance=${s.stopDistanceUnits}u`);
    assert.ok(s.stopDurationMs > 190 && s.stopDurationMs < 220, `stopDuration=${s.stopDurationMs}ms`);
    assert.equal(s.stoppedCleanly, true);
  });

  it('knockback-distance: hit taken yields ~1.8u and hit dealt applies recoil', () => {
    const k = measureKnockback();
    assert.ok(k.hitTakenDistanceUnits > 1.70 && k.hitTakenDistanceUnits < 1.90, `hitTaken=${k.hitTakenDistanceUnits}u`);
    assert.ok(k.hitDealtRecoilDistanceUnits > 0.08 && k.hitDealtRecoilDistanceUnits < 0.15, `recoil=${k.hitDealtRecoilDistanceUnits}u`);
    assert.ok(k.dashDistanceUnits > 2.3 && k.dashDistanceUnits < 2.7, `dash=${k.dashDistanceUnits}u`);
  });

  it('jump: vertical impulse elevates and lands smoothly', () => {
    const j = measureJump();
    assert.ok(j.peakHeightUnits > 0.7 && j.peakHeightUnits < 1.1, `peak=${j.peakHeightUnits}u`);
    assert.ok(j.hangTimeMs > 400 && j.hangTimeMs < 700, `hangTime=${j.hangTimeMs}ms`);
    assert.equal(j.cleanTouchdown, true);
  });

  it('TTK per weapon: computes hits, TTK in seconds, and effective DPS with distinct weapon profiles', () => {
    const weapons = measureTtkPerWeapon(100, 0.05);
    assert.ok(weapons.length >= 6, `expected >= 6 weapons, found ${weapons.length}`);

    const unarmed = weapons.find((w) => w.weaponId === 'unarmed')!;
    assert.ok(unarmed);
    assert.equal(unarmed.damagePerHit, 11.4); // 12 * 0.95
    assert.equal(unarmed.hitsToKill, 9);
    assert.equal(unarmed.reach, 1.4);
    assert.equal(unarmed.cooldownMs, 360);

    const dagger = weapons.find((w) => w.weaponId === 'wisp-touched-dagger')!;
    assert.ok(dagger);
    assert.equal(dagger.reach, 1.6);
    assert.equal(dagger.arcDeg, 120);
    assert.equal(dagger.cooldownMs, 480);

    const halberd = weapons.find((w) => w.weaponId === 'deep-halberd')!;
    assert.ok(halberd);
    assert.equal(halberd.reach, 3.2); // Longest reach
    assert.equal(halberd.arcDeg, 45); // Narrow thrust
    assert.equal(halberd.cooldownMs, 950);

    const greatsword = weapons.find((w) => w.weaponId === 'caldera-greatsword')!;
    assert.ok(greatsword);
    assert.equal(greatsword.reach, 2.8);
    assert.equal(greatsword.arcDeg, 150); // Widest arc
    assert.equal(greatsword.damagePerHit, 22.8); // 24 * 0.95
    assert.equal(greatsword.hitsToKill, 5);
  });

  it('cancel-window: input during hitstop freeze queues and resolves immediately on exit', () => {
    const cw = measureCancelWindow();
    assert.equal(cw.queuedDuringHitstop, true);
    assert.equal(cw.heldDuringFreeze, true);
    assert.equal(cw.executedImmediatelyOnExpiry, true);
    assert.equal(cw.chainReproducible, true);
  });

  it('i-frames: dash grants invulnerability that cleanly expires', () => {
    const iframe = measureDashIFrames();
    assert.equal(iframe.iframeWindowMs, 200);
    assert.equal(iframe.isInvulnerableDuringDash, true);
    assert.equal(iframe.expiresCleanly, true);
  });

  it('sdi: directional input during hitstop nudges character to escape multi-hits', () => {
    const sdi = measureSdiNudge();
    assert.equal(sdi.sdiNudgePerInput, 0.2);
    assert.ok(sdi.displacementUnits >= 0.5, `displacement=${sdi.displacementUnits}u`);
    assert.equal(sdi.escapedMultiHit, true);
  });

  it('time-to-first-enemy: calculates distance and travel time from spawn anchors', () => {
    const firstEnemies = measureTimeToFirstEnemy();
    assert.ok(firstEnemies.length >= 2);
    for (const fe of firstEnemies) {
      assert.ok(fe.distanceUnits >= 12.0, 'nearest mob must be outside 12u safe radius');
      assert.ok(fe.travelTimeToMeleeSec > 1.0 && fe.travelTimeToMeleeSec < 15.0, `travelTime=${fe.travelTimeToMeleeSec}s`);
    }
  });

  it('mobs-in-sight: reports mob density within interaction, viewport and interest radii', () => {
    const sight = measureMobsInSight();
    assert.ok(sight.length >= 3);
    for (const s of sight) {
      assert.ok(s.inInterestRadius40u >= s.inViewportRadius15u);
      assert.ok(s.inViewportRadius15u >= s.inInteractionRadius12u);
    }
  });

  it('client-server parity: achieves 0 desync after a stop-and-go sequence', () => {
    const p = measureClientServerParity();
    assert.equal(p.inParity, true);
    assert.ok(p.maxPosErrorUnits < 1e-5, `maxPosError=${p.maxPosErrorUnits}`);
    assert.ok(p.maxVelErrorUnits < 1e-5, `maxVelError=${p.maxVelErrorUnits}`);
  });

  it('weapon-aware AI: ranged holds distance, melee charges, unarmed flees at low HP, spectator observes differential', () => {
    const ai = measureAiWeaponBehaviors();
    assert.equal(ai.ranged.holdsDistanceInPocket, true);
    assert.equal(ai.ranged.repositionsAwayWhenCrowded, true);
    assert.ok(ai.ranged.retreatDistanceDelta > 0);
    assert.equal(ai.melee.chargesAtSpeed, true);
    assert.equal(ai.melee.strikesAtReach, true);
    assert.equal(ai.unarmed.brawlsAtFullHp, true);
    assert.equal(ai.unarmed.fleesAtLowHp, true);
    assert.equal(ai.spectatorDifferential.mobsBehaveVisiblyDifferently, true);
    assert.ok(ai.spectatorDifferential.rangedDelta < 0);
    assert.ok(ai.spectatorDifferential.meleeDelta > 0);
  });

  it('runFullFeelAudit: passes all Phase 0, Phase 1, Phase 2, and Phase 3 acceptance criteria', () => {
    const report = runFullFeelAudit();
    const ac = report.acceptanceCriteria;
    assert.equal(ac.accelCurveSmooth, true);
    assert.equal(ac.stopDistanceNonZero, true);
    assert.equal(ac.zeroToFullAround80ms, true);
    assert.equal(ac.frictionAround28PctOfAccel, true);
    assert.equal(ac.knockbackAround1Point8u, true);
    assert.equal(ac.clientServerAgreement, true);
    assert.equal(ac.everyWeaponHasDistinctReachAndTiming, true);
    assert.equal(ac.cancellingDuringHitstopIsReliablyReproducible, true);
    assert.equal(ac.dashIFramesActiveAndExpires, true);
    assert.equal(ac.sdiMultiHitEscapeAppliesNudge, true);
    assert.equal(ac.rangedHoldsDistanceAndRepositions, true);
    assert.equal(ac.meleeChargesAndStrikesAtReach, true);
    assert.equal(ac.unarmedFleesAtLowHp, true);
    assert.equal(ac.spectatorObservesWeaponDifferential, true);
  });
});
