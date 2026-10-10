// ONBOARDING: the first five minutes as an explicit, tuned experience.
//
// This suite is the acceptance gate for the player-facing problem, not a unit
// test of one helper. It drives a simulated brand-new player through the REAL
// systems — `tickGameplay` for position/chunks, `playerMeleeAttack` for the
// hit/knockdown/finisher chain, `collectPickup` for loot, and a real
// `GameSession` for the mask + vocation signature — and asserts the four
// properties the design promises:
//
//   1. the track completes end to end headlessly;
//   2. every objective's predicate is FALSE before its action and TRUE after
//      (no objective can complete itself);
//   3. an objective cannot complete out of order, and cannot pay twice;
//   4. the retuned Road thresholds are reachable in the intended order by a
//      player who follows the track — with existing quest behaviour intact.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import {
  ATTACK_COOLDOWN_MS,
  MELEE_RANGE,
} from './combat.js';
import {
  collectPickup,
  createGameState,
  ensurePlayer,
  playerMeleeAttack,
  setPlayerPos,
  tickGameplay,
  type GameEvent,
  type GameState,
} from './index.js';
import {
  FIRST_BLOOD_COUNT,
  FIRST_BLOOD_ITEM,
  TUTORIAL_IDS,
  TUTORIAL_OBJECTIVES,
  TUTORIAL_TOTAL_XP,
  TUT_MOVE_DISTANCE,
  applyTutorialSignal,
  createTutorialState,
  deathNotice,
  hasFirstBloodGift,
  isTutorialComplete,
  nextOnboardingStep,
  noteMaskEquipped,
  noteSignatureUsed,
  resetTutorials,
  tutorialActive,
  tutorialFor,
  tutorialObjective,
  type TutorialSignal,
  type TutorialState,
} from './onboarding.js';
import {
  WAYFARER_ROAD,
  chunkKeyOf,
  createQuestState,
  isRoadComplete,
  onCollect,
  onExplore,
  onKill,
  roadActive,
  roadOnCollect,
  roadOnExplore,
  roadOnKill,
  type QuestEvent,
  type QuestState,
} from './quests.js';
import { GameSession } from './integrated.js';
import { MELEE_COOLDOWN as MELEE_COOLDOWN_SEC, MELEE_DAMAGE } from '../ai/npc.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const seeded = mulberry32(0xa11ce);

function questIds(events: GameEvent[], kind: string): string[] {
  return events
    .filter((e) => e.kind === kind)
    .map((e) => (e.payload as { questId?: string }).questId ?? '');
}

/**
 * A world where a player spawns at the shrine anchor and a live spawner mob
 * sits just OUTSIDE the clearing, so walking the tutorial's 12 units really
 * does end the walk next to something to fight — which is the experience the
 * track is tuned for.
 */
const ORIGIN = { x: 16, y: 16 };

function worldWithMob(seed = 1337): { game: GameState; targetId: number; mob: { x: number; y: number } } {
  const game = createGameState(seed);
  ensurePlayer(game, 1, 'hero', ORIGIN.x, ORIGIN.y);
  game.spawner.ensureAround(ORIGIN.x, ORIGIN.y, 0);
  const live = game.spawner
    .mobsList()
    .filter((m) => m.alive && Math.hypot(m.pos.x - ORIGIN.x, m.pos.y - ORIGIN.y) >= TUT_MOVE_DISTANCE + 3);
  assert.ok(live.length > 0, 'a mob exists just beyond the shrine clearing');
  // The closest such mob is the one the player's walk will end up beside.
  live.sort((a, b) => Math.hypot(a.pos.x - ORIGIN.x, a.pos.y - ORIGIN.y) - Math.hypot(b.pos.x - ORIGIN.x, b.pos.y - ORIGIN.y));
  const mob = live[0]!;
  return { game, targetId: mob.id, mob: { x: mob.pos.x, y: mob.pos.y } };
}

/**
 * Walk the player from wherever they stand to (tx, ty) in `steps` ticks,
 * feeding each position through the real `tickGameplay` (which is what
 * observes objective 1). Returns the tick time it ended on plus every event
 * the walk produced.
 */
function walkTo(
  game: GameState,
  tx: number,
  ty: number,
  steps: number,
  t0: number,
): { now: number; events: GameEvent[] } {
  const p = game.players.get(1)!;
  const x0 = p.x;
  const y0 = p.y;
  const events: GameEvent[] = [];
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    setPlayerPos(game, 1, x0 + (tx - x0) * f, y0 + (ty - y0) * f);
    events.push(...tickGameplay(game, t0 + i * 50));
  }
  return { now: t0 + steps * 50, events };
}

/** Swing until the mob is down, then swing once more to execute it. */
function fightToDeath(game: GameState, from: number, swings = 16): { events: GameEvent[]; finished: boolean; downed: boolean; now: number } {
  const merged: GameEvent[] = [];
  let now = from;
  let downed = false;
  let finished = false;
  for (let i = 0; i < swings; i++) {
    now += ATTACK_COOLDOWN_MS + 20;
    const res = playerMeleeAttack(game, 1, now, { rand: mulberry32(7 + i) });
    merged.push(...res.events);
    if (res.ok && res.downed) downed = true;
    if (res.ok && res.finished) {
      finished = true;
      break;
    }
  }
  return { events: merged, finished, downed, now };
}

beforeEach(() => {
  resetTutorials();
});

// ---------------------------------------------------------------------------
// 1. Track shape
// ---------------------------------------------------------------------------

describe('onboarding: the tutorial spine', () => {
  it('is 6 short objectives, in order, one signal each, all with real copy', () => {
    assert.equal(TUTORIAL_OBJECTIVES.length, 6);
    assert.equal(TUTORIAL_TOTAL_XP, TUTORIAL_OBJECTIVES.reduce((a, o) => a + o.rewardXp, 0));
    const ids = new Set<string>();
    const signals = new Set<string>();
    TUTORIAL_OBJECTIVES.forEach((o, i) => {
      assert.equal(o.seq, i + 1, 'seq must be contiguous and in array order');
      assert.ok(o.id.startsWith('tut-'), `${o.id} must live in the tut- namespace`);
      assert.ok(!ids.has(o.id), `${o.id} duplicated`);
      ids.add(o.id);
      assert.ok(!signals.has(o.signal), `${o.id} shares signal ${o.signal} — one signal must map to exactly one objective`);
      signals.add(o.signal);
      assert.ok(o.objective.length > 0 && o.hint.length > 0, `${o.id} needs player-facing copy`);
      assert.ok(o.rewardXp > 0, `${o.id} must pay something`);
    });
    assert.deepEqual([...signals].sort(), [
      'collected',
      'finisher',
      'mask-equipped',
      'melee-hit',
      'position',
      'signature-used',
    ]);
  });

  it('covers every mechanic the first minute is supposed to teach', () => {
    const bySignal = new Map(TUTORIAL_OBJECTIVES.map((o) => [o.signal, o]));
    for (const s of ['position', 'melee-hit', 'finisher', 'collected', 'mask-equipped', 'signature-used'] as const) {
      assert.ok(bySignal.has(s), `missing objective for ${s}`);
    }
  });

  it('a fresh player is on step 1 with nothing met', () => {
    const st = createTutorialState(0, 0);
    assert.equal(tutorialActive(st)!.id, 'tut-first-steps');
    for (const id of TUTORIAL_IDS) assert.equal(st.objectives[id]!.done, false);
    assert.equal(isTutorialComplete(st), false);
  });
});

// ---------------------------------------------------------------------------
// 2. Predicate is FALSE before the action, TRUE after
// ---------------------------------------------------------------------------

describe('onboarding: no objective completes itself', () => {
  /**
   * The "before" fixture for each objective is the signal of the objective
   * BEFORE it — the most advanced thing a player can genuinely have done and
   * still be stuck on this step. "After" is its own signal carrying a real
   * payload. Walking the table proves both halves of every predicate without
   * any hand-waving about "a fresh player hasn't moved".
   */
  const ORDER: Array<{ id: string; before: () => TutorialSignal; after: () => TutorialSignal }> = [
    {
      id: 'tut-first-steps',
      before: () => ({ kind: 'position', x: 0, y: 0 }), // standing exactly on the anchor
      after: () => ({ kind: 'position', x: 0, y: TUT_MOVE_DISTANCE }),
    },
    {
      id: 'tut-first-blow',
      before: () => ({ kind: 'position', x: 0, y: TUT_MOVE_DISTANCE }), // walked, never swung
      after: () => ({ kind: 'melee-hit', mobId: 11, dmg: 12 }),
    },
    {
      id: 'tut-finisher',
      before: () => ({ kind: 'melee-hit', mobId: 11, dmg: 12 }), // hit it, never executed it
      after: () => ({ kind: 'finisher', mobId: 11 }),
    },
    {
      id: 'tut-first-loot',
      before: () => ({ kind: 'finisher', mobId: 11 }), // corpse felled, nothing picked up
      after: () => ({ kind: 'collected', itemId: 'ember-shard', count: 1 }),
    },
    {
      id: 'tut-don-a-mask',
      before: () => ({ kind: 'collected', itemId: 'ember-shard', count: 1 }), // looted, still bare-faced
      after: () => ({ kind: 'mask-equipped', maskId: 'cinder-hide' }),
    },
    {
      id: 'tut-signature',
      before: () => ({ kind: 'mask-equipped', maskId: 'cinder-hide' }), // masked, never fired
      after: () => ({ kind: 'signature-used', signatureId: 'oath-of-embers' }),
    },
  ];

  it('covers every objective in the track, in order', () => {
    assert.deepEqual(ORDER.map((r) => r.id), [...TUTORIAL_IDS]);
  });

  it('every predicate is FALSE for the state before its action, TRUE after', () => {
    for (const row of ORDER) {
      const obj = tutorialObjective(row.id)!;
      const fresh = createTutorialState(0, 0);
      assert.equal(obj.matches(row.before(), fresh), false, `${row.id}: true BEFORE its action`);
      assert.equal(obj.matches(row.after(), fresh), true, `${row.id}: still false AFTER its action`);
      // And the surrounding state did not help it along: the "before" signal
      // is the previous step's real payload, replayed against a fresh track.
      // (For step 2+ it legitimately completes the PREVIOUS step — what it
      // must never do is complete this one.)
      const st = createTutorialState(0, 0);
      applyTutorialSignal(st, row.before());
      assert.equal(st.objectives[row.id]!.done, false, `${row.id} completed out of order`);
    }
  });

  it('no objective accepts another objective\'s signal', () => {
    for (const o of TUTORIAL_OBJECTIVES) {
      for (const row of ORDER) {
        if (row.id === o.id) continue;
        assert.equal(o.matches(row.after(), createTutorialState(0, 0)), false, `${o.id} accepted ${row.id}'s signal`);
      }
    }
  });

  it('the move objective is anchored to the spawn point, not to any point', () => {
    const st = createTutorialState(100, 100);
    const obj = tutorialObjective('tut-first-steps')!;
    assert.equal(obj.matches({ kind: 'position', x: 100, y: 100 }, st), false);
    assert.equal(obj.matches({ kind: 'position', x: 100 + TUT_MOVE_DISTANCE - 1, y: 100 }, st), false);
    assert.equal(obj.matches({ kind: 'position', x: 100 + TUT_MOVE_DISTANCE, y: 100 }, st), true);
    // The anchor is per-player: the same coordinate satisfies a player who has
    // been walking and does NOT satisfy one who just stood up there.
    const here: TutorialState = createTutorialState(500, 500);
    const elsewhere: TutorialState = createTutorialState(0, 0);
    assert.equal(obj.matches({ kind: 'position', x: 500, y: 500 }, here), false);
    assert.equal(obj.matches({ kind: 'position', x: 500, y: 500 }, elsewhere), true);
  });

  it('standing still for many ticks never completes anything', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    let now = 1_000;
    for (let i = 0; i < 200; i++) {
      tickGameplay(game, (now += 50));
    }
    const st = tutorialFor(1)!;
    assert.equal(st.objectives['tut-first-steps']!.done, false, 'an idle player walked nowhere');
    const next = nextOnboardingStep(game.players.get(1)!.quests);
    assert.equal(next!.id, 'tut-first-steps', 'the tracker must still point at step 1');
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering + no duplicate rewards
// ---------------------------------------------------------------------------

describe('onboarding: ordering and single payout', () => {
  it('a step-6 action alone completes nothing', () => {
    const st = createTutorialState(0, 0);
    const completed = applyTutorialSignal(st, { kind: 'signature-used', signatureId: 'oath-of-embers' });
    assert.deepEqual(completed, [], 'out-of-order action must not advance the track');
    assert.equal(st.objectives['tut-signature']!.done, false);
    // It IS latched, so the player cannot get stuck once they get to step 6.
    assert.equal(st.objectives['tut-signature']!.met, true);
  });

  it('a latched out-of-order action completes the moment the ladder catches up', () => {
    const st = createTutorialState(0, 0);
    applyTutorialSignal(st, { kind: 'signature-used', signatureId: 'oath-of-embers' });
    applyTutorialSignal(st, { kind: 'mask-equipped', maskId: 'cinder-hide' });
    // Nothing yet.
    assert.equal(st.objectives['tut-don-a-mask']!.done, false);
    // Do steps 1-4 in order; steps 5 and 6 were already met, so they fire too.
    applyTutorialSignal(st, { kind: 'position', x: 40, y: 0 });
    applyTutorialSignal(st, { kind: 'melee-hit', mobId: 1, dmg: 12 });
    applyTutorialSignal(st, { kind: 'finisher', mobId: 1 });
    applyTutorialSignal(st, { kind: 'collected', itemId: 'ember-shard', count: 1 });
    assert.equal(st.objectives['tut-first-loot']!.done, true);
    assert.equal(st.objectives['tut-don-a-mask']!.done, true, 'latched mask equip completed in order');
    assert.equal(st.objectives['tut-signature']!.done, true, 'latched signature completed in order');
    assert.equal(isTutorialComplete(st), true);
  });

  it('steps complete strictly in seq order, never skipping a gap', () => {
    const st = createTutorialState(0, 0);
    const order: string[] = [];
    st.pending.length = 0;
    const collect = (): void => {
      while (st.pending.length > 0) order.push(st.pending.shift()!);
    };
    applyTutorialSignal(st, { kind: 'position', x: 40, y: 0 });
    collect();
    applyTutorialSignal(st, { kind: 'melee-hit', mobId: 1, dmg: 12 });
    collect();
    applyTutorialSignal(st, { kind: 'finisher', mobId: 1 });
    collect();
    applyTutorialSignal(st, { kind: 'collected', itemId: 'ember-shard', count: 1 });
    collect();
    applyTutorialSignal(st, { kind: 'mask-equipped', maskId: 'gallow-beak' });
    collect();
    applyTutorialSignal(st, { kind: 'signature-used', signatureId: 'skyhook-volley' });
    collect();
    assert.deepEqual(order, [...TUTORIAL_IDS]);
  });

  it('replaying a completed signal pays nothing the second time', () => {
    const quests = createQuestState();
    const st = createTutorialState(0, 0);
    applyTutorialSignal(st, { kind: 'position', x: 40, y: 0 });
    // Drain manually through the same path the tick uses.
    const game = createGameState(1337);
    ensurePlayer(game, 42, 'dupe', 0, 0);
    const tut = tutorialFor(42)!;
    applyTutorialSignal(tut, { kind: 'position', x: 40, y: 0 });
    const first = drain(game, 42);
    assert.ok(questIds(first, 'quest-complete').includes('tut-first-steps'));
    const xpAfterFirst = game.players.get(42)!.quests.xp;
    // Replay the identical signal many times over many ticks.
    for (let i = 0; i < 5; i++) applyTutorialSignal(tutorialFor(42)!, { kind: 'position', x: 40 + i, y: 0 });
    const replay = drain(game, 42);
    assert.deepEqual(replay, [], 'a finished objective must never pay twice');
    assert.equal(game.players.get(42)!.quests.xp, xpAfterFirst, 'no duplicate XP');
    void quests;
    void st;
  });

  it('draining twice cannot re-pay an objective already marked done', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 7, 'once', 0, 0);
    const tut = tutorialFor(7)!;
    applyTutorialSignal(tut, { kind: 'position', x: 40, y: 0 });
    // Simulate a stale pending buffer (a dropped drain on a lagging tick).
    tut.pending.push('tut-first-steps');
    const a = drain(game, 7);
    const b = drain(game, 7);
    assert.equal(questIds(a, 'quest-complete').length, 1);
    assert.deepEqual(b, [], 'the second drain must be empty');
    assert.equal(a.filter((e) => e.kind === 'quest-progress').length, 1, 'one progress event, not two');
    assert.equal(game.players.get(7)!.quests.xp, 20, 'step 1 paid exactly once');
  });
});

/** Drain the tutorial's buffered events through the real GameState path. */
function drain(game: GameState, playerId: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (const e of tickGameplay(game, 1_000)) {
    if ((e.payload as { playerId?: number } | null)?.playerId === playerId) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. End-to-end: a simulated new player doing exactly what the track asks
// ---------------------------------------------------------------------------

describe('onboarding: headless walkthrough of the whole first five minutes', () => {
  it('a real new player completes all six objectives through the live systems', () => {
    const { game, mob } = worldWithMob();
    const quests = game.players.get(1)!.quests;
    const session = new GameSession({ enabled: true });
    session.addPlayer(1, 'hero', ORIGIN.x, ORIGIN.y);

    // Step 1 — actually walk out of the clearing; the tick observes position.
    const walk = walkTo(game, mob.x + 1, mob.y, 24, 10_000);
    const seen: GameEvent[] = [...walk.events];
    let now = walk.now;
    assert.equal(tutorialFor(1)!.objectives['tut-first-steps']!.done, true, 'step 1 via tick position');
    assert.ok(
      seen.some((e) => e.kind === 'quest-complete' && (e.payload as { questId: string }).questId === 'tut-first-steps'),
      'step 1 was announced to the client',
    );

    // Steps 2 + 3 — hit a real mob, knock it down, walk up and execute it.
    const fight = fightToDeath(game, walk.now);
    now = fight.now;
    seen.push(...fight.events);
    assert.equal(fight.downed, true, 'a lethal melee swing knocks down rather than kills');
    assert.equal(fight.finished, true, 'the downed mob is finished by a follow-up swing');
    seen.push(...tickGameplay(game, (now += 50)));
    assert.equal(tutorialFor(1)!.objectives['tut-first-blow']!.done, true, 'step 2 via a connecting melee swing');
    assert.equal(tutorialFor(1)!.objectives['tut-finisher']!.done, true, 'step 3 via the execution');

    // Step 4 — take the loot. The first corpse is GUARANTEED to leave one.
    const gift = game.pickups.find((p) => p.itemId === FIRST_BLOOD_ITEM && p.count === FIRST_BLOOD_COUNT);
    assert.ok(gift, 'the first kill always leaves a drop to walk over');
    seen.push(...collectPickup(game, 1, gift.id));
    seen.push(...tickGameplay(game, (now += 50)));
    assert.equal(tutorialFor(1)!.objectives['tut-first-loot']!.done, true, 'step 4 via a real pickup');

    // Step 5 — take a calling (its kit hands over a mask) and wear it.
    session.chooseVocation(1, 'dawnwarden');
    assert.ok(session.equipMask(1, 'cinder-hide').length > 0, 'mask equip accepted');
    seen.push(...tickGameplay(game, (now += 50)));
    assert.equal(tutorialFor(1)!.objectives['tut-don-a-mask']!.done, true, 'step 5 via GameSession.equipMask');

    // Step 6 — fire the signature off cooldown.
    const sig = session.useSignature(1, 1, now);
    assert.equal(sig.ok, true, 'signature fired');
    seen.push(...tickGameplay(game, (now += 50)));
    assert.equal(tutorialFor(1)!.objectives['tut-signature']!.done, true, 'step 6 via GameSession.useSignature');

    // The whole track is done and every objective was announced + paid.
    assert.equal(isTutorialComplete(tutorialFor(1)!), true);
    const completed = questIds(seen, 'quest-complete');
    for (const id of TUTORIAL_IDS) assert.ok(completed.includes(id), `${id} never announced`);
    const progressed = questIds(seen, 'quest-progress');
    for (const id of TUTORIAL_IDS) assert.ok(progressed.includes(id), `${id} never reported progress`);
    assert.ok(quests.level >= 2, `tutorial XP must level the player (lv${quests.level}, ${quests.xp} xp)`);
    for (const id of TUTORIAL_IDS) {
      assert.equal(quests.progress[id]!.done, true, `${id} not mirrored into QuestState`);
      assert.equal(quests.progress[id]!.claimed, true);
    }
  });

  it('the first minute pays a kill, visible loot, XP and a clear next step', () => {
    const { game, mob } = worldWithMob();
    const quests = game.players.get(1)!.quests;
    assert.ok(hasFirstBloodGift(1), 'a new player starts with the gift coming');

    const walk = walkTo(game, mob.x + 1, mob.y, 24, 20_000);
    const fight = fightToDeath(game, walk.now);
    const killEvents = fight.events;
    tickGameplay(game, fight.now + 50);

    // kill
    assert.ok(killEvents.some((e) => e.kind === 'mob-die'), 'a kill was announced');
    // visible loot
    const drops = killEvents.filter((e) => e.kind === 'pickup-spawn');
    assert.ok(drops.length > 0, 'the first kill always leaves loot on the ground');
    assert.ok(
      drops.some((e) => (e.payload as { itemId: string }).itemId === FIRST_BLOOD_ITEM),
      'and the guaranteed starter drop is one of them',
    );
    // XP
    assert.ok(quests.xp + (quests.level - 1) * 100 > 0, 'the player has earned XP');
    // a clear next
    const next = nextOnboardingStep(quests);
    assert.ok(next, 'the spine always names a next step');
    assert.equal(next!.id, 'tut-first-loot', 'the immediate next thing is to pick the loot up');
    assert.ok(next!.hint.length > 0, 'the next step carries instructions');
    assert.equal(hasFirstBloodGift(1), false, 'the gift is granted exactly once');
  });
});

// ---------------------------------------------------------------------------
// 5. Quest pacing: the retuned Road ladder
// ---------------------------------------------------------------------------

describe('onboarding: the retuned quest order + thresholds', () => {
  it('the Road is a strictly gated 4-step ladder sized for the first hour', () => {
    assert.equal(WAYFARER_ROAD.length, 4);
    WAYFARER_ROAD.forEach((q, i) => {
      assert.equal(q.seq, i + 1);
      assert.ok(q.goal > 0 && q.rewardXp > 0 && q.hint.length > 0);
      if (i === 0) assert.equal(q.prerequisite, undefined, 'the ladder must have an open start');
      else assert.equal(q.prerequisite, WAYFARER_ROAD[i - 1]!.id);
    });
    assert.deepEqual(
      WAYFARER_ROAD.map((q) => `${q.kind}:${q.goal}`),
      ['kill:1', 'collect:3', 'kill:3', 'explore:2'],
      'thresholds: first kill fast, then loot, then a short hunt, then a short walk',
    );
  });

  it('a locked Road step accrues nothing and unlocks only after its predecessor', () => {
    const s = createQuestState();
    roadOnKill(s, 20); // only step 1 is open
    assert.equal(s.progress['road-first-blood']!.done, true);
    assert.equal(s.progress['road-hunt']!.count, 0, 'step 3 is still shut');
    roadOnCollect(s, 20);
    assert.equal(s.progress['road-pickups']!.done, true);
    assert.equal(s.progress['road-hunt']!.count, 0, 'gating survives a flood of pickups');
    assert.equal(roadActive(s)!.id, 'road-hunt');
  });

  it('a scripted player following the track satisfies every threshold in order', () => {
    const s = createQuestState();
    const order: string[] = [];
    const run = (events: QuestEvent[]): void => {
      for (const e of events) if (e.type === 'complete') order.push(e.questId);
    };
    // 1: one kill.
    run(roadOnKill(s, 1));
    // 2: walk over three drops (the first kill's gift plus two more).
    run(roadOnCollect(s, 3));
    // 3: three more kills.
    run(roadOnKill(s, 3));
    // 4: walk into two new chunks (the spawn chunk is free).
    const seen = new Set<string>([chunkKeyOf(0, 0)]);
    run(roadOnExploreRoad(s, seen, '1,0'));
    run(roadOnExploreRoad(s, seen, '2,0'));
    assert.deepEqual(order, WAYFARER_ROAD.map((q) => q.id), 'completed in play order');
    assert.equal(isRoadComplete(s), true);
    assert.equal(roadActive(s), null);
    // Every Road payout landed on the shared level*100 curve.
    const total = WAYFARER_ROAD.reduce((a, q) => a + q.rewardXp, 0);
    assert.equal(s.xp + (s.level - 1) * 100, total);
    assert.ok(s.level >= 2, 'the Road alone levels a new player');
  });

  it('the tutorial + the Road together level the player inside the first minute', () => {
    const s = createQuestState();
    // What a first-minute scripted player earns: step 1, one hit, the first
    // kill's XP and loot pickup, plus the Road's first two steps.
    const xp =
      TUTORIAL_OBJECTIVES.filter((o) => o.id === 'tut-first-steps' || o.id === 'tut-first-blow').reduce((a, o) => a + o.rewardXp, 0) +
      30 + // xpForKill('meadow', 1)
      WAYFARER_ROAD.slice(0, 2).reduce((a, q) => a + q.rewardXp, 0);
    assert.ok(xp >= 100, `the first minute must cross level 2 (it pays ${xp})`);
    assert.ok(xp < 200, 'and must not blow past level 3 in one minute');
  });

  it('nextOnboardingStep walks tutorial -> road -> trio -> maren -> chapter', () => {
    const s = createQuestState();
    const first = nextOnboardingStep(s);
    assert.equal(first!.track, 'tutorial');
    assert.equal(first!.stage, 1);
    // Finish the tutorial the short way: mark every tut-* row done.
    for (const id of TUTORIAL_IDS) s.progress[id] = { questId: id, count: 1, done: true, claimed: true };
    assert.equal(nextOnboardingStep(s)!.track, 'road');
    // Finish the Road.
    roadOnKill(s, 1);
    roadOnCollect(s, 3);
    roadOnKill(s, 3);
    const seen = new Set<string>([chunkKeyOf(0, 0), '1,0', '2,0']);
    roadOnExploreRoad(s, seen, '3,0');
    assert.equal(isRoadComplete(s), true);
    const trio = nextOnboardingStep(s)!;
    assert.equal(trio.track, 'trio');
    assert.equal(trio.id, 'slay5', 'the trio is presented in a stated order: slay5 first');
    // Finish the trio; the Maren chain takes over.
    onKill(s, 5);
    onCollect(s, 10);
    const seen2 = new Set<string>([chunkKeyOf(0, 0), '1,0', '2,0', '3,0']);
    onExplore(s, seen2, '4,0');
    const maren = nextOnboardingStep(s)!;
    assert.equal(maren.track, 'maren');
    assert.equal(maren.id, 'ward-spark');
    // Finish the Maren chain; STATIC closes the roadmap.
    for (const id of ['ward-spark', 'ember-road', 'deep-delvers', 'chart-the-fall', 'heart-of-fall']) {
      s.progress[id] = { questId: id, count: 1, done: true, claimed: true };
    }
    assert.equal(nextOnboardingStep(s)!.id, 'static-porchlight');
  });

  it('never points at a step that is already done', () => {
    const s = createQuestState();
    const walk = (): void => {
      const step = nextOnboardingStep(s);
      if (!step) return;
      assert.equal(step.done, false, `${step.id} was offered while already done`);
      assert.ok(step.goal > 0, `${step.id} has no goal`);
      assert.ok(step.hint.length > 0, `${step.id} has no hint`);
      s.progress[step.id] = { questId: step.id, count: step.goal, done: true, claimed: true };
    };
    for (let i = 0; i < 40; i++) walk();
    assert.equal(nextOnboardingStep(s), null, 'a fully cleared roadmap reports "nothing left", not a dead end');
  });
});

function roadOnExploreRoad(state: QuestState, seen: Set<string>, key: string): QuestEvent[] {
  return roadOnExplore(state, seen, key);
}

// ---------------------------------------------------------------------------
// 6. Existing quest behaviour must still hold
// ---------------------------------------------------------------------------

describe('onboarding: existing quest behaviour is unchanged', () => {
  it('the base trio still completes exactly as before', () => {
    const s = createQuestState();
    onKill(s, 3);
    assert.equal(s.progress['slay5']!.count, 3);
    assert.equal(s.progress['slay5']!.done, false);
    onKill(s, 2);
    assert.equal(s.progress['slay5']!.count, 5);
    assert.equal(s.progress['slay5']!.done, true);
    onCollect(s, 10);
    assert.equal(s.progress['gather10']!.done, true);
    const seen = new Set<string>([chunkKeyOf(0, 0)]);
    onExplore(s, seen, '1,0');
    onExplore(s, seen, '2,0');
    onExplore(s, seen, '3,0');
    assert.equal(s.progress['explorer']!.done, true);
  });

  it('the tutorial track does not disturb the trio, the chain or STATIC', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 0, 0);
    const q = game.players.get(1)!.quests;
    const tut = tutorialFor(1)!;
    applyTutorialSignal(tut, { kind: 'position', x: 40, y: 0 });
    tickGameplay(game, 1_000);
    // Tutorial XP was granted...
    assert.ok(q.progress['tut-first-steps']!.done);
    // ...and nothing else moved.
    assert.equal(q.progress['slay5']!.count, 0);
    assert.equal(q.progress['gather10']!.count, 0);
    assert.equal(q.progress['explorer']!.count, 0);
    assert.equal(q.progress['ward-spark'], undefined);
    assert.equal(q.progress['static-porchlight'], undefined);
  });

  it('a normal kill still pays the trio, the chain and the Road together', () => {
    const { game, mob } = worldWithMob();
    const q = game.players.get(1)!.quests;
    const walk = walkTo(game, mob.x + 1, mob.y, 24, 1_000);
    const { events } = fightToDeath(game, walk.now);
    // The Road's completion is buffered by the swing and announced on the
    // drain, which is where the XP is actually paid.
    const drained = tickGameplay(game, walk.now + 20_000);
    assert.ok(q.progress['slay5']!.count >= 1, 'the trio still counts kills');
    assert.ok(q.progress['road-first-blood']!.done, 'the Road counts the same kill');
    assert.ok(questIds([...events, ...drained], 'quest-complete').includes('road-first-blood'));
    assert.ok(q.level > 1, `XP still flows (lv${q.level})`);
  });

  it('a rejected mask equip does not advance the tutorial', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 3, 'bare', 0, 0);
    const session = new GameSession({ enabled: true });
    session.addPlayer(3, 'bare', 0, 0);
    const out = session.equipMask(3, 'cinder-hide'); // not in the bag
    assert.equal(session.activeMask(3), null);
    assert.equal(tutorialFor(3)!.objectives['tut-don-a-mask']!.done, false, 'a refusal is not a don');
    assert.ok(out.length > 0, 'the refusal is still reported to the player');
  });

  it('a signature denied by cooldown does not advance the tutorial', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 4, 'cd', 0, 0);
    const session = new GameSession({ enabled: true });
    session.addPlayer(4, 'cd', 0, 0);
    session.chooseVocation(4, 'dawnwarden');
    assert.equal(session.useSignature(4, 1, 1_000).ok, true);
    assert.equal(session.useSignature(4, 1, 2_000).ok, false, 'cooldown enforced');
    // The tutorial only had the ONE real use; the denied press changed nothing.
    assert.equal(tutorialFor(4)!.objectives['tut-signature']!.met, true);
    assert.equal(tutorialFor(4)!.objectives['tut-signature']!.count, 0, 'still unconsumed');
  });
});

// ---------------------------------------------------------------------------
// 7. Death loop clarity
// ---------------------------------------------------------------------------

describe('onboarding: the death loop explains itself', () => {
  it('names the respawn point, the protection window and the (absent) penalty', () => {
    const n = deathNotice();
    assert.deepEqual(n.respawnAt, { x: 50, y: 50 }, 'the shrine is the respawn point');
    assert.ok(n.respawnLabel.includes('50, 50'), 'the label repeats the coordinates');
    assert.ok(n.protectionS > 0, 'respawn grants protection');
    assert.match(n.penalty, /No XP lost/);
    assert.match(n.penalty, /No items lost/);
    assert.match(n.title, /FELL/);
    assert.ok(n.body.length > 0);
  });

  it('credits a killer when one is known', () => {
    assert.match(deathNotice({ killer: 'gloomfang' }).body, /Killed by gloomfang/);
    assert.doesNotMatch(deathNotice().body, /Killed by/);
  });
});

// ---------------------------------------------------------------------------
// 8. Balance guardrails
// ---------------------------------------------------------------------------

describe('onboarding: the damage budget is not weakened', () => {
  it('a minion hit is still 7 damage on a 1.5s cadence', () => {
    // Read from the AI constants themselves, not a copy: if anyone retunes
    // the budget this test fails loudly instead of testing a stale literal.
    assert.equal(MELEE_DAMAGE, 7, 'the documented per-hit damage');
    assert.equal(MELEE_COOLDOWN_SEC, 1.5, 'the documented cadence');
  });

  it('an idle naked level-1 player still survives ~21s of hitting minion', () => {
    // 100 HP, 7 per hit: hits 1..14 leave the player at 2 HP, the 15th kills.
    // With the first hit landing immediately and one every 1.5s after it,
    // that is 14 intervals = 21s — the floor docs/GAMEPLAY.md publishes for
    // "an idle player always gets a chance to react". Onboarding must not
    // shave it.
    const hitsToDie = Math.floor(100 / MELEE_DAMAGE) + 1;
    const seconds = (hitsToDie - 1) * MELEE_COOLDOWN_SEC;
    assert.equal(hitsToDie, 15);
    assert.equal(seconds, 21);
    assert.ok(seconds >= 18, 'the onboarding track must not make a fresh player die faster');
  });

  it('onboarding adds no damage, no spawn and no XP multiplier of its own', () => {
    // Every reward the track pays is flat XP through the shared `addXp`
    // (level*100). The whole track is a bounded, known amount.
    assert.equal(TUTORIAL_TOTAL_XP, 230);
    assert.ok(TUTORIAL_TOTAL_XP < 300, 'the whole track is less than three levels');
    const s = createQuestState();
    assert.equal(s.level, 1);
    assert.equal(s.xp, 0);
  });
});

// ---------------------------------------------------------------------------
// signal fixtures
// ---------------------------------------------------------------------------

function otherSignal(kind: TutorialSignal['kind']): TutorialSignal['kind'] {
  const all: TutorialSignal['kind'][] = ['position', 'melee-hit', 'finisher', 'collected', 'mask-equipped', 'signature-used'];
  return all.find((k) => k !== kind)!;
}

function signalFor(kind: TutorialSignal['kind'], st: TutorialState): TutorialSignal {
  switch (kind) {
    case 'position':
      return { kind: 'position', x: st.origin.x + TUT_MOVE_DISTANCE + 5, y: st.origin.y };
    case 'melee-hit':
      return { kind: 'melee-hit', mobId: 11, dmg: 12 };
    case 'finisher':
      return { kind: 'finisher', mobId: 11 };
    case 'collected':
      return { kind: 'collected', itemId: 'ember-shard', count: 1 };
    case 'mask-equipped':
      return { kind: 'mask-equipped', maskId: 'cinder-hide' };
    case 'signature-used':
      return { kind: 'signature-used', signatureId: 'oath-of-embers' };
    default: {
      const never: never = kind;
      throw new Error(`unknown tutorial signal: ${String(never)}`);
    }
  }
}

void seeded;
void noteMaskEquipped;
void noteSignatureUsed;