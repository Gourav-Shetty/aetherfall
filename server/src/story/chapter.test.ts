// Chapter STATIC walkthrough: accept -> 5 missions -> twist -> reward.
// Gating enforced; mission state lives in existing quest-progress structures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATIC_CHAPTER_ID,
  STATIC_CHAPTER_TITLE,
  STATIC_MASK_ID,
  STATIC_MASK_NAME,
  STATIC_MISSION_ORDER,
  STATIC_MISSIONS,
  STATIC_PAROLES,
  STATIC_PAYOFF,
  STATIC_TITLE_REWARD,
  ensureStaticProgress,
  isStaticChapterDone,
  isStaticUnlocked,
  staticActiveMission,
  staticChapterProgress,
  staticMission,
  staticNextParole,
  staticOnCollect,
  staticOnExplore,
  staticOnKill,
  staticPayoffFor,
  staticParoleUnlocked,
} from './chapter.js';
import { createQuestState } from '../game/quests.js';

describe('STATIC chapter shape', () => {
  it('chapter id + title are set', () => {
    assert.equal(STATIC_CHAPTER_ID, 'static');
    assert.equal(STATIC_CHAPTER_TITLE, 'STATIC');
  });

  it('5 missions in strict order with mixed acts', () => {
    assert.equal(STATIC_MISSIONS.length, 5);
    assert.deepEqual(STATIC_MISSION_ORDER, [
      'static-porchlight',
      'static-kiosk',
      'static-arcade',
      'static-meridian',
      'static-exchange',
    ]);
    for (let i = 1; i < STATIC_MISSIONS.length; i++) {
      assert.equal(STATIC_MISSIONS[i]!.seq, i + 1);
    }
    const kinds = new Set(STATIC_MISSIONS.map((m) => m.kind));
    assert.ok(kinds.has('kill') && kinds.has('collect') && kinds.has('explore'));
  });

  it('every mission names an original landmark + return hint', () => {
    for (const m of STATIC_MISSIONS) {
      assert.ok(m.landmark.length > 0);
      assert.ok(m.briefing.length > 0);
      assert.ok(m.returnHint.length > 0);
      assert.ok(staticMission(m.id)?.name === m.name);
    }
    const landmarks = new Set(STATIC_MISSIONS.map((m) => m.landmark));
    assert.equal(landmarks.size, 5, 'each mission gets its own landmark');
  });

  it('seeds progress idempotently without touching other quests', () => {
    const s = createQuestState();
    ensureStaticProgress(s);
    for (const m of STATIC_MISSIONS) {
      assert.ok(s.progress[m.id]);
      assert.equal(s.progress[m.id]!.count, 0);
    }
    assert.ok(s.progress['slay5'], 'base trio intact');
    ensureStaticProgress(s);
    assert.equal(Object.keys(s.progress).filter((k) => k.startsWith('static-')).length, 5);
  });
});

describe('STATIC gating', () => {
  it('mission 1 open, rest locked until predecessor done', () => {
    const s = createQuestState();
    ensureStaticProgress(s);
    const done = (id: string) => !!s.progress[id]?.done;
    assert.equal(isStaticUnlocked('static-porchlight', done), true);
    assert.equal(isStaticUnlocked('static-kiosk', done), false);
    assert.equal(isStaticUnlocked('static-exchange', done), false);
    assert.equal(isStaticUnlocked('nope', done), false);
  });

  it('locked missions accrue nothing', () => {
    const s = createQuestState();
    ensureStaticProgress(s);
    // Everything past mission 1 is shut: collect/explore accrue nothing.
    staticOnCollect(s, 50);
    staticOnExplore(s, new Set(['0,0']), '1,0');
    assert.equal(s.progress['static-kiosk']!.count, 0);
    assert.equal(s.progress['static-meridian']!.count, 0);
    // Only the first kill mission (porchlight, goal 4) may complete; later
    // kill missions stay at 0 because their gates are shut.
    staticOnKill(s, 50);
    assert.equal(s.progress['static-porchlight']!.done, true);
    assert.equal(s.progress['static-arcade']!.count, 0);
    assert.equal(s.progress['static-exchange']!.count, 0);
  });

  it('active mission pointer walks the order', () => {
    const s = createQuestState();
    assert.equal(staticActiveMission(s)!.id, 'static-porchlight');
    assert.equal(staticChapterProgress(s), 0);
  });
});

describe('STATIC full walkthrough (accept -> twist -> reward)', () => {
  function walkthrough() {
    const s = createQuestState();
    const seen = new Set<string>(['0,0']);
    const evts: unknown[] = [];
    // M1: kill 4 (meadow porch).
    evts.push(...staticOnKill(s, 4));
    assert.equal(s.progress['static-porchlight']!.done, true);
    // M2: collect 6 shards.
    evts.push(...staticOnCollect(s, 6));
    assert.equal(s.progress['static-kiosk']!.done, true);
    // M3: kill 6 (arcade).
    evts.push(...staticOnKill(s, 6));
    assert.equal(s.progress['static-arcade']!.done, true);
    // M4: explore 4 new points.
    for (const k of ['1,0', '2,0', '3,0', '4,0']) evts.push(...staticOnExplore(s, seen, k));
    assert.equal(s.progress['static-meridian']!.done, true);
    // M5: kill 8 (exchange) — the twist mission.
    evts.push(...staticOnKill(s, 8));
    assert.equal(s.progress['static-exchange']!.done, true);
    return { s, evts };
  }

  it('completes all 5 missions with quest-progress + quest-complete events', () => {
    const { s, evts } = walkthrough();
    assert.equal(isStaticChapterDone(s), true);
    assert.equal(staticActiveMission(s), null);
    assert.equal(staticChapterProgress(s), 1);
    const types = (evts as Array<{ type: string }>).map((e) => e.type);
    assert.ok(types.includes('progress'));
    assert.equal(types.filter((t) => t === 'complete').length, 5);
    assert.ok(types.includes('levelup'), 'chapter XP levels the walker');
  });

  it('chapter XP follows the 40/60/90/120/200 curve', () => {
    const goals = STATIC_MISSIONS.map((m) => m.rewardXp);
    assert.deepEqual(goals, [40, 60, 90, 120, 200]);
  });

  it('twist payoff: unique mask + title only when done', () => {
    const fresh = createQuestState();
    assert.equal(staticPayoffFor(fresh), null, 'no reward before the chapter is done');
    const { s } = walkthrough();
    const payoff = staticPayoffFor(s);
    assert.ok(payoff);
    assert.equal(payoff!.maskId, STATIC_MASK_ID);
    assert.equal(payoff!.maskName, STATIC_MASK_NAME);
    assert.equal(payoff!.title, STATIC_TITLE_REWARD);
    assert.deepEqual(payoff, { ...STATIC_PAYOFF });
    assert.ok(payoff!.inscription.length > 0);
  });

  it('partial progress yields a fractional chapter bar', () => {
    const s = createQuestState();
    staticOnKill(s, 2);
    const p = staticChapterProgress(s);
    assert.ok(p > 0 && p < 1);
  });
});

describe('STATIC paroles', () => {
  it('two interludes gated after missions 2 and 4, skippable', () => {
    assert.equal(STATIC_PAROLES.length, 2);
    assert.equal(STATIC_PAROLES[0]!.afterMissionId, 'static-kiosk');
    assert.equal(STATIC_PAROLES[1]!.afterMissionId, 'static-meridian');
    for (const p of STATIC_PAROLES) {
      assert.equal(p.skippable, true);
      assert.equal(p.npcs.length, 2);
      assert.ok(p.room.length > 0);
    }
  });

  it('parole unlock follows mission completion', () => {
    const s = createQuestState();
    const done = (id: string) => !!s.progress[id]?.done;
    assert.equal(staticParoleUnlocked('static-parole-kettle', done), false);
    staticOnKill(s, 4);
    staticOnCollect(s, 6);
    assert.equal(staticParoleUnlocked('static-parole-kettle', done), true);
    assert.equal(staticParoleUnlocked('static-parole-chapel', done), false);
    assert.equal(staticParoleUnlocked('nope', done), false);
  });

  it('next-parole pointer skips played scenes', () => {
    const done = new Set<string>(['static-porchlight', 'static-kiosk']);
    const played = new Set<string>();
    assert.equal(staticNextParole(done, played)!.id, 'static-parole-kettle');
    played.add('static-parole-kettle');
    assert.equal(staticNextParole(done, played), null);
    done.add('static-arcade');
    done.add('static-meridian');
    assert.equal(staticNextParole(done, played)!.id, 'static-parole-chapel');
  });
});
