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
 * Distinct chunks only: callers pass the player's current chunk key each tick;
 * repeats are ignored via the `seen` set the caller owns per player.
 */
export function onExplore(state: QuestState, seen: Set<string>, chunkKey: string): QuestEvent[] {
  if (seen.has(chunkKey)) return [];
  seen.add(chunkKey);
  // First chunk ever seen is the spawn chunk — discovering NEW chunks counts.
  // Progress = seen.size - 1 (chunks beyond spawn).
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
