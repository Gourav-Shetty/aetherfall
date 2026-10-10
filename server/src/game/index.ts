// @aetherfall/gameplay — aggregate state + per-tick hooks for the server.
// Server wiring: `createGameState()` once, then call `tickGameplay(game, nowMs)`
// (alias: `applyGameplay`) inside the 20Hz loop and broadcast returned events as
// `t:'event'` messages. Protocol v1 untouched — events only add `kind` payloads.

import {
  ATTACK_COOLDOWN_MS,
  MELEE_RANGE,
  inReachOf,
  resolveMeleeDamage,
  updateAggro,
  updateRespawns,
  type Fighter,
  type MeleeResolution,
  type Mob,
} from './combat.js';
import {
  DOWNED_DURATION_MS,
  DOWNED_RECOVER_FRAC,
  FINISHER_BONUS_XP,
  HIT_STOP_MS,
  THROW_RANGE,
  THROW_STUN_MS,
  UNARMED_PICKUP_RANGE,
} from '../systems/combat_ext.js';
import { canFinishMob, isMobDowned } from './melee/downed.js';
import { firstWeapon, inThrowRange, landingPos, pickupRadiusFor } from './melee/throw.js';
import { getZone } from '@aetherfall/engine';
import { createInventory, makePickup, removeItem, tryPickup, type Inventory, type Pickup } from './inventory.js';
import { addXp, chunkKeyOf, createQuestState, onCollect, onExplore, type QuestEvent, type QuestState } from './quests.js';
import { applyBossKillRewards, applyKillRewards } from './loot.js';
import { chainOnCollect, weaponDef, type BossName } from './content.js';
import { GuildStore } from './guilds.js';
import { ChatRateLimiter } from './chat.js';
import { Spawner } from './spawner.js';
import { cancelTrade, tradeReady, tryCompleteTrade, type TradeSession } from './trading.js';

export * from './combat.js';
export * from './inventory.js';
export * from './quests.js';
export * from './content.js';
export * from './loot.js';
export * from './trading.js';
export * from './guilds.js';
export * from './chat.js';
export * from './spawner.js';
export * from './mobs.js';
export * from './melee/index.js';

export type GameEvent = { kind: string; payload: unknown };

// ---------------------------------------------------------------------------
// Player melee against world (spawner) mobs
//
// Before this, `input.attack` only ever reached `npcs.damageFromPlayer`, so no
// regular world mob could die: `onMobKilled` never ran for the spawner
// population, which meant `mob-die` / `xp-gain` / `pickup-spawn` were never
// broadcast, kill quests never advanced and no loot ever dropped. The client
// covered for it with a snapshot-diff kill fallback (client/src/main.ts,
// `announcedDeaths`). `playerMeleeAttack` is the missing link: it targets the
// nearest living mob through the Spawner's spatial grid, applies the
// combat_ext-backed swing, and pays out the kill.
// ---------------------------------------------------------------------------

/** Per-player swing bookkeeping, owned here rather than in QuestState. */
export type MeleeCooldown = { lastAttackAt: number };

export type MeleeOptions = {
  /** Override melee reach (default MELEE_RANGE). */
  range?: number;
  /** Bonus damage from gear; adds to `damageFor`'s level curve. */
  bonusDmg?: number;
  /** Injected RNG for crits and loot rolls (tests/replay determinism). */
  rand?: () => number;
  /** Force crit on/off instead of rolling one. */
  crit?: boolean;
  /**
   * Projectile-equivalent swing (thrown sidearms, ranged skills). Knocks a
   * target downed like melee but NEVER finishes a downed target — the killer
   * must walk up and finish in person.
   */
  ranged?: boolean;
  /** Extra loot rolls on a killing blow (tithe mask's extra-loot perk). */
  bonusRolls?: number;
  /** Extra finish reach in units (gallow-beak's swift-finish perk). */
  finishBonus?: number;
};

export type MeleeResult =
  | {
      ok: true;
      /** The mob that was hit. */
      mobId: number;
      mobName: string;
      /** HP actually removed (clamped on an overkill swing). */
      dmg: number;
      /** Damage the swing resolved to before the hp floor. */
      dealt: number;
      killed: boolean;
      crit: boolean;
      /** This swing knocked the mob downed (a finisher is still required). */
      downed?: boolean;
      /** This swing finished a downed mob (instant kill + bonus XP). */
      finished?: boolean;
      /** Empty unless `killed` or `downed` — see `creditKill`. */
      events: GameEvent[];
    }
  | { ok: false; reason: 'cooldown' | 'out-of-range' | 'no-target' | 'downed'; events: GameEvent[] };

/**
 * Resolve one authoritative player melee swing against world (spawner) mobs.
 *
 * Targeting picks the nearest LIVING mob within melee reach via the Spawner's
 * cell grid — O(cells) rather than O(mobs), which keeps this cheap on the input
 * hot path with hundreds of live mobs. NPC minions and bosses are a separate id
 * namespace reached by a separate call (`npcs.damageFromPlayer`); both resolve
 * from the same input frame and never contend for the same target.
 *
 * Cooldown mirrors `combat.canAttack` (ATTACK_COOLDOWN_MS). A swing that finds
 * no target does NOT consume the cooldown, so mashing attack while walking up
 * to a mob still lands the first hit.
 *
 * Lethal swings knock the mob DOWNED (3s crawl) instead of killing it — see
 * game/melee/downed.ts. A follow-up melee swing on the downed mob inside
 * finish reach FINISHes it (instant kill + bonus XP via `creditKill`). Ranged
 * swings (`ranged:true`) knock down but refuse the finish (`reason:'downed'`),
 * so the killer must walk up. An unanswered knockdown stands back up on the
 * tick (`tickGameplay` recovery), never bleeding out on its own.
 */
export function playerMeleeAttack(
  game: GameState,
  playerId: number,
  now: number,
  opts: MeleeOptions = {},
): MeleeResult {
  const empty: GameEvent[] = [];
  const player = game.players.get(playerId);
  if (!player) return { ok: false, reason: 'no-target', events: empty };

  const cd = meleeCooldown(game, playerId);
  if (now - cd.lastAttackAt < ATTACK_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', events: empty };
  }

  const range = opts.range ?? MELEE_RANGE;
  const ranged = opts.ranged ?? false;
  const rand = opts.rand ?? Math.random;
  const target = game.spawner.nearestMobWithin(player.x, player.y, range);
  if (!target) return { ok: false, reason: 'no-target', events: empty };
  // The grid query is a superset of the reach circle; confirm exactly.
  if (!inReachOf(player, target.pos, range)) {
    return { ok: false, reason: 'out-of-range', events: empty };
  }

  // FINISH branch: melee only, on a downed target inside finish reach.
  // The swift-finish mask widens the execution window (finishBonus).
  if (isMobDowned(target, now)) {
    if (ranged || !canFinishMob(player, target, now, { range: range + (opts.finishBonus ?? 0) })) {
      return { ok: false, reason: 'downed', events: empty };
    }
    // Consume the cooldown once the finishing swing is committed.
    cd.lastAttackAt = now;
    const fin = game.spawner.finishMob(target.id, now);
    if (!fin) return { ok: false, reason: 'no-target', events: empty };
    const events: GameEvent[] = creditKill(game, player, fin.mob, rand, { finisher: true, bonusRolls: opts.bonusRolls ?? 0 });
    return {
      ok: true,
      mobId: fin.mob.id,
      mobName: fin.mob.name,
      dmg: 0,
      dealt: 0,
      killed: true,
      crit: false,
      finished: true,
      events,
    };
  }

  // Consume the cooldown only once a real swing is committed.
  cd.lastAttackAt = now;

  const res: MeleeResolution = resolveMeleeDamage(player.quests.level, target.name, {
    ...(opts.bonusDmg !== undefined ? { bonusDmg: opts.bonusDmg } : {}),
    ...(opts.rand ? { rand: opts.rand } : {}),
    ...(opts.crit !== undefined ? { crit: opts.crit } : {}),
  });

  // A lethal swing knocks DOWNED instead of killing: hp floored at 0, crawl
  // timer armed, `mob-downed` announced. `damageMob` keeps its direct-kill
  // semantics for non-melee callers, so this bypasses it on purpose.
  if (res.dmg >= target.hp) {
    const removed = target.hp;
    const downed = game.spawner.downMob(target.id, now, DOWNED_DURATION_MS);
    if (!downed) return { ok: false, reason: 'no-target', events: empty };
    const events: GameEvent[] = [
      {
        kind: 'mob-downed',
        payload: {
          id: downed.id,
          x: downed.pos.x,
          y: downed.pos.y,
          downedUntil: downed.downedUntil ?? now + DOWNED_DURATION_MS,
        },
      },
    ];
    return {
      ok: true,
      mobId: downed.id,
      mobName: downed.name,
      dmg: removed,
      dealt: res.dmg,
      killed: false,
      crit: res.crit,
      downed: true,
      events,
    };
  }

  const hit = game.spawner.damageMob(target.id, res.dmg, now);
  if (!hit) return { ok: false, reason: 'no-target', events: empty };

  // `damageMob` already marked the corpse and armed the respawn timer, so the
  // payout runs through `creditKill` directly — routing it back through
  // `onMobKilled` would hit that function's already-dead guard and pay nothing.
  // (Unreachable via the downed bypass above, kept for non-melee callers.)
  const events: GameEvent[] = hit.killed ? creditKill(game, player, hit.mob, rand, { bonusRolls: opts.bonusRolls ?? 0 }) : empty;
  return {
    ok: true,
    mobId: hit.mob.id,
    mobName: hit.mob.name,
    dmg: hit.dmg,
    dealt: hit.resolved,
    killed: hit.killed,
    crit: res.crit,
    events,
  };
}

/**
 * Swing cooldowns are held per GameState in a WeakMap, so a `GameState` that
 * goes out of scope takes its timers with it (no leak between test cases) and
 * there is nothing to clean up on the 20Hz path.
 */
const meleeCooldowns = new WeakMap<GameState, Map<number, MeleeCooldown>>();

function meleeCooldown(game: GameState, playerId: number): MeleeCooldown {
  let m = meleeCooldowns.get(game);
  if (!m) {
    m = new Map();
    meleeCooldowns.set(game, m);
  }
  let cd = m.get(playerId);
  if (!cd) {
    cd = { lastAttackAt: -Infinity };
    m.set(playerId, cd);
  }
  return cd;
}

/** Forget a player's swing cooldown (called on logout, so a reconnect swings at once). */
export function clearMeleeCooldown(game: GameState, playerId: number): void {
  meleeCooldowns.get(game)?.delete(playerId);
}

/** Current swing cooldown timestamp for a player (tests/debug). */
export function meleeCooldownAt(game: GameState, playerId: number): number {
  return meleeCooldowns.get(game)?.get(playerId)?.lastAttackAt ?? -Infinity;
}

export type GamePlayer = {
  id: number;
  name: string;
  x: number;
  y: number;
  inv: Inventory;
  quests: QuestState;
  seenChunks: Set<string>;
};

export type GameState = {
  seed: number;
  players: Map<number, GamePlayer>;
  spawner: Spawner;
  guilds: GuildStore;
  trades: Map<number, TradeSession>;
  chat: ChatRateLimiter;
  /** Live world pickups from mob loot (see loot.ts). */
  pickups: Pickup[];
};

export function createGameState(seed = 1337): GameState {
  return {
    seed,
    players: new Map(),
    spawner: new Spawner(seed),
    guilds: new GuildStore(),
    trades: new Map(),
    chat: new ChatRateLimiter(),
    pickups: [],
  };
}

export function ensurePlayer(game: GameState, id: number, name: string, x = 0, y = 0): GamePlayer {
  let p = game.players.get(id);
  if (!p) {
    p = { id, name, x, y, inv: createInventory(), quests: createQuestState(), seenChunks: new Set() };
    game.players.set(id, p);
  }
  p.x = x;
  p.y = y;
  return p;
}

export function removePlayer(game: GameState, id: number): void {
  game.players.delete(id);
  // Cancel open trades involving this player (items never left inventories, so safe).
  for (const t of game.trades.values()) {
    if ((t.a === id || t.b === id) && t.state === 'open') cancelTrade(t, 'party-left');
  }
  clearMeleeCooldown(game, id);
}

export function setPlayerPos(game: GameState, id: number, x: number, y: number): void {
  const p = game.players.get(id);
  if (p) {
    p.x = x;
    p.y = y;
  }
}

/**
 * Combat onKill wiring (loot.ts): call after a player's melee swing reports
 * killed=true. Marks the mob dead (5s respawn), advances kill quests, grants
 * zone-scaled kill XP, rolls loot -> corpse pickups. Returns protocol-v1-safe
 * events for the server to broadcast as `t:'event'` messages.
 */
export function onMobKilled(
  game: GameState,
  playerId: number,
  mobId: number,
  now: number,
  rand: () => number = Math.random,
  opts: { bonusRolls?: number } = {},
): GameEvent[] {
  const mob = game.spawner.getMob(mobId);
  const player = game.players.get(playerId);
  if (!mob || !player) return [];
  // Guards double rewards: a mob that is already dead has been paid out.
  if (!game.spawner.killMob(mobId, now)) return [];
  return creditKill(game, player, mob, rand, { bonusRolls: opts.bonusRolls ?? 0 });
}

/**
 * Reward half of a kill: kill-quest progress, XP and corpse loot for a mob that
 * is ALREADY dead. Split out of `onMobKilled` because the melee path kills the
 * mob inside `Spawner.damageMob` (the same call that reported the lethal hit),
 * and re-killing it here would be rejected as a corpse — so the melee path
 * calls this directly instead of round-tripping through `onMobKilled`.
 *
 * Finishers (`finisher:true`) pay FINISHER_BONUS_XP on top and flag the
 * `mob-die` payload, so the client can shake harder. Every kill also emits a
 * `hit-stop` event (HIT_STOP_MS) for the client's freeze frame.
 */
function creditKill(
  game: GameState,
  player: GamePlayer,
  mob: Mob,
  rand: () => number,
  opts: { finisher?: boolean; bonusRolls?: number } = {},
): GameEvent[] {
  const out: GameEvent[] = [];
  const playerId = player.id;
  const mobId = mob.id;
  const finisher = opts.finisher === true;
  const zone = getZone(mob.pos.x, mob.pos.y, game.seed);
  const { questEvents, xp, drops, pickups } = applyKillRewards(
    player.quests,
    mob.name,
    zone,
    mob.level,
    mob.pos.x,
    mob.pos.y,
    rand,
    opts.bonusRolls ?? 0,
  );
  let totalXp = xp;
  const bonusEvents: QuestEvent[] = finisher ? [...addXp(player.quests, FINISHER_BONUS_XP)] : [];
  if (finisher) totalXp += FINISHER_BONUS_XP;
  game.pickups.push(...pickups);
  out.push({
    kind: 'mob-die',
    payload: finisher ? { id: mobId, killedBy: playerId, finisher: true } : { id: mobId, killedBy: playerId },
  });
  out.push({
    kind: 'hit-stop',
    payload: finisher
      ? { durationMs: HIT_STOP_MS, mobId, finisher: true }
      : { durationMs: HIT_STOP_MS, mobId },
  });
  out.push({ kind: 'xp-gain', payload: { playerId, amount: totalXp, level: player.quests.level, xpLeft: player.quests.xp } });
  for (const e of questEvents) out.push(questEvent(game, playerId, e));
  for (const e of bonusEvents) out.push(questEvent(game, playerId, e));
  for (const pk of pickups) {
    out.push({
      kind: 'pickup-spawn',
      payload: { id: pk.id, itemId: pk.itemId, count: pk.count, x: pk.x, y: pk.y },
    });
  }
  void drops;
  return out;
}

/**
 * Boss onKill wiring (loot.applyBossKillRewards): call when ai/npc.ts reports a
 * `boss-kill`. Rolls the boss drop table (guaranteed materials + a rare
 * progression weapon) into corpse pickups, grants the flat BOSS_KILL_XP, and
 * emits the `boss-kill` achievement event alongside the usual quest/XP/pickup
 * events. Protocol-v1 safe: events only add `kind` payloads.
 *
 * Finishers (`finisher:true`) pay FINISHER_BONUS_XP on top and flag the
 * payload. Every boss kill also emits `hit-stop` (HIT_STOP_MS).
 */
export function onBossKilled(
  game: GameState,
  playerId: number,
  boss: BossName,
  x: number,
  y: number,
  rand: () => number = Math.random,
  opts: { finisher?: boolean; bonusRolls?: number } = {},
): GameEvent[] {
  const out: GameEvent[] = [];
  const player = game.players.get(playerId);
  if (!player) return out; // no credited killer (e.g. add damage) -> no payout
  const finisher = opts.finisher === true;
  const { questEvents, xp, pickups, achievement } = applyBossKillRewards(
    player.quests,
    boss,
    x,
    y,
    rand,
    opts.bonusRolls ?? 0,
  );
  let totalXp = xp;
  const bonusEvents: QuestEvent[] = finisher ? [...addXp(player.quests, FINISHER_BONUS_XP)] : [];
  if (finisher) totalXp += FINISHER_BONUS_XP;
  game.pickups.push(...pickups);
  out.push({
    kind: 'boss-kill',
    payload: finisher
      ? { playerId, boss: achievement.boss, xp: totalXp, x, y, finisher: true }
      : { playerId, boss: achievement.boss, xp: achievement.xp, x, y },
  });
  out.push({
    kind: 'hit-stop',
    payload: finisher
      ? { durationMs: HIT_STOP_MS, boss, finisher: true }
      : { durationMs: HIT_STOP_MS, boss },
  });
  out.push({
    kind: 'xp-gain',
    payload: { playerId, amount: totalXp, level: player.quests.level, xpLeft: player.quests.xp },
  });
  for (const e of questEvents) out.push(questEvent(game, playerId, e));
  for (const e of bonusEvents) out.push(questEvent(game, playerId, e));
  for (const pk of pickups) {
    out.push({
      kind: 'pickup-spawn',
      payload: { id: pk.id, itemId: pk.itemId, count: pk.count, x: pk.x, y: pk.y },
    });
  }
  return out;
}

/** Remove a world pickup once collected despawn (idempotent). */
export function removePickup(game: GameState, pickupId: number): boolean {
  const i = game.pickups.findIndex((p) => p.id === pickupId);
  if (i < 0) return false;
  game.pickups.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Thrown sidearms + armed/unarmed pickup radius
// ---------------------------------------------------------------------------

export type ThrowOptions = {
  /** Override the thrown weapon's own damage bonus (default: the weapon's). */
  bonusDmg?: number;
  /** Injected RNG for crits (tests/replay determinism). */
  rand?: () => number;
  /** Force crit on/off instead of rolling one. */
  crit?: boolean;
  /** Override throw reach (default THROW_RANGE; the long-throw mask adds +4). */
  range?: number;
};

export type ThrowResult =
  | {
      ok: true;
      /** True when a mob was hit (damage + stun applied). */
      hit: boolean;
      /** Hit mob id (null on a miss). */
      mobId: number | null;
      weaponId: string;
      landing: { x: number; y: number };
      /** World pickup id of the landed weapon (see `pickup-spawn`). */
      pickupId: number;
      events: GameEvent[];
    }
  | { ok: false; reason: 'no-player' | 'no-weapon'; events: GameEvent[] };

/**
 * Throw the first weapon in inventory: THROW_RANGE reach, melee-curve damage
 * plus a THROW_STUN_MS stun, and the weapon lands as a world pickup at the
 * throw's landing point (hit or miss — throwing always spends the weapon).
 * Throws are ranged-equivalent: they knock downed but NEVER finish a downed
 * target (downed mobs in the lane are ignored). Throws sit off the swing
 * cooldown; the spent weapon is the cost.
 */
export function playerThrowWeapon(
  game: GameState,
  playerId: number,
  now: number,
  dx: number,
  dy: number,
  opts: ThrowOptions = {},
): ThrowResult {
  const empty: GameEvent[] = [];
  const player = game.players.get(playerId);
  if (!player) return { ok: false, reason: 'no-player', events: empty };
  const wielded = firstWeapon(player.inv);
  if (!wielded) return { ok: false, reason: 'no-weapon', events: empty };
  const def = weaponDef(wielded.itemId);
  const bonusDmg = opts.bonusDmg ?? def?.damage ?? 0;
  const rand = opts.rand ?? Math.random;
  const range = opts.range ?? THROW_RANGE;

  // Spend the weapon first: the throw always costs it, hit or miss.
  removeItem(player.inv, wielded.itemId, 1);

  const landing = landingPos(player, dx, dy, range);
  const thrown = makePickup(wielded.itemId, 1, landing.x, landing.y);
  game.pickups.push(thrown);

  const events: GameEvent[] = [
    {
      kind: 'weapon-throw',
      payload: { playerId, weaponId: wielded.itemId, from: { x: player.x, y: player.y }, to: { ...landing } },
    },
  ];

  let hit = false;
  let mobId: number | null = null;
  const target = game.spawner.nearestMobWithin(player.x, player.y, range);
  if (target && inThrowRange(player, target.pos, range) && !isMobDowned(target, now)) {
    hit = true;
    mobId = target.id;
    const res = resolveMeleeDamage(player.quests.level, target.name, {
      bonusDmg,
      rand,
      ...(opts.crit !== undefined ? { crit: opts.crit } : {}),
    });
    game.spawner.stunMob(target.id, now, THROW_STUN_MS);
    events.push({ kind: 'mob-stun', payload: { id: target.id, until: now + THROW_STUN_MS } });
    if (res.dmg >= target.hp) {
      const downed = game.spawner.downMob(target.id, now, DOWNED_DURATION_MS);
      if (downed) {
        events.push({
          kind: 'mob-downed',
          payload: {
            id: downed.id,
            x: downed.pos.x,
            y: downed.pos.y,
            downedUntil: downed.downedUntil ?? now + DOWNED_DURATION_MS,
          },
        });
      }
    } else {
      game.spawner.damageMob(target.id, res.dmg, now);
    }
  }
  // Downed targets in the lane are ignored: throws never finish.

  events.push({
    kind: 'pickup-spawn',
    payload: { id: thrown.id, itemId: thrown.itemId, count: thrown.count, x: thrown.x, y: thrown.y },
  });
  return { ok: true, hit, mobId, weaponId: wielded.itemId, landing, pickupId: thrown.id, events };
}

/**
 * Pickup radius for a player: full reach while armed, UNARMED_PICKUP_RANGE
 * while unarmed. Pass the result into inventory.tryPickup.
 */
export function playerPickupRadius(game: GameState, playerId: number): number {
  const p = game.players.get(playerId);
  if (!p) return UNARMED_PICKUP_RANGE;
  return pickupRadiusFor(p.inv);
}

/**
 * Collect a world pickup with the armed/unarmed radius. On success removes
 * the pickup, advances collect quests, and emits `pickup-collect` plus the
 * usual quest events. Returns [] when unknown/far/full.
 */
export function collectPickup(game: GameState, playerId: number, pickupId: number): GameEvent[] {
  const player = game.players.get(playerId);
  if (!player) return [];
  const pickup = game.pickups.find((p) => p.id === pickupId);
  if (!pickup) return [];
  const radius = pickupRadiusFor(player.inv);
  const res = tryPickup(player.inv, pickup, player, radius);
  if (!res.ok) return [];
  removePickup(game, pickupId);
  const out: GameEvent[] = [
    { kind: 'pickup-collect', payload: { playerId, pickupId, itemId: pickup.itemId, count: pickup.count } },
  ];
  for (const e of onCollect(player.quests, pickup.count)) out.push(questEvent(game, playerId, e));
  for (const e of chainOnCollect(player.quests, pickup.count)) out.push(questEvent(game, playerId, e));
  return out;
}

function playerFighters(game: GameState): Fighter[] {
  // Combat uses positions only for aggro; hp/alive tracked server-side for players.
  // We synthesize lightweight fighters so updateAggro() stays pure.
  return [...game.players.values()].map((p) => ({
    id: p.id,
    pos: { x: p.x, y: p.y },
    hp: 100,
    maxHp: 100,
    alive: true,
    lastAttackAt: -Infinity,
    respawnAt: 0,
    level: p.quests.level,
  }));
}

/**
 * Per-tick gameplay update. Cheap: idempotent chunk spawns, mob respawns,
 * aggro hysteresis, explorer quest progress. Returns protocol-v1-safe events.
 */
export function tickGameplay(game: GameState, now: number): GameEvent[] {
  const out: GameEvent[] = [];

  // 1. Ensure terrain around every player has mobs.
  for (const p of game.players.values()) {
    const fresh = game.spawner.ensureAround(p.x, p.y, 0);
    for (const m of fresh) {
      out.push({ kind: 'mob-spawn', payload: { id: m.id, name: m.name, x: m.pos.x, y: m.pos.y, hp: m.hp, maxHp: m.maxHp } });
    }
    // Explorer quest: track distinct chunks beyond spawn.
    const key = chunkKeyOf(p.x, p.y);
    const evts: QuestEvent[] = onExplore(p.quests, p.seenChunks, key);
    for (const e of evts) out.push(questEvent(game, p.id, e));
  }

  // 2. Mob respawns (5s) -> events.
  const mobs: Mob[] = game.spawner.mobsList();
  const respawned = updateRespawns(now, mobs);
  for (const id of respawned) {
    const m = game.spawner.getMob(id);
    out.push({ kind: 'mob-respawn', payload: { id, x: m?.pos.x, y: m?.pos.y } });
  }

  // 2b. Downed recovery (3s crawl): unanswered knockdowns stand back up at
  // partial HP instead of bleeding out. One `mob-up` per recovery.
  const recovered = game.spawner.recoverDowned(now, DOWNED_RECOVER_FRAC);
  for (const m of recovered) {
    out.push({ kind: 'mob-up', payload: { id: m.id, x: m.pos.x, y: m.pos.y, hp: m.hp, maxHp: m.maxHp } });
  }

  // 3. Aggro hysteresis -> events only on change.
  const changed = updateAggro(mobs, playerFighters(game), now);
  for (const id of changed) {
    const m = game.spawner.getMob(id);
    out.push({ kind: 'mob-aggro', payload: { id, targetId: m?.targetId ?? null } });
  }

  // 4. Auto-complete ready trades (both locked+confirmed). Atomic; skips when not ready.
  for (const t of game.trades.values()) {
    if (t.state === 'open' && tradeReady(t)) {
      const invs = new Map<number, Inventory>([
        [t.a, game.players.get(t.a)?.inv ?? createInventory()],
        [t.b, game.players.get(t.b)?.inv ?? createInventory()],
      ]);
      // Only use real inventories — skip if a party is offline.
      if (!game.players.has(t.a) || !game.players.has(t.b)) continue;
      const pa = game.players.get(t.a)!;
      const pb = game.players.get(t.b)!;
      invs.set(t.a, pa.inv);
      invs.set(t.b, pb.inv);
      const r = tryCompleteTrade(t, invs);
      out.push({
        kind: r.ok ? 'trade-done' : 'trade-failed',
        payload: r.ok ? { tradeId: t.id } : { tradeId: t.id, reason: (r as { reason: string }).reason },
      });
    }
  }

  return out;
}

function questEvent(game: GameState, playerId: number, e: QuestEvent): GameEvent {
  void game;
  if (e.type === 'progress') return { kind: 'quest-progress', payload: { playerId, ...e } };
  if (e.type === 'complete') return { kind: 'quest-complete', payload: { playerId, ...e } };
  return { kind: 'levelup', payload: { playerId, level: e.level } };
}

/**
 * Alias the server loop can call: `applyGameplay(game, nowMs)`.
 * Same as tickGameplay — kept as a separate named export per integration convention.
 */
export function applyGameplay(game: GameState, now: number): GameEvent[] {
  return tickGameplay(game, now);
}
