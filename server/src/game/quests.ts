// @aetherfall/gameplay — quests: 3 quests with XP/level rewards.
// Protocol-safe: progress surfaces as `t:'event'` payloads only.

export type QuestKind = 'kill' | 'collect' | 'explore';

export type QuestDef = {
  id: string;
  name: string;
  kind: QuestKind;
  goal: number;
  rewardXp: number;
};

export const QUEST_DEFS: QuestDef[] = [
  { id: 'slay5', name: 'Cull the Gloom', kind: 'kill', goal: 5, rewardXp: 60 },
  { id: 'gather10', name: 'Shard Harvest', kind: 'collect', goal: 10, rewardXp: 80 },
  { id: 'explorer', name: 'Chart the Fall', kind: 'explore', goal: 3, rewardXp: 100 },
];

export function questDef(id: string): QuestDef | undefined {
  return QUEST_DEFS.find((q) => q.id === id);
}

export type QuestProgress = {
  questId: string;
  count: number;
  done: boolean;
  claimed: boolean;
};

export type QuestState = {
  progress: Record<string, QuestProgress>;
  level: number;
  xp: number;
};

export function xpForNextLevel(level: number): number {
  return level * 100;
}

export function createQuestState(): QuestState {
  const progress: Record<string, QuestProgress> = {};
  for (const q of QUEST_DEFS) progress[q.id] = { questId: q.id, count: 0, done: false, claimed: false };
  return { progress, level: 1, xp: 0 };
}

export type QuestEvent =
  | { type: 'progress'; questId: string; count: number; goal: number }
  | { type: 'complete'; questId: string; rewardXp: number }
  | { type: 'levelup'; level: number };

function bump(state: QuestState, questId: string, by: number): QuestEvent[] {
  const def = questDef(questId);
  const p = state.progress[questId];
  if (!def || !p || p.done) return [];
  p.count = Math.min(def.goal, p.count + by);
  const out: QuestEvent[] = [{ type: 'progress', questId, count: p.count, goal: def.goal }];
  if (p.count >= def.goal) {
    p.done = true;
    out.push({ type: 'complete', questId, rewardXp: def.rewardXp });
    out.push(...addXp(state, def.rewardXp));
  }
  return out;
}

/** Add XP; levels up at level*100 thresholds. Returns levelup events. */
export function addXp(state: QuestState, amount: number): QuestEvent[] {
  if (amount <= 0) return [];
  const out: QuestEvent[] = [];
  state.xp += amount;
  while (state.xp >= xpForNextLevel(state.level)) {
    state.xp -= xpForNextLevel(state.level);
    state.level += 1;
    out.push({ type: 'levelup', level: state.level });
  }
  return out;
}

/** Record mob kills for 'kill' quests. kills = number of mobs killed in one tick batch. */
export function onKill(state: QuestState, kills = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const q of QUEST_DEFS) if (q.kind === 'kill') out.push(...bump(state, q.id, kills));
  return out;
}

/** Record item pickups for 'collect' quests. */
export function onCollect(state: QuestState, count = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const q of QUEST_DEFS) if (q.kind === 'collect') out.push(...bump(state, q.id, count));
  return out;
}

/**
 * Record visiting a chunk key (`cx,cy`) for 'explore' quests.
 *
 * `seen` is the CALLER's set of distinct chunks walked this session, and it is
 * shared by every explore family (trio `onExplore`, Road `roadOnExplore`,
 * Maren `chainOnExplore`) because the server has one `seenChunks` set per
 * player. It is therefore a LEDGER, not a per-family cursor: a key is folded in
 * idempotently and each family's own monotonic progress guard below decides
 * whether there is anything to award.
 *
 * It must NOT be used as an early-return (`if (seen.has(key)) return []`).
 * That made the ledger a single-consumer token: whichever family the tick ran
 * first consumed the key and the other two bailed forever, so `explorer`
 * advanced while `road-lookout` and `chart-the-fall` never moved — and
 * `chart-the-fall` gates `heart-of-fall`, soft-locking the whole Maren chain.
 *
 * Distinct chunks only: repeats are naturally idempotent because `target` is
 * derived from `seen.size` and only applied when it exceeds `p.count`.
 * The first chunk ever seen is the spawn chunk — discovering NEW chunks counts,
 * so progress = seen.size - 1 (chunks beyond spawn).
 */
export function onExplore(state: QuestState, seen: Set<string>, chunkKey: string): QuestEvent[] {
  seen.add(chunkKey);
  const out: QuestEvent[] = [];
  for (const q of QUEST_DEFS) {
    if (q.kind !== 'explore') continue;
    const p = state.progress[q.id];
    if (!p || p.done) continue;
    const target = Math.min(q.goal, Math.max(0, seen.size - 1));
    if (target > p.count) {
      const delta = target - p.count;
      out.push(...bump(state, q.id, delta));
    }
  }
  return out;
}

export function chunkKeyOf(x: number, y: number, chunkSize = 32): string {
  return `${Math.floor(x / chunkSize)},${Math.floor(y / chunkSize)}`;
}

// ---------------------------------------------------------------------------
// Wayfarer's Road — the explicit first-hour ladder (onboarding pacing)
// ---------------------------------------------------------------------------
// The base trio above all start OPEN at t=0 and run in parallel, which is what
// made a fresh login read as "three things at once and none of them urgent".
// The Road is a short, strictly-gated ladder that runs BEFORE them, sized so
// the first completion lands inside the first minute:
//
//   kill 1 -> loot 3 -> kill 3 -> walk to 2 new chunks
//
// Thresholds are deliberately small: `road-first-blood` pays out on the very
// first corpse, and `road-pickups` is satisfied by the loot a 3-beast hunt
// leaves behind. The Road shares `QuestState.progress` (keyed `road-*`), the
// `quest-progress` / `quest-complete` events and the level*100 XP curve with
// every other family, so it costs no new protocol and no new persistence.
//
// The trio, the Maren chain and STATIC are untouched: they keep accruing in
// the background exactly as before, so every existing quest stays reachable
// and completable. The Road only decides what the player is told to do NEXT
// (see `game/onboarding.ts` for the resolver that stitches the tracks into a
// single ordered spine).

export type RoadQuestKind = 'kill' | 'collect' | 'explore';

export interface RoadQuestDef {
  id: string;
  seq: number;
  name: string;
  kind: RoadQuestKind;
  goal: number;
  rewardXp: number;
  /** Previous Road quest that must be done first (undefined = ladder start). */
  prerequisite?: string;
  /** One line the objective tracker shows as "do this next". */
  hint: string;
}

export const WAYFARER_ROAD: RoadQuestDef[] = [
  {
    id: 'road-first-blood',
    seq: 1,
    name: 'First Blood',
    kind: 'kill',
    goal: 1,
    rewardXp: 25,
    hint: 'Kill one meadow beast. Your first kill always leaves something at the corpse.',
  },
  {
    id: 'road-pickups',
    seq: 2,
    name: 'Pick It Up',
    kind: 'collect',
    goal: 3,
    rewardXp: 35,
    prerequisite: 'road-first-blood',
    hint: 'Walk over three drops and take them — the loot is the point of the swing.',
  },
  {
    id: 'road-hunt',
    seq: 3,
    name: 'Thin the Meadow',
    kind: 'kill',
    goal: 3,
    rewardXp: 45,
    prerequisite: 'road-pickups',
    hint: 'Kill three more beasts. Finishers pay bonus XP — walk up and swing again.',
  },
  {
    id: 'road-lookout',
    seq: 4,
    name: 'See the Far Side',
    kind: 'explore',
    goal: 2,
    rewardXp: 55,
    prerequisite: 'road-hunt',
    hint: 'Walk into two chunks you have never seen before.',
  },
];

export const ROAD_IDS: string[] = WAYFARER_ROAD.map((q) => q.id);

export function roadQuest(id: string): RoadQuestDef | undefined {
  return WAYFARER_ROAD.find((q) => q.id === id);
}

/** First Road quest in order that is not done (null when the ladder is done). */
export function roadActive(state: QuestState): RoadQuestDef | null {
  ensureRoadProgress(state);
  for (const q of WAYFARER_ROAD) if (!state.progress[q.id]?.done) return q;
  return null;
}

export function isRoadComplete(state: QuestState): boolean {
  ensureRoadProgress(state);
  return WAYFARER_ROAD.every((q) => state.progress[q.id]?.done === true);
}

/** 0..1 across the ladder. */
export function roadProgress(state: QuestState): number {
  ensureRoadProgress(state);
  const goal = WAYFARER_ROAD.reduce((a, q) => a + q.goal, 0);
  if (goal <= 0) return 0;
  const have = WAYFARER_ROAD.reduce(
    (a, q) => a + Math.min(state.progress[q.id]?.count ?? 0, q.goal),
    0,
  );
  return Math.max(0, Math.min(1, have / goal));
}

/** Seed Road progress entries (idempotent; keeps every other entry intact). */
export function ensureRoadProgress(state: QuestState): void {
  for (const q of WAYFARER_ROAD) {
    if (!state.progress[q.id]) {
      state.progress[q.id] = { questId: q.id, count: 0, done: false, claimed: false };
    }
  }
}

/**
 * Advance one Road quest. Prerequisite-gated exactly like the Maren chain: a
 * locked step accrues nothing, and a finished step never pays twice (`p.done`
 * short-circuits before any mutation, so a duplicate reward is impossible).
 */
function roadBump(state: QuestState, questId: string, by: number): QuestEvent[] {
  const q = roadQuest(questId);
  if (!q || by <= 0) return [];
  ensureRoadProgress(state);
  const p = state.progress[questId];
  if (!p || p.done) return [];
  if (q.prerequisite && !state.progress[q.prerequisite]?.done) return [];
  p.count = Math.min(q.goal, p.count + by);
  const out: QuestEvent[] = [{ type: 'progress', questId, count: p.count, goal: q.goal }];
  if (p.count >= q.goal) {
    p.done = true;
    out.push({ type: 'complete', questId, rewardXp: q.rewardXp });
    out.push(...addXp(state, q.rewardXp));
  }
  return out;
}

/** Advance the unlocked Road 'kill' step (call alongside `onKill`). */
export function roadOnKill(state: QuestState, kills = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const q of WAYFARER_ROAD) if (q.kind === 'kill') out.push(...roadBump(state, q.id, kills));
  return out;
}

/** Advance the unlocked Road 'collect' step (call alongside `onCollect`). */
export function roadOnCollect(state: QuestState, count = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const q of WAYFARER_ROAD) if (q.kind === 'collect') out.push(...roadBump(state, q.id, count));
  return out;
}

/**
 * Advance the unlocked Road 'explore' step. Mirrors `onExplore`: the caller
 * owns the `seen` set of distinct chunks, the spawn chunk is free, and progress
 * is the count of distinct chunks beyond it (never a re-walk of ground already
 * covered).
 *
 * `seen` is SHARED with `onExplore` and `chainOnExplore` (one `seenChunks` set
 * per player), so — exactly like `onExplore` — it is a ledger to fold the key
 * into, never an early-return cursor. See the long note on `onExplore`.
 */
export function roadOnExplore(state: QuestState, seen: Set<string>, chunkKey: string): QuestEvent[] {
  seen.add(chunkKey);
  ensureRoadProgress(state);
  const out: QuestEvent[] = [];
  for (const q of WAYFARER_ROAD) {
    if (q.kind !== 'explore') continue;
    if (q.prerequisite && !state.progress[q.prerequisite]?.done) continue;
    const p = state.progress[q.id];
    if (!p || p.done) continue;
    const target = Math.min(q.goal, Math.max(0, seen.size - 1));
    if (target > p.count) out.push(...roadBump(state, q.id, target - p.count));
  }
  return out;
}

/**
 * Canonical PLAY ORDER across every auto-advancing quest family.
 *
 * Before this, `slay5` / `gather10` / `explorer`, the Maren chain and STATIC
 * were all open at once with no stated order, so a new player had five
 * simultaneous "do this" lines and no signal about which one was first. The
 * order below is the single spine the objective tracker reads:
 *
 *   1. tutorial  (game/onboarding.ts) — the six real-mechanics objectives
 *   2. road      (WAYFARER_ROAD above) — the gated first-hour ladder
 *   3. trio      (slay5 -> gather10 -> explorer, in that order)
 *   4. maren     (Elder Maren chain, prerequisite order)
 *   5. chapter   (STATIC, opt-in from a call-booth)
 *
 * `stage` is presentation order only: it never gates accrual. Every quest in
 * every track keeps running on its own rules, so nothing becomes unreachable.
 */
export type QuestTrackId = 'tutorial' | 'road' | 'trio' | 'maren' | 'chapter';

export interface QuestRoadmapStage {
  stage: number;
  track: QuestTrackId;
  trackTitle: string;
  /** Ids in play order. `tutorial`/`chapter` are filled in by the resolver. */
  ids: string[];
}

export const QUEST_ROADMAP: QuestRoadmapStage[] = [
  { stage: 1, track: 'tutorial', trackTitle: 'FIRST FIVE MINUTES', ids: [] },
  { stage: 2, track: 'road', trackTitle: "WAYFARER'S ROAD", ids: [...ROAD_IDS] },
  { stage: 3, track: 'trio', trackTitle: "WANDERER'S TASKS", ids: QUEST_DEFS.map((q) => q.id) },
  {
    stage: 4,
    track: 'maren',
    trackTitle: 'ELDER MAREN',
    ids: [
      'ward-spark',
      'ember-road',
      'deep-delvers',
      'chart-the-fall',
      'heart-of-fall',
    ],
  },
  {
    stage: 5,
    track: 'chapter',
    trackTitle: 'CHAPTER — STATIC',
    ids: ['static-porchlight', 'static-kiosk', 'static-arcade', 'static-meridian', 'static-exchange'],
  },
];

/**
 * First quest id on the roadmap that is not done, or null when the whole
 * roadmap is complete. `tutorial` and `chapter` ids are supplied by the caller
 * (they live in `game/onboarding.ts` and `story/chapter.ts`, which import this
 * module — hard-coding them here would create an import cycle).
 */
export function nextRoadmapQuestId(
  state: QuestState,
  extra?: Partial<Record<QuestTrackId, string[]>>,
): string | null {
  for (const entry of QUEST_ROADMAP) {
    const ids = extra?.[entry.track] ?? entry.ids;
    for (const id of ids) if (!state.progress[id]?.done) return id;
  }
  return null;
}

/** The roadmap stage a quest belongs to (null for an unknown id). */
export function roadmapStageOf(questId: string, extra?: Partial<Record<QuestTrackId, string[]>>): QuestRoadmapStage | null {
  for (const entry of QUEST_ROADMAP) {
    const ids = extra?.[entry.track] ?? entry.ids;
    if (ids.includes(questId)) return entry;
  }
  return null;
}
