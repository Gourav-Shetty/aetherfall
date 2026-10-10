// AETHERFALL story — Chapter "STATIC": 5 voicemail missions from UNKNOWN NUMBER.
//
// Original neon-noir chapter in AETHERFALL's own setting (the Fall, shards,
// Emberfall, Elder Maren). Structure only nods to the classics: cryptic calls
// -> missions -> parole interludes -> twist. All names, places and dialogue
// are original to AETHERFALL.
//
// Mission state lives in the existing quest-progress structures
// (`QuestState.progress`, `QuestEvent` from game/quests.ts): STATIC missions
// are keyed `static-*` in the same map the Maren chain uses, so no netcode,
// combat-number or persistence-schema change is needed — `quests_progress`
// already keys on free-form `quest_id` TEXT.

import { addXp, type QuestEvent, type QuestProgress, type QuestState } from '../game/quests.js';
import type { ZoneId } from '@aetherfall/engine';

export const STATIC_CHAPTER_ID = 'static';
export const STATIC_CHAPTER_TITLE = 'STATIC';

export type StaticMissionKind = 'kill' | 'collect' | 'explore';

export interface StaticMission {
  id: string;
  /** Voicemail slot: 1..5. */
  seq: number;
  name: string;
  kind: StaticMissionKind;
  goal: number;
  rewardXp: number;
  zone: ZoneId;
  /** Original AETHERFALL landmark for this mission. */
  landmark: string;
  /** What to do there (clear mobs / collect / reach point). */
  act: string;
  briefing: string;
  /** How to "return": what the booth tells the player to do next. */
  returnHint: string;
}

/**
 * The five STATIC missions. XP mirrors the Maren chain curve (40/60/90/120/200)
 * deliberately so no economy rebalance is needed.
 */
export const STATIC_MISSIONS: StaticMission[] = [
  {
    id: 'static-porchlight',
    seq: 1,
    name: 'Porchlight',
    kind: 'kill',
    goal: 4,
    rewardXp: 40,
    zone: 'meadow',
    landmark: 'Brazen Porch',
    act: 'Clear 4 shard-maddened mobs along the south-gate porches.',
    briefing: 'Go to the Brazen Porch at the meadow edge. Clear 4 mobs. Then pick up the next message.',
    returnHint: 'Return to any call-booth and lift the receiver for the next message.',
  },
  {
    id: 'static-kiosk',
    seq: 2,
    name: 'Kiosk Tithe',
    kind: 'collect',
    goal: 6,
    rewardXp: 60,
    zone: 'meadow',
    landmark: 'Flicker Kiosk Row',
    act: 'Collect 6 ember-shards from the dead booths.',
    briefing: 'Go to Flicker Kiosk Row. Gather 6 ember-shards. Then pick up the next message.',
    returnHint: 'Return to any call-booth and lift the receiver for the next message.',
  },
  {
    id: 'static-arcade',
    seq: 3,
    name: 'Arcade Sweep',
    kind: 'kill',
    goal: 6,
    rewardXp: 90,
    zone: 'dungeon',
    landmark: 'Sunken Arcade',
    act: 'Clear 6 delvers in the drowned market arcade.',
    briefing: 'Go to the Sunken Arcade in the Hollow Deep. Clear 6 delvers. Then pick up the next message.',
    returnHint: 'Return to any call-booth and lift the receiver for the next message.',
  },
  {
    id: 'static-meridian',
    seq: 4,
    name: 'Meridian Walk',
    kind: 'explore',
    goal: 4,
    rewardXp: 120,
    zone: 'dungeon',
    landmark: 'Glass Meridian',
    act: 'Reach 4 new survey points along the glass survey line.',
    briefing: 'Walk the Glass Meridian beyond the highlands. Reach 4 new points. Then pick up the next message.',
    returnHint: 'Return to any call-booth and lift the receiver for the final message.',
  },
  {
    id: 'static-exchange',
    seq: 5,
    name: 'Exchange Silence',
    kind: 'kill',
    goal: 8,
    rewardXp: 200,
    zone: 'volcano',
    landmark: 'Ashfall Exchange',
    act: 'Silence 8 caldera horrors inside the relay hall. The caller will meet you there.',
    briefing: 'Go to the Ashfall Exchange in the caldera. Silence 8 horrors. The caller answers in person.',
    returnHint: 'Stay on the line. She is already there.',
  },
];

/** Mission ids in play order. */
export const STATIC_MISSION_ORDER: string[] = STATIC_MISSIONS.map((m) => m.id);

export function staticMission(id: string): StaticMission | undefined {
  return STATIC_MISSIONS.find((m) => m.id === id);
}

export function staticMissionBySeq(seq: number): StaticMission | undefined {
  return STATIC_MISSIONS.find((m) => m.seq === seq);
}

/** True when the mission's predecessor (if any) is done. Mission 1 is open. */
export function isStaticUnlocked(missionId: string, isDone: (id: string) => boolean): boolean {
  const i = STATIC_MISSIONS.findIndex((m) => m.id === missionId);
  if (i < 0) return false;
  if (i === 0) return true;
  return isDone(STATIC_MISSIONS[i - 1]!.id);
}

/** Seed STATIC progress entries (idempotent; keeps all other entries intact). */
export function ensureStaticProgress(state: QuestState): void {
  for (const m of STATIC_MISSIONS) {
    if (!state.progress[m.id]) {
      state.progress[m.id] = { questId: m.id, count: 0, done: false, claimed: false };
    }
  }
}

function staticBump(state: QuestState, missionId: string, by: number): QuestEvent[] {
  const m = staticMission(missionId);
  if (!m || by <= 0) return [];
  ensureStaticProgress(state);
  const p: QuestProgress | undefined = state.progress[missionId];
  if (!p || p.done) return [];
  const i = STATIC_MISSIONS.findIndex((x) => x.id === missionId);
  if (i > 0 && !state.progress[STATIC_MISSIONS[i - 1]!.id]?.done) return [];
  p.count = Math.min(m.goal, p.count + by);
  const out: QuestEvent[] = [{ type: 'progress', questId: missionId, count: p.count, goal: m.goal }];
  if (p.count >= m.goal) {
    p.done = true;
    out.push({ type: 'complete', questId: missionId, rewardXp: m.rewardXp });
    out.push(...addXp(state, m.rewardXp));
  }
  return out;
}

/** Advance the unlocked STATIC 'kill' mission (call alongside quests/chain hooks). */
export function staticOnKill(state: QuestState, kills = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const m of STATIC_MISSIONS) if (m.kind === 'kill') out.push(...staticBump(state, m.id, kills));
  return out;
}

/** Advance the unlocked STATIC 'collect' mission. */
export function staticOnCollect(state: QuestState, count = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const m of STATIC_MISSIONS) if (m.kind === 'collect') out.push(...staticBump(state, m.id, count));
  return out;
}

/**
 * Advance the unlocked STATIC 'explore' mission for distinct new chunks.
 * Mirrors quests.onExplore semantics: caller-owned `seen` set, spawn chunk free.
 */
export function staticOnExplore(state: QuestState, seen: Set<string>, chunkKey: string): QuestEvent[] {
  if (seen.has(chunkKey)) return [];
  seen.add(chunkKey);
  ensureStaticProgress(state);
  const out: QuestEvent[] = [];
  for (const m of STATIC_MISSIONS) {
    if (m.kind !== 'explore') continue;
    const i = STATIC_MISSIONS.findIndex((x) => x.id === m.id);
    if (i > 0 && !state.progress[STATIC_MISSIONS[i - 1]!.id]?.done) continue;
    const p = state.progress[m.id];
    if (!p || p.done) continue;
    const target = Math.min(m.goal, Math.max(0, seen.size - 1));
    if (target > p.count) out.push(...staticBump(state, m.id, target - p.count));
  }
  return out;
}

/** First STATIC mission in order that is not done (null when the chapter is done). */
export function staticActiveMission(state: QuestState): StaticMission | null {
  ensureStaticProgress(state);
  for (const m of STATIC_MISSIONS) {
    if (!state.progress[m.id]?.done) return m;
  }
  return null;
}

export function isStaticChapterDone(state: QuestState): boolean {
  ensureStaticProgress(state);
  return STATIC_MISSIONS.every((m) => state.progress[m.id]?.done === true);
}

/** 0..1 completion across the five missions. */
export function staticChapterProgress(state: QuestState): number {
  ensureStaticProgress(state);
  const goal = STATIC_MISSIONS.reduce((a, m) => a + m.goal, 0);
  if (goal <= 0) return 0;
  const have = STATIC_MISSIONS.reduce(
    (a, m) => a + Math.min(state.progress[m.id]?.count ?? 0, m.goal),
    0,
  );
  return Math.max(0, Math.min(1, have / goal));
}

// ---------------------------------------------------------------------------
// Twist + payoff (original character, AETHERFALL lore)
// ---------------------------------------------------------------------------

/**
 * The caller. ORIGINAL character tied to AETHERFALL lore: Wren Halloway was
 * Elder Maren's signal-tender apprentice, believed lost when the ward-relay
 * collapsed during the Fall. She has lived inside the Ashfall Exchange ever
 * since, splicing her voice through dead ward-stone conduits and hiring
 * strangers booth by booth to clear the shard-choked lines so the relay can
 * finally be shut down — and so Maren stops blaming herself.
 */
export const STATIC_CALLER_IDENTITY = {
  name: 'Wren Halloway',
  role: 'Fallen signal-tender, once apprentice to Elder Maren',
  revealLine:
    'You kept picking up, so I kept calling. I am Wren Halloway — Maren taught me the relays, and the Fall buried me in one.',
} as const;

export const STATIC_MASK_ID = 'hollow-receiver';
export const STATIC_MASK_NAME = 'Hollow Receiver';
export const STATIC_TITLE_REWARD = 'Callerbound';

export interface StaticPayoff {
  maskId: string;
  maskName: string;
  title: string;
  /** Flavor line etched inside the mask. */
  inscription: string;
}

/** The unique mask + title granted for finishing mission 5. */
export const STATIC_PAYOFF: StaticPayoff = {
  maskId: STATIC_MASK_ID,
  maskName: STATIC_MASK_NAME,
  title: STATIC_TITLE_REWARD,
  inscription: 'For the one who answered. — W.H.',
};

/** Payoff is available only once the whole chapter is done. */
export function staticPayoffFor(state: QuestState): StaticPayoff | null {
  return isStaticChapterDone(state) ? { ...STATIC_PAYOFF } : null;
}

// ---------------------------------------------------------------------------
// Parole interludes (walk-and-talk scenes, original)
// ---------------------------------------------------------------------------

export interface StaticParole {
  id: string;
  /** Shown after this mission completes (mission id). */
  afterMissionId: string;
  seq: number;
  room: string;
  npcs: [string, string];
  /** One-line premise for the quest log. */
  premise: string;
  skippable: boolean;
}

export const STATIC_PAROLES: StaticParole[] = [
  {
    id: 'static-parole-kettle',
    afterMissionId: 'static-kiosk',
    seq: 1,
    room: 'Copper Kettle back room',
    npcs: ['Bram Vey', 'Sella Qinn'],
    premise: 'A fence and a night courier argue over who is paying through the dead booths.',
    skippable: true,
  },
  {
    id: 'static-parole-chapel',
    afterMissionId: 'static-meridian',
    seq: 2,
    room: 'Rust Chapel vestry',
    npcs: ['Pale Odo', 'Tilda Vess'],
    premise: 'A chapel keeper and a relay-sweeper admit the voice sounds like someone Maren lost.',
    skippable: true,
  },
];

/** Parole unlocked when its gate mission is done (and the chapter is not over). */
export function staticParoleUnlocked(paroleId: string, isDone: (id: string) => boolean): boolean {
  const p = STATIC_PAROLES.find((x) => x.id === paroleId);
  if (!p) return false;
  return isDone(p.afterMissionId);
}

/** Next parole to play given completed missions, or null. */
export function staticNextParole(
  doneIds: Set<string>,
  playedIds: Set<string>,
): StaticParole | null {
  for (const p of STATIC_PAROLES) {
    if (playedIds.has(p.id)) continue;
    if (doneIds.has(p.afterMissionId)) return p;
  }
  return null;
}
