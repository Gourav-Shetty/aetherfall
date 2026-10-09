// AETHERFALL client — Elder Maren 5-quest chain tracker (view-model only).
//
// Mirrors server/src/game/content.ts QUEST_CHAIN (ward-spark -> heart-of-fall).
// Authoritative progress arrives as `quest-progress` / `quest-complete`
// events; `mob-die` + `xp-gain` feed a local fallback so the tracker still
// moves when those events race or drop.

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
