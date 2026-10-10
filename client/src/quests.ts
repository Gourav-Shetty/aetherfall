// AETHERFALL client — Elder Maren 5-quest chain tracker (view-model only).
//
// Mirrors server/src/game/content.ts QUEST_CHAIN (ward-spark -> heart-of-fall).
// Authoritative progress arrives as `quest-progress` / `quest-complete`
// events; `mob-die` + `xp-gain` feed a local fallback so the tracker still
// moves when those events race or drop.
//
// SCOPE: this tracker is the MAREN CHAIN panel — the five quests Elder Maren
// offers at the shrine. It deliberately knows nothing about the onboarding
// spine (the six `tut-*` objectives and the four `road-*` ladder steps): those
// are surfaced separately and always-on by the objective tracker in
// `onboarding.ts` / `panels.ts`, which is the thing that answers "what do I
// do next". Keeping the two apart means a returning player's Maren list is
// never overwritten by a tutorial, and a new player's chain list is never
// used as their to-do list. `QUEST_PLAY_ORDER` below is the shared spine both
// views read for stage numbers.

import type { TrackId } from './onboarding.js';

/**
 * Canonical play order across every auto-advancing quest family — mirrors
 * `QUEST_ROADMAP` / `onboardingRoadmap()` on the server. Presentation order
 * only; it never gates accrual, so nothing here can make a quest
 * unreachable.
 */
export const QUEST_PLAY_ORDER: Array<{ stage: number; track: TrackId; title: string; ids: string[] }> = [
  { stage: 1, track: 'tutorial', title: 'FIRST FIVE MINUTES', ids: ['tut-first-steps', 'tut-first-blow', 'tut-finisher', 'tut-first-loot', 'tut-don-a-mask', 'tut-signature'] },
  { stage: 2, track: 'road', title: "WAYFARER'S ROAD", ids: ['road-first-blood', 'road-pickups', 'road-hunt', 'road-lookout'] },
  { stage: 3, track: 'trio', title: "WANDERER'S TASKS", ids: ['slay5', 'gather10', 'explorer'] },
  { stage: 4, track: 'maren', title: 'ELDER MAREN', ids: ['ward-spark', 'ember-road', 'deep-delvers', 'chart-the-fall', 'heart-of-fall'] },
  { stage: 5, track: 'chapter', title: 'CHAPTER — STATIC', ids: ['static-porchlight', 'static-kiosk', 'static-arcade', 'static-meridian', 'static-exchange'] },
];

/** Stage number + track title for a quest id, or null when it is not on the spine. */
export function playOrderStage(questId: string): { stage: number; track: TrackId; title: string } | null {
  for (const entry of QUEST_PLAY_ORDER) {
    if (entry.ids.includes(questId)) return { stage: entry.stage, track: entry.track, title: entry.title };
  }
  return null;
}

/** Ids belonging to the onboarding spine (tutorial track + Road ladder). */
export function isSpineQuestId(questId: string): boolean {
  const t = questId.startsWith('tut-');
  const r = questId.startsWith('road-');
  return t || r;
}

export interface ChainQuestView {
  id: string;
  name: string;
  kind: 'kill' | 'collect' | 'explore';
  goal: number;
  briefing: string;
  count: number;
  done: boolean;
}

export interface HudQuest {
  title: string;
  obj: string;
  done?: boolean;
}

const CHAIN: Array<{ id: string; name: string; kind: 'kill' | 'collect' | 'explore'; goal: number; briefing: string }> = [
  { id: 'ward-spark', name: 'Ward-Spark', kind: 'kill', goal: 3, briefing: 'Drive off 3 meadow gloomfangs for Elder Maren.' },
  { id: 'ember-road', name: 'Ember Road', kind: 'collect', goal: 5, briefing: 'Gather 5 ember-shards along the old road.' },
  { id: 'deep-delvers', name: 'Deep Delvers', kind: 'kill', goal: 6, briefing: 'Cull 6 Hollow Deep delvers.' },
  { id: 'chart-the-fall', name: 'Chart the Fall', kind: 'explore', goal: 4, briefing: 'Chart 4 new chunks beyond the highlands.' },
  { id: 'heart-of-fall', name: 'Heart of the Fall', kind: 'kill', goal: 8, briefing: 'Fell 8 volcano horrors. Maren promises the Ward Blade.' },
];

export class ChainTracker {
  quests: ChainQuestView[] = CHAIN.map((q) => ({ ...q, count: 0, done: false }));
  /** Local kill fallback (authoritative quest-progress wins when present). */
  private localKills = 0;

  /** First quest in chain order that is not done (-1 when the chain is done). */
  activeIndex(): number {
    return this.quests.findIndex((q) => !q.done);
  }

  isChainDone(): boolean {
    return this.quests.every((q) => q.done);
  }

  /**
   * Authoritative `quest-progress` event: `{ playerId, type:'progress',
   * questId, count, goal }` (server/src/game/index.ts questEvent()).
   * Authoritative counts are absolute, so they win over local fallbacks —
   * but only forward progress counts (a stale/duplicated event is ignored).
   */
  onQuestProgress(questId: string, count: number, goal: number): boolean {
    const q = this.quests.find((x) => x.id === questId);
    if (!q || q.done) return false;
    if (!Number.isFinite(count) || !Number.isFinite(goal) || goal <= 0) return false;
    const next = Math.max(0, Math.min(q.goal, Math.floor(count)));
    if (next <= q.count) return false;
    q.count = next;
    return true;
  }

  /** Returns the completed quest, if this event finished one. */
  onQuestComplete(questId: string): ChainQuestView | null {
    const q = this.quests.find((x) => x.id === questId);
    if (!q || q.done) return null;
    q.done = true;
    q.count = q.goal;
    return q;
  }

  /**
   * Local fallback: a mob died to anyone. Only advances the ACTIVE quest when
   * it is a kill quest and the server has not already reported progress for it
   * (prevents double-counting when quest-progress arrives for the same kill).
   */
  onMobDie(killedByMe: boolean, serverCountForActive: number | null = null): boolean {
    if (!killedByMe) return false;
    this.localKills++;
    const i = this.activeIndex();
    if (i < 0) return false;
    const q = this.quests[i]!;
    if (q.kind !== 'kill') return false;
    if (serverCountForActive !== null && serverCountForActive >= q.count) return false;
    if (q.count >= q.goal) return false;
    q.count = Math.min(q.goal, q.count + 1);
    return true;
  }

  /** xp-gain implies combat happened; no direct count — kept for HUD parity. */
  onXpGain(_amount: number): void {
    // Intentionally count-free: kills flow through onMobDie / quest-progress.
  }

  /**
   * Local explore fallback: the player stepped into a chunk they had not
   * visited before (driven by fog.ts chunk keys). Only advances the ACTIVE
   * quest while it is an 'explore' quest — authoritative `quest-progress`
   * for the same id still wins because it carries a higher count.
   */
  onExploreStep(): boolean {
    const i = this.activeIndex();
    if (i < 0) return false;
    const q = this.quests[i]!;
    if (q.kind !== 'explore' || q.count >= q.goal) return false;
    q.count = Math.min(q.goal, q.count + 1);
    return true;
  }

  /** 0..1 completion of the whole chain (HUD/debug + toast copy). */
  chainProgress(): number {
    const goal = this.quests.reduce((a, q) => a + q.goal, 0);
    if (goal <= 0) return 0;
    const have = this.quests.reduce((a, q) => a + Math.min(q.count, q.goal), 0);
    return Math.max(0, Math.min(1, have / goal));
  }

  questById(id: string): ChainQuestView | undefined {
    return this.quests.find((q) => q.id === id);
  }

  localKillCount(): number {
    return this.localKills;
  }

  /** HUD shape: title + objective with live count, active quest marked ▶. */
  toHud(): HudQuest[] {
    const active = this.activeIndex();
    return this.quests.map((q, i) => ({
      title: (i === active ? '▶ ' : '') + q.name + ` (${Math.min(q.count, q.goal)}/${q.goal})`,
      obj: q.briefing,
      done: q.done,
    }));
  }
}

// ---------------------------------------------------------------------------
// Chapter "STATIC" — client view-model (ADDITIVE).
// ---------------------------------------------------------------------------
// Mirrors server/src/story/chapter.ts + calls.ts (copied as data so the client
// stays dependency-free). Authoritative progress arrives as the SAME
// `quest-progress` / `quest-complete` events the Maren chain uses — this
// tracker only listens for `static-*` ids, so the two chapters never collide.

export const STATIC_CHAPTER_ID = 'static';
export const STATIC_CHAPTER_TITLE = 'STATIC';
export const STATIC_UNKNOWN_CALLER = 'UNKNOWN NUMBER';
export const STATIC_CALLER_NAME = 'Wren Halloway';
export const STATIC_MASK_NAME = 'Hollow Receiver';
export const STATIC_TITLE_REWARD = 'Callerbound';

export interface StaticMissionView {
  id: string;
  seq: number;
  name: string;
  kind: 'kill' | 'collect' | 'explore';
  goal: number;
  briefing: string;
  landmark: string;
  returnHint: string;
  count: number;
  done: boolean;
}

export interface StaticCallView {
  missionId: string;
  seq: number;
  from: string;
  subject: string;
  lines: string[];
  landmark: string;
}

const STATIC_MISSIONS_VIEW: Array<Omit<StaticMissionView, 'count' | 'done'>> = [
  { id: 'static-porchlight', seq: 1, name: 'Porchlight', kind: 'kill', goal: 4, briefing: 'Go to the Brazen Porch. Clear 4 mobs. Then pick up the next message.', landmark: 'Brazen Porch', returnHint: 'Return to any call-booth and lift the receiver.' },
  { id: 'static-kiosk', seq: 2, name: 'Kiosk Tithe', kind: 'collect', goal: 6, briefing: 'Go to Flicker Kiosk Row. Gather 6 ember-shards.', landmark: 'Flicker Kiosk Row', returnHint: 'Return to any call-booth and lift the receiver.' },
  { id: 'static-arcade', seq: 3, name: 'Arcade Sweep', kind: 'kill', goal: 6, briefing: 'Go to the Sunken Arcade. Clear 6 delvers.', landmark: 'Sunken Arcade', returnHint: 'Return to any call-booth and lift the receiver.' },
  { id: 'static-meridian', seq: 4, name: 'Meridian Walk', kind: 'explore', goal: 4, briefing: 'Walk the Glass Meridian. Reach 4 new points.', landmark: 'Glass Meridian', returnHint: 'Return to any call-booth for the final message.' },
  { id: 'static-exchange', seq: 5, name: 'Exchange Silence', kind: 'kill', goal: 8, briefing: 'Go to the Ashfall Exchange. Silence 8 horrors. The caller answers in person.', landmark: 'Ashfall Exchange', returnHint: 'Stay on the line. She is already there.' },
];

const STATIC_CALLS_VIEW: StaticCallView[] = [
  { missionId: 'static-porchlight', seq: 1, from: STATIC_UNKNOWN_CALLER, subject: 'MSG 01 — PORCHLIGHT', landmark: 'Brazen Porch', lines: ['Do not say your name. The line remembers names.', 'South gate. Brazen Porch. Four of them. Quiet work.', 'When the porch burns blue again, lift any receiver.'] },
  { missionId: 'static-kiosk', seq: 2, from: STATIC_UNKNOWN_CALLER, subject: 'MSG 02 — KIOSK TITHE', landmark: 'Flicker Kiosk Row', lines: ['Good. You pick up. Most do not.', 'Six ember-shards, still in the dead booths. Count them on the line.'] },
  { missionId: 'static-arcade', seq: 3, from: STATIC_UNKNOWN_CALLER, subject: 'MSG 03 — ARCADE SWEEP', landmark: 'Sunken Arcade', lines: ['Sunken Arcade, under the Deep. Six delvers in the dry spots.', 'Someone will offer coin to stop. Do not stop.'] },
  { missionId: 'static-meridian', seq: 4, from: STATIC_UNKNOWN_CALLER, subject: 'MSG 04 — MERIDIAN WALK', landmark: 'Glass Meridian', lines: ['Glass Meridian. Four points still sing when you stand on them.', 'One message left after this.'] },
  { missionId: 'static-exchange', seq: 5, from: STATIC_CALLER_NAME, subject: 'MSG 05 — EXCHANGE SILENCE', landmark: 'Ashfall Exchange', lines: ['No more booths. Come to the Ashfall Exchange.', 'I am Wren Halloway — Maren taught me the relays. Take my receiver.'] },
];

export function staticCallsView(): StaticCallView[] {
  return STATIC_CALLS_VIEW.map((c) => ({ ...c, lines: [...c.lines] }));
}

export function staticCallFor(missionId: string): StaticCallView | undefined {
  return STATIC_CALLS_VIEW.find((c) => c.missionId === missionId);
}

/** VHS-style chapter intro cards (client overlay text, skippable). */
export const STATIC_INTRO_CARDS: string[] = [
  'EMBERFALL // AFTER THE FALL',
  'CHANNEL 0 — STATIC',
  'PICK UP.',
];

/**
 * Chapter STATIC tracker: mission checklist with live progress off the
 * existing `quest-progress` / `quest-complete` events, plus a completed
 * archive. Ignores every non-`static-*` id so Maren-chain traffic passes
 * through untouched.
 */
export class StaticChapterTracker {
  missions: StaticMissionView[] = STATIC_MISSIONS_VIEW.map((m) => ({ ...m, count: 0, done: false }));
  /** Bump on every accepted event so panels can skip redundant re-renders. */
  revision = 0;
  /** Intro-card overlay state (VHS cards, skippable). */
  introIndex = 0;
  introDismissed = false;

  static isStaticId(questId: string): boolean {
    return questId.startsWith('static-');
  }

  activeIndex(): number {
    return this.missions.findIndex((m) => !m.done);
  }

  active(): StaticMissionView | null {
    const i = this.activeIndex();
    return i < 0 ? null : this.missions[i]!;
  }

  isChapterDone(): boolean {
    return this.missions.every((m) => m.done);
  }

  missionById(id: string): StaticMissionView | undefined {
    return this.missions.find((m) => m.id === id);
  }

  /** Authoritative `quest-progress` (absolute counts, forward-only). */
  onQuestProgress(questId: string, count: number, goal: number): boolean {
    const m = this.missionById(questId);
    if (!m || m.done) return false;
    if (!Number.isFinite(count) || !Number.isFinite(goal) || goal <= 0) return false;
    const next = Math.max(0, Math.min(m.goal, Math.floor(count)));
    if (next <= m.count) return false;
    m.count = next;
    this.revision++;
    return true;
  }

  /** Authoritative `quest-complete` (pins count to goal, archives the mission). */
  onQuestComplete(questId: string): StaticMissionView | null {
    const m = this.missionById(questId);
    if (!m || m.done) return null;
    m.done = true;
    m.count = m.goal;
    this.revision++;
    return m;
  }

  /** Local kill fallback: only the ACTIVE kill mission, no double-count. */
  onMobDie(killedByMe: boolean, serverCountForActive: number | null = null): boolean {
    if (!killedByMe) return false;
    const a = this.active();
    if (!a || a.kind !== 'kill' || a.count >= a.goal) return false;
    if (serverCountForActive !== null && serverCountForActive >= a.count) return false;
    a.count = Math.min(a.goal, a.count + 1);
    this.revision++;
    return true;
  }

  /** Local explore fallback: only the ACTIVE explore mission. */
  onExploreStep(): boolean {
    const a = this.active();
    if (!a || a.kind !== 'explore' || a.count >= a.goal) return false;
    a.count = Math.min(a.goal, a.count + 1);
    this.revision++;
    return true;
  }

  /** Completed missions, in order (the archive). */
  archive(): StaticMissionView[] {
    return this.missions.filter((m) => m.done);
  }

  /** 0..1 across the five missions. */
  chapterProgress(): number {
    const goal = this.missions.reduce((x, m) => x + m.goal, 0);
    if (goal <= 0) return 0;
    const have = this.missions.reduce((x, m) => x + Math.min(m.count, m.goal), 0);
    return Math.max(0, Math.min(1, have / goal));
  }

  /** Checklist rows for the quest-log panel (active marked ▶). */
  toChecklist(): Array<{ id: string; label: string; detail: string; done: boolean; active: boolean }> {
    const active = this.activeIndex();
    return this.missions.map((m, i) => ({
      id: m.id,
      label: `${i === active ? '▶ ' : ''}${m.seq}. ${m.name} (${Math.min(m.count, m.goal)}/${m.goal})`,
      detail: `${m.landmark} — ${m.briefing}`,
      done: m.done,
      active: i === active,
    }));
  }

  /** Generic event entry-point: routes `quest-progress` / `quest-complete`. */
  applyEvent(kind: string, questId: string, count = 0, goal = 0): boolean {
    if (!StaticChapterTracker.isStaticId(questId)) return false;
    if (kind === 'quest-progress') return this.onQuestProgress(questId, count, goal);
    if (kind === 'quest-complete') return this.onQuestComplete(questId) !== null;
    return false;
  }

  // -- intro cards (VHS overlay, skippable) --

  currentIntroCard(): string | null {
    if (this.introDismissed || this.introIndex >= STATIC_INTRO_CARDS.length) return null;
    return STATIC_INTRO_CARDS[this.introIndex]!;
  }

  advanceIntro(): string | null {
    if (this.introDismissed) return null;
    this.introIndex++;
    this.revision++;
    if (this.introIndex >= STATIC_INTRO_CARDS.length) this.introDismissed = true;
    return this.currentIntroCard();
  }

  skipIntro(): void {
    this.introDismissed = true;
    this.introIndex = STATIC_INTRO_CARDS.length;
    this.revision++;
  }

  resetIntro(): void {
    this.introDismissed = false;
    this.introIndex = 0;
    this.revision++;
  }
}
