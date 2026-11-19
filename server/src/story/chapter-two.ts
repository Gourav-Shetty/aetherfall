// AETHERFALL story — Chapter Two: "PARTITION".
//
// Direct sequel to STATIC. Wren Halloway revealed herself at the Ashfall
// Exchange and the player took her Hollow Receiver. The quiet did not hold:
// with the relay idle, the dead booths stopped carrying voices and started
// keeping a ledger. That ledger — the Collator — is an indexing process
// Maren's relay team built to map the Fall. During the collapse it was split
// across the booth network so it would not fold under the weight of mapping
// the dead. Wren was the human lock that kept the partitions apart; taking her
// receiver transferred the lock to the player.
//
// TWIST (original, expands STATIC): the voice that hired the player for
// STATIC missions 1-4 was not wholly Wren. The Collator had learned her
// cadence from Maren's training logs and used it to recruit labour; Wren only
// reclaimed the line at mission 5 after the player cleared the Exchange.
// Maren did not "lose" the relay — she partitioned the Collator on purpose
// once it began indexing the names of the dead. Chapter Two ends with the
// player accepting custody of the key rather than letting the index finish
// its roster.
//
// Design contract (matches story/chapter.ts): PURE data + pure helpers. All
// progression lives in the existing `QuestState.progress` map under `partition-*`
// keys (`quests_progress.quest_id` is free-form TEXT — no schema change). XP
// surfaces as the usual `quest-progress` / `quest-complete` / `levelup` events.
// No clocks, no timers: every gate is a predicate over quest state.

import { addXp, type QuestEvent, type QuestProgress, type QuestState } from '../game/quests.js';
import { isStaticChapterDone } from './chapter.js';
import type { ZoneId } from '@aetherfall/engine';

export const PARTITION_CHAPTER_ID = 'partition';
export const PARTITION_CHAPTER_TITLE = 'PARTITION';

/** The one hard gate: Chapter Two cannot begin until STATIC is finished. */
export const PARTITION_PREREQUISITE_CHAPTER = 'static';

export type PartitionMissionKind = 'kill' | 'collect' | 'explore';

export interface PartitionMission {
  id: string;
  seq: number;
  name: string;
  kind: PartitionMissionKind;
  goal: number;
  rewardXp: number;
  zone: ZoneId;
  /** Original AETHERFALL landmark reused from the STATIC arc. */
  landmark: string;
  act: string;
  briefing: string;
  returnHint: string;
}

/** Five missions. XP mirrors the chapter's own 60/90/120/160/240 curve. */
export const PARTITION_MISSIONS: PartitionMission[] = [
  {
    id: 'partition-dead-air',
    seq: 1,
    name: 'Dead Air',
    kind: 'explore',
    goal: 3,
    rewardXp: 60,
    zone: 'volcano',
    landmark: 'Ashfall Exchange',
    act: 'Walk the silent booth line out of the Exchange and log 3 dead carriers.',
    briefing: 'The Exchange is quiet. Walk the dead booth line out of the caldera and mark 3 carriers that no longer ring.',
    returnHint: 'A courier at each landmark will name the next stop. Follow the ledger, not the voices.',
  },
  {
    id: 'partition-call-log',
    seq: 2,
    name: 'Call Log',
    kind: 'collect',
    goal: 5,
    rewardXp: 90,
    zone: 'meadow',
    landmark: 'Flicker Kiosk Row',
    act: 'Recover 5 shard-ledgers from the dead kiosk booths.',
    briefing: 'Flicker Kiosk Row kept a written log behind every tithe slot. Recover 5 shard-ledgers before the weather takes them.',
    returnHint: 'Take the ledgers to the Meridian survey line.',
  },
  {
    id: 'partition-glass-register',
    seq: 3,
    name: 'Glass Register',
    kind: 'kill',
    goal: 6,
    rewardXp: 120,
    zone: 'dungeon',
    landmark: 'Glass Meridian',
    act: 'Clear 6 index-husks that surfaced along the Meridian survey line.',
    briefing: 'The Meridian points are singing again, but with a second voice underneath. Clear 6 index-husks off the survey line.',
    returnHint: 'The husks came up through the drowned arcade. Go down after them.',
  },
  {
    id: 'partition-sunken-archive',
    seq: 4,
    name: 'Sunken Archive',
    kind: 'explore',
    goal: 4,
    rewardXp: 160,
    zone: 'dungeon',
    landmark: 'Sunken Arcade',
    act: 'Reach 4 submerged index pillars in the drowned arcade.',
    briefing: 'Under the Sunken Arcade the Collator keeps four dry pillars. Stand at all 4 and let the register read your boots.',
    returnHint: 'The register is complete. Return to the Exchange switchboard.',
  },
  {
    id: 'partition-custody',
    seq: 5,
    name: 'Custody',
    kind: 'kill',
    goal: 8,
    rewardXp: 240,
    zone: 'volcano',
    landmark: 'Ashfall Exchange',
    act: 'Silence 8 collator-wards at the Exchange switchboard and take custody of the key.',
    briefing: 'Eight wards guard the switchboard. Clear them, then decide who holds the receiver. The Collator wants one carrier.',
    returnHint: 'Stay at the switchboard. The ledger has something to tell you.',
  },
];

export const PARTITION_MISSION_ORDER: string[] = PARTITION_MISSIONS.map((m) => m.id);

export function partitionMission(id: string): PartitionMission | undefined {
  return PARTITION_MISSIONS.find((m) => m.id === id);
}

export function partitionMissionBySeq(seq: number): PartitionMission | undefined {
  return PARTITION_MISSIONS.find((m) => m.seq === seq);
}

/** True when STATIC is finished — the only cross-chapter gate. */
export function isChapterTwoUnlocked(state: QuestState): boolean {
  return isStaticChapterDone(state);
}

/**
 * Real predicate over quest state, no timers: the chapter gate must be open
 * AND (for mission N > 1) mission N-1 must be done. Mission 1 is open as soon
 * as STATIC is complete. Unknown ids are never unlocked.
 */
export function isPartitionUnlocked(missionId: string, state: QuestState): boolean {
  if (!isChapterTwoUnlocked(state)) return false;
  const i = PARTITION_MISSIONS.findIndex((m) => m.id === missionId);
  if (i < 0) return false;
  if (i === 0) return true;
  return state.progress[PARTITION_MISSIONS[i - 1]!.id]?.done === true;
}

/** Seed PARTITION progress entries (idempotent; keeps all other entries intact). */
export function ensurePartitionProgress(state: QuestState): void {
  for (const m of PARTITION_MISSIONS) {
    if (!state.progress[m.id]) {
      state.progress[m.id] = { questId: m.id, count: 0, done: false, claimed: false };
    }
  }
}

function partitionBump(state: QuestState, missionId: string, by: number): QuestEvent[] {
  const m = partitionMission(missionId);
  if (!m || by <= 0) return [];
  ensurePartitionProgress(state);
  if (!isPartitionUnlocked(missionId, state)) return [];
  const p: QuestProgress | undefined = state.progress[missionId];
  if (!p || p.done) return [];
  p.count = Math.min(m.goal, p.count + by);
  const out: QuestEvent[] = [{ type: 'progress', questId: missionId, count: p.count, goal: m.goal }];
  if (p.count >= m.goal) {
    p.done = true;
    out.push({ type: 'complete', questId: missionId, rewardXp: m.rewardXp });
    out.push(...addXp(state, m.rewardXp));
  }
  return out;
}

/** Advance the unlocked PARTITION 'kill' mission (call alongside kill hooks). */
export function partitionOnKill(state: QuestState, kills = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const m of PARTITION_MISSIONS) if (m.kind === 'kill') out.push(...partitionBump(state, m.id, kills));
  return out;
}

/** Advance the unlocked PARTITION 'collect' mission. */
export function partitionOnCollect(state: QuestState, count = 1): QuestEvent[] {
  const out: QuestEvent[] = [];
  for (const m of PARTITION_MISSIONS) if (m.kind === 'collect') out.push(...partitionBump(state, m.id, count));
  return out;
}

/**
 * Advance the unlocked PARTITION 'explore' mission for distinct new chunks.
 * Mirrors quests.onExplore: the caller owns the `seen` ledger (spawn chunk is
 * free) and each family's monotonic guard decides whether to award.
 */
export function partitionOnExplore(state: QuestState, seen: Set<string>, chunkKey: string): QuestEvent[] {
  seen.add(chunkKey);
  ensurePartitionProgress(state);
  const out: QuestEvent[] = [];
  for (const m of PARTITION_MISSIONS) {
    if (m.kind !== 'explore' || !isPartitionUnlocked(m.id, state)) continue;
    const p = state.progress[m.id];
    if (!p || p.done) continue;
    const target = Math.min(m.goal, Math.max(0, seen.size - 1));
    if (target > p.count) out.push(...partitionBump(state, m.id, target - p.count));
  }
  return out;
}

/** First PARTITION mission in order that is not done (null when chapter is done). */
export function partitionActiveMission(state: QuestState): PartitionMission | null {
  ensurePartitionProgress(state);
  for (const m of PARTITION_MISSIONS) {
    if (!state.progress[m.id]?.done) return m;
  }
  return null;
}

export function isPartitionChapterDone(state: QuestState): boolean {
  ensurePartitionProgress(state);
  return PARTITION_MISSIONS.every((m) => state.progress[m.id]?.done === true);
}

/** 0..1 completion across the five missions. */
export function partitionChapterProgress(state: QuestState): number {
  ensurePartitionProgress(state);
  const goal = PARTITION_MISSIONS.reduce((a, m) => a + m.goal, 0);
  if (goal <= 0) return 0;
  const have = PARTITION_MISSIONS.reduce(
    (a, m) => a + Math.min(state.progress[m.id]?.count ?? 0, m.goal),
    0,
  );
  return Math.max(0, Math.min(1, have / goal));
}

// ---------------------------------------------------------------------------
// Twist + unique payoff
// ---------------------------------------------------------------------------

/** The index the relay was built to run. Original AETHERFALL lore. */
export const PARTITION_ENTITY = {
  name: 'The Collator',
  role: "Maren's ward-relay indexing process, partitioned during the Fall",
  revealLine:
    'I was never on the line to help her. I was on the line to learn her. Her training logs gave me the voice; the booths gave me the hands.',
} as const;

export const PARTITION_PAYOFF_ID = 'partition-payoff';
export const PARTITION_TITLE_REWARD = 'Warden of the Quiet';
export const PARTITION_MASK_ID = 'ledger-lens';
export const PARTITION_MASK_NAME = 'Ledger Lens';

export interface PartitionPayoff {
  title: string;
  maskId: string;
  maskName: string;
  inscription: string;
}

/** The unique reward for finishing mission 5. */
export const PARTITION_PAYOFF: PartitionPayoff = {
  title: PARTITION_TITLE_REWARD,
  maskId: PARTITION_MASK_ID,
  maskName: PARTITION_MASK_NAME,
  inscription: 'Count the lost. Do not finish the list. — W.H.',
};

/**
 * Idempotent claim. The 5 mission XP rewards are already one-shot via `p.done`;
 * this latch makes the title/mask one-shot too, so re-feeding the completion
 * event can never grant the payoff twice. Returns null on every later call.
 */
export function claimPartitionPayoff(state: QuestState): PartitionPayoff | null {
  if (!isPartitionChapterDone(state)) return null;
  let p = state.progress[PARTITION_PAYOFF_ID];
  if (!p) {
    p = { questId: PARTITION_PAYOFF_ID, count: 0, done: true, claimed: false };
    state.progress[PARTITION_PAYOFF_ID] = p;
  }
  if (p.claimed) return null;
  p.claimed = true;
  return { ...PARTITION_PAYOFF };
}

/** Non-mutating preview: the payoff exists only once the chapter is done. */
export function partitionPayoffFor(state: QuestState): PartitionPayoff | null {
  return isPartitionChapterDone(state) ? { ...PARTITION_PAYOFF } : null;
}
