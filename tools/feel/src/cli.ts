#!/usr/bin/env node
// @aetherfall/feel — CLI entrypoint for the headless feel harness.

import { runFullFeelAudit } from './harness.js';

const isJson = process.argv.includes('--json');
const report = runFullFeelAudit();

if (isJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log('================================================================================');
console.log('                      AETHERFALL — HEADLESS FEEL HARNESS                        ');
console.log('================================================================================\n');

console.log('--- 1. MOVEMENT & PHYSICS (Venturelli Model) ---');
console.log(`  * Time-to-full-speed:  ${report.movement.accel.timeToFullSpeedMs.toFixed(1)} ms (0 -> 8.0 u/s)`);
console.log(`  * Accel curve smooth:  ${report.movement.accel.isSmooth ? 'PASS (monotonically accelerating)' : 'FAIL'}`);
console.log(`  * Stop distance:       ${report.movement.stop.stopDistanceUnits.toFixed(3)} units (stop time: ${report.movement.stop.stopDurationMs.toFixed(1)} ms)`);
console.log(`  * Hit-taken knockback: ${report.movement.knockback.hitTakenDistanceUnits.toFixed(3)} units (impulse: 11.88 u/s)`);
console.log(`  * Hit-dealt recoil:    ${report.movement.knockback.hitDealtRecoilDistanceUnits.toFixed(3)} units (impulse: 3.0 u/s)`);
console.log(`  * Dash distance:       ${report.movement.knockback.dashDistanceUnits.toFixed(3)} units (impulse: 14.0 u/s)`);
console.log(`  * Jump peak / hang:    ${report.movement.jump.peakHeightUnits.toFixed(2)} units / ${report.movement.jump.hangTimeMs.toFixed(1)} ms\n`);

console.log('--- 2. COMBAT DEPTH & WEAPON TIMINGS ---');
console.log('  Weapon               | Reach | Arc  | Windup | Recov  | CD (ms) | Dmg/Hit | TTK (s) | DPS');
console.log('  ---------------------+-------+------+--------+--------+---------+---------+---------+------');
for (const w of report.combat.weaponsTtk) {
  const name = w.weaponName.padEnd(20);
  const reach = `${w.reach.toFixed(1)}u`.padStart(5);
  const arc = `${w.arcDeg}°`.padStart(4);
  const windup = `${w.windupMs}ms`.padStart(6);
  const recov = `${w.recoveryMs}ms`.padStart(6);
  const cd = `${w.cooldownMs}ms`.padStart(7);
  const dmg = w.damagePerHit.toFixed(1).padStart(7);
  const ttk = `${w.ttkSeconds.toFixed(2)}s`.padStart(7);
  const dps = w.effectiveDps.toFixed(1).padStart(5);
  console.log(`  ${name} | ${reach} | ${arc} | ${windup} | ${recov} | ${cd} | ${dmg} | ${ttk} | ${dps}`);
}
console.log('');
console.log(`  * Hitstop cancel buffer (SF2 insight): ${report.combat.cancelWindow.chainReproducible ? 'PASS (100% reproducible across 100 trials)' : 'FAIL'}`);
console.log(`  * Dash invulnerability (i-frames):     ${report.combat.iframes.isInvulnerableDuringDash && report.combat.iframes.expiresCleanly ? `PASS (${report.combat.iframes.iframeWindowMs}ms active, clean expiry)` : 'FAIL'}`);
console.log(`  * Multi-hit SDI escape:                ${report.combat.sdi.escapedMultiHit ? `PASS (nudge: ${report.combat.sdi.sdiNudgePerInput}u, displacement: ${report.combat.sdi.displacementUnits}u)` : 'FAIL'}\n`);

console.log('--- 3. WORLD DENSITY & FIRST ENEMY CONTACT ---');
for (const fe of report.world.firstEnemy) {
  console.log(`  * ${fe.anchorName} (${fe.anchorX}, ${fe.anchorY}):`);
  console.log(`    Nearest mob:  ${fe.nearestMobName} at (${fe.nearestMobX}, ${fe.nearestMobY})`);
  console.log(`    Distance:     ${fe.distanceUnits.toFixed(1)} units`);
  console.log(`    Walk to reach:${fe.travelTimeToMeleeSec.toFixed(2)} seconds at 8 u/s`);
}
console.log('\n  Mobs in Sight:');
console.log('  Location             | In 12u (Interact) | In 15u (Viewport) | In 40u (Interest)');
console.log('  ---------------------+-------------------+-------------------+------------------');
for (const mis of report.world.mobsInSight) {
  const loc = mis.locationName.padEnd(20);
  const c12 = String(mis.inInteractionRadius12u).padStart(17);
  const c15 = String(mis.inViewportRadius15u).padStart(17);
  const c40 = String(mis.inInterestRadius40u).padStart(17);
  console.log(`  ${loc} | ${c12} | ${c15} | ${c40}`);
}
console.log('');

console.log('--- 4. CLIENT / SERVER RECONCILIATION PARITY ---');
console.log(`  * Simulated steps:    ${report.parity.stepsSimulated} ticks (stop-and-go sequence)`);
console.log(`  * Max position error: ${report.parity.maxPosErrorUnits.toFixed(6)} units`);
console.log(`  * Max velocity error: ${report.parity.maxVelErrorUnits.toFixed(6)} units`);
console.log(`  * Parity status:      ${report.parity.inParity ? 'PASS (100% lockstep parity)' : 'FAIL'}\n`);

console.log('--- 5. WEAPON-AWARE AI (The Hotline Miami Insight) ---');
console.log(`  * Ranged marksman (${report.aiBehaviors.ranged.weaponId}):`);
console.log(`    Pocket range:  [${report.aiBehaviors.ranged.preferredRangeMin}u, ${report.aiBehaviors.ranged.preferredRangeMax}u] (${report.aiBehaviors.ranged.holdsDistanceInPocket ? 'holds distance in pocket' : 'out of pocket'})`);
console.log(`    Crowded:       ${report.aiBehaviors.ranged.repositionsAwayWhenCrowded ? `PASS (back-pedals ${report.aiBehaviors.ranged.retreatDistanceDelta}u away)` : 'FAIL'}`);
console.log(`  * Melee vanguard (${report.aiBehaviors.melee.weaponId}):`);
console.log(`    Charge speed:  ${report.aiBehaviors.melee.chargeSpeedUnitsPerSec} u/s (${report.aiBehaviors.melee.chargesAtSpeed ? 'PASS' : 'FAIL'})`);
console.log(`    Strikes reach: ${report.aiBehaviors.melee.attackReach}u (${report.aiBehaviors.melee.strikesAtReach ? 'PASS' : 'FAIL'})`);
console.log(`  * Unarmed brawler (${report.aiBehaviors.unarmed.weaponId}):`);
console.log(`    Flee threshold:${report.aiBehaviors.unarmed.fleeThresholdHpPct}% HP`);
console.log(`    Panic flee:    ${report.aiBehaviors.unarmed.fleesAtLowHp ? `PASS (${report.aiBehaviors.unarmed.fleeSpeedUnitsPerSec} u/s escape)` : 'FAIL'}`);
console.log(`  * Spectator diff: ${report.aiBehaviors.spectatorDifferential.mobsBehaveVisiblyDifferently ? `PASS (melee: +${report.aiBehaviors.spectatorDifferential.meleeDelta}u/step, ranged: ${report.aiBehaviors.spectatorDifferential.rangedDelta}u/step)` : 'FAIL'}\n`);

console.log('================================================================================');
console.log('                           ACCEPTANCE CRITERIA STATUS                           ');
console.log('================================================================================');
const ac = report.acceptanceCriteria;
console.log(`  [${ac.zeroToFullAround80ms ? 'PASS' : 'FAIL'}] Ground accel: 0 -> full speed is ~80ms (${report.movement.accel.timeToFullSpeedMs.toFixed(1)}ms)`);
console.log(`  [${ac.frictionAround28PctOfAccel ? 'PASS' : 'FAIL'}] Friction ratio: ~28% of accel (39.2 / 140 = 28.0%)`);
console.log(`  [${ac.accelCurveSmooth ? 'PASS' : 'FAIL'}] Acceleration curve: smooth & monotonic`);
console.log(`  [${ac.stopDistanceNonZero ? 'PASS' : 'FAIL'}] Stop distance: non-zero (${report.movement.stop.stopDistanceUnits.toFixed(3)} units)`);
console.log(`  [${ac.knockbackAround1Point8u ? 'PASS' : 'FAIL'}] Knockback impulse: ~1.8 units (${report.movement.knockback.hitTakenDistanceUnits.toFixed(3)} units)`);
console.log(`  [${ac.clientServerAgreement ? 'PASS' : 'FAIL'}] Client/Server agreement: 0 desync on stop-and-go`);
console.log(`  [${ac.everyWeaponHasDistinctReachAndTiming ? 'PASS' : 'FAIL'}] Distinct weapons: every weapon has unique reach/timing`);
console.log(`  [${ac.cancellingDuringHitstopIsReliablyReproducible ? 'PASS' : 'FAIL'}] Hitstop cancel: 100% reproducible queuing & resolution`);
console.log(`  [${ac.dashIFramesActiveAndExpires ? 'PASS' : 'FAIL'}] Dash i-frames: invulnerability active and cleanly expires`);
console.log(`  [${ac.sdiMultiHitEscapeAppliesNudge ? 'PASS' : 'FAIL'}] SDI multi-hit escape: directional input nudges body out of trap`);
console.log(`  [${ac.rangedHoldsDistanceAndRepositions ? 'PASS' : 'FAIL'}] Ranged AI: holds distance in [5u,8u] and repositions when crowded`);
console.log(`  [${ac.meleeChargesAndStrikesAtReach ? 'PASS' : 'FAIL'}] Melee AI: charges at 6.8u/s and strikes within reach`);
console.log(`  [${ac.unarmedFleesAtLowHp ? 'PASS' : 'FAIL'}] Unarmed AI: flees at panic speed (6.2u/s) when HP <= 35%`);
console.log(`  [${ac.spectatorObservesWeaponDifferential ? 'PASS' : 'FAIL'}] Spectator: two mobs with different weapons behave visibly differently`);
console.log('================================================================================\n');

const allPassed = Object.values(ac).every(Boolean);
if (!allPassed) {
  console.error('CRITERIA FAILURE DETECTED');
  process.exit(1);
}
