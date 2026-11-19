// @aetherfall/gameplay — deterministic world events.
//
// A seeded schedule fires one world-tier event every N minutes at a landmark:
// a `shard-surge` boosts XP in its zone, a `roost-awakening` wakes a boss.
// Everything is a PURE function of (seed, slot index, clock), so the schedule
// is identical on every shard/restart and needs no stored state. Nothing here
// touches the live tick loop — `server/src/index.ts` owns that wiring (see
// README.md in this folder). The `WorldEventClock` class is just a thin,
// immutable adapter for the future call site.

import { mulberry32, type WorldEventKind, type WorldEventView } from '@aetherfall/shared';
import { BOSS_ANCHORS, DEFAULT_WORLD_SEED, getZone } from '@aetherfall/engine';
import { tierAt } from './world_tiers.js';

/** One event every five minutes of server tick time. */
export const WORLD_EVENT_INTERVAL_MS = 5 * 60_000;
/** A shard surge lasts three minutes; enough to finish a dungeon run. */
export const SHARD_SURGE_DURATION_MS = 3 * 60_000;
/** A roost stays awake for two minutes. */
export const ROOST_AWAKENING_DURATION_MS = 2 * 60_000;

/** Surge XP multipliers are stepped: 1.5, 1.75, 2.0 or 2.25. */
export const SHARD_SURGE_XP_MIN = 1.5;
export const SHARD_SURGE_XP_STEP = 0.25;
export const SHARD_SURGE_XP_STEPS = 4;

/** The 'roost-awakening' kind lands on every third slot (index % 3 === 2). */
export const ROOST_SLOT_MODULUS = 3;
export const ROOST_SLOT_REMAINDER = 2;

/**
 * Hand-placed landmarks for surges. Coordinates sit inside the 100x100 arena;
 * original names, mirroring the places named in docs/WORLD.md. `zone` and
 * `tier` are always derived from the engine, never hand-written here.
 */
export const EVENT_LANDMARKS: ReadonlyArray<Readonly<{ name: string; x: number; y: number }>> = Object.freeze([
  Object.freeze({ name: 'Brazen Porch', x: 24, y: 28 }),
  Object.freeze({ name: 'Flicker Kiosk Row', x: 38, y: 12 }),
  Object.freeze({ name: 'Sunken Arcade', x: 66, y: 44 }),
  Object.freeze({ name: 'Glass Meridian', x: 58, y: 74 }),
  Object.freeze({ name: 'Ashfall Exchange', x: 98, y: 98 }),
]);

function eventId(seed: number, index: number): string {
  return `wf-${(seed >>> 0).toString(36)}-${index.toString(36)}`;
}

/**
 * The event in one schedule slot. `index` is 0-based; the first event starts
 * one full interval after `startMs`, so a freshly booted shard has a quiet
 * first five minutes.
 *
 * Seeded without sequential state: slot N is derived from `mulberry32(seed ^
 * mix(N))`, so querying slot 50 directly gives the same result as building a
 * 51-entry schedule. That is what makes `activeEventAt` and `nextEventAfter`
 * constant-time instead of rebuilding the whole calendar.
 */
export function worldEventAt(
  seed: number,
  index: number,
  startMs = 0,
  intervalMs = WORLD_EVENT_INTERVAL_MS,
  worldSeed = DEFAULT_WORLD_SEED,
): WorldEventView {
  const idx = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : WORLD_EVENT_INTERVAL_MS;
  const base = Number.isFinite(startMs) ? startMs : 0;
  const rng = mulberry32(((seed >>> 0) ^ Math.imul(idx + 1, 0x9e3779b1)) >>> 0);

  const kind: WorldEventKind = idx % ROOST_SLOT_MODULUS === ROOST_SLOT_REMAINDER
    ? 'roost-awakening'
    : 'shard-surge';

  let x: number;
  let y: number;
  let landmark: string;
  let xpMult: number | undefined;
  let boss: string | undefined;

  if (kind === 'shard-surge') {
    const site = EVENT_LANDMARKS[Math.floor(rng() * EVENT_LANDMARKS.length)]!;
    x = site.x;
    y = site.y;
    landmark = site.name;
    const step = Math.floor(rng() * SHARD_SURGE_XP_STEPS);
    xpMult = Math.round((SHARD_SURGE_XP_MIN + step * SHARD_SURGE_XP_STEP) * 100) / 100;
  } else {
    const roost = BOSS_ANCHORS[Math.floor(rng() * BOSS_ANCHORS.length)]!;
    x = roost.x;
    y = roost.y;
    landmark = roost.name;
    boss = roost.name;
  }

  const startsAtMs = base + interval * (idx + 1);
  const endsAtMs = startsAtMs + (kind === 'shard-surge' ? SHARD_SURGE_DURATION_MS : ROOST_AWAKENING_DURATION_MS);
  return {
    id: eventId(seed, idx),
    index: idx,
    kind,
    zone: getZone(x, y, worldSeed),
    x,
    y,
    tier: tierAt(x, y, worldSeed),
    landmark,
    startsAtMs,
    endsAtMs,
    ...(xpMult === undefined ? {} : { xpMult }),
    ...(boss === undefined ? {} : { boss }),
  };
}

/** The first `count` events of a seeded schedule starting at `startMs`. */
export function worldEventSchedule(
  seed: number,
  startMs = 0,
  count = 12,
  intervalMs = WORLD_EVENT_INTERVAL_MS,
  worldSeed = DEFAULT_WORLD_SEED,
): WorldEventView[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const out: WorldEventView[] = [];
  for (let i = 0; i < n; i++) out.push(worldEventAt(seed, i, startMs, intervalMs, worldSeed));
  return out;
}

/** Events whose active window overlaps `[fromMs, toMs)`. */
export function eventsInWindow(
  seed: number,
  fromMs: number,
  toMs: number,
  intervalMs = WORLD_EVENT_INTERVAL_MS,
  worldSeed = DEFAULT_WORLD_SEED,
): WorldEventView[] {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : WORLD_EVENT_INTERVAL_MS;
  const a = Number.isFinite(fromMs) ? fromMs : 0;
  const b = Number.isFinite(toMs) ? toMs : a;
  if (b <= a) return [];
  // A surge is at most 3 min, so looking back one slot is always enough.
  const first = Math.max(0, Math.floor(a / interval) - 1);
  const last = Math.floor(b / interval);
  const out: WorldEventView[] = [];
  for (let i = first; i <= last; i++) {
    const e = worldEventAt(seed, i, 0, interval, worldSeed);
    if (e.startsAtMs < b && e.endsAtMs > a) out.push(e);
  }
  return out;
}

/** The event active at `nowMs`, or null during a quiet gap. */
export function activeEventAt(
  seed: number,
  nowMs: number,
  intervalMs = WORLD_EVENT_INTERVAL_MS,
  worldSeed = DEFAULT_WORLD_SEED,
): WorldEventView | null {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : WORLD_EVENT_INTERVAL_MS;
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const slot = Math.floor(now / interval);
  for (const i of [slot, slot - 1]) {
    if (i < 0) continue;
    const e = worldEventAt(seed, i, 0, interval, worldSeed);
    if (e.startsAtMs <= now && now < e.endsAtMs) return e;
  }
  return null;
}

/** The first event that starts strictly after `nowMs`. */
export function nextEventAfter(
  seed: number,
  nowMs: number,
  intervalMs = WORLD_EVENT_INTERVAL_MS,
  worldSeed = DEFAULT_WORLD_SEED,
): WorldEventView {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : WORLD_EVENT_INTERVAL_MS;
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  let slot = Math.max(0, Math.floor(now / interval));
  let event = worldEventAt(seed, slot, 0, interval, worldSeed);
  while (event.startsAtMs <= now) {
    slot += 1;
    event = worldEventAt(seed, slot, 0, interval, worldSeed);
  }
  return event;
}

/**
 * Immutable adapter over the pure functions. Construct once at boot; call
 * `activeAt(now)` from the tick loop. Holds no mutable cursor, so a lagged or
 * replayed tick can never skip an event.
 */
export class WorldEventClock {
  readonly seed: number;
  readonly intervalMs: number;
  readonly worldSeed: number;

  constructor(seed: number, intervalMs = WORLD_EVENT_INTERVAL_MS, worldSeed = DEFAULT_WORLD_SEED) {
    this.seed = seed;
    this.intervalMs = intervalMs;
    this.worldSeed = worldSeed;
  }

  at(index: number): WorldEventView {
    return worldEventAt(this.seed, index, 0, this.intervalMs, this.worldSeed);
  }

  schedule(count = 12): WorldEventView[] {
    return worldEventSchedule(this.seed, 0, count, this.intervalMs, this.worldSeed);
  }

  activeAt(nowMs: number): WorldEventView | null {
    return activeEventAt(this.seed, nowMs, this.intervalMs, this.worldSeed);
  }

  nextAfter(nowMs: number): WorldEventView {
    return nextEventAfter(this.seed, nowMs, this.intervalMs, this.worldSeed);
  }

  inWindow(fromMs: number, toMs: number): WorldEventView[] {
    return eventsInWindow(this.seed, fromMs, toMs, this.intervalMs, this.worldSeed);
  }
}
