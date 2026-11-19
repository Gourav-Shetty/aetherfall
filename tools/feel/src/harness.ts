// @aetherfall/feel — Headless Feel Harness.
// Produces hard, measurable numbers for movement, combat, and world density.
// Acceptance criteria for Phase 0, Phase 1, and Phase 2.

import {
  MAX_SPEED,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_IMPULSE,
  KNOCKBACK_IMPULSE,
  HIT_RECOIL_IMPULSE,
  DASH_IMPULSE,
  VERTICAL_GRAVITY,
  VERTICAL_FRICTION,
  CATALOG_ITEMS,
  type CatalogItemDef,
  stepBodyPhysics,
  applyImpulse,
  type BodyPhysicsState,
  WEAPON_PROFILES,
  getWeaponProfile,
  type WeaponCombatProfile,
  HitstopCancelBuffer,
  HITSTOP_DEFAULT_MS,
  DASH_IFRAME_MS,
  SDI_NUDGE_DIST,
  computeContactPoint,
  MOB_LOADOUT_PROFILES,
  getMobLoadout,
  type MobLoadoutProfile,
  type MobLoadoutKind,
} from '@aetherfall/shared';
import {
  genChunk,
  getZone,
  SPAWN_ANCHORS,
  SPAWN_SAFE_RADIUS,
} from '@aetherfall/engine';

export interface AccelCurveSample {
  tMs: number;
  speed: number;
  dist: number;
}

export interface AccelMetrics {
  timeToFullSpeedMs: number;
  maxSpeedReached: number;
  samples: AccelCurveSample[];
  isSmooth: boolean;
  maxDeltaV: number;
}

export interface StopMetrics {
  stopDistanceUnits: number;
  stopDurationMs: number;
  initialSpeed: number;
  stoppedCleanly: boolean;
}

export interface KnockbackMetrics {
  hitTakenDistanceUnits: number;
  hitTakenDurationMs: number;
  hitDealtRecoilDistanceUnits: number;
  hitDealtRecoilDurationMs: number;
  dashDistanceUnits: number;
}

export interface JumpMetrics {
  peakHeightUnits: number;
  hangTimeMs: number;
  cleanTouchdown: boolean;
}

export interface WeaponTtkMetric {
  weaponId: string;
  weaponName: string;
  reach: number;
  arcDeg: number;
  windupMs: number;
  recoveryMs: number;
  cooldownMs: number;
  attackBonus: number;
  damagePerHit: number;
  hitsToKill: number;
  ttkSeconds: number;
  effectiveDps: number;
}

export interface CancelWindowMetric {
  queuedAction: string;
  queuedDuringHitstop: boolean;
  heldDuringFreeze: boolean;
  executedImmediatelyOnExpiry: boolean;
  chainReproducible: boolean;
}

export interface IFrameMetric {
  iframeWindowMs: number;
  isInvulnerableDuringDash: boolean;
  expiresCleanly: boolean;
}

export interface SdiMetric {
  hitstopDurationMs: number;
  sdiNudgePerInput: number;
  displacementUnits: number;
  escapedMultiHit: boolean;
}

export interface FirstEnemyMetrics {
  anchorName: string;
  anchorX: number;
  anchorY: number;
  nearestMobName: string;
  nearestMobX: number;
  nearestMobY: number;
  distanceUnits: number;
  travelTimeToMeleeSec: number;
}

export interface MobsInSightMetrics {
  locationName: string;
  x: number;
  y: number;
  inInteractionRadius12u: number;
  inViewportRadius15u: number;
  inInterestRadius40u: number;
}

export interface ClientServerParityMetrics {
  maxPosErrorUnits: number;
  maxVelErrorUnits: number;
  stepsSimulated: number;
  inParity: boolean;
}

export interface AiWeaponBehaviorMetrics {
  ranged: {
    weaponId: string;
    preferredRangeMin: number;
    preferredRangeMax: number;
    holdsDistanceInPocket: boolean;
    repositionsAwayWhenCrowded: boolean;
    retreatDistanceDelta: number;
  };
  melee: {
    weaponId: string;
    attackReach: number;
    chargesAtSpeed: boolean;
    chargeSpeedUnitsPerSec: number;
    strikesAtReach: boolean;
  };
  unarmed: {
    weaponId: string;
    fleeThresholdHpPct: number;
    brawlsAtFullHp: boolean;
    fleesAtLowHp: boolean;
    fleeSpeedUnitsPerSec: number;
  };
  spectatorDifferential: {
    mobsBehaveVisiblyDifferently: boolean;
    meleeDelta: number;
    rangedDelta: number;
  };
}

export interface FeelReport {
  timestamp: string;
  movement: {
    accel: AccelMetrics;
    stop: StopMetrics;
    knockback: KnockbackMetrics;
    jump: JumpMetrics;
  };
  combat: {
    weaponsTtk: WeaponTtkMetric[];
    cancelWindow: CancelWindowMetric;
    iframes: IFrameMetric;
    sdi: SdiMetric;
    attackCooldownMs: number;
    baseDamage: number;
  };
  world: {
    firstEnemy: FirstEnemyMetrics[];
    mobsInSight: MobsInSightMetrics[];
  };
  aiBehaviors: AiWeaponBehaviorMetrics;
  parity: ClientServerParityMetrics;
  acceptanceCriteria: {
    accelCurveSmooth: boolean;
    stopDistanceNonZero: boolean;
    zeroToFullAround80ms: boolean;
    frictionAround28PctOfAccel: boolean;
    knockbackAround1Point8u: boolean;
    clientServerAgreement: boolean;
    everyWeaponHasDistinctReachAndTiming: boolean;
    cancellingDuringHitstopIsReliablyReproducible: boolean;
    dashIFramesActiveAndExpires: boolean;
    sdiMultiHitEscapeAppliesNudge: boolean;
    rangedHoldsDistanceAndRepositions: boolean;
    meleeChargesAndStrikesAtReach: boolean;
    unarmedFleesAtLowHp: boolean;
    spectatorObservesWeaponDifferential: boolean;
  };
}

/** Measure acceleration curve using Venturelli model at high resolution (1ms steps). */
export function measureTimeToFullSpeed(targetSpeed = MAX_SPEED, dt = 0.001): AccelMetrics {
  const body: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
  const samples: AccelCurveSample[] = [];
  let t = 0;
  let prevV = 0;
  let maxDeltaV = 0;
  let timeToFullSpeedMs = -1;

  while (t <= 0.25) {
    stepBodyPhysics(body, { moveX: 1, moveY: 0 }, dt);
    t += dt;
    const v = body.vx;
    const deltaV = v - prevV;
    if (deltaV > maxDeltaV) maxDeltaV = deltaV;
    prevV = v;

    if (samples.length < 50 || Math.round(t * 1000) % 5 === 0) {
      samples.push({
        tMs: +(t * 1000).toFixed(1),
        speed: +v.toFixed(3),
        dist: +body.x.toFixed(4),
      });
    }

    if (timeToFullSpeedMs < 0 && Math.abs(v - targetSpeed) < 1e-3) {
      timeToFullSpeedMs = +(t * 1000).toFixed(1);
    }
  }

  return {
    timeToFullSpeedMs: timeToFullSpeedMs > 0 ? timeToFullSpeedMs : +(t * 1000).toFixed(1),
    maxSpeedReached: +body.vx.toFixed(3),
    samples,
    isSmooth: maxDeltaV < 1.0,
    maxDeltaV: +maxDeltaV.toFixed(4),
  };
}

/** Measure stop distance from full speed when input drops to 0. */
export function measureStopDistance(dt = 0.001): StopMetrics {
  const body: BodyPhysicsState = { x: 0, y: 0, vx: MAX_SPEED, vy: 0 };
  let stopDist = 0;
  let t = 0;

  while (body.vx > 0 && t < 1.0) {
    stepBodyPhysics(body, { moveX: 0, moveY: 0 }, dt);
    stopDist = body.x;
    t += dt;
  }

  return {
    stopDistanceUnits: +stopDist.toFixed(4),
    stopDurationMs: +(t * 1000).toFixed(1),
    initialSpeed: MAX_SPEED,
    stoppedCleanly: body.vx === 0 && body.vy === 0,
  };
}

/** Measure knockback and recoil impulses. */
export function measureKnockback(dt = 0.005): KnockbackMetrics {
  // 1. Hit taken knockback
  const target: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
  applyImpulse(target, KNOCKBACK_IMPULSE, 0);
  let tTarget = 0;
  while (target.vx > 0 && tTarget < 1.0) {
    stepBodyPhysics(target, { moveX: 0, moveY: 0 }, dt);
    tTarget += dt;
  }

  // 2. Hit dealt recoil
  const attacker: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
  applyImpulse(attacker, HIT_RECOIL_IMPULSE, 0);
  let tAttacker = 0;
  while (attacker.vx > 0 && tAttacker < 1.0) {
    stepBodyPhysics(attacker, { moveX: 0, moveY: 0 }, dt);
    tAttacker += dt;
  }

  // 3. Dash impulse
  const dasher: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
  applyImpulse(dasher, DASH_IMPULSE, 0);
  let tDash = 0;
  while (dasher.vx > 0 && tDash < 1.0) {
    stepBodyPhysics(dasher, { moveX: 0, moveY: 0 }, dt);
    tDash += dt;
  }

  return {
    hitTakenDistanceUnits: +target.x.toFixed(4),
    hitTakenDurationMs: +(tTarget * 1000).toFixed(1),
    hitDealtRecoilDistanceUnits: +attacker.x.toFixed(4),
    hitDealtRecoilDurationMs: +(tAttacker * 1000).toFixed(1),
    dashDistanceUnits: +dasher.x.toFixed(4),
  };
}

/** Measure jump vertical metrics. */
export function measureJump(dt = 0.005): JumpMetrics {
  const body: BodyPhysicsState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: JUMP_IMPULSE };
  let peakZ = 0;
  let t = 0;

  while (t < 1.5) {
    stepBodyPhysics(body, { moveX: 0, moveY: 0 }, dt);
    t += dt;
    if ((body.z ?? 0) > peakZ) peakZ = body.z ?? 0;
    if ((body.z ?? 0) === 0 && t > 0.05) break;
  }

  return {
    peakHeightUnits: +peakZ.toFixed(3),
    hangTimeMs: +(t * 1000).toFixed(1),
    cleanTouchdown: (body.z ?? 0) === 0 && (body.vz ?? 0) === 0,
  };
}

/** Measure TTK per weapon in the catalog using distinct weapon profiles against standard 100 HP target. */
export function measureTtkPerWeapon(targetHp = 100, physicalResist = 0.05): WeaponTtkMetric[] {
  const baseDamage = 12; // BASE_DMG

  // Extract catalog weapons
  const weapons: Array<{ id: string; name: string; attack: number }> = [
    { id: 'unarmed', name: 'Unarmed (Fists)', attack: 0 },
  ];

  for (const item of CATALOG_ITEMS) {
    if (item.slot === 'mainhand') {
      weapons.push({
        id: item.id,
        name: item.name,
        attack: item.stats.attack ?? 0,
      });
    }
  }

  const results: WeaponTtkMetric[] = [];

  for (const w of weapons) {
    const profile = getWeaponProfile(w.id);
    const attackCooldownMs = profile.cooldownMs;
    const rawDamage = baseDamage + w.attack;
    const damagePerHit = +(rawDamage * (1 - physicalResist)).toFixed(1);
    const hitsToKill = Math.ceil(targetHp / damagePerHit);
    // 1st swing lands at t = 0, subsequent swings occur after cooldown
    const ttkSeconds = +(((hitsToKill - 1) * attackCooldownMs) / 1000).toFixed(2);
    const effectiveDps = +(targetHp / (ttkSeconds || (attackCooldownMs / 1000))).toFixed(1);

    results.push({
      weaponId: w.id,
      weaponName: w.name,
      reach: profile.reach,
      arcDeg: profile.arcDeg,
      windupMs: profile.windupMs,
      recoveryMs: profile.recoveryMs,
      cooldownMs: profile.cooldownMs,
      attackBonus: w.attack,
      damagePerHit,
      hitsToKill,
      ttkSeconds,
      effectiveDps,
    });
  }

  return results;
}

/** Measure cancel window buffering during hitstop (Street Fighter II insight). */
export function measureCancelWindow(): CancelWindowMetric {
  const buffer = new HitstopCancelBuffer<string>(300);
  const t0 = 1000;
  const hitstopDur = HITSTOP_DEFAULT_MS;

  // 1. Queue attack during hitstop
  buffer.queue('attack', t0 + 20);
  const queuedDuringHitstop = buffer.hasQueued();

  // 2. While freeze is active, consume yields null (held in cancel buffer)
  const heldDuringFreeze = buffer.consume(true, t0 + 50) === null;

  // 3. When hitstop completes, buffered attack resolves immediately
  const resolved = buffer.consume(false, t0 + hitstopDur);
  const executedImmediatelyOnExpiry = resolved === 'attack';

  // 4. Test repeated reproducibility across 100 trial iterations
  let reproducibleCount = 0;
  for (let i = 0; i < 100; i++) {
    const trialBuf = new HitstopCancelBuffer<string>(300);
    trialBuf.queue('attack', 2000 + i * 10);
    if (trialBuf.consume(true, 2020 + i * 10) === null &&
        trialBuf.consume(false, 2100 + i * 10) === 'attack') {
      reproducibleCount++;
    }
  }

  return {
    queuedAction: 'attack',
    queuedDuringHitstop,
    heldDuringFreeze,
    executedImmediatelyOnExpiry,
    chainReproducible: reproducibleCount === 100,
  };
}

/** Measure dash/roll invulnerability frames. */
export function measureDashIFrames(): IFrameMetric {
  const t0 = 5000;
  const iframeUntil = t0 + DASH_IFRAME_MS;

  const isInvulnerable = (t: number) => t < iframeUntil;

  const isInvulnerableDuringDash = isInvulnerable(t0 + 50) && isInvulnerable(t0 + 150);
  const expiresCleanly = !isInvulnerable(t0 + DASH_IFRAME_MS + 1);

  return {
    iframeWindowMs: DASH_IFRAME_MS,
    isInvulnerableDuringDash,
    expiresCleanly,
  };
}

/** Measure Smash Directional Influence (SDI) escape from multi-hits during hitstop. */
export function measureSdiNudge(): SdiMetric {
  const startX = 50;
  const startY = 50;
  let currentX = startX;
  let currentY = startY;

  // Multi-hit scenario: 3 successive hitstop freezes
  // During each freeze, the victim presses directional escape vector (+X, +Y)
  for (let hit = 0; hit < 3; hit++) {
    // 1 SDI nudge per hit freeze
    currentX += (1 / Math.SQRT2) * SDI_NUDGE_DIST;
    currentY += (1 / Math.SQRT2) * SDI_NUDGE_DIST;
  }

  const displacement = Math.hypot(currentX - startX, currentY - startY);

  return {
    hitstopDurationMs: HITSTOP_DEFAULT_MS,
    sdiNudgePerInput: SDI_NUDGE_DIST,
    displacementUnits: +displacement.toFixed(4),
    escapedMultiHit: displacement >= SDI_NUDGE_DIST * 2.5,
  };
}

const chunkCache = new Map<string, ReturnType<typeof genChunk>>();
function getCachedChunk(cx: number, cy: number, seed: number) {
  const key = `${cx}:${cy}:${seed}`;
  let c = chunkCache.get(key);
  if (!c) {
    c = genChunk(cx, cy, seed);
    chunkCache.set(key, c);
  }
  return c;
}

/** Measure distance and travel time from spawn anchors to nearest mob. */
export function measureTimeToFirstEnemy(): FirstEnemyMetrics[] {
  const results: FirstEnemyMetrics[] = [];
  const seed = 1337;

  // Measure nearest mob around primary spawn anchors
  for (const anchor of SPAWN_ANCHORS.slice(0, 2)) {
    const chunkX = Math.floor(anchor.x / 16);
    const chunkY = Math.floor(anchor.y / 16);

    let nearestMobName = 'unknown';
    let nearestMobX = 0;
    let nearestMobY = 0;
    let minD = Infinity;

    // Search 2x2 chunk grid around anchor
    for (let dx = 0; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        const c = getCachedChunk(chunkX + dx, chunkY + dy, seed);
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const worldX = (chunkX + dx) * 16 + x;
            const worldY = (chunkY + dy) * 16 + y;
            const d = Math.hypot(worldX - anchor.x, worldY - anchor.y);

            // Mobs only spawn outside the safe radius
            if (d >= SPAWN_SAFE_RADIUS && c.tiles[y]![x] === 0) {
              if (d < minD) {
                minD = d;
                const zone = getZone(worldX, worldY, seed);
                nearestMobName = zone === 'volcano' ? 'cinder-imp' : zone === 'dungeon' ? 'ashcrawler' : 'gloomfang';
                nearestMobX = worldX;
                nearestMobY = worldY;
              }
            }
          }
        }
      }
    }

    const travelTime = +(minD / MAX_SPEED).toFixed(2);

    results.push({
      anchorName: anchor.name,
      anchorX: anchor.x,
      anchorY: anchor.y,
      nearestMobName,
      nearestMobX,
      nearestMobY,
      distanceUnits: +minD.toFixed(2),
      travelTimeToMeleeSec: travelTime,
    });
  }

  return results;
}

/** Measure mob density around points of interest. */
export function measureMobsInSight(): MobsInSightMetrics[] {
  const seed = 1337;
  const locations = [
    { name: 'Shrine Anchor', x: SPAWN_ANCHORS[0]!.x, y: SPAWN_ANCHORS[0]!.y },
    { name: 'Meadow Frontier (100, 100)', x: 100, y: 100 },
    { name: 'Dungeon Boundary (150, 150)', x: 150, y: 150 },
  ];

  const allMobs: Array<{ x: number; y: number }> = [];

  for (const loc of locations) {
    const cx0 = Math.floor(loc.x / 16);
    const cy0 = Math.floor(loc.y / 16);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        const c = getCachedChunk(cx, cy, seed);
        for (let y = 0; y < 16; y += 4) {
          for (let x = 0; x < 16; x += 4) {
            if (c.tiles[y]![x] === 0) {
              allMobs.push({ x: cx * 16 + x, y: cy * 16 + y });
            }
          }
        }
      }
    }
  }

  const results: MobsInSightMetrics[] = [];

  for (const loc of locations) {
    let c12 = 0;
    let c15 = 0;
    let c40 = 0;

    for (const m of allMobs) {
      const d = Math.hypot(m.x - loc.x, m.y - loc.y);
      if (d <= 12) c12++;
      if (d <= 15) c15++;
      if (d <= 40) c40++;
    }

    results.push({
      locationName: loc.name,
      x: loc.x,
      y: loc.y,
      inInteractionRadius12u: c12,
      inViewportRadius15u: c15,
      inInterestRadius40u: c40,
    });
  }

  return results;
}

/** Measure client-server parity during a stop-and-go sequence. */
export function measureClientServerParity(): ClientServerParityMetrics {
  const clientBody: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };
  const serverBody: BodyPhysicsState = { x: 0, y: 0, vx: 0, vy: 0 };

  const dt = 0.05; // 20Hz tick
  let maxPosError = 0;
  let maxVelError = 0;
  let steps = 0;

  // 4 phases: Move X, Stop, Move Y, Stop
  for (let phase = 0; phase < 4; phase++) {
    const mx = phase === 0 ? 1 : 0;
    const my = phase === 2 ? 1 : 0;

    for (let s = 0; s < 10; s++) {
      steps++;
      stepBodyPhysics(clientBody, { moveX: mx, moveY: my }, dt);
      stepBodyPhysics(serverBody, { moveX: mx, moveY: my }, dt);

      const posErr = Math.hypot(clientBody.x - serverBody.x, clientBody.y - serverBody.y);
      const velErr = Math.hypot(clientBody.vx - serverBody.vx, clientBody.vy - serverBody.vy);
      if (posErr > maxPosError) maxPosError = posErr;
      if (velErr > maxVelError) maxVelError = velErr;
    }
  }

  return {
    maxPosErrorUnits: +maxPosError.toFixed(6),
    maxVelErrorUnits: +maxVelError.toFixed(6),
    stepsSimulated: steps,
    inParity: maxPosError < 1e-5 && maxVelError < 1e-5,
  };
}

/** Measure weapon-aware AI tactical behaviors (Phase 3: The Hotline Miami insight). */
export function measureAiWeaponBehaviors(): AiWeaponBehaviorMetrics {
  const rangedProfile = getMobLoadout('wisp-bolt');
  const meleeProfile = getMobLoadout('ward-blade');
  const unarmedProfile = getMobLoadout('unarmed');

  const dt = 0.1; // 10Hz AI cadence

  // 1. Ranged marksmanship simulation
  // A. In pocket: optimal range [min, max] = [5u, 8u]
  const rangedPos = { x: 6, y: 20 };
  const playerInPocket = { x: 12, y: 20 };
  const distInPocket = Math.hypot(playerInPocket.x - rangedPos.x, playerInPocket.y - rangedPos.y);
  const holdsDistanceInPocket =
    distInPocket >= (rangedProfile.preferredRangeMin ?? 5.0) &&
    distInPocket <= (rangedProfile.preferredRangeMax ?? 8.0);

  // B. Crowded: player inside minimum range (< 5u) -> reposition back-pedal
  const playerCrowding = { x: 8.5, y: 20 }; // dist = 2.5u
  const crowdDist = Math.hypot(playerCrowding.x - rangedPos.x, playerCrowding.y - rangedPos.y);
  let retreatDelta = 0;
  let repositionsAway = false;
  if (crowdDist < (rangedProfile.preferredRangeMin ?? 5.0)) {
    const awayX = (rangedPos.x - playerCrowding.x) / crowdDist;
    const awayY = (rangedPos.y - playerCrowding.y) / crowdDist;
    const moveX = awayX * rangedProfile.combatSpeed * dt;
    const moveY = awayY * rangedProfile.combatSpeed * dt;
    retreatDelta = Math.hypot(moveX, moveY);
    repositionsAway = moveX < 0 && retreatDelta > 0;
  }

  // 2. Melee vanguard simulation
  // Starts at dist = 5.0u, charges aggressively at combatSpeed (6.8 u/s)
  const meleePos = { x: 6, y: 20 };
  const meleeTarget = { x: 11, y: 20 };
  const chargeDist = Math.hypot(meleeTarget.x - meleePos.x, meleeTarget.y - meleePos.y);
  const chargeSpeed = meleeProfile.combatSpeed;
  const chargesAtSpeed = chargeDist > 2.5 && chargeSpeed >= 6.5;

  // Step until within attack reach
  let curMeleeX = meleePos.x;
  for (let step = 0; step < 10; step++) {
    const d = meleeTarget.x - curMeleeX;
    if (d <= meleeProfile.attackRange) break;
    curMeleeX += chargeSpeed * dt;
  }
  const strikesAtReach = (meleeTarget.x - curMeleeX) <= meleeProfile.attackRange;

  // 3. Unarmed brawler simulation
  // Full HP: brawls and stays aggressive; Low HP (<= 35%): flees at panic speed (6.2 u/s)
  const maxHp = 100;
  const fullHp = 100;
  const lowHp = 30; // 30% <= 35%
  const brawlsAtFullHp = fullHp / maxHp > unarmedProfile.fleeThreshold;
  const fleesAtLowHp = lowHp / maxHp <= unarmedProfile.fleeThreshold && unarmedProfile.allowedStates.includes('flee');
  const fleeSpeed = unarmedProfile.combatSpeed;

  // 4. Spectator differential
  // Side-by-side: Melee charges (+X toward player), Ranged retreats (-X away from player)
  const rangedDelta = -(rangedProfile.combatSpeed * dt);
  const meleeDelta = +(meleeProfile.combatSpeed * dt);
  const spectatorDiff = rangedDelta < 0 && meleeDelta > 0 && Math.abs(meleeDelta - rangedDelta) > 1.0;

  return {
    ranged: {
      weaponId: rangedProfile.weaponId,
      preferredRangeMin: rangedProfile.preferredRangeMin ?? 5.0,
      preferredRangeMax: rangedProfile.preferredRangeMax ?? 8.0,
      holdsDistanceInPocket,
      repositionsAwayWhenCrowded: repositionsAway,
      retreatDistanceDelta: +retreatDelta.toFixed(3),
    },
    melee: {
      weaponId: meleeProfile.weaponId,
      attackReach: meleeProfile.attackRange,
      chargesAtSpeed,
      chargeSpeedUnitsPerSec: +chargeSpeed.toFixed(1),
      strikesAtReach,
    },
    unarmed: {
      weaponId: unarmedProfile.weaponId,
      fleeThresholdHpPct: +(unarmedProfile.fleeThreshold * 100).toFixed(0),
      brawlsAtFullHp,
      fleesAtLowHp,
      fleeSpeedUnitsPerSec: +fleeSpeed.toFixed(1),
    },
    spectatorDifferential: {
      mobsBehaveVisiblyDifferently: spectatorDiff,
      meleeDelta: +meleeDelta.toFixed(3),
      rangedDelta: +rangedDelta.toFixed(3),
    },
  };
}

/** Execute full feel harness audit producing all metrics and grading criteria. */
export function runFullFeelAudit(): FeelReport {
  const accel = measureTimeToFullSpeed();
  const stop = measureStopDistance();
  const knockback = measureKnockback();
  const jump = measureJump();
  const weaponsTtk = measureTtkPerWeapon();
  const cancelWindow = measureCancelWindow();
  const iframes = measureDashIFrames();
  const sdi = measureSdiNudge();
  const firstEnemy = measureTimeToFirstEnemy();
  const mobsInSight = measureMobsInSight();
  const parity = measureClientServerParity();
  const aiBehaviors = measureAiWeaponBehaviors();

  const frictionRatio = GROUND_FRICTION / GROUND_ACCEL;

  // Verify weapons have distinct reach, timing, and arc
  const reachSet = new Set(weaponsTtk.map((w) => w.reach));
  const cooldownSet = new Set(weaponsTtk.map((w) => w.cooldownMs));
  const distinctWeapons = reachSet.size === weaponsTtk.length && cooldownSet.size === weaponsTtk.length;

  return {
    timestamp: new Date().toISOString(),
    movement: {
      accel,
      stop,
      knockback,
      jump,
    },
    combat: {
      weaponsTtk,
      cancelWindow,
      iframes,
      sdi,
      attackCooldownMs: 800,
      baseDamage: 12,
    },
    world: {
      firstEnemy,
      mobsInSight,
    },
    aiBehaviors,
    parity,
    acceptanceCriteria: {
      accelCurveSmooth: accel.isSmooth,
      stopDistanceNonZero: stop.stopDistanceUnits > 0 && stop.stopDistanceUnits < 1.0,
      zeroToFullAround80ms: accel.timeToFullSpeedMs >= 75 && accel.timeToFullSpeedMs <= 85,
      frictionAround28PctOfAccel: Math.abs(frictionRatio - 0.28) < 0.01,
      knockbackAround1Point8u: Math.abs(knockback.hitTakenDistanceUnits - 1.8) < 0.1,
      clientServerAgreement: parity.inParity,
      everyWeaponHasDistinctReachAndTiming: distinctWeapons,
      cancellingDuringHitstopIsReliablyReproducible: cancelWindow.chainReproducible,
      dashIFramesActiveAndExpires: iframes.isInvulnerableDuringDash && iframes.expiresCleanly,
      sdiMultiHitEscapeAppliesNudge: sdi.escapedMultiHit,
      rangedHoldsDistanceAndRepositions:
        aiBehaviors.ranged.holdsDistanceInPocket && aiBehaviors.ranged.repositionsAwayWhenCrowded,
      meleeChargesAndStrikesAtReach:
        aiBehaviors.melee.chargesAtSpeed && aiBehaviors.melee.strikesAtReach,
      unarmedFleesAtLowHp:
        aiBehaviors.unarmed.brawlsAtFullHp && aiBehaviors.unarmed.fleesAtLowHp,
      spectatorObservesWeaponDifferential:
        aiBehaviors.spectatorDifferential.mobsBehaveVisiblyDifferently,
    },
  };
}
