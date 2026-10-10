// AETHERFALL client — onboarding: the objective tracker, level-up banner and
// death explainer.
//
// Mirrors `server/src/game/onboarding.ts` + `server/src/game/quests.ts`
// (`WAYFARER_ROAD`, `QUEST_ROADMAP`) as view data, because the client stays
// dependency-free. Nothing here is authoritative: every count arrives on the
// EXISTING `quest-progress` / `quest-complete` events, exactly like the Maren
// chain and STATIC already do. No new wire format, no new event kind.
//
// Three small view models, each with one job:
//   TutorialTracker — the six-objective spine, step by step;
//   ObjectiveTracker — the ONE thing to do next, across every quest family;
//   LevelUpBanner   / DeathExplain — the two moments a quiet number change
//                               used to pass for.
//
// All of them are reduced-motion aware: motion is opt-in via `setReducedMotion`
// and never required to read the state.

// every objective is satisfied by a signal the live systems already emit —
// the numbers, never a guess. `esc` is re-exported so a panel built on this
// view model escapes server text by default.
import { esc } from './social.js';
import { QUEST_PLAY_ORDER } from './quests.js';

export { esc };

// ---------------------------------------------------------------------------
// Tutorial spine (mirrors server TUTORIAL_OBJECTIVES)
// ---------------------------------------------------------------------------

export interface TutorialStepView {
  id: string;
  seq: number;
  name: string;
  /** The tracker row: what you must achieve. */
  objective: string;
  /** The control or slash command that achieves it. */
  hint: string;
  rewardXp: number;
  count: number;
  done: boolean;
}

const TUTORIAL_STEPS: Array<Omit<TutorialStepView, 'count' | 'done'>> = [
  {
    id: 'tut-first-steps', seq: 1, name: 'First Steps', rewardXp: 20,
    objective: 'Walk out of the shrine clearing.',
    hint: 'Move with WASD / arrows / the joystick. The clearing is empty on purpose — leave it.',
  },
  {
    id: 'tut-first-blow', seq: 2, name: 'First Blow', rewardXp: 25,
    objective: 'Land a hit on a meadow beast.',
    hint: 'Stand next to one and hold your attack key. Swings land every 0.8s.',
  },
  {
    id: 'tut-finisher', seq: 3, name: 'Finish It', rewardXp: 40,
    objective: 'Put a beast down, then finish it while it crawls.',
    hint: 'A lethal blow knocks it down for 3s — walk up and swing again. A thrown weapon knocks down too, but never finishes.',
  },
  {
    id: 'tut-first-loot', seq: 4, name: 'First Loot', rewardXp: 35,
    objective: 'Take what it dropped.',
    hint: 'Step onto a glowing drop. Your first kill always leaves one behind.',
  },
  {
    id: 'tut-don-a-mask', seq: 5, name: 'Don a Mask', rewardXp: 45,
    objective: 'Wear any mask.',
    hint: 'Type /vocation to list the four callings — each hands you a mask. Then /mask equip <id>.',
  },
  {
    id: 'tut-signature', seq: 6, name: 'Signature', rewardXp: 65,
    objective: "Fire your calling's signature.",
    hint: 'Press your skill key (or /sig). 12s cooldown — save it for a fight you want to win.',
  },
];

export const TUTORIAL_STEP_IDS: string[] = TUTORIAL_STEPS.map((s) => s.id);

/**
 * The six-objective spine.
 *
 * Forward-only by construction: counts are clamped to the goal, stale or
 * duplicated `quest-progress` is ignored, and a finished step is never
 * reopened. That mirrors the server's own guarantees so the tracker can never
 * show a number the server has not actually granted.
 */
export class TutorialTracker {
  steps: TutorialStepView[] = TUTORIAL_STEPS.map((s) => ({ ...s, count: 0, done: false }));
  /** Bumped on every accepted event so panels can skip redundant re-renders. */
  revision = 0;
  private reducedMotion = false;

  static isTutorialId(questId: string): boolean {
    return questId.startsWith('tut-');
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  activeIndex(): number {
    return this.steps.findIndex((s) => !s.done);
  }

  active(): TutorialStepView | null {
    const i = this.activeIndex();
    return i < 0 ? null : this.steps[i]!;
  }

  isComplete(): boolean {
    return this.steps.every((s) => s.done);
  }

  completedCount(): number {
    return this.steps.filter((s) => s.done).length;
  }

  /** 0..1 across the six objectives. */
  progress(): number {
    return this.completedCount() / this.steps.length;
  }

  step(id: string): TutorialStepView | undefined {
    return this.steps.find((s) => s.id === id);
  }

  /** Authoritative `quest-progress` (absolute count, forward-only). */
  onQuestProgress(questId: string, count: number, goal: number): boolean {
    const s = this.step(questId);
    if (!s || s.done) return false;
    if (!Number.isFinite(count) || goal <= 0) return false;
    const next = Math.max(0, Math.min(1, Math.floor(count)));
    if (next <= s.count) return false;
    s.count = next;
    this.revision++;
    return true;
  }

  /** Authoritative `quest-complete`. Returns the step, or null if ignored. */
  onQuestComplete(questId: string): TutorialStepView | null {
    const s = this.step(questId);
    if (!s || s.done) return null;
    s.done = true;
    s.count = 1;
    this.revision++;
    return s;
  }

  /** Generic event entry-point, mirroring `StaticChapterTracker.applyEvent`. */
  applyEvent(kind: string, questId: string, count = 0, goal = 0): boolean {
    if (!TutorialTracker.isTutorialId(questId)) return false;
    if (kind === 'quest-progress') return this.onQuestProgress(questId, count, goal);
    if (kind === 'quest-complete') return this.onQuestComplete(questId) !== null;
    return false;
  }

  /** Compact tracker rows: the active step first, then what is queued behind. */
  toRows(): Array<{ id: string; label: string; detail: string; done: boolean; active: boolean }> {
    const active = this.activeIndex();
    return this.steps.map((s, i) => ({
      id: s.id,
      label: `${i === active ? '▶ ' : ''}${s.seq}. ${s.name}`,
      detail: s.done ? 'done' : s.objective,
      done: s.done,
      active: i === active,
    }));
  }

  /** One sentence for a screen reader / the announcement bar. */
  narrate(): string {
    const a = this.active();
    if (!a) return 'Tutorial complete. Every mechanic is yours — hunt the meadow.';
    return `Step ${a.seq} of ${this.steps.length}: ${a.objective} ${a.hint}`;
  }
}

// ---------------------------------------------------------------------------
// The spine across every quest family (mirrors server QUEST_ROADMAP)
// ---------------------------------------------------------------------------

export type TrackId = 'tutorial' | 'road' | 'trio' | 'maren' | 'chapter';

export interface RoadmapStepView {
  stage: number;
  track: TrackId;
  trackTitle: string;
  id: string;
  name: string;
  hint: string;
  count: number;
  goal: number;
  done: boolean;
}

const ROAD_STEPS: Record<string, { name: string; goal: number; hint: string }> = {
  'road-first-blood': { name: 'First Blood', goal: 1, hint: 'Kill one meadow beast. Your first kill always leaves something at the corpse.' },
  'road-pickups': { name: 'Pick It Up', goal: 3, hint: 'Walk over three drops and take them — the loot is the point of the swing.' },
  'road-hunt': { name: 'Thin the Meadow', goal: 3, hint: 'Kill three more beasts. Finishers pay bonus XP — walk up and swing again.' },
  'road-lookout': { name: 'See the Far Side', goal: 2, hint: 'Walk into two chunks you have never seen before.' },
};

const FAMILY: Record<string, { name: string; goal: number; hint: string }> = {
  slay5: { name: 'Cull the Gloom', goal: 5, hint: 'Kill five beasts. Elder Maren is waiting at the shrine (50, 50).' },
  gather10: { name: 'Shard Harvest', goal: 10, hint: 'Collect ten drops from the meadow — kill more, walk over more.' },
  explorer: { name: 'Chart the Fall', goal: 3, hint: 'Walk into three chunks you have never seen.' },
  'ward-spark': { name: 'Ward-Spark', goal: 3, hint: 'Elder Maren (shrine, 50, 50) wants three meadow beasts driven off.' },
  'ember-road': { name: 'Ember Road', goal: 5, hint: 'Gather five ember-shards along the old road.' },
  'deep-delvers': { name: 'Deep Delvers', goal: 6, hint: 'Cull six delvers in the Hollow Deep (dungeon, past the highlands).' },
  'chart-the-fall': { name: 'Chart the Fall', goal: 4, hint: 'Chart four new chunks beyond the highlands.' },
  'heart-of-fall': { name: 'Heart of the Fall', goal: 8, hint: 'Fell eight horrors in the Ashfall Caldera. Maren promises the Ward Blade.' },
  'static-porchlight': { name: 'Porchlight', goal: 4, hint: 'Brazen Porch (meadow edge). Clear four, then lift a call-booth receiver.' },
  'static-kiosk': { name: 'Kiosk Tithe', goal: 6, hint: 'Flicker Kiosk Row. Gather six ember-shards from the dead booths.' },
  'static-arcade': { name: 'Arcade Sweep', goal: 6, hint: 'Sunken Arcade, under the Hollow Deep. Clear six delvers.' },
  'static-meridian': { name: 'Meridian Walk', goal: 4, hint: 'Glass Meridian. Reach four new survey points.' },
  'static-exchange': { name: 'Exchange Silence', goal: 8, hint: 'Ashfall Exchange, in the caldera. Silence eight horrors.' },
};

/** Track titles, derived from the shared play order so the two cannot drift. */
const TRACK_TITLE: Record<TrackId, string> = Object.fromEntries(
  QUEST_PLAY_ORDER.map((e) => [e.track, e.title]),
) as Record<TrackId, string>;

/**
 * The roadmap in play order — stage 1 first.
 *
 * Built from `QUEST_PLAY_ORDER` (client/src/quests.ts), which mirrors the
 * server's `QUEST_ROADMAP` so the stage numbers a player is shown can never
 * drift between the two trackers.
 */
export const CLIENT_ROADMAP: Array<{ stage: number; track: TrackId; ids: string[] }> =
  QUEST_PLAY_ORDER.map((e) => ({ stage: e.stage, track: e.track, ids: [...e.ids] }));

/** Copy for the "the spine is finished" state — never an empty screen. */
export const SPINE_COMPLETE_LINE =
  'The road is open. Keep hunting in the meadow — every beast you fell feeds Elder Maren at the shrine (50, 50).';

export interface ObjectiveRow {
  id: string;
  trackTitle: string;
  name: string;
  hint: string;
  count: number;
  goal: number;
  done: boolean;
}

/**
 * The persistent objective tracker.
 *
 * Holds one live count per quest id — fed by the same `quest-progress` /
 * `quest-complete` events the rest of the UI already handles — and answers
 * exactly one question: what do I do next? It walks the roadmap in order, so
 * it can never point at a locked quest while an open one sits behind it, and
 * it always shows the objective plus the control that achieves it.
 */
export class ObjectiveTracker {
  /** questId -> absolute count reported by the server. */
  readonly counts = new Map<string, number>();
  readonly done = new Set<string>();
  revision = 0;
  private reducedMotion = false;

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Absolute counts only move forward, and never past the goal. */
  onQuestProgress(questId: string, count: number, goal: number): boolean {
    if (!Number.isFinite(count) || goal <= 0) return false;
    const next = Math.max(0, Math.min(goal, Math.floor(count)));
    if (this.done.has(questId)) return false;
    const have = this.counts.get(questId) ?? 0;
    if (next <= have) return false;
    this.counts.set(questId, next);
    this.revision++;
    return true;
  }

  /** Idempotent: a duplicate `quest-complete` is a no-op. */
  onQuestComplete(questId: string): boolean {
    if (this.done.has(questId)) return false;
    this.done.add(questId);
    const goal = goalOf(questId);
    this.counts.set(questId, Math.max(this.counts.get(questId) ?? 0, goal));
    this.revision++;
    return true;
  }

  applyEvent(kind: string, questId: string, count = 0, goal = 0): boolean {
    if (kind === 'quest-progress') return this.onQuestProgress(questId, count, goal);
    if (kind === 'quest-complete') return this.onQuestComplete(questId);
    return false;
  }

  /** True when the id belongs to any onboarding family. */
  isOnboardingId(questId: string): boolean {
    return questId.startsWith('tut-') || questId.startsWith('road-');
  }

  count(questId: string): number {
    return this.counts.get(questId) ?? 0;
  }

  isDone(questId: string): boolean {
    return this.done.has(questId);
  }

  /** The one thing to do next, or null when the whole roadmap is cleared. */
  next(): RoadmapStepView | null {
    for (const entry of CLIENT_ROADMAP) {
      for (const id of entry.ids) {
        if (this.done.has(id)) continue;
        return this.describe(entry.stage, entry.track, id);
      }
    }
    return null;
  }

  /** The row immediately behind the active one — proves the "next next". */
  upcoming(count = 1): RoadmapStepView[] {
    const out: RoadmapStepView[] = [];
    let seenActive = false;
    for (const entry of CLIENT_ROADMAP) {
      for (const id of entry.ids) {
        if (this.done.has(id)) continue;
        if (!seenActive) {
          seenActive = true;
          if (out.length >= count) return out;
          continue;
        }
        out.push(this.describe(entry.stage, entry.track, id));
        if (out.length >= count) return out;
      }
    }
    return out;
  }

  describe(stage: number, track: TrackId, id: string): RoadmapStepView {
    const tut = TUTORIAL_STEPS.find((s) => s.id === id);
    const info: { name: string; goal: number; hint: string } | undefined =
      tut ? { name: tut.name, goal: 1, hint: tut.hint } : (ROAD_STEPS[id] ?? FAMILY[id]);
    return {
      stage,
      track,
      trackTitle: TRACK_TITLE[track],
      id,
      name: info?.name ?? id,
      hint: info?.hint ?? 'Keep going.',
      count: this.count(id),
      goal: info?.goal ?? Math.max(1, this.count(id)),
      done: this.done.has(id),
    };
  }

  /** Every step of the current track, in play order, with live counts. */
  trackRows(track: TrackId): RoadmapStepView[] {
    const entry = CLIENT_ROADMAP.find((e) => e.track === track)!;
    return entry.ids.map((id) => this.describe(entry.stage, entry.track, id));
  }

  /**
   * The compact body the tracker panel renders. Always non-empty: a cleared
   * roadmap falls back to the free-roam line rather than an empty box.
   */
  body(): { heading: string; headline: string; detail: string; progress: string } {
    const next = this.next();
    if (!next) {
      return {
        heading: 'ROAD COMPLETE',
        headline: 'The meadow is yours.',
        detail: SPINE_COMPLETE_LINE,
        progress: '',
      };
    }
    const count = next.goal > 1 ? ` (${countLabel(next.count, next.goal)})` : '';
    return {
      heading: next.trackTitle,
      headline: `${next.name}${count}`,
      detail: next.hint,
      progress: countLabel(next.count, next.goal),
    };
  }
}

/**
 * Display name for any spine quest id, or null when the id is not on the
 * spine. Lets a caller announce a completion without knowing which family it
 * belongs to.
 */
export function spineLabel(questId: string): string | null {
  const tut = TUTORIAL_STEPS.find((s) => s.id === questId);
  if (tut) return tut.name;
  return ROAD_STEPS[questId]?.name ?? FAMILY[questId]?.name ?? null;
}

function goalOf(questId: string): number {
  const tut = TUTORIAL_STEPS.find((s) => s.id === questId);
  if (tut) return 1;
  return ROAD_STEPS[questId]?.goal ?? FAMILY[questId]?.goal ?? 1;
}

// ---------------------------------------------------------------------------
// Level-up banner
// ---------------------------------------------------------------------------

export interface LevelUpView {
  level: number;
  prevLevel: number;
  xpIntoLevel: number;
  xpForNext: number;
  talentPoints: number | null;
  /** One line, already written for the player. */
  headline: string;
  detail: string;
  /** True while the banner should be on screen. */
  show: boolean;
}

/**
 * Level-up feedback model.
 *
 * A level-up used to be a number ticking over on a bar — indistinguishable
 * from any other number tick. The banner turns it into an event with a
 * headline, the numbers that produced it, and — when the systems path supplies
 * them — the talent point that came with it.
 *
 * `holdMs` is the time the banner stays up. Reduced motion does not shorten it
 * (the player still needs to read it); it only removes the entrance animation,
 * which the panel keys off `isReducedMotion`.
 */
export class LevelUpBanner {
  private view: LevelUpView = blank();
  private reducedMotion = false;
  holdMs = 2600;
  private until = 0;

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** Feed the `levelup` event payload (legacy and systems shapes both work). */
  raise(payload: Record<string, unknown> | null | undefined, now = 0): LevelUpView | null {
    const level = numOf(payload?.['level']);
    if (level === null || level < 2) return null;
    const prev = numOf(payload?.['prevLevel']) ?? Math.max(1, level - 1);
    const into = Math.max(0, numOf(payload?.['xpLeft']) ?? numOf(payload?.['xp']) ?? 0);
    const need = Math.max(1, numOf(payload?.['xpForNext']) ?? numOf(payload?.['next']) ?? level * 100);
    const talent = numOf(payload?.['talentPointsGained']);
    this.view = {
      level,
      prevLevel: prev,
      xpIntoLevel: Math.min(into, need),
      xpForNext: need,
      talentPoints: talent,
      headline: `LEVEL ${level}`,
      detail:
        talent !== null && talent > 0
          ? `${into} / ${need} XP · +${talent} talent point${talent === 1 ? '' : 's'} · /talent to spend it`
          : `${into} / ${need} XP · +3 damage per swing`,
      show: true,
    };
    this.until = now + this.holdMs;
    return this.view;
  }

  /** Advance the auto-dismiss clock; returns true when the banner just hid. */
  tick(now: number): boolean {
    if (!this.view.show) return false;
    if (now < this.until) return false;
    this.view = { ...this.view, show: false };
    return true;
  }

  current(): LevelUpView {
    return { ...this.view };
  }

  dismiss(): void {
    this.view = { ...this.view, show: false };
  }

  get motionEnabled(): boolean {
    return !this.reducedMotion;
  }
}

function blank(): LevelUpView {
  return {
    level: 1,
    prevLevel: 0,
    xpIntoLevel: 0,
    xpForNext: 100,
    talentPoints: null,
    headline: '',
    detail: '',
    show: false,
  };
}

function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Death explainer
// ---------------------------------------------------------------------------

/** Where a dead player wakes, and what it costs. Mirrors server deathNotice(). */
export const RESPAWN_POINT = { x: 50, y: 50 };
export const RESPAWN_LABEL = 'the Ward Shrine (50, 50)';
export const RESPAWN_PROTECTION_S = 3;

export interface DeathView {
  title: string;
  body: string;
  respawnLabel: string;
  penalty: string;
  show: boolean;
}

/**
 * Death feedback model.
 *
 * The respawn path itself is untouched — the server still moves the player and
 * broadcasts `respawn` (with a 0-HP snapshot as the fallback trigger). All
 * this adds is the sentence that was missing: what happened, where you wake,
 * and the fact that nothing was taken from you.
 */
export class DeathExplain {
  private view: DeathView = blankDeath();
  /** Roughly matches the death overlay's own 2.5s, plus a short tail so a
   *  screen-reader user finishes the sentence. */
  holdMs = 3200;
  private until = 0;

  /** Build the notice from a `respawn` payload (or nothing, for the fallback). */
  raise(killer?: string, now = 0): DeathView {
    const who = killer && killer.length > 0 ? ` Killed by ${killer}.` : '';
    this.view = {
      title: 'YOU FELL',
      body: `The meadow beasts finished what your health could not.${who} Nothing is lost — you keep every item, quest and level.`,
      respawnLabel: `You wake at ${RESPAWN_LABEL} with ${RESPAWN_PROTECTION_S}s of protection.`,
      penalty: 'No XP lost. No items lost.',
      show: true,
    };
    this.until = now + this.holdMs;
    return { ...this.view };
  }

  tick(now: number): boolean {
    if (!this.view.show) return false;
    if (now < this.until) return false;
    this.view = { ...this.view, show: false };
    return true;
  }

  current(): DeathView {
    return { ...this.view };
  }

  dismiss(): void {
    this.view = { ...this.view, show: false };
  }
}

function blankDeath(): DeathView {
  return { title: '', body: '', respawnLabel: '', penalty: '', show: false };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** `3/5`, or `''` for a 1-step objective (a bare `1/1` reads as noise). */
export function countLabel(count: number, goal: number): string {
  if (goal <= 1) return '';
  return `${Math.min(count, goal)}/${goal}`;
}