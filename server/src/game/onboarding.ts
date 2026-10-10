// @aetherfall/gameplay — onboarding: the first five minutes, as an explicit spine.
//
// The complaint this fixes is not "the mechanics are missing" — melee, loot,
// XP, finishers and mob AI all work. It is that nothing TOLD the player any
// of it. A fresh login opened five quest families at once, produced no
// guaranteed loot, and turned a level-up into a quiet digit change. This
// module is the answer, and it is deliberately built out of REAL predicates
// over REAL game state — no click-throughs, no "wait 3 seconds" timers.
//
// Every objective is satisfied by a signal the live systems already emit:
//
//   tut-first-steps   distance from the spawn anchor  (tick position)
//   tut-first-blow    a melee swing that removed HP  (playerMeleeAttack)
//   tut-finisher      a melee execution of a downed mob (playerMeleeAttack)
//   tut-first-loot    a successful world-pickup     (collectPickup)
//   tut-don-a-mask    a mask-equipped event         (GameSession.equipMask)
//   tut-signature     a signature event             (GameSession.useSignature)
//
// Ordering, duplicate rewards and the "cannot complete itself" guarantee all
// live in `advanceTutorial`: an objective can only complete while every earlier
// objective is already done, and `done` is checked before `met` is ever
// consulted, so a signal that arrives twice (or arrives early) can never mint
// a second reward. Signals that arrive out of order are LATCHED, not dropped,
// so a returning player who equips a mask before walking cannot get stuck on
// step 1 with step 5 already satisfied.
//
// Protocol-safe: the only thing that leaves this module is `QuestEvent[]`,
// which `game/index.ts` converts to the existing `quest-progress` /
// `quest-complete` / `levelup` events. No new `ServerMsg`/`ClientMsg` variant
// and no new event kind is introduced.

import {
  WAYFARER_ROAD,
  addXp,
  roadOnCollect,
  roadOnKill,
  roadOnExplore,
  type QuestEvent,
  type QuestState,
} from './quests.js';
import { STATIC_MISSION_ORDER } from '../story/chapter.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Distance (world units) from the spawn anchor that satisfies step 1. Set to
 * `SPAWN_SAFE_RADIUS` on purpose: walking this far is the same motion that
 * takes the player OUT of the no-mob clearing, so the tutorial walks them
 * straight into their first fight instead of stopping in a safe bubble.
 */
export const TUT_MOVE_DISTANCE = 12;

/** Item guaranteed to drop at a player's FIRST corpse (once per account). */
export const FIRST_BLOOD_ITEM = 'ember-shard';
/** How many of it. One stack unit: enough to walk over, not a windfall. */
export const FIRST_BLOOD_COUNT = 1;

/** Total XP the whole track pays out (230 → level 3 with 30 to spare). */
export const TUTORIAL_TOTAL_XP = 230;

/** Death loop: where a dead player returns to and what it costs them. */
export const RESPAWN_POINT = { x: 50, y: 50 } as const;
/** Seconds of spawn protection granted on respawn (mirrors sim.SPAWN_PROTECTION_MS). */
export const RESPAWN_PROTECTION_S = 3;

/** Prefixes that belong to the onboarding track. */
export const TUTORIAL_ID_PREFIX = 'tut-';
export const ROAD_ID_PREFIX = 'road-';

export function isTutorialQuestId(id: string): boolean {
  return id.startsWith(TUTORIAL_ID_PREFIX);
}

/** True for any onboarding-owned id (tutorial track or the Road ladder). */
export function isOnboardingQuestId(id: string): boolean {
  return id.startsWith(TUTORIAL_ID_PREFIX) || id.startsWith(ROAD_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Signals — the only way an objective can be satisfied
// ---------------------------------------------------------------------------

export type TutorialSignal =
  /** Player position this tick. Drives the step-1 distance predicate. */
  | { kind: 'position'; x: number; y: number }
  /** A melee swing removed HP from a living mob (this includes the lethal
   *  swing that knocks it down instead of killing it). */
  | { kind: 'melee-hit'; mobId: number; dmg: number }
  /** A melee swing executed a downed mob (instant kill + FINISHER_BONUS_XP). */
  | { kind: 'finisher'; mobId: number }
  /** A world pickup entered the bag. */
  | { kind: 'collected'; itemId: string; count: number }
  /** A mask was worn. */
  | { kind: 'mask-equipped'; maskId: string }
  /** A vocation signature fired off cooldown. */
  | { kind: 'signature-used'; signatureId: string };

export type TutorialSignalKind = TutorialSignal['kind'];

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export interface TutorialObjective {
  id: string;
  seq: number;
  name: string;
  /** The objective row in the tracker: what you must achieve. */
  objective: string;
  /** The control or slash command that achieves it. */
  hint: string;
  rewardXp: number;
  /** Which signal this objective listens for. Exactly one, 1:1. */
  signal: TutorialSignalKind;
  /**
   * The predicate. A pure function over the signal and the player's own
   * tutorial state — it must be FALSE for a fresh player who has done
   * nothing, and TRUE only once the described thing actually happened.
   */
  matches: (sig: TutorialSignal, state: TutorialState) => boolean;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export const TUTORIAL_OBJECTIVES: TutorialObjective[] = [
  {
    id: 'tut-first-steps',
    seq: 1,
    name: 'First Steps',
    objective: 'Walk out of the shrine clearing.',
    hint: 'Move with WASD / arrows / the joystick. The clearing is empty on purpose — leave it.',
    rewardXp: 20,
    signal: 'position',
    matches: (sig, st) => sig.kind === 'position' && dist(sig.x, sig.y, st.origin.x, st.origin.y) >= TUT_MOVE_DISTANCE,
  },
  {
    id: 'tut-first-blow',
    seq: 2,
    name: 'First Blow',
    objective: 'Land a hit on a meadow beast.',
    hint: 'Stand next to one and hold your attack key. Swings land every 0.8s.',
    rewardXp: 25,
    signal: 'melee-hit',
    matches: (sig) => sig.kind === 'melee-hit' && sig.dmg > 0,
  },
  {
    id: 'tut-finisher',
    seq: 3,
    name: 'Finish It',
    objective: 'Put a beast down, then finish it while it crawls.',
    hint: 'A lethal blow knocks it down for 3s — walk up and swing again. A thrown weapon knocks down too, but never finishes.',
    rewardXp: 40,
    signal: 'finisher',
    matches: (sig) => sig.kind === 'finisher' && Number.isFinite(sig.mobId),
  },
  {
    id: 'tut-first-loot',
    seq: 4,
    name: 'First Loot',
    objective: 'Take what it dropped.',
    hint: 'Step onto a glowing drop. Your first kill always leaves one behind.',
    rewardXp: 35,
    signal: 'collected',
    matches: (sig) => sig.kind === 'collected' && sig.count > 0 && sig.itemId.length > 0,
  },
  {
    id: 'tut-don-a-mask',
    seq: 5,
    name: 'Don a Mask',
    objective: 'Wear any mask.',
    hint: 'Type /vocation to list the four callings — each hands you a mask. Then /mask equip <id>.',
    rewardXp: 45,
    signal: 'mask-equipped',
    matches: (sig) => sig.kind === 'mask-equipped' && sig.maskId.length > 0,
  },
  {
    id: 'tut-signature',
    seq: 6,
    name: 'Signature',
    objective: "Fire your calling's signature.",
    hint: 'Press your skill key (or /sig). 12s cooldown — one good hit is worth saving it for.',
    rewardXp: 65,
    signal: 'signature-used',
    matches: (sig) => sig.kind === 'signature-used' && sig.signatureId.length > 0,
  },
];

export const TUTORIAL_IDS: string[] = TUTORIAL_OBJECTIVES.map((o) => o.id);

export function tutorialObjective(id: string): TutorialObjective | undefined {
  return TUTORIAL_OBJECTIVES.find((o) => o.id === id);
}

export function tutorialObjectiveBySeq(seq: number): TutorialObjective | undefined {
  return TUTORIAL_OBJECTIVES.find((o) => o.seq === seq);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type TutorialObjectiveState = {
  count: number;
  done: boolean;
  claimed: boolean;
  /** Predicate satisfied but not yet consumed (out-of-order latch). */
  met: boolean;
};

export interface TutorialState {
  objectives: Record<string, TutorialObjectiveState>;
  /** Spawn anchor — the zero point of the step-1 distance predicate. */
  origin: { x: number; y: number };
  /** Best distance walked from the anchor (drives the live progress bar). */
  travelled: number;
  /** Objective ids completed since the last drain. */
  pending: string[];
  /** Road-ladder events buffered by the same drain point. */
  pendingRoad: QuestEvent[];
  /** The guaranteed first-corpse drop has been granted. */
  gifted: boolean;
  /** Quest state this player is bound to (set by `bindTutorialQuests`). */
  quests: QuestState | null;
}

function freshObjectiveState(): TutorialObjectiveState {
  return { count: 0, done: false, claimed: false, met: false };
}

export function createTutorialState(x = 0, y = 0): TutorialState {
  const objectives: Record<string, TutorialObjectiveState> = {};
  for (const o of TUTORIAL_OBJECTIVES) objectives[o.id] = freshObjectiveState();
  return {
    objectives,
    origin: { x, y },
    travelled: 0,
    pending: [],
    pendingRoad: [],
    gifted: false,
    quests: null,
  };
}

/**
 * Per-player tutorial registry.
 *
 * Module-scoped and keyed by player id, exactly like the `dialogues` /
 * `tokensByPid` / `sysViews` maps in `server/src/index.ts`: the systems layer
 * (`GameSession.equipMask`, `GameSession.useSignature`) has to reach it without
 * holding a `GameState`, while the gameplay layer (`game/index.ts`) owns the
 * lifecycle. Entries are created on join and dropped on disconnect, so the map
 * is bounded by the live player count.
 */
const tutorials = new Map<number, TutorialState>();

/** Create (or return) the tutorial state for a joining player. */
export function startTutorial(playerId: number, x: number, y: number): TutorialState {
  const st = createTutorialState(x, y);
  tutorials.set(playerId, st);
  return st;
}

/** Drop a player's tutorial state (disconnect). No-op when unknown. */
export function forgetTutorial(playerId: number): boolean {
  return tutorials.delete(playerId);
}

/** Peek at a player's tutorial state (tests/debug). */
export function tutorialFor(playerId: number): TutorialState | undefined {
  return tutorials.get(playerId);
}

/** Drop every player's state (test isolation). */
export function resetTutorials(): void {
  tutorials.clear();
}

/**
 * Bind the player's `QuestState` so signals raised from the systems layer
 * (which has no handle on it) can still advance the Road ladder's XP.
 */
export function bindTutorialQuests(playerId: number, state: QuestState): void {
  const st = tutorials.get(playerId);
  if (st) st.quests = state;
}

// ---------------------------------------------------------------------------
// Queries (pure, over the state)
// ---------------------------------------------------------------------------

export function isTutorialComplete(state: TutorialState): boolean {
  return TUTORIAL_OBJECTIVES.every((o) => state.objectives[o.id]?.done === true);
}

/** First objective not done (null when the track is complete). */
export function tutorialActive(state: TutorialState): TutorialObjective | null {
  for (const o of TUTORIAL_OBJECTIVES) if (!state.objectives[o.id]?.done) return o;
  return null;
}

/** Objectives completed so far. */
export function tutorialStepCount(state: TutorialState): number {
  return TUTORIAL_OBJECTIVES.filter((o) => state.objectives[o.id]?.done).length;
}

/** 0..1 across the track. */
export function tutorialProgress(state: TutorialState): number {
  return tutorialStepCount(state) / TUTORIAL_OBJECTIVES.length;
}

/** Live progress of the current objective, 0..1 (steps that need no counter
 *  report 0 until the signal lands, which is honest: nothing has happened). */
export function tutorialObjectiveProgress(state: TutorialState): number {
  const active = tutorialActive(state);
  if (!active) return 1;
  const os = state.objectives[active.id];
  if (os?.done) return 1;
  if (active.signal === 'position' && TUT_MOVE_DISTANCE > 0) {
    return Math.max(0, Math.min(1, state.travelled / TUT_MOVE_DISTANCE));
  }
  return os?.met ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Consume every satisfied-but-uncompleted objective, strictly in order, and
 * return the ids that completed. This is the ONLY place `done` flips, which is
 * what makes the three guarantees hold at once:
 *
 *   - no objective completes itself: only `matches(sig, state)` can set `met`;
 *   - no out-of-order completion: the loop only ever looks at the first
 *     unfinished objective, so step 5 cannot finish while step 1 is open;
 *   - no duplicate reward: `done` is checked before `met`, and a finished
 *     objective is never revisited.
 */
export function advanceTutorial(state: TutorialState): string[] {
  const completed: string[] = [];
  for (const o of TUTORIAL_OBJECTIVES) {
    const os = state.objectives[o.id];
    if (!os) continue;
    if (os.done) continue;
    if (!os.met) break; // ordered: a gap stops the ladder here
    os.done = true;
    os.claimed = true;
    os.count = 1;
    completed.push(o.id);
  }
  state.pending.push(...completed);
  return completed;
}

/**
 * Record one signal. Latches `met` on the matching objective when the
 * predicate passes, then advances the track. Returns the ids completed by this
 * signal (usually empty — completions are drained as events on the tick).
 */
export function applyTutorialSignal(state: TutorialState, sig: TutorialSignal): string[] {
  if (isTutorialComplete(state)) return [];
  const def = TUTORIAL_OBJECTIVES.find((o) => o.signal === sig.kind);
  if (!def) return [];
  const os = state.objectives[def.id];
  if (!os || os.done) return [];
  if (sig.kind === 'position') {
    state.travelled = Math.max(state.travelled, dist(sig.x, sig.y, state.origin.x, state.origin.y));
  }
  // Re-run the predicate on EVERY signal, never a cached result: that is what
  // proves the objective is false before the action and true after.
  if (os.met || !def.matches(sig, state)) return [];
  os.met = true;
  return advanceTutorial(state);
}

// ---------------------------------------------------------------------------
// QuestState mirroring + event drain
// ---------------------------------------------------------------------------

/**
 * Mirror tutorial entries into `QuestState.progress` so they persist through
 * the existing `quests_progress` rows and read back like any other quest.
 * Idempotent and non-destructive: an already-done entry is never reopened.
 */
export function ensureTutorialProgress(state: QuestState): void {
  for (const o of TUTORIAL_OBJECTIVES) {
    const existing = state.progress[o.id];
    if (existing) continue;
    state.progress[o.id] = { questId: o.id, count: 0, done: false, claimed: false };
  }
}

/**
 * Turn completed tutorial objectives into `quest-progress` / `quest-complete` /
 * `levelup` events, granting each objective's XP exactly once.
 *
 * The Road ladder's buffered events ride the same drain so a player sees one
 * ordered stream of "you did the thing -> here is your reward -> here is the
 * next thing", rather than two interleaved voices.
 */
export function drainOnboardingEvents(playerId: number, state: QuestState): QuestEvent[] {
  const tut = tutorials.get(playerId);
  if (!tut) return [];
  ensureTutorialProgress(state);
  const out: QuestEvent[] = [];

  if (tut.pending.length > 0) {
    for (const id of tut.pending.splice(0)) {
      const def = tutorialObjective(id);
      const entry = state.progress[id];
      if (!def || !entry || entry.done) continue; // already paid — never twice
      entry.count = 1;
      entry.done = true;
      entry.claimed = true;
      out.push({ type: 'progress', questId: id, count: 1, goal: 1 });
      out.push({ type: 'complete', questId: id, rewardXp: def.rewardXp });
      out.push(...addXp(state, def.rewardXp));
    }
  }
  if (tut.pendingRoad.length > 0) out.push(...tut.pendingRoad.splice(0));
  return out;
}

// ---------------------------------------------------------------------------
// Observation helpers — one call per real gameplay site
// ---------------------------------------------------------------------------

function note(playerId: number, sig: TutorialSignal, questState?: QuestState): void {
  const tut = tutorials.get(playerId);
  if (!tut) return;
  applyTutorialSignal(tut, sig);
  // The Road rides the same signals, but only where the caller can hand us the
  // QuestState (the systems layer cannot — masks/signatures are not Road steps
  // anyway, so nothing is lost by skipping the ladder there).
  if (!questState) return;
  if (sig.kind === 'melee-hit' || sig.kind === 'finisher') {
    tut.pendingRoad.push(...roadOnKill(questState, 1));
  } else if (sig.kind === 'collected') {
    tut.pendingRoad.push(...roadOnCollect(questState, sig.count));
  }
}

/**
 * Player position for this tick (drives step 1). Cheap: the distance is only
 * computed while step 1 is the unfinished objective.
 */
export function notePlayerPosition(playerId: number, x: number, y: number): void {
  const tut = tutorials.get(playerId);
  if (!tut || isTutorialComplete(tut)) return;
  note(playerId, { kind: 'position', x, y });
}

/**
 * A resolved melee swing. `dmg > 0` is step 2 (a lethal swing reports the HP
 * it removed AND knocks the mob down, so it satisfies step 2 on the way to
 * step 3); `finished` is step 3. One call covers both, because they are one
 * swing in the player's eyes.
 */
export function noteMeleeSwing(
  playerId: number,
  questState: QuestState | undefined,
  mobId: number,
  dmg: number,
  finished: boolean,
): void {
  const tut = tutorials.get(playerId);
  if (!tut || isTutorialComplete(tut)) return;
  if (finished) note(playerId, { kind: 'finisher', mobId }, questState);
  else if (dmg > 0) note(playerId, { kind: 'melee-hit', mobId, dmg }, questState);
}

/** A world pickup entered the bag (step 4). */
export function notePickupCollected(
  playerId: number,
  questState: QuestState | undefined,
  itemId: string,
  count: number,
): void {
  note(playerId, { kind: 'collected', itemId, count }, questState);
}

/**
 * A boss fell. Counts toward the Road's kill step (bosses are kills, and the
 * chain already counts them) but never satisfies step 2 or 3: the tutorial
 * teaches the ordinary mob loop, and crediting a boss for a swing the player
 * never made would be exactly the "fake predicate" this track forbids.
 */
export function noteBossKilled(playerId: number, questState: QuestState, finisher: boolean): void {
  const tut = tutorials.get(playerId);
  if (!tut) return;
  if (finisher) note(playerId, { kind: 'finisher', mobId: -1 }, questState);
  else tut.pendingRoad.push(...roadOnKill(questState, 1));
}

/** A mask was worn (step 5). Raised by `GameSession.equipMask`. */
export function noteMaskEquipped(playerId: number, maskId: string): void {
  note(playerId, { kind: 'mask-equipped', maskId });
}

/** A signature fired off cooldown (step 6). Raised by `GameSession.useSignature`. */
export function noteSignatureUsed(playerId: number, signatureId: string): void {
  note(playerId, { kind: 'signature-used', signatureId });
}

/** A distinct world chunk was entered (the Road's explore step). */
export function noteChunkExplored(
  playerId: number,
  questState: QuestState,
  seen: Set<string>,
  chunkKey: string,
): void {
  const tut = tutorials.get(playerId);
  if (!tut) return;
  tut.pendingRoad.push(...roadOnExplore(questState, seen, chunkKey));
}

// ---------------------------------------------------------------------------
// First-corpse gift — the guaranteed visible loot in the first minute
// ---------------------------------------------------------------------------

/**
 * True ONCE per player, on their first kill. `creditKill` turns it into a
 * world pickup at the corpse.
 *
 * Loot tables are probabilistic by design (a gloomfang drops a fang 65% of the
 * time), which is fine at minute ten and fatal at minute zero: a new player
 * who kills something and sees nothing on the ground concludes the game is
 * broken. This one-time gift makes "kill -> visible loot" deterministic
 * without touching a single drop table, price or catalog entry.
 */
export function consumeFirstBloodGift(playerId: number): boolean {
  const tut = tutorials.get(playerId);
  if (!tut || tut.gifted) return false;
  tut.gifted = true;
  return true;
}

/** True when the player still has their first-corpse gift coming. */
export function hasFirstBloodGift(playerId: number): boolean {
  const tut = tutorials.get(playerId);
  return !!tut && !tut.gifted;
}

// ---------------------------------------------------------------------------
// Death loop
// ---------------------------------------------------------------------------

/**
 * Everything the death screen needs, in one shape, so the client copy and the
 * server rule can never drift. There is NO XP penalty and NO loot loss on
 * death today; a dead player wakes at the shrine at full HP with
 * `RESPAWN_PROTECTION_S` seconds of immunity. The respawn path itself is
 * untouched (`sim.respawnPlayer` still owns the move) — this only describes
 * it.
 */
export function deathNotice(over: { killer?: string; x?: number; y?: number } = {}): {
  title: string;
  body: string;
  respawnAt: { x: number; y: number };
  respawnLabel: string;
  protectionS: number;
  penalty: string;
} {
  const who = over.killer && over.killer.length > 0 ? ` Killed by ${over.killer}.` : '';
  return {
    title: 'YOU FELL',
    body: `The meadow beasts finished what your health could not.${who} Nothing is lost — you keep every item, quest and level.`,
    respawnAt: { x: RESPAWN_POINT.x, y: RESPAWN_POINT.y },
    respawnLabel: 'the Ward Shrine (50, 50)',
    protectionS: RESPAWN_PROTECTION_S,
    penalty: 'No XP lost. No items lost.',
  };
}

// ---------------------------------------------------------------------------
// The spine: one ordered "do this next" across every track
// ---------------------------------------------------------------------------

export interface OnboardingStep {
  stage: number;
  track: 'tutorial' | 'road' | 'trio' | 'maren' | 'chapter';
  trackTitle: string;
  id: string;
  name: string;
  /** What to do, in one line. */
  hint: string;
  count: number;
  goal: number;
  done: boolean;
}

const TRACK_TITLES = {
  tutorial: 'FIRST FIVE MINUTES',
  road: "WAYFARER'S ROAD",
  trio: "WANDERER'S TASKS",
  maren: 'ELDER MAREN',
  chapter: 'CHAPTER — STATIC',
} as const;

/** The roadmap in play order, tutorial ids first. */
export function onboardingRoadmap(): Array<{ stage: number; track: string; trackTitle: string; ids: string[] }> {
  return [
    { stage: 1, track: 'tutorial', trackTitle: TRACK_TITLES.tutorial, ids: [...TUTORIAL_IDS] },
    { stage: 2, track: 'road', trackTitle: TRACK_TITLES.road, ids: WAYFARER_ROAD.map((q) => q.id) },
    { stage: 3, track: 'trio', trackTitle: TRACK_TITLES.trio, ids: ['slay5', 'gather10', 'explorer'] },
    {
      stage: 4,
      track: 'maren',
      trackTitle: TRACK_TITLES.maren,
      // Mirrors QUEST_CHAIN in content.ts. Kept as ids here rather than an
      // import because content.ts already imports this module's quest helpers;
      // the two lists are pinned by `quests.test.ts` + `content.test.ts`.
      ids: ['ward-spark', 'ember-road', 'deep-delvers', 'chart-the-fall', 'heart-of-fall'],
    },
    { stage: 5, track: 'chapter', trackTitle: TRACK_TITLES.chapter, ids: [...STATIC_MISSION_ORDER] },
  ];
}

/**
 * The ONE thing a new player should be doing right now.
 *
 * Walks the roadmap in order and returns the first unfinished step, so the
 * tracker can never point at a locked quest while an open one sits behind it.
 * After the last track it returns null — the caller is expected to fall back to
 * "keep hunting", never to an empty screen.
 */
export function nextOnboardingStep(state: QuestState): OnboardingStep | null {
  for (const entry of onboardingRoadmap()) {
    for (const id of entry.ids) {
      const p = state.progress[id];
      if (p?.done) continue;
      return describeStep(entry.stage, entry.track, entry.trackTitle, id, p?.count ?? 0, p?.done ?? false);
    }
  }
  return null;
}

/** Fill-in data for one roadmap row (count/goal resolved from the quests). */
export function describeStep(
  stage: number,
  track: string,
  trackTitle: string,
  id: string,
  count = 0,
  done = false,
): OnboardingStep {
  const tut = tutorialObjective(id);
  if (tut) {
    return { stage, track: 'tutorial', trackTitle, id, name: tut.name, hint: tut.hint, count: done ? 1 : count, goal: 1, done };
  }
  const road = ROAD_HINTS[id];
  if (road) {
    return { stage, track: 'road', trackTitle, id, name: road.name, hint: road.hint, count, goal: road.goal, done };
  }
  const hint = FAMILY_HINTS[id] ?? 'Keep going.';
  const goal = GOALS[id] ?? Math.max(1, count);
  return { stage, track: track as OnboardingStep['track'], trackTitle, id, name: NAME[id] ?? id, hint, count, goal, done };
}

/**
 * Road + family presentation data, kept here (not in `quests.ts`) so the pure
 * state module stays free of onboarding copy.
 */
const ROAD_HINTS: Record<string, { name: string; goal: number; hint: string }> = Object.fromEntries(
  WAYFARER_ROAD.map((q) => [q.id, { name: q.name, goal: q.goal, hint: q.hint }]),
);

const NAME: Record<string, string> = {
  slay5: 'Cull the Gloom',
  gather10: 'Shard Harvest',
  explorer: 'Chart the Fall',
  'ward-spark': 'Ward-Spark',
  'ember-road': 'Ember Road',
  'deep-delvers': 'Deep Delvers',
  'chart-the-fall': 'Chart the Fall',
  'heart-of-fall': 'Heart of the Fall',
  'static-porchlight': 'Porchlight',
  'static-kiosk': 'Kiosk Tithe',
  'static-arcade': 'Arcade Sweep',
  'static-meridian': 'Meridian Walk',
  'static-exchange': 'Exchange Silence',
};

const GOALS: Record<string, number> = {
  slay5: 5,
  gather10: 10,
  explorer: 3,
  'ward-spark': 3,
  'ember-road': 5,
  'deep-delvers': 6,
  'chart-the-fall': 4,
  'heart-of-fall': 8,
  'static-porchlight': 4,
  'static-kiosk': 6,
  'static-arcade': 6,
  'static-meridian': 4,
  'static-exchange': 8,
};

const FAMILY_HINTS: Record<string, string> = {
  slay5: 'Kill five beasts. Elder Maren is waiting at the shrine (50, 50).',
  gather10: 'Collect ten drops from the meadow — kill more, walk over more.',
  explorer: 'Walk into three chunks you have never seen.',
  'ward-spark': 'Elder Maren (shrine, 50, 50) wants three meadow beasts driven off.',
  'ember-road': 'Gather five ember-shards along the old road.',
  'deep-delvers': 'Cull six delvers in the Hollow Deep (dungeon, past the highlands).',
  'chart-the-fall': 'Chart four new chunks beyond the highlands.',
  'heart-of-fall': 'Fell eight horrors in the Ashfall Caldera. Maren promises the Ward Blade.',
  'static-porchlight': 'Brazen Porch (meadow edge). Clear four, then lift a call-booth receiver.',
  'static-kiosk': 'Flicker Kiosk Row. Gather six ember-shards from the dead booths.',
  'static-arcade': 'Sunken Arcade, under the Hollow Deep. Clear six delvers.',
  'static-meridian': 'Glass Meridian. Reach four new survey points.',
  'static-exchange': 'Ashfall Exchange, in the caldera. Silence eight horrors.',
};

/** Copy for the "the spine is finished" state — never an empty screen. */
export const ONBOARDING_COMPLETE_LINE =
  'The road is open. Keep hunting in the meadow — every beast you fell feeds Elder Maren at the shrine (50, 50).';