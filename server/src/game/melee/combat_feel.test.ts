// Close-quarters finish loop: downed -> finisher, ranged-cannot-finish,
// thrown sidearms (stun + drop + pickup round-trip), hit-stop emission.
//
// Mobs/NPCs reduced to 0 HP go DOWNED (3s crawl) instead of dying; only a
// melee swing inside finish reach finishes them (instant kill + bonus XP).
// Ranged-equivalent hits knock down but never finish. Unanswered knockdowns
// stand back up; they never bleed out.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import { getZone } from '@aetherfall/engine';
import { ATTACK_COOLDOWN_MS } from '../combat.js';
import {
  DOWNED_DURATION_MS,
  FINISHER_BONUS_XP,
  HIT_STOP_MS,
  THROW_RANGE,
  THROW_STUN_MS,
  UNARMED_PICKUP_RANGE,
} from '../../systems/combat_ext.js';import {
  addItem,
  clearMeleeCooldown,
  collectPickup,
  countOf,
  createGameState,
  ensurePlayer,
  onBossKilled,
  onMobKilled,
  playerMeleeAttack,
  playerPickupRadius,
  playerThrowWeapon,
  setPlayerPos,
  tickGameplay,
  tryPickup,
  xpForKill,
  type GameEvent,
  type GameState,
} from '../index.js';
import { NPCManager, _resetNpcIds } from '../../ai/npc.js';

const rand = mulberry32(0x5eed);

function kindsOf(events: GameEvent[]): string[] {
  return events.map((e) => e.kind);
}

function payload<T>(e: GameEvent): T {
  return e.payload as T;
}

/** One player parked on a live spawner mob's tile (guaranteed in reach). */
function worldWithMob() {
  const game = createGameState(1337);
  ensurePlayer(game, 1, 'hero', 16, 16);
  game.spawner.ensureAround(16, 16, 0);
  const live = game.spawner.mobsList().filter((m) => m.alive);
  assert.ok(live.length > 0, 'spawner produced mobs');
  const target = live[0]!;
  setPlayerPos(game, 1, target.pos.x, target.pos.y);
  return { game, target };
}

/** One lethal melee swing (deterministic, no crit). */
function oneShot(game: GameState, now: number) {
  return playerMeleeAttack(game, 1, now, { bonusDmg: 1000, crit: false, rand });
}

describe('finish loop: downed -> finisher (spawner mobs)', () => {
  it('a lethal swing knocks downed instead of killing', () => {
    const { game, target } = worldWithMob();
    const hp0 = target.hp;
    assert.ok(hp0 > 0);

    const r = oneShot(game, 1000);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.killed, false, 'no kill yet');
    assert.equal(r.downed, true, 'knocked downed');
    assert.equal(r.dmg, hp0, 'removed exactly the remaining hp');
    assert.equal(target.hp, 0);
    assert.equal(target.alive, true, 'downed mobs stay alive');
    assert.ok((target.downedUntil ?? 0) > 1000, 'crawl timer armed');
    const kinds = kindsOf(r.events);
    assert.ok(kinds.includes('mob-downed'), 'mob-downed announced');
    assert.ok(!kinds.includes('mob-die'), 'no death announced');
    assert.ok(!kinds.includes('xp-gain'), 'no XP before the finish');
  });

  it('a melee swing on the downed mob finishes it with bonus XP + hit-stop', () => {
    const { game, target } = worldWithMob();
    const zone = getZone(target.pos.x, target.pos.y, game.seed);
    const baseXp = xpForKill(zone, target.level);

    const down = oneShot(game, 1000);
    assert.equal(down.ok, true);
    // Finish with a rigged RNG (always rolls) so the corpse-loot assertion is
    // deterministic rather than at the mercy of the shared loot stream.
    const fin = playerMeleeAttack(game, 1, 1000 + ATTACK_COOLDOWN_MS, { rand: () => 0 });
    assert.equal(fin.ok, true);
    if (!fin.ok) return;
    assert.equal(fin.killed, true);
    assert.equal(fin.finished, true);
    assert.equal(target.alive, false, 'finished mobs die');
    assert.ok(target.respawnAt > 0, 'standard 5s respawn armed');

    const die = fin.events.find((e) => e.kind === 'mob-die')!;
    assert.ok(die, 'mob-die emitted');
    assert.deepEqual(payload(die), { id: target.id, killedBy: 1, finisher: true });
    const xp = fin.events.find((e) => e.kind === 'xp-gain')!;
    assert.equal(payload<{ amount: number }>(xp).amount, baseXp + FINISHER_BONUS_XP, 'base kill XP + finisher bonus');
    const stop = fin.events.find((e) => e.kind === 'hit-stop')!;
    assert.deepEqual(payload(stop), { durationMs: HIT_STOP_MS, mobId: target.id, finisher: true });
    assert.equal(HIT_STOP_MS, 90);
    assert.ok(fin.events.some((e) => e.kind === 'pickup-spawn'), 'corpse loot still drops');
  });

  it('an unanswered knockdown stands back up (mob-up), never bleeds out', () => {
    const { game, target } = worldWithMob();
    oneShot(game, 1000);
    assert.equal(target.alive, true);

    const evts = tickGameplay(game, 1000 + DOWNED_DURATION_MS);
    const up = evts.find((e) => e.kind === 'mob-up');
    assert.ok(up, 'mob-up announced');
    assert.equal(payload<{ id: number }>(up!).id, target.id);
    assert.equal(target.alive, true, 'still alive');
    assert.ok(target.hp > 0 && target.hp < target.maxHp, `partial HP (${target.hp}/${target.maxHp})`);
    assert.ok(!kindsOf(evts).includes('mob-die'), 'no death without a finish');

    // The recovered mob is targetable again.
    clearMeleeCooldown(game, 1);
    const again = playerMeleeAttack(game, 1, 1000 + DOWNED_DURATION_MS, { crit: false, rand });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.mobId, target.id);
  });

  it('ranged swings knock down but never finish (must walk up)', () => {
    const { game, target } = worldWithMob();
    const down = oneShot(game, 1000);
    assert.equal(down.ok, true);

    const at = 1000 + ATTACK_COOLDOWN_MS;
    const refused = playerMeleeAttack(game, 1, at, { ranged: true, crit: false, rand });
    assert.deepEqual(refused, { ok: false, reason: 'downed', events: [] });
    assert.equal(target.alive, true, 'still crawling');
    assert.equal(target.hp, 0);
    // A refused ranged swing does not eat the cooldown: the melee finish lands now.
    const fin = playerMeleeAttack(game, 1, at, { crit: false, rand });
    assert.equal(fin.ok, true);
    if (fin.ok) assert.equal(fin.killed, true);
  });

  it('a downed mob drops aggro while crawling', () => {
    const { game, target } = worldWithMob();
    target.targetId = 1;
    oneShot(game, 1000);
    const evts = tickGameplay(game, 1500);
    assert.equal(target.targetId, null, 'crawling mobs hold no target');
    void evts;
  });
});

describe('finish loop: NPC minions + bosses', () => {
  it('minion: lethal hit downs, ranged refuses, melee finishes (mob-die)', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const t0 = 1_000_000;
    const id = npcs.minionIds()[0]!;
    const snap = npcs.snapshot().find((e) => e.id === id)!;
    const players = [{ id: 7, x: snap.p.x, y: snap.p.y, hp: 100 }];

    assert.equal(npcs.damageFromPlayer(snap.p.x, snap.p.y, 1000, 7, { now: t0 }), id);
    let ev = npcs.tick(0.1, players, t0 + 100);
    assert.ok(ev.some((e) => e.kind === 'mob-downed'), 'crawl announced');
    assert.ok(!ev.some((e) => e.kind === 'boss-kill'), 'no boss-kill for a minion');
    assert.ok(npcs.snapshot().some((e) => e.id === id && e.hp === 0), 'downed minion still visible at 0 HP');
    assert.equal(npcs.isNpcDowned(id, t0 + 100), true);

    assert.equal(
      npcs.damageFromPlayer(snap.p.x, snap.p.y, 12, 7, { ranged: true, now: t0 + 200 }),
      -1,
      'ranged cannot finish',
    );
    assert.equal(npcs.isNpcDowned(id, t0 + 200), true, 'still crawling');

    assert.equal(npcs.damageFromPlayer(snap.p.x, snap.p.y, 12, 7, { now: t0 + 300 }), id);
    ev = npcs.tick(0.1, players, t0 + 400);
    const died = ev.filter((e) => e.kind === 'mob-die');
    assert.equal(died.length, 1, 'exactly one finish announcement');
    assert.deepEqual(died[0], { kind: 'mob-die', id, killedBy: 7, finisher: true });

    // The finished minion runs the normal death -> 5s respawn cycle.
    let now = t0 + 400;
    for (let i = 0; i < 60; i++) {
      now += 100;
      npcs.tick(0.1, players, now);
    }
    const back = npcs.snapshot().find((e) => e.id === id)!;
    assert.ok(back, 'respawned');
    assert.equal(back.hp, back.maxHp, 'full HP after the 5s timer');
  });

  it('minion: unanswered knockdown recovers (mob-up)', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const t0 = 2_000_000;
    const id = npcs.minionIds()[0]!;
    const snap = npcs.snapshot().find((e) => e.id === id)!;
    const players = [{ id: 7, x: snap.p.x, y: snap.p.y, hp: 100 }];

    npcs.damageFromPlayer(snap.p.x, snap.p.y, 1000, 7, { now: t0 });
    npcs.tick(0.1, players, t0 + 100);
    const ev = npcs.tick(0.1, players, t0 + DOWNED_DURATION_MS + 100);
    assert.ok(ev.some((e) => e.kind === 'mob-up'), 'recovery announced');
    const back = npcs.snapshot().find((e) => e.id === id)!;
    assert.ok(back.hp > 0 && back.hp < back.maxHp, 'partial HP on stand-up');
  });

  it('boss: lethal hit downs (no boss-kill), melee finishes (one boss-kill)', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const t0 = 3_000_000;
    const players = [{ id: 42, x: 86, y: 20, hp: 100 }];
    npcs.tick(0.1, players, t0);
    const wyrm = npcs.snapshot().find((e) => e.name === 'Ember Wyrm')!;
    assert.ok(wyrm, 'wyrm woke on approach');
    players[0]!.x = wyrm.p.x;
    players[0]!.y = wyrm.p.y;

    assert.equal(npcs.damageFromPlayer(wyrm.p.x, wyrm.p.y, 10000, 42, { now: t0 + 100 }), wyrm.id);
    let ev = npcs.tick(0.1, players, t0 + 200);
    assert.ok(ev.some((e) => e.kind === 'mob-downed'), 'boss crawl announced');
    assert.ok(!ev.some((e) => e.kind === 'boss-kill'), 'no payout before the finish');

    assert.equal(
      npcs.damageFromPlayer(wyrm.p.x, wyrm.p.y, 12, 42, { ranged: true, now: t0 + 300 }),
      -1,
      'ranged cannot finish a boss',
    );
    assert.equal(npcs.damageFromPlayer(wyrm.p.x, wyrm.p.y, 12, 42, { now: t0 + 400 }), wyrm.id);
    ev = npcs.tick(0.1, players, t0 + 500);
    const kills = ev.filter((e) => e.kind === 'boss-kill');
    assert.equal(kills.length, 1, 'exactly one boss-kill');
    assert.equal((kills[0] as { killedBy: number }).killedBy, 42);
  });

  it('stun: a stunned minion holds still and cannot attack', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const t0 = 4_000_000;
    const id = npcs.minionIds()[0]!;
    // No players in sense range: the minion patrols, so movement is observable.
    const players = [{ id: 1, x: 0, y: 0, hp: 100 }];
    for (let i = 0; i < 5; i++) npcs.tick(0.1, players, t0 + i * 100);

    assert.equal(npcs.stunNpc(id, t0 + 10_000), true);
    const drain = npcs.tick(0.1, players, t0 + 500);
    assert.ok(drain.some((e) => e.kind === 'mob-stun'), 'stun announced');
    const frozen = npcs.snapshot().find((e) => e.id === id)!;
    for (let i = 0; i < 10; i++) {
      const ev = npcs.tick(0.1, players, t0 + 600 + i * 100);
      assert.ok(!ev.some((e) => e.kind === 'damage-player' && (e as { fromId: number }).fromId === id));
    }
    const still = npcs.snapshot().find((e) => e.id === id)!;
    assert.deepEqual({ x: still.p.x, y: still.p.y }, { x: frozen.p.x, y: frozen.p.y }, 'no movement while stunned');

    // After the window the minion walks again.
    for (let i = 0; i < 10; i++) npcs.tick(0.1, players, t0 + 11_000 + i * 100);
    const free = npcs.snapshot().find((e) => e.id === id)!;
    assert.ok(
      Math.hypot(free.p.x - still.p.x, free.p.y - still.p.y) > 0,
      'movement resumes once the stun lapses',
    );
  });
});

describe('thrown sidearms: stun + drop + pickup round-trip', () => {
  function armedWorld() {
    const { game } = worldWithMob();
    const me = game.players.get(1)!;
    assert.equal(addItem(me.inv, 'ember-axe', 1), true);
    return { game, me };
  }

  it('a throw hits in reach: damage + 1s stun, weapon lands as a pickup', () => {
    const { game, me } = armedWorld();
    const target = game.spawner.mobsList().find((m) => m.alive)!;
    setPlayerPos(game, 1, target.pos.x - 3, target.pos.y);
    const hp0 = target.hp;
    const now = 5000;

    const dx = target.pos.x - me.x;
    const dy = target.pos.y - me.y;
    const r = playerThrowWeapon(game, 1, now, dx, dy, { crit: false, rand });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hit, true);
    assert.equal(r.mobId, target.id);
    assert.equal(r.weaponId, 'ember-axe');
    assert.equal(countOf(me.inv, 'ember-axe'), 0, 'throw spends the weapon');
    assert.ok(target.hp < hp0, 'damage landed');
    assert.equal(game.spawner.isStunned(target.id, now + THROW_STUN_MS - 1), true, 'stunned for 1s');
    assert.equal(game.spawner.isStunned(target.id, now + THROW_STUN_MS + 1), false, 'stun lapses');
    const dist = Math.hypot(r.landing.x - me.x, r.landing.y - me.y);
    assert.ok(dist <= THROW_RANGE + 1e-9, `lands within ${THROW_RANGE}u (got ${dist})`);

    const landed = game.pickups.find((p) => p.id === r.pickupId)!;
    assert.ok(landed, 'landed weapon exists in world state');
    assert.equal(landed.itemId, 'ember-axe');
    assert.deepEqual({ x: landed.x, y: landed.y }, r.landing);
    assert.ok(kindsOf(r.events).includes('mob-stun'), 'mob-stun announced');
    assert.ok(kindsOf(r.events).includes('pickup-spawn'), 'landing announced');
  });

  it('a lethal throw downs (never kills): the walk-up is still required', () => {
    const { game, me } = armedWorld();
    const target = game.spawner.mobsList().find((m) => m.alive)!;
    target.hp = 1;
    setPlayerPos(game, 1, target.pos.x - 3, target.pos.y);
    const now = 6000;

    const r = playerThrowWeapon(game, 1, now, target.pos.x - me.x, target.pos.y - me.y, { crit: false, rand });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hit, true);
    assert.equal(target.alive, true, 'downed, not dead');
    assert.equal(target.hp, 0);
    assert.ok(kindsOf(r.events).includes('mob-downed'));
    assert.ok(!kindsOf(r.events).includes('mob-die'), 'throws never finish');
    assert.ok(!kindsOf(r.events).includes('hit-stop'), 'no kill, no hit-stop');
  });

  it('a throw with nothing in reach still spends and lands the weapon', () => {
    const { game } = armedWorld();
    setPlayerPos(game, 1, 500, 500); // nowhere near the 16,16 spawns
    const r = playerThrowWeapon(game, 1, 7000, 1, 0, { rand });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hit, false);
    assert.equal(r.mobId, null);
    assert.ok(game.pickups.some((p) => p.id === r.pickupId), 'missed weapon still lands');
  });

  it('unarmed fighters cannot throw', () => {
    const { game } = worldWithMob();
    const r = playerThrowWeapon(game, 1, 8000, 1, 0, { rand });
    assert.deepEqual(r, { ok: false, reason: 'no-weapon', events: [] });
  });

  it('pickup round-trip: landing -> walk up -> collect regains the weapon', () => {
    const { game, me } = armedWorld();
    const target = game.spawner.mobsList().find((m) => m.alive)!;
    setPlayerPos(game, 1, target.pos.x - 3, target.pos.y);
    const r = playerThrowWeapon(game, 1, 9000, target.pos.x - me.x, target.pos.y - me.y, { crit: false, rand });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    // Walk to the landing and collect with the (now unarmed) short radius.
    setPlayerPos(game, 1, r.landing.x, r.landing.y);
    assert.equal(playerPickupRadius(game, 1), UNARMED_PICKUP_RANGE);
    const evts = collectPickup(game, 1, r.pickupId);
    assert.ok(kindsOf(evts).includes('pickup-collect'), 'collection announced');
    assert.equal(countOf(me.inv, 'ember-axe'), 1, 'weapon back in hand');
    assert.ok(!game.pickups.some((p) => p.id === r.pickupId), 'pickup removed from the world');
  });

  it('unarmed pickup radius is 1.5u (armed 2.5u)', () => {
    const { game } = worldWithMob();
    const me = game.players.get(1)!;
    assert.equal(playerPickupRadius(game, 1), UNARMED_PICKUP_RANGE, 'empty hands: short reach');
    assert.equal(addItem(me.inv, 'ember-axe', 1), true);
    assert.equal(playerPickupRadius(game, 1), 2.5, 'armed: full reach');

    // At 2.0u the same pickup is out of reach unarmed but fine armed.
    const unarmed = tryPickup(
      { slots: Array.from({ length: 20 }, () => null) },
      { id: 1, kind: 'pickup', itemId: 'ember-shard', count: 1, x: 2, y: 0 },
      { x: 0, y: 0 },
      UNARMED_PICKUP_RANGE,
    );
    assert.deepEqual(unarmed, { ok: false, reason: 'too-far' });
    const armed = tryPickup(
      { slots: Array.from({ length: 20 }, () => null) },
      { id: 1, kind: 'pickup', itemId: 'ember-shard', count: 1, x: 2, y: 0 },
      { x: 0, y: 0 },
      2.5,
    );
    assert.deepEqual(armed, { ok: true });
  });
});

describe('hit-stop event emission', () => {
  it('direct kills emit hit-stop (90ms, no finisher flag)', () => {
    const { game } = worldWithMob();
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    const evts = onMobKilled(game, 1, mob.id, 10_000, rand);
    assert.ok(evts.some((e) => e.kind === 'mob-die'), 'kill announced');
    const stop = evts.find((e) => e.kind === 'hit-stop')!;
    assert.ok(stop, 'hit-stop emitted on the kill');
    assert.deepEqual(payload(stop), { durationMs: 90, mobId: mob.id });
  });

  it('boss finishers pay the bonus and flag hit-stop', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 7, 'duo-tank', 10, 20);
    const evts = onBossKilled(game, 7, 'ember-wyrm', 10, 20, rand, { finisher: true });
    const kill = evts.find((e) => e.kind === 'boss-kill')!;
    assert.deepEqual(payload(kill), {
      playerId: 7, boss: 'ember-wyrm', xp: 200 + FINISHER_BONUS_XP, x: 10, y: 20, finisher: true,
    });
    const xp = evts.find((e) => e.kind === 'xp-gain')!;
    assert.equal(payload<{ amount: number }>(xp).amount, 200 + FINISHER_BONUS_XP);
    const stop = evts.find((e) => e.kind === 'hit-stop')!;
    assert.deepEqual(payload(stop), { durationMs: 90, boss: 'ember-wyrm', finisher: true });
  });

  it('non-finisher boss kills keep the exact legacy payload (+ hit-stop)', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 7, 'duo-tank', 10, 20);
    const evts = onBossKilled(game, 7, 'ember-wyrm', 10, 20, rand);
    const kill = evts.find((e) => e.kind === 'boss-kill')!;
    assert.deepEqual(payload(kill), { playerId: 7, boss: 'ember-wyrm', xp: 200, x: 10, y: 20 });
    assert.ok(evts.some((e) => e.kind === 'hit-stop'), 'hit-stop still emitted');
  });

  it('every emitted payload stays JSON-serialisable protocol-v1 cargo', () => {
    const { game, target } = worldWithMob();
    setPlayerPos(game, 1, target.pos.x, target.pos.y);
    const down = oneShot(game, 1000);
    assert.equal(down.ok, true);
    const fin = playerMeleeAttack(game, 1, 1000 + ATTACK_COOLDOWN_MS, { crit: false, rand });
    assert.equal(fin.ok, true);
    const all = [...(down.ok ? down.events : []), ...(fin.ok ? fin.events : [])];
    assert.ok(all.length > 0);
    for (const e of all) {
      assert.ok(e.payload !== null && e.payload !== undefined, `${e.kind} has a payload`);
      assert.doesNotThrow(() => JSON.stringify(e.payload), `${e.kind} is serialisable`);
    }
  });
});
