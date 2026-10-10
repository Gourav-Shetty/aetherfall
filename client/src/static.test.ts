// Chapter STATIC client tests: tracker walkthrough, gating, panel wiring.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ElStub } from './domstub.js';
import {
  STATIC_CALLER_NAME,
  STATIC_INTRO_CARDS,
  STATIC_TITLE_REWARD,
  STATIC_UNKNOWN_CALLER,
  StaticChapterTracker,
  staticCallFor,
  staticCallsView,
} from './quests.js';
import { IntroCardOverlay, PhoneBoothPanel, QuestLogPanel } from './panels.js';

function inner<T = ElStub>(panel: unknown, key: string): T {
  return (panel as unknown as Record<string, T>)[key]!;
}

describe('StaticChapterTracker walkthrough', () => {
  it('5 missions in order, first active', () => {
    const t = new StaticChapterTracker();
    assert.equal(t.missions.length, 5);
    assert.deepEqual(t.missions.map((m) => m.id), [
      'static-porchlight', 'static-kiosk', 'static-arcade', 'static-meridian', 'static-exchange',
    ]);
    assert.equal(t.active()!.id, 'static-porchlight');
    assert.equal(t.isChapterDone(), false);
    assert.equal(t.chapterProgress(), 0);
  });

  it('accept -> 5 missions -> twist -> reward state', () => {
    const t = new StaticChapterTracker();
    assert.equal(t.onQuestProgress('static-porchlight', 4, 4), true);
    assert.ok(t.onQuestComplete('static-porchlight'));
    assert.equal(t.active()!.id, 'static-kiosk');
    assert.equal(t.onQuestProgress('static-kiosk', 6, 6), true);
    t.onQuestComplete('static-kiosk');
    assert.equal(t.onQuestProgress('static-arcade', 6, 6), true);
    t.onQuestComplete('static-arcade');
    assert.equal(t.onQuestProgress('static-meridian', 4, 4), true);
    t.onQuestComplete('static-meridian');
    assert.equal(t.active()!.id, 'static-exchange', 'twist mission is last');
    assert.equal(t.onQuestProgress('static-exchange', 8, 8), true);
    t.onQuestComplete('static-exchange');
    assert.equal(t.isChapterDone(), true);
    assert.equal(t.active(), null);
    assert.equal(t.chapterProgress(), 1);
    assert.equal(t.archive().length, 5);
    assert.equal(STATIC_TITLE_REWARD, 'Callerbound');
  });

  it('gating: ignores non-static ids + stale counts', () => {
    const t = new StaticChapterTracker();
    assert.equal(t.onQuestProgress('ward-spark', 3, 3), false);
    assert.equal(t.onQuestComplete('ward-spark'), null);
    assert.equal(t.applyEvent('quest-progress', 'slay5', 3, 5), false);
    assert.equal(t.onQuestProgress('static-porchlight', NaN, 4), false);
    assert.equal(t.onQuestProgress('static-porchlight', 2, 4), true);
    assert.equal(t.onQuestProgress('static-porchlight', 1, 4), false, 'stale event ignored');
    assert.equal(t.applyEvent('quest-progress', 'static-porchlight', 4, 4), true);
    assert.equal(t.applyEvent('quest-complete', 'static-porchlight'), true);
    assert.equal(t.applyEvent('quest-complete', 'static-porchlight'), false, 'duplicate no-op');
  });

  it('local fallbacks only credit the active kind', () => {
    const t = new StaticChapterTracker();
    assert.equal(t.onMobDie(true), true, 'porchlight is a kill mission');
    assert.equal(t.onExploreStep(), false, 'active is kill, not explore');
    t.onQuestComplete('static-porchlight');
    assert.equal(t.onMobDie(true), false, 'kiosk is collect');
    assert.equal(t.onMobDie(false), false);
    t.onQuestComplete('static-kiosk');
    t.onQuestComplete('static-arcade');
    assert.equal(t.onExploreStep(), true, 'meridian is explore');
  });

  it('checklist marks active + archive lists completed', () => {
    const t = new StaticChapterTracker();
    let rows = t.toChecklist();
    assert.match(rows[0]!.label, /^▶ 1\. Porchlight/);
    t.onQuestComplete('static-porchlight');
    rows = t.toChecklist();
    assert.match(rows[1]!.label, /^▶ 2\. Kiosk Tithe/);
    assert.equal(rows[0]!.done, true);
    assert.deepEqual(t.archive().map((m) => m.id), ['static-porchlight']);
  });
});

describe('STATIC calls view', () => {
  it('5 calls, anonymous until the twist', () => {
    const calls = staticCallsView();
    assert.equal(calls.length, 5);
    for (const c of calls.slice(0, 4)) assert.equal(c.from, STATIC_UNKNOWN_CALLER);
    assert.equal(calls[4]!.from, STATIC_CALLER_NAME);
    assert.equal(staticCallFor('static-exchange')!.landmark, 'Ashfall Exchange');
    assert.equal(staticCallFor('nope'), undefined);
  });

  it('intro cards are 3 VHS beats', () => {
    assert.deepEqual(STATIC_INTRO_CARDS, ['EMBERFALL // AFTER THE FALL', 'CHANNEL 0 — STATIC', 'PICK UP.']);
  });
});

describe('PhoneBoothPanel', () => {
  function mount() {
    const parent = new ElStub();
    const tracker = new StaticChapterTracker();
    const panel = new PhoneBoothPanel(parent as unknown as HTMLElement, tracker);
    return { parent, tracker, panel };
  }

  it('shows UNKNOWN NUMBER for missions 1-4', () => {
    const { panel } = mount();
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.ok(html.includes('UNKNOWN NUMBER'));
    assert.ok(html.includes('Brazen Porch'));
    assert.equal(panel.render(), false, 'no tracker change -> no DOM work');
  });

  it('reveals the caller on mission 5', () => {
    const { panel, tracker } = mount();
    for (const id of ['static-porchlight', 'static-kiosk', 'static-arcade', 'static-meridian']) {
      tracker.onQuestComplete(id);
    }
    panel.pickUp();
    assert.equal(panel.render(), true);
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.ok(html.includes('Wren Halloway'));
    assert.ok(html.includes('Ashfall Exchange'));
    assert.ok(!html.includes('UNKNOWN NUMBER'));
  });

  it('advances the message as quest-progress lands', () => {
    const { panel, tracker } = mount();
    panel.render();
    tracker.onQuestComplete('static-porchlight');
    assert.equal(panel.render(), true);
    assert.ok(inner<ElStub>(panel, 'body').innerHTML.includes('Flicker Kiosk Row'));
  });

  it('hangUp hides, pickUp reopens; closes when the chapter is done', () => {
    const { panel, tracker } = mount();
    panel.render();
    panel.hangUp();
    assert.equal(panel.isDismissed, true);
    panel.render();
    assert.equal(panel.el.classList.contains('open'), false);
    panel.pickUp();
    panel.render();
    assert.equal(panel.el.classList.contains('open'), true);
    for (const m of tracker.missions) tracker.onQuestComplete(m.id);
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), false, 'no active mission -> closed');
  });

  it('escapes hostile briefing text', () => {
    const { panel, tracker } = mount();
    tracker.missions[0]!.briefing = '<img src=x>';
    tracker.revision++;
    panel.render();
    assert.ok(!inner<ElStub>(panel, 'body').innerHTML.includes('<img'));
  });
});

describe('QuestLogPanel', () => {
  function mount() {
    const parent = new ElStub();
    const tracker = new StaticChapterTracker();
    const panel = new QuestLogPanel(parent as unknown as HTMLElement, tracker);
    return { tracker, panel };
  }

  it('lists the chapter + 5 checklist rows with live counts', () => {
    const { panel } = mount();
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    const html = inner<ElStub>(panel, 'list').innerHTML;
    assert.equal((html.match(/af-qrow/g) ?? []).length, 5);
    assert.ok(html.includes('Porchlight'));
    assert.ok(inner<ElStub>(panel, 'head').textContent.includes('STATIC'));
    assert.equal(panel.render(), false);
  });

  it('live progress re-renders; archive fills as missions complete', () => {
    const { panel, tracker } = mount();
    panel.render();
    tracker.onQuestProgress('static-porchlight', 2, 4);
    assert.equal(panel.render(), true);
    assert.ok(inner<ElStub>(panel, 'list').innerHTML.includes('(2/4)'));
    tracker.onQuestComplete('static-porchlight');
    panel.render();
    assert.ok(inner<ElStub>(panel, 'archiveEl').textContent.includes('Porchlight'));
    assert.ok(inner<ElStub>(panel, 'list').innerHTML.includes('af-qrow done'));
  });

  it('reaches 100% + full archive on chapter completion', () => {
    const { panel, tracker } = mount();
    for (const m of tracker.missions) tracker.onQuestComplete(m.id);
    panel.render();
    assert.ok(inner<ElStub>(panel, 'head').textContent.includes('100%'));
    assert.ok(inner<ElStub>(panel, 'archiveEl').textContent.includes('Exchange Silence'));
  });
});

describe('IntroCardOverlay (VHS, skippable, reduced-motion safe)', () => {
  function mount(reduced = false) {
    const parent = new ElStub();
    const tracker = new StaticChapterTracker();
    const overlay = new IntroCardOverlay(parent as unknown as HTMLElement, tracker, reduced);
    return { tracker, overlay };
  }

  it('plays the 3 cards in order, then dismisses', () => {
    const { overlay, tracker } = mount();
    assert.equal(overlay.render(), true);
    assert.equal(overlay.el.classList.contains('open'), true);
    assert.equal(inner<ElStub>(overlay, 'card').textContent, STATIC_INTRO_CARDS[0]);
    overlay.next();
    overlay.render();
    assert.equal(inner<ElStub>(overlay, 'card').textContent, STATIC_INTRO_CARDS[1]);
    overlay.next();
    overlay.render();
    assert.equal(inner<ElStub>(overlay, 'card').textContent, STATIC_INTRO_CARDS[2]);
    overlay.next();
    assert.equal(tracker.currentIntroCard(), null);
    overlay.render();
    assert.equal(overlay.el.classList.contains('open'), false);
    assert.equal(overlay.render(), false, 'settled -> quiet');
  });

  it('skip() dismisses every remaining card', () => {
    const { overlay } = mount();
    overlay.render();
    overlay.skip();
    overlay.render();
    assert.equal(overlay.el.classList.contains('open'), false);
    assert.equal(overlay.dismissed, true);
  });

  it('reduced-motion flag is exposed + tagged for CSS', () => {
    const { overlay } = mount(true);
    assert.equal(overlay.isReducedMotion, true);
    assert.equal(overlay.el.getAttribute('data-motion'), 'reduced');
    overlay.setReducedMotion(false);
    assert.equal(overlay.isReducedMotion, false);
  });
});
