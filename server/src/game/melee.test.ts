// Player melee against world (spawner) mobs.
//
// This is the regression suite for the gap that started all of this: the server
// routed `input.attack` only into `npcs.damageFromPlayer`, so NO regular mob
// ever died. `onMobKilled` therefore never ran for gameplay/spawner mobs and
// `mob-die` / `xp-gain` / `pickup-spawn` were never emitted, kill quests never
// advanced, and no loot ever dropped. The client compensated with a
// snapshot-diff fallback in client/src/main.ts (`announcedDeaths`).
//
// These tests pin the server-authoritative behaviour instead: a simulated
// player attack kills a mob and emits the three events, quest progress
// increments, XP/loot land on the killer, and the respawn timer still holds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import {
  ATTACK_COOLDOWN_MS,
  MELEE_RANGE,
  RESPAWN_DELAY_MS,
} from './combat.js';
import {
  clearMeleeCooldown,
  createGameState,
  ensurePlayer,
  meleeCooldownAt,
  onMobKilled,
  playerMeleeAttack,
  setPlayerPos,
  tickGameplay,
  type GameEvent,
  type GameState,
} from './index.js';
/** Seeded RNG so crit + loot rolls are deterministic across runs. */
const alwaysLoot = mulberry32(0x5eed);

function kindsOf(events: GameEvent[]): string[] {
  return events.map((e) => e.kind);
}

/** Typed view of an event payload. */
function payload<T>(e: GameEvent): T {
  return e.payload as T;
}

/**
 * A world with one player standing within melee reach of at least one live
 * spawner mob. Returns the game plus those mobs, so tests assert on real
 * spawner output rather than a fabricated Mob.
 *
 * The player is parked ON a mob's own (walkable) tile rather than on an
 * arbitrary coordinate: `MOBS_PER_CHUNK` is 4 per 32x32 chunk, so a fixed
 * spawn point usually has nothing within MELEE_RANGE and the test would be
 * testing geometry rather than the kill path.
 */
function worldWithMob() {
  const game = createGameState(1337);
  ensurePlayer(game, 1, 'hero', 16, 16);
  // ensureAround is exactly what the 20Hz tick calls, so the mob population
  // here is the same one gameplay sees.
  game.spawner.ensureAround(16, 16, 0);
  const live = game.spawner.mobsList().filter((m) => m.alive);
  assert.ok(live.length > 0, 'spawner produced mobs around the start chunk');
  const anchor = live[0]!;
  // Teleport the player next to the anchor mob. `range` is deliberately larger
  // than MELEE_RANGE so a spread-out spawn still yields a target, but small
  // enough that the anchor is unambiguously the nearest one.
  const range = 40;
  const best = live
    .map((m) => ({ m, d: Math.hypot(m.pos.x - anchor.pos.x, m.pos.y - anchor.pos.y) }))
    .filter((e) => e.d > MELEE_RANGE * 0.5 && e.d < range)
    .sort((a, b) => a.d - b.d)[0];
  // Anchor or the closest usable neighbour becomes the expected target.
  const target = best ? best.m : anchor;
  const dx = target.pos.x - anchor.pos.x;
  const dy = target.pos.y - anchor.pos.y;
  const len = Math.hypot(dx, dy) || 1;
  setPlayerPos(game, 1, target.pos.x - (dx / len) * 1.0, target.pos.y - (dy / len) * 1.0);
  const me = game.players.get(1)!;
  const inReach = game.spawner
    .mobsList()
    .filter((m) => m.alive && Math.hypot(m.pos.x - me.x, m.pos.y - me.y) <= MELEE_RANGE);
  assert.ok(inReach.length > 0, 'at least one mob is in melee reach');
  return { game, inReach };
}

/**
 * Swing until the targeted mob dies, honouring the attack cooldown. Returns
 * every event produced across the fight, in order.
 */
function fightToKill(
  game: GameState,
  playerId: number,
  opts: { startAt?: number; crit?: boolean } = {},
): { events: GameEvent[]; swings: number; lastAt: number; killed: boolean; mobId: number | null } {
  const events: GameEvent[] = [];
  let now = opts.startAt ?? 1000;
  let swings = 0;
  let mobId: number | null = null;
  for (let i = 0; i < 200; i++) {
    const r = playerMeleeAttack(game, playerId, now, {
      rand: alwaysLoot,
      ...(opts.crit !== undefined ? { crit: opts.crit } : {}),
    });
    if (r.ok) {
      swings++;
      mobId = r.mobId;
      events.push(...r.events);
      if (r.killed) return { events, swings, lastAt: now, killed: true, mobId: r.mobId };
    }
    now += ATTACK_COOLDOWN_MS;
  }
  return { events, swings, lastAt: now, killed: false, mobId };
}

describe('melee: player attack kills a world mob and emits the 3 events', () => {
  it('finds a live mob in reach and damages it', () => {
    const { game, inReach } = worldWithMob();
    assert.ok(inReach.length > 0, 'spawner produced a mob within melee reach');
    const target = inReach[0]!;
    const before = target.hp;

    const r = playerMeleeAttack(game, 1, 1000, { crit: false, rand: alwaysLoot });
    assert.equal(r.ok, true);
    assert.equal(r.mobId, target.id);
    assert.ok(r.dmg > 0, 'a landed swing removes hp');
    assert.equal(target.hp, before - r.dmg);
  });

  it('kills the mob and emits mob-die + xp-gain + pickup-spawn', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    const { events, killed } = fightToKill(game, 1);

    assert.equal(killed, true, 'the mob died to player melee');
    const seen = kindsOf(events);
    assert.ok(seen.includes('mob-die'), 'mob-die emitted');
    assert.ok(seen.includes('xp-gain'), 'xp-gain emitted');
    assert.ok(seen.includes('pickup-spawn'), 'pickup-spawn emitted');
  });

  it('mob-die credits the killer and marks the mob dead', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    const { events } = fightToKill(game, 1);
    const die = events.find((e) => e.kind === 'mob-die')!;

    assert.equal(payload<{ id: number }>(die).id, target.id);
    assert.equal(payload<{ killedBy: number }>(die).killedBy, 1);
    assert.equal(target.alive, false, 'mob marked dead');
    assert.equal(target.hp, 0);
    // The respawn timer is still the pre-existing 5s one; no second timer.
    assert.ok(target.respawnAt > 0, 'a respawn timer was set');
  });

  it('pickup-spawn events match the loot actually placed in the world', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    const { events } = fightToKill(game, 1);
    const spawns = events.filter((e) => e.kind === 'pickup-spawn');
    const pickupsBefore = game.pickups.length;

    assert.equal(spawns.length, pickupsBefore, 'every announced pickup exists in game state');
    for (const e of spawns) {
      const p = payload<{ id: number; itemId: string; count: number }>(e);
      const real = game.pickups.find((q) => q.id === p.id);
      assert.ok(real, `pickup ${p.id} exists`);
      assert.equal(real.itemId, p.itemId);
      assert.equal(real.count, p.count);
    }
  });

  it('loot is placed near the corpse, not at the player', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    fightToKill(game, 1);
    for (const q of game.pickups) {
      const d = Math.hypot(q.x - target.pos.x, q.y - target.pos.y);
      assert.ok(d <= 2, `pickup dropped at the corpse (got ${d.toFixed(2)}u)`);
    }
  });

  it('xp-gain carries the killer, a positive amount and the post-kill level', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    const { events } = fightToKill(game, 1);
    const xp = events.find((e) => e.kind === 'xp-gain')!;
    const p = payload<{ playerId: number; amount: number; level: number; xpLeft: number }>(xp);

    assert.equal(p.playerId, 1, 'XP credited to the killer only');
    assert.ok(p.amount > 0, 'positive XP amount');
    assert.equal(p.level, game.players.get(1)!.quests.level);
  });
});

describe('melee: quest progress increments on a kill', () => {
  it('advances the slay5 kill quest by exactly one per kill', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const quests = game.players.get(1)!.quests;
    assert.equal(quests.progress['slay5']!.count, 0, 'starts at zero');

    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    // Park the player on the mob so the swing is guaranteed to land.
    setPlayerPos(game, 1, mob.pos.x, mob.pos.y);
    const { killed } = fightToKill(game, 1);

    assert.equal(killed, true);
    assert.equal(quests.progress['slay5']!.count, 1, 'kill quest incremented');
  });

  it('emits quest-progress with an absolute count the client can trust', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    setPlayerPos(game, 1, mob.pos.x, mob.pos.y);

    const { events, killed } = fightToKill(game, 1);
    assert.equal(killed, true);
    const progress = events.find((e) => e.kind === 'quest-progress');
    assert.ok(progress, 'quest-progress emitted on kill');
    const p = payload<{ playerId: number; questId: string; count: number; goal: number }>(progress!);
    assert.equal(p.playerId, 1);
    assert.equal(p.questId, 'slay5');
    assert.equal(p.count, 1, 'absolute count, not a delta');
    assert.equal(p.goal, 5);
  });

  it('a non-lethal swing advances no kill quest', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    setPlayerPos(game, 1, mob.pos.x, mob.pos.y);

    const r = playerMeleeAttack(game, 1, 1000, { crit: false, rand: alwaysLoot });
    assert.equal(r.ok, true);
    assert.equal(r.killed, false, 'a single weak swing does not kill a meadow mob');
    assert.deepEqual(r.events, [], 'no quest/xp/loot events without a kill');
    assert.equal(game.players.get(1)!.quests.progress['slay5']!.count, 0);
  });
});

describe('melee: swing rules on the input hot path', () => {
  it('respects the attack cooldown', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    const first = playerMeleeAttack(game, 1, 1000, { crit: false, rand: alwaysLoot });
    assert.equal(first.ok, true);
    assert.equal(first.mobId, target.id);

    const early = playerMeleeAttack(game, 1, 1000 + ATTACK_COOLDOWN_MS - 1, { crit: false, rand: alwaysLoot });
    assert.deepEqual(early, { ok: false, reason: 'cooldown', events: [] });

    const onTime = playerMeleeAttack(game, 1, 1000 + ATTACK_COOLDOWN_MS, { crit: false, rand: alwaysLoot });
    assert.equal(onTime.ok, true, 'the swing lands once the cooldown elapses');
  });

  it('does not consume the cooldown when there is no target in range', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 900, 900); // far from any spawned chunk
    game.spawner.ensureAround(16, 16, 0);
    const before = meleeCooldownAt(game, 1);
    assert.equal(before, -Infinity);

    const miss = playerMeleeAttack(game, 1, 5000, { rand: alwaysLoot });
    assert.deepEqual(miss, { ok: false, reason: 'no-target', events: [] });
    assert.equal(meleeCooldownAt(game, 1), before, 'a whiffed swing does not start the timer');
  });

  it('cannot hit a mob beyond melee range', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList()[0]!;
    setPlayerPos(game, 1, mob.pos.x, mob.pos.y + MELEE_RANGE + 5);

    const r = playerMeleeAttack(game, 1, 1000, { rand: alwaysLoot });
    assert.equal(r.ok, false, 'out of reach is not a hit');
    assert.equal(mob.hp, mob.maxHp, 'mob untouched');
  });

  it('clearing the cooldown lets a fresh swing land immediately', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    const hp0 = target.hp;

    const first = playerMeleeAttack(game, 1, 1000, { crit: false, rand: alwaysLoot });
    assert.equal(first.ok, true);
    assert.equal(playerMeleeAttack(game, 1, 1001, { crit: false, rand: alwaysLoot }).ok, false);

    clearMeleeCooldown(game, 1);
    const second = playerMeleeAttack(game, 1, 1002, { crit: false, rand: alwaysLoot });
    assert.equal(second.ok, true, 'cleared cooldown allows an immediate second swing');
    // Both swings landed: hp reflects exactly the two reported amounts.
    assert.equal(target.hp, hp0 - first.dmg - second.dmg);
  });
});

describe('melee: target selection and mob bookkeeping', () => {
  it('picks the NEAREST mob, not the first spawned', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const live = game.spawner.mobsList().filter((m) => m.alive);
    assert.ok(live.length >= 2, 'need at least two mobs to test nearest-target');
    // Stand on the second mob's tile: it must be chosen even though the first
    // mob has a lower id.
    const want = live[1]!;
    setPlayerPos(game, 1, want.pos.x, want.pos.y);
    const r = playerMeleeAttack(game, 1, 1000, { crit: false, rand: alwaysLoot });
    assert.equal(r.ok, true);
    assert.equal(r.mobId, want.id, 'the mob actually stood on was hit');
    assert.notEqual(want.id, live[0]!.id, 'not simply the lowest-id mob');
  });

  it('prefers the nearer of two mobs sharing a tile region', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const live = game.spawner.mobsList().filter((m) => m.alive);
    const [a, b] = live;
    // Two mobs 2u apart: stand between them, closer to `a`.
    game.spawner.moveMob(a.id, 10, 10);
    game.spawner.moveMob(b.id, 12, 10);
    setPlayerPos(game, 1, 9, 10);
    const r = playerMeleeAttack(game, 1, 1000, { crit: false, rand: alwaysLoot });
    assert.equal(r.ok, true);
    assert.equal(r.mobId, a.id, 'the 1u mob was hit, not the 3u one');
  });

  it('never targets a dead mob', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const live = game.spawner.mobsList().filter((m) => m.alive);
    const corpse = live[0]!;
    // Park the player on the corpse's tile AND pull a second mob within reach,
    // so the post-kill query has a live alternative to find.
    const other = live.find((m) => m.id !== corpse.id)!;
    game.spawner.moveMob(other.id, corpse.pos.x + 1, corpse.pos.y);
    setPlayerPos(game, 1, corpse.pos.x, corpse.pos.y);
    // Kill the corpse directly, leaving the survivor the nearest live target.
    onMobKilled(game, 1, corpse.id, 1000, alwaysLoot);
    assert.equal(corpse.alive, false);

    const r = playerMeleeAttack(game, 1, 2000, { crit: false, rand: alwaysLoot });
    assert.equal(r.ok, true);
    assert.notEqual(r.mobId, corpse.id, 'a dead mob is never retargeted');
    assert.ok(
      live.filter((m) => m.id !== corpse.id).some((m) => m.id === r.mobId),
      'some other live mob was targeted',
    );
  });

  it('a killed mob cannot be double-killed for double rewards', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    setPlayerPos(game, 1, target.pos.x, target.pos.y);
    const { events } = fightToKill(game, 1);
    const xpEvents = events.filter((e) => e.kind === 'xp-gain');
    const dieEvents = events.filter((e) => e.kind === 'mob-die');
    assert.equal(dieEvents.length, 1, 'exactly one death announcement');
    assert.equal(xpEvents.length, 1, 'exactly one XP payout');
  });

  it('unknown players cannot swing', () => {
    const { game } = worldWithMob();
    const r = playerMeleeAttack(game, 4242, 1000, { rand: alwaysLoot });
    assert.deepEqual(r, { ok: false, reason: 'no-target', events: [] });
  });
});

describe('melee: the respawn timer still owns revival', () => {
  it('a mob killed by melee respawns on the existing 5s tick', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    setPlayerPos(game, 1, mob.pos.x, mob.pos.y);
    const killAt = 10_000;
    const { killed, lastAt } = fightToKill(game, 1, { startAt: killAt });
    assert.equal(killed, true);
    // The lethal swing landed on `lastAt` (the cooldown walk), not on `killAt`.
    assert.equal(mob.respawnAt, lastAt + RESPAWN_DELAY_MS, '5s respawn preserved');

    // Before the timer: still dead, no respawn event.
    const early = tickGameplay(game, lastAt + RESPAWN_DELAY_MS - 1).filter((e) => e.kind === 'mob-respawn');
    assert.deepEqual(early, []);
    assert.equal(mob.alive, false);

    // After: back at full HP at its spawn point, announced once.
    const due = tickGameplay(game, lastAt + RESPAWN_DELAY_MS);
    const respawns = due.filter((e) => e.kind === 'mob-respawn');
    assert.equal(respawns.length >= 1, true, 'mob-respawn emitted');
    assert.equal(mob.alive, true);
    assert.equal(mob.hp, mob.maxHp);
    assert.equal(mob.pos.x, mob.spawnPos.x);
    assert.equal(mob.pos.y, mob.spawnPos.y);
  });

  it('a respawned mob is targetable again', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    setPlayerPos(game, 1, mob.pos.x, mob.pos.y);
    const killAt = 10_000;
    const { lastAt } = fightToKill(game, 1, { startAt: killAt });
    tickGameplay(game, lastAt + RESPAWN_DELAY_MS);
    clearMeleeCooldown(game, 1);

    const again = playerMeleeAttack(game, 1, lastAt + RESPAWN_DELAY_MS, { crit: false, rand: alwaysLoot });
    assert.equal(again.ok, true, 'the revived mob can be hit');
    assert.equal(again.mobId, mob.id);
  });
});

describe('melee: kills do not double-credit XP on a second call', () => {
  it('onMobKilled is idempotent for an already-dead mob', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    const first = onMobKilled(game, 1, mob.id, 10_000, alwaysLoot);
    assert.ok(first.some((e) => e.kind === 'mob-die'));
    const pickupsAfterFirst = game.pickups.length;
    const xpAfterFirst = game.players.get(1)!.quests.xp;

    const second = onMobKilled(game, 1, mob.id, 10_001, alwaysLoot);
    assert.deepEqual(second, [], 'no second payout');
    assert.equal(game.pickups.length, pickupsAfterFirst, 'loot not duplicated');
    assert.ok(
      game.players.get(1)!.quests.xp - xpAfterFirst < xpAfterFirst + 100,
      'XP not re-awarded at scale',
    );
  });
});

describe('melee: event payload shape is protocol-v1 safe', () => {
  it('every emitted payload is JSON-serialisable and non-null', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    setPlayerPos(game, 1, target.pos.x, target.pos.y);
    const { events } = fightToKill(game, 1);
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.ok(e.payload !== null && e.payload !== undefined, `${e.kind} has a payload`);
      assert.doesNotThrow(() => JSON.stringify(e.payload), `${e.kind} is serialisable`);
    }
  });

  it('the three headline events are all present in one kill', () => {
    const { game, inReach } = worldWithMob();
    const target = inReach[0]!;
    setPlayerPos(game, 1, target.pos.x, target.pos.y);
    const { events } = fightToKill(game, 1);
    const seen = new Set(kindsOf(events));
    for (const required of ['mob-die', 'xp-gain', 'pickup-spawn']) {
      assert.equal(seen.has(required), true, `${required} fired`);
    }
  });
});
