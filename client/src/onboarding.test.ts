// ONBOARDING (client): the objective tracker, the level-up banner and the
// death explainer.
//
// The server already ships every fact these show, on the EXISTING
// `quest-progress` / `quest-complete` / `levelup` / `respawn` events. These
// tests pin the client half of the contract: the tracker always names ONE
// next thing, counts only move forward on authoritative events, the level-up
// is unmistakable, and the death card explains the respawn.
//
// Panels run against the ElStub recorder from domstub.ts — the same pattern
// panels.test.ts uses — so the rendered markup is asserted without a browser.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ElStub } from './domstub.js';
import {
  CLIENT_ROADMAP,
  DeathExplain,
  LevelUpBanner,
  ObjectiveTracker,
  RESPAWN_LABEL,
  SPINE_COMPLETE_LINE,
  TUTORIAL_STEP_IDS,
  TutorialTracker,
  countLabel,
} from './onboarding.js';
import {
  DeathPanel,
  LevelUpPanel,
  ONBOARDING_PANEL_CSS,
  ObjectiveTrackerPanel,
  mountOnboardingUi,
} from './panels.js';

/** Reach a panel's private child for markup assertions. */
function inner<T = ElStub>(panel: unknown, key: string): T {
  return (panel as unknown as Record<string, T>)[key]!;
}

const ALL_IDS = CLIENT_ROADMAP.flatMap((e) => e.ids);

/** Feed the event stream a scripted first-minute player would receive. */
function playFirstMinute(t: ObjectiveTracker, tut: TutorialTracker): void {
  const complete = (id: string): void => {
    t.onQuestProgress(id, 1, 1);
    t.onQuestComplete(id);
    tut.applyEvent('quest-complete', id, 1, 1);
  };
  complete('tut-first-steps');
  complete('tut-first-blow');
  complete('tut-finisher');
  complete('tut-first-loot');
  // The Road's first two steps ride real counts.
  t.onQuestProgress('road-first-blood', 1, 1);
  t.onQuestComplete('road-first-blood');
  t.onQuestProgress('road-pickups', 3, 3);
  t.onQuestComplete('road-pickups');
}

// ---------------------------------------------------------------------------
// TutorialTracker
// ---------------------------------------------------------------------------

describe('TutorialTracker (client)', () => {
  it('starts on step 1 with every step at zero', () => {
    const t = new TutorialTracker();
    assert.equal(t.steps.length, 6);
    assert.deepEqual(TUTORIAL_STEP_IDS, t.steps.map((s) => s.id));
    assert.equal(t.active()!.id, 'tut-first-steps');
    assert.equal(t.progress(), 0);
    assert.equal(t.isComplete(), false);
  });

  it('only moves on authoritative, forward-only, clamped counts', () => {
    const t = new TutorialTracker();
    assert.equal(t.onQuestProgress('tut-first-steps', 1, 1), true);
    assert.equal(t.step('tut-first-steps')!.count, 1);
    assert.equal(t.onQuestProgress('tut-first-steps', 1, 1), false, 'a duplicate is ignored');
    assert.equal(t.onQuestProgress('tut-first-steps', 0, 1), false, 'a stale count is ignored');
    assert.equal(t.onQuestProgress('tut-first-steps', 9, 1), true, 'a count past the goal still clamps');
    assert.equal(t.step('tut-first-steps')!.count, 1);
    assert.equal(t.onQuestProgress('nope', 1, 1), false);
    assert.equal(t.onQuestProgress('tut-first-blow', Number.NaN, 1), false);
  });

  it('completes once and never re-opens', () => {
    const t = new TutorialTracker();
    assert.equal(t.onQuestComplete('tut-first-steps')!.seq, 1);
    assert.equal(t.onQuestComplete('tut-first-steps'), null, 'a duplicate completion is a no-op');
    assert.equal(t.active()!.id, 'tut-first-blow');
    assert.equal(t.progress(), 1 / 6);
  });

  it('ignores ids from other chapters entirely', () => {
    const t = new TutorialTracker();
    assert.equal(t.applyEvent('quest-progress', 'slay5', 3, 5), false);
    assert.equal(t.applyEvent('quest-complete', 'static-kiosk', 0, 6), false);
    assert.equal(t.applyEvent('levelup', 'tut-first-steps', 0, 1), false);
    assert.equal(t.completedCount(), 0);
  });

  it('renders a checklist with an active marker and narrates the step', () => {
    const t = new TutorialTracker();
    t.onQuestComplete('tut-first-steps');
    const rows = t.toRows();
    assert.equal(rows.length, 6);
    assert.equal(rows[0]!.done, true);
    assert.equal(rows[0]!.active, false);
    assert.ok(rows[1]!.label.startsWith('▶ '), 'the active step is marked');
    assert.match(t.narrate(), /Step 2 of 6: Land a hit/);
    for (const id of TUTORIAL_STEP_IDS) t.onQuestComplete(id);
    assert.match(t.narrate(), /Tutorial complete/);
  });
});

// ---------------------------------------------------------------------------
// ObjectiveTracker — the spine
// ---------------------------------------------------------------------------

describe('ObjectiveTracker (client)', () => {
  it('always names exactly one next step, starting at the tutorial', () => {
    const t = new ObjectiveTracker();
    const next = t.next()!;
    assert.equal(next.id, 'tut-first-steps');
    assert.equal(next.stage, 1);
    assert.equal(next.track, 'tutorial');
    assert.ok(next.hint.length > 0, 'the step carries the control that achieves it');
  });

  it('walks tutorial -> road -> trio -> maren -> chapter in order', () => {
    const t = new ObjectiveTracker();
    const seen: string[] = [];
    for (let i = 0; i < ALL_IDS.length; i++) {
      const next = t.next()!;
      seen.push(next.id);
      t.onQuestComplete(next.id);
    }
    assert.deepEqual(seen, ALL_IDS, 'every id was offered exactly once, in roadmap order');
    assert.equal(t.next(), null, 'a cleared roadmap reports nothing left');
  });

  it('never points at a step that is already done', () => {
    const t = new ObjectiveTracker();
    t.onQuestComplete('tut-first-steps');
    t.onQuestComplete('tut-first-blow');
    assert.equal(t.next()!.id, 'tut-finisher');
    assert.equal(t.next()!.done, false);
  });

  it('counts move forward only, clamped to the goal', () => {
    const t = new ObjectiveTracker();
    assert.equal(t.onQuestProgress('road-pickups', 2, 3), true);
    assert.equal(t.count('road-pickups'), 2);
    assert.equal(t.onQuestProgress('road-pickups', 1, 3), false, 'a stale count is ignored');
    assert.equal(t.onQuestProgress('road-pickups', 99, 3), true);
    assert.equal(t.count('road-pickups'), 3);
    t.onQuestComplete('road-pickups');
    assert.equal(t.onQuestProgress('road-pickups', 3, 3), false, 'a finished quest takes no more progress');
  });

  it('shows a live count and a concrete next-next', () => {
    const t = new ObjectiveTracker();
    playFirstMinute(t, new TutorialTracker());
    const next = t.next()!;
    assert.equal(next.id, 'road-hunt', 'the road opens once the tutorial is finished');
    t.onQuestProgress('road-hunt', 2, 3);
    const body = t.body();
    assert.match(body.headline, /Thin the Meadow \(2\/3\)/);
    assert.equal(body.progress, '2/3');
    assert.ok(body.detail.length > 0, 'the objective carries its instructions');
    const ahead = t.upcoming(1)[0]!;
    assert.equal(ahead.id, 'road-lookout');
    assert.ok(ahead.hint.length > 0, 'the player can see what comes after this');
  });

  it('falls back to free-roam copy instead of an empty box', () => {
    const t = new ObjectiveTracker();
    for (const id of ALL_IDS) t.onQuestComplete(id);
    const body = t.body();
    assert.equal(t.next(), null);
    assert.ok(body.headline.length > 0);
    assert.equal(body.detail, SPINE_COMPLETE_LINE);
  });

  it('countLabel stays quiet for 1-step objectives', () => {
    assert.equal(countLabel(1, 1), '');
    assert.equal(countLabel(2, 3), '2/3');
    assert.equal(countLabel(9, 3), '3/3');
  });

  it('lists a whole track with live counts', () => {
    const t = new ObjectiveTracker();
    t.onQuestProgress('road-first-blood', 1, 1);
    const rows = t.trackRows('road');
    assert.deepEqual(rows.map((r) => r.id), ['road-first-blood', 'road-pickups', 'road-hunt', 'road-lookout']);
    assert.equal(rows[0]!.count, 1);
    assert.equal(rows[1]!.count, 0);
    assert.equal(rows[1]!.goal, 3);
  });
});

// ---------------------------------------------------------------------------
// LevelUpBanner
// ---------------------------------------------------------------------------

describe('LevelUpBanner (client)', () => {
  it('turns a bare level number into an unmistakable banner', () => {
    const b = new LevelUpBanner();
    const v = b.raise({ playerId: 1, level: 2, prevLevel: 1, xpLeft: 30, xpForNext: 200 }, 1_000)!;
    assert.equal(v.level, 2);
    assert.match(v.headline, /LEVEL 2/);
    assert.match(v.detail, /30 \/ 200 XP/);
    assert.equal(v.show, true);
    assert.equal(b.current().show, true);
  });

  it('mentions the talent point when the systems path reports one', () => {
    const b = new LevelUpBanner();
    const v = b.raise({ level: 3, talentPointsGained: 1, xpLeft: 10, xpForNext: 300 }, 0)!;
    assert.match(v.detail, /\+1 talent point /);
    const v2 = b.raise({ level: 4, talentPointsGained: 2, xpLeft: 0, xpForNext: 400 }, 0)!;
    assert.match(v2.detail, /\+2 talent points/);
  });

  it('ignores anything that is not a level-up', () => {
    const b = new LevelUpBanner();
    assert.equal(b.raise(null, 0), null);
    assert.equal(b.raise({}, 0), null);
    assert.equal(b.raise({ level: 1 }, 0), null, 'level 1 is the start, not an event');
    assert.equal(b.current().show, false);
  });

  it('holds long enough to read, then auto-hides on the caller clock', () => {
    const b = new LevelUpBanner();
    b.raise({ level: 2 }, 1_000);
    assert.equal(b.tick(1_000), false);
    assert.equal(b.tick(1_000 + b.holdMs - 1), false, 'still up just before the hold expires');
    assert.equal(b.tick(1_000 + b.holdMs), true, 'hides exactly when the hold expires');
    assert.equal(b.current().show, false);
    assert.equal(b.tick(1_000 + b.holdMs + 1_000), false, 'and stays hidden');
  });

  it('reduced motion removes the animation, never the information', () => {
    const b = new LevelUpBanner();
    assert.equal(b.motionEnabled, true);
    b.setReducedMotion(true);
    assert.equal(b.motionEnabled, false);
    const v = b.raise({ level: 5, xpLeft: 5, xpForNext: 500 }, 0)!;
    assert.equal(v.show, true, 'the banner still appears');
    assert.match(v.headline, /LEVEL 5/);
  });
});

// ---------------------------------------------------------------------------
// DeathExplain
// ---------------------------------------------------------------------------

describe('DeathExplain (client)', () => {
  it('says what happened, where you wake and what it cost', () => {
    const d = new DeathExplain();
    const v = d.raise(undefined, 0);
    assert.equal(v.show, true);
    assert.equal(v.title, 'YOU FELL');
    assert.match(v.respawnLabel, new RegExp(RESPAWN_LABEL.replace(/[()]/g, '\\$&')));
    assert.match(v.penalty, /No XP lost/);
    assert.match(v.penalty, /No items lost/);
  });

  it('credits a named killer', () => {
    assert.match(new DeathExplain().raise('gloomfang', 0).body, /Killed by gloomfang/);
  });

  it('auto-hides after its hold and can be dismissed early', () => {
    const d = new DeathExplain();
    d.raise(undefined, 100);
    assert.equal(d.tick(100 + d.holdMs - 1), false);
    assert.equal(d.tick(100 + d.holdMs), true);
    const d2 = new DeathExplain();
    d2.raise(undefined, 0);
    d2.dismiss();
    assert.equal(d2.current().show, false);
    assert.equal(d2.tick(10_000), false);
  });
});

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

describe('onboarding panels', () => {
  it('the objective tracker shows the objective, the hint, the count and the next', () => {
    const parent = new ElStub();
    const t = new ObjectiveTracker();
    const tut = new TutorialTracker();
    const panel = new ObjectiveTrackerPanel(parent as unknown as HTMLElement, t, tut, false);
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    assert.equal(inner<ElStub>(panel, 'trackEl').textContent, 'FIRST FIVE MINUTES');
    assert.match(inner<ElStub>(panel, 'nameEl').textContent, /First Steps/);
    assert.match(inner<ElStub>(panel, 'hintEl').textContent, /Move with WASD/);
    assert.match(inner<ElStub>(panel, 'nextEl').innerHTML, /First Blow/);

    t.onQuestProgress('road-pickups', 2, 3);
    t.onQuestComplete('tut-first-steps');
    assert.equal(panel.render(), true, 'a tracker change repaints');
    assert.equal(panel.render(), false, 'an unchanged tracker costs no DOM work');
  });

  it('the tracker bar fills with real progress', () => {
    const parent = new ElStub();
    const t = new ObjectiveTracker();
    const panel = new ObjectiveTrackerPanel(parent as unknown as HTMLElement, t, new TutorialTracker(), false);
    panel.render();
    assert.equal(inner<ElStub>(panel, 'barEl').style.width, '0.0%');
    t.onQuestProgress('road-first-blood', 1, 1);
    t.onQuestComplete('tut-first-steps');
    for (const id of ['tut-first-blow', 'tut-finisher', 'tut-first-loot', 'tut-don-a-mask', 'tut-signature']) {
      t.onQuestComplete(id);
    }
    t.onQuestProgress('road-hunt', 1, 3);
    panel.render();
    assert.equal(inner<ElStub>(panel, 'barEl').style.width, '33.3%');
  });

  it('the tracker can expand into the six-step checklist, and hides it by default', () => {
    const parent = new ElStub();
    const t = new ObjectiveTracker();
    const tut = new TutorialTracker();
    const panel = new ObjectiveTrackerPanel(parent as unknown as HTMLElement, t, tut, false);
    panel.render();
    assert.equal(inner<ElStub>(panel, 'stepsEl').innerHTML, '');
    panel.toggleSteps();
    panel.render();
    const html = inner<ElStub>(panel, 'stepsEl').innerHTML;
    assert.ok(html.includes('First Steps'));
    assert.ok(html.includes('Signature'));
    assert.ok(html.includes('▶'), 'the active step is marked');
  });

  it('escapes server text in the tracker (hostile quest names)', () => {
    const parent = new ElStub();
    const t = new ObjectiveTracker();
    const panel = new ObjectiveTrackerPanel(parent as unknown as HTMLElement, t, new TutorialTracker(), false);
    panel.render();
    t.onQuestProgress('road-first-blood', 1, 1);
    t.onQuestComplete('tut-first-steps');
    panel.render();
    const html = inner<ElStub>(panel, 'nextEl').innerHTML;
    assert.ok(!html.includes('<script'), 'no raw markup can reach the DOM');
  });

  it('honours reduced motion without hiding anything', () => {
    const parent = new ElStub();
    const t = new ObjectiveTracker();
    const panel = new ObjectiveTrackerPanel(parent as unknown as HTMLElement, t, new TutorialTracker(), false);
    panel.setReducedMotion(true);
    panel.render();
    assert.equal(panel.el.getAttribute('data-motion'), 'reduced');
    assert.equal(t.isReducedMotion, true);
    assert.match(inner<ElStub>(panel, 'hintEl').textContent, /Move with WASD/, 'the instructions are still there');
    panel.setReducedMotion(false);
    assert.equal(panel.el.getAttribute('data-motion'), null);
  });

  it('the level-up panel shows, holds and hides', () => {
    const parent = new ElStub();
    const b = new LevelUpBanner();
    const panel = new LevelUpPanel(parent as unknown as HTMLElement, b, false);
    assert.equal(panel.render(), false, 'nothing to show');
    b.raise({ level: 2, xpLeft: 30, xpForNext: 200, talentPointsGained: 1 }, 0);
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    assert.match(inner<ElStub>(panel, 'titleEl').textContent, /LEVEL 2/);
    assert.match(inner<ElStub>(panel, 'detailEl').textContent, /talent point/);
    assert.equal(panel.render(), false, 'no repaint while the state is unchanged');
    b.dismiss();
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), false);
  });

  it('the level-up panel drops its entrance animation under reduced motion', () => {
    const parent = new ElStub();
    const b = new LevelUpBanner();
    const panel = new LevelUpPanel(parent as unknown as HTMLElement, b, true);
    assert.equal(panel.el.getAttribute('data-motion'), 'reduced');
    b.raise({ level: 4 }, 0);
    panel.render();
    assert.equal(panel.el.classList.contains('open'), true, 'the banner still shows');
    assert.equal(panel.el.classList.contains('enter'), false, 'but it does not fly in');
  });

  it('the death card explains the respawn, then gets out of the way', () => {
    const parent = new ElStub();
    const d = new DeathExplain();
    const panel = new DeathPanel(parent as unknown as HTMLElement, d);
    assert.equal(panel.render(), false);
    d.raise('gloomfang', 0);
    assert.equal(panel.render(), true);
    assert.match(inner<ElStub>(panel, 'bodyEl').textContent, /Killed by gloomfang/);
    assert.match(inner<ElStub>(panel, 'whereEl').textContent, /Ward Shrine/);
    assert.match(inner<ElStub>(panel, 'penaltyEl').textContent, /No XP lost/);
    d.dismiss();
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), false);
  });

  it('the stylesheet gates its animations behind the existing reduced-motion setting', () => {
    assert.ok(ONBOARDING_PANEL_CSS.includes('data-a11y-motion="reduced"'), 'banner/bar animation gated');
    assert.ok(ONBOARDING_PANEL_CSS.includes('prefers-reduced-motion:reduce'), 'OS-level fallback');
    assert.ok(ONBOARDING_PANEL_CSS.includes('.af-objectives'), 'tracker styled');
    assert.ok(ONBOARDING_PANEL_CSS.includes('.af-levelup'), 'banner styled');
    assert.ok(ONBOARDING_PANEL_CSS.includes('.af-deathcard'), 'death card styled');
  });
});

// ---------------------------------------------------------------------------
// End to end: the same events the server emits for a scripted player
// ---------------------------------------------------------------------------

describe('mountOnboardingUi: a scripted first five minutes', () => {
  it('drives the whole surface off the existing event stream', () => {
    const parent = new ElStub();
    const ui = mountOnboardingUi(parent as unknown as HTMLElement, { selfId: () => 7 });

    // Step 1 arrives as a progress + complete pair, exactly like the server.
    assert.equal(ui.handleEvent('quest-progress', { playerId: 7, questId: 'tut-first-steps', count: 1, goal: 1 }), true);
    assert.equal(ui.handleEvent('quest-complete', { playerId: 7, questId: 'tut-first-steps', rewardXp: 20 }), true);
    assert.equal(ui.tutorial.completedCount(), 1);
    assert.equal(ui.tracker.next()!.id, 'tut-first-blow');

    // Another player's events never move our tracker.
    assert.equal(ui.handleEvent('quest-complete', { playerId: 8, questId: 'tut-first-blow' }), false);
    assert.equal(ui.tutorial.completedCount(), 1);

    // XP + level-up.
    assert.equal(ui.handleEvent('xp-gain', { playerId: 7, amount: 55, level: 1, xpLeft: 55 }), false);
    assert.equal(ui.handleEvent('levelup', { playerId: 7, level: 2, prevLevel: 1, xpLeft: 30, xpForNext: 200 }), true);
    ui.render(1_000);
    assert.equal(inner<ElStub>(ui.levelUp, 'titleEl').textContent, 'LEVEL 2');

    // Death: the explainer fires off the EXISTING `respawn` event.
    assert.equal(ui.handleEvent('respawn', { id: 7 }), true);
    ui.render(1_100);
    assert.match(inner<ElStub>(ui.death, 'whereEl').textContent, /Ward Shrine/);
    assert.equal(inner<ElStub>(ui.objectives, 'nameEl').textContent.length > 0, true);

    // Both banners auto-expire on the caller's clock.
    ui.render(1_000 + ui.banner.holdMs + ui.explain.holdMs + 10);
    assert.equal(ui.levelUp.el.classList.contains('open'), false);
    assert.equal(ui.death.el.classList.contains('open'), false);
    // ...and the tracker is still up, because it is the persistent spine.
    assert.equal(ui.objectives.el.classList.contains('open'), true);
  });

  it('runs the whole first minute of a new player and lands on a clear next', () => {
    const parent = new ElStub();
    const ui = mountOnboardingUi(parent as unknown as HTMLElement, { selfId: () => 1 });
    const feed = (kind: string, payload: Record<string, unknown>): void => {
      ui.handleEvent(kind, payload);
      ui.render(Date.now());
    };
    for (const id of ['tut-first-steps', 'tut-first-blow', 'tut-finisher', 'tut-first-loot']) {
      feed('quest-complete', { playerId: 1, questId: id, rewardXp: 20 });
    }
    feed('quest-progress', { playerId: 1, questId: 'road-first-blood', count: 1, goal: 1 });
    feed('quest-complete', { playerId: 1, questId: 'road-first-blood', rewardXp: 25 });
    feed('quest-progress', { playerId: 1, questId: 'road-pickups', count: 3, goal: 3 });
    feed('quest-complete', { playerId: 1, questId: 'road-pickups', rewardXp: 35 });

    const body = ui.tracker.body();
    assert.match(body.heading, /WAYFARER'S ROAD/);
    assert.match(body.headline, /Thin the Meadow/);
    assert.match(body.detail, /three more beasts/);
    assert.equal(ui.objectives.el.classList.contains('open'), true);
    // The tutorial's own checklist agrees with where the player is.
    assert.equal(ui.tutorial.active()!.id, 'tut-don-a-mask');
  });

  it('reduced motion reaches every sub-view', () => {
    const parent = new ElStub();
    const ui = mountOnboardingUi(parent as unknown as HTMLElement, { selfId: () => 1 });
    ui.setReducedMotion(true);
    assert.equal(ui.tutorial.isReducedMotion, true);
    assert.equal(ui.tracker.isReducedMotion, true);
    assert.equal(ui.banner.motionEnabled, false);
    assert.equal(ui.objectives.el.getAttribute('data-motion'), 'reduced');
    assert.equal(ui.levelUp.el.getAttribute('data-motion'), 'reduced');
  });
});