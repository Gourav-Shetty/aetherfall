// Hazard-aware steering for the headless bot swarm (terrain hazards).
//
// The bots are honest clients: they send unit-circle input at `inputHz` and the
// server clamps + rejects anything else. Water and lava are now solid on the
// server, so a bot that keeps walking its waypoint into the lake now burns 5-22
// hp/s and gets washed ashore — technically correct, but useless load: it
// spends its whole run drowning instead of exercising combat and movement.
//
// So the steering gets a repulsion term: probe `hazardAt()` on a small cross in
// front of the bot and blend an "away from the hazard" vector into the
// waypoint direction, weighted by dps. Everything here is a pure function of
// (x, y, seed) — no state, no timers — so it is unit tested without a server.

import { hazardAt, type HazardType } from '@aetherfall/engine';

/** Distance (world units) of the near probe ring. */
export const HAZARD_PROBE_NEAR = 5;
/** Distance of the far probe ring (gives a body of water a real edge). */
export const HAZARD_PROBE_FAR = 11;
/** How much a full-strength hazard (lava, 22 dps) bends the heading. */
export const HAZARD_AVOID_GAIN = 2.2;
/** Waypoints are rejected if they land inside this dps. */
export const HAZARD_WAYPOINT_DPS = 0.01;

export interface HazardAvoid {
  /** Unit push away from the strongest hazard (-1,1)x(-1,1). */
  x: number;
  y: number;
  /** Hazard type that produced the strongest response. */
  hazard: HazardType;
  /** Worst dps seen across all probes (0 = clear ground). */
  threat: number;
  /** threat / LAVA_DPS, clamped to 1 — the blend weight. */
  weight: number;
}

/** Probe directions (cardinals + diagonals), fixed order for determinism. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0.7071067811865476, 0.7071067811865476],
  [0, 1],
  [-0.7071067811865476, 0.7071067811865476],
  [-1, 0],
  [-0.7071067811865476, -0.7071067811865476],
  [0, -1],
  [0.7071067811865476, -0.7071067811865476],
];

/** dps that reads as "maximum hazard" (LAVA_DPS in the engine field). */
const MAX_DPS = 22;

/**
 * Repulsion away from the nearest hazard around (x, y).
 *
 * Each probe contributes `-dir * weight` where `weight` rises with the dps at
 * that probe and with distance (a far ring nudges harder because there is more
 * time to turn). The result is normalized so it can be blended into any
 * heading, and `threat`/`weight` let the caller scale the correction.
 */
export function hazardAvoid(
  x: number,
  y: number,
  seed: number,
  near = HAZARD_PROBE_NEAR,
  far = HAZARD_PROBE_FAR,
): HazardAvoid {
  let rx = 0;
  let ry = 0;
  let threat = 0;
  let hazard: HazardType = 'none';
  for (let ring = 0; ring < 2; ring++) {
    const r = ring === 0 ? near : far;
    const gain = ring === 0 ? 1 : 1.6;
    for (let i = 0; i < DIRS.length; i++) {
      const [dx, dy] = DIRS[i]!;
      const hz = hazardAt(x + dx * r, y + dy * r, seed);
      if (hz.dps <= 0) continue;
      const w = (hz.dps / MAX_DPS) * gain;
      rx -= dx * w;
      ry -= dy * w;
      if (hz.dps > threat) {
        threat = hz.dps;
        hazard = hz.type;
      }
    }
  }
  const len = Math.hypot(rx, ry);
  if (len === 0) return { x: 0, y: 0, hazard: 'none', threat: 0, weight: 0 };
  return {
    x: rx / len,
    y: ry / len,
    hazard,
    threat,
    weight: Math.min(1, threat / MAX_DPS),
  };
}

/**
 * Blend hazard repulsion into a desired heading.
 *
 * The repulsion is added with a factor of `1 + gain * weight`, not
 * `gain * weight`. The `1` matters: a bot walking *straight at* a lake has a
 * heading exactly opposed to the push, so a factor below 1 would leave it
 * ploughing in (just slower). With the `1` the correction always wins, and
 * `gain * weight` is how much it overshoots — a bot facing a 22 dps lava flow
 * turns right around, one next to 5 dps shallows only leans away.
 *
 * Returns a unit vector (the protocol's honest-input contract). On clear
 * ground the input is returned untouched, so bots that never approach water
 * behave bit-identically to pre-terrain builds.
 */
export function steerAwayFromHazards(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  seed: number,
  gain = HAZARD_AVOID_GAIN,
): { x: number; y: number; avoid: HazardAvoid } {
  const avoid = hazardAvoid(x, y, seed);
  if (avoid.weight === 0) return { x: dirX, y: dirY, avoid };
  const k = 1 + gain * avoid.weight;
  let mx = dirX + avoid.x * k;
  let my = dirY + avoid.y * k;
  if (Math.hypot(mx, my) < 1e-6) {
    // Perfectly opposed at a tiny weight: fall back to the pure repulsion.
    return { x: avoid.x, y: avoid.y, avoid };
  }
  // Keep the unit-circle contract the server and the anticheat expect.
  const len = Math.hypot(mx, my);
  return { x: mx / len, y: my / len, avoid };
}

/**
 * Pick a roam waypoint inside the arena that is not in a hazard.
 * `roll()` is the caller's RNG so the sweep stays deterministic per bot;
 * at most `tries` rejections before the last candidate is accepted anyway
 * (an unlucky bot must still move).
 */
export function pickSafeWaypoint(
  roll: () => number,
  seed: number,
  arena = 100,
  tries = 4,
): { x: number; y: number } {
  let x = roll() * arena;
  let y = roll() * arena;
  for (let i = 0; i < tries; i++) {
    if (hazardAt(x, y, seed).dps <= HAZARD_WAYPOINT_DPS) break;
    x = roll() * arena;
    y = roll() * arena;
  }
  return { x, y };
}