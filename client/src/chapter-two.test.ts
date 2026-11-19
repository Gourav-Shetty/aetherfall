// Chapter PARTITION client tests: tracker walkthrough, gating, panel event wiring.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ElStub } from './domstub.js';
import {
  ChapterTwoTracker,
  PARTITION_CHAPTER_TITLE,
  PARTITION_ENTITY_NAME,
  PARTITION_MASK_NAME,
  PARTITION_TITLE_REWARD,
  StaticChapterTracker,
} from './quests.js';
import { QuestLogPanel } from './panels.js';

function inner<T = ElStub>(panel: unknown, key: string): T {
  return (panel as unknown as Record<string, T>)[key]!;
}

function completeAll(t: ChapterTwoTracker): void {
  for (const m of t.missions) {
    t.onQuestProgress(m.id, m.goal, m.goal);
    t.onQuestComplete(m.id);
  }
}

describe('ChapterTwoTracker', () => {
  it('5 missions in order, first active', () => {
    const t = new ChapterTwoTracker();
    assert.equal(t.missions.length, 5);
    assert.deepEqual(t.missions.map((m) => m.id), [
      'partition-dead-air',
      'partition-call-log',
      'partition-glass-register',
      'partition-sunken-archive',
      'partition-custody',
    ]);
    assert.equal(t.active()!.id, 'partition-dead-air');
    assert.equal(t.isChapterDone(), false);
    assert.equal(t.chapterProgress(), 0);
  });

  it('walkthrough: progress + complete every mission', () => {
    const t = new ChapterTwoTracker();
    assert.equal(t.onQuestProgress('partition-dead-air', 3, 3), true);
    assert.ok(t.onQuestComplete('partition-dead-air'));
    assert.equal(t.active()!.id, 'partition-call-log');
    t.onQuestProgress('partition-call-log', 5, 5);
    t.onQuestComplete('partition-call-log');
    t.onQuestProgress('partition-glass-register', 6, 6);
    t.onQuestComplete('partition-glass-register');
    t.onQuestProgress('partition-sunken-archive', 4, 4);
    t.onQuestComplete('partition-sunken-archive');
    assert.equal(t.active()!.id, 'partition-custody');
    t.onQuestProgress('partition-custody', 8, 8);
    t.onQuestComplete('partition-custody');
    assert.equal(t.isChapterDone(), true);
    assert.equal(t.active(), null);
    assert.equal(t.chapterProgress(), 1);
    assert.equal(t.archive().length, 5);
    assert.equal(PARTITION_CHAPTER_TITLE, 'PARTITION');
    assert.equal(PARTITION_TITLE_REWARD, 'Warden of the Quiet');
    assert.equal(PARTITION_MASK_NAME, 'Ledger Lens');
    assert.equal(PARTITION_ENTITY_NAME, 'The Collator');
  });

  it('gating: ignores other ids + stale counts + duplicate completes', () => {
    const t = new ChapterTwoTracker();
    assert.equal(t.onQuestProgress('ward-spark', 3, 3), false);
    assert.equal(t.onQuestComplete('ward-spark'), null);
    assert.equal(t.onQuestProgress('static-porchlight', 4, 4), false);
    assert.equal(t.applyEvent('quest-progress', 'slay5', 3, 5), false);
    assert.equal(t.onQuestProgress('partition-dead-air', NaN, 3), false);
    assert.equal(t.onQuestProgress('partition-dead-air', 2, 3), true);
    assert.equal(t.onQuestProgress('partition-dead-air', 1, 3), false, 'stale event ignored');
    assert.equal(t.applyEvent('quest-progress', 'partition-dead-air', 3, 3), true);
    assert.equal(t.applyEvent('quest-complete', 'partition-dead-air'), true);
    assert.equal(t.applyEvent('quest-complete', 'partition-dead-air'), false, 'duplicate no-op');
  });

  it('local fallbacks only credit the active kind', () => {
    const t = new ChapterTwoTracker();
    assert.equal(t.onExploreStep(), true, 'dead-air is explore');
    assert.equal(t.onMobDie(true), false, 'active is explore, not kill');
    t.onQuestComplete('partition-dead-air');
    assert.equal(t.onMobDie(true), false, 'call-log is collect');
    assert.equal(t.onMobDie(false), false);
    t.onQuestComplete('partition-call-log');
    assert.equal(t.onMobDie(true), true, 'glass-register is kill');
  });

  it('checklist marks active + archive lists completed', () => {
    const t = new ChapterTwoTracker();
    let rows = t.toChecklist();
    assert.match(rows[0]!.label, /^▶ 1\. Dead Air/);
    t.onQuestComplete('partition-dead-air');
    rows = t.toChecklist();
    assert.match(rows[1]!.label, /^▶ 2\. Call Log/);
    assert.equal(rows[0]!.done, true);
    assert.deepEqual(t.archive().map((m) => m.id), ['partition-dead-air']);
  });
});

describe('Chapter Two quest-panel wiring', () => {
  function mount() {
    const parent = new ElStub();
    const staticTracker = new StaticChapterTracker();
    const c2 = new ChapterTwoTracker();
    const panel = new QuestLogPanel(parent as unknown as HTMLElement, staticTracker, c2);
    return { panel, staticTracker, c2 };
  }

  it('two-argument constructor is unchanged (no Chapter Two block)', () => {
    const parent = new ElStub();
    const panel = new QuestLogPanel(parent as unknown as HTMLElement, new StaticChapterTracker());
    assert.equal(panel.render(), true);
    assert.equal((inner<ElStub>(panel, 'list').innerHTML.match(/af-qrow/g) ?? []).length, 5);
    assert.ok(!inner<ElStub>(panel, 'head').textContent.includes('PARTITION'));
    assert.equal(panel.handleChapterTwoEvent('quest-complete', 'partition-dead-air'), false);
  });

  it('renders a Chapter Two block without touching STATIC rows', () => {
    const { panel } = mount();
    assert.equal(panel.render(), true);
    const html = inner<ElStub>(panel, 'list').innerHTML;
    assert.equal((html.match(/af-qrow/g) ?? []).length, 5, 'STATIC rows unchanged');
    assert.equal((html.match(/af-c2row/g) ?? []).length, 5, 'five PARTITION rows');
    assert.ok(html.includes('CHAPTER TWO — PARTITION'));
    assert.ok(inner<ElStub>(panel, 'head').textContent.includes('PARTITION'));
    assert.equal(panel.render(), false, 'no revision change -> no DOM work');
  });

  it('quest events route through handleChapterTwoEvent and repaint', () => {
    const { panel } = mount();
    panel.render();
    assert.equal(panel.handleChapterTwoEvent('quest-progress', 'partition-dead-air', 2, 3), true);
    assert.equal(panel.render(), true);
    assert.ok(inner<ElStub>(panel, 'list').innerHTML.includes('(2/3)'));
    assert.equal(panel.handleChapterTwoEvent('quest-complete', 'partition-dead-air'), true);
    panel.render();
    assert.ok(inner<ElStub>(panel, 'list').innerHTML.includes('af-c2row done'));
    assert.equal(panel.handleChapterTwoEvent('quest-complete', 'partition-dead-air'), false);
    assert.equal(panel.handleChapterTwoEvent('quest-complete', 'ward-spark'), false);
  });

  it('reaches 100% and a full Chapter Two block on completion', () => {
    const { panel, c2 } = mount();
    completeAll(c2);
    panel.render();
    assert.ok(inner<ElStub>(panel, 'head').textContent.includes('PARTITION · 100%'));
    assert.equal((inner<ElStub>(panel, 'list').innerHTML.match(/af-c2row done/g) ?? []).length, 5);
  });

  it('escapes hostile Chapter Two briefing text', () => {
    const { panel, c2 } = mount();
    c2.missions[0]!.briefing = '<img src=x>';
    c2.revision++;
    panel.render();
    assert.ok(!inner<ElStub>(panel, 'list').innerHTML.includes('<img'));
  });
});
