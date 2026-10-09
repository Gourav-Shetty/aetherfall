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
import { getZone } from '@aetherfall/engine';
import { createInventory, type Inventory, type Pickup } from './inventory.js';
import { chunkKeyOf, createQuestState, onExplore, type QuestEvent, type QuestState } from './quests.js';
import { applyBossKillRewards, applyKillRewards } from './loot.js';
import type { BossName } from './content.js';
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
      /** Empty unless `killed` — see `creditKill`. */
      events: GameEvent[];
    }
  | { ok: false; reason: 'cooldown' | 'out-of-range' | 'no-target'; events: GameEvent[] };

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
 * A kill is paid out by `creditKill`. HP bookkeeping and the 5s respawn timer
 * live in `Spawner.damageMob`, so `tickGameplay`'s `updateRespawns` remains the
 * single respawn authority — no second timer was introduced.
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
  const target = game.spawner.nearestMobWithin(player.x, player.y, range);
  if (!target) return { ok: false, reason: 'no-target', events: empty };
  // The grid query is a superset of the reach circle; confirm exactly.
  if (!inReachOf(player, target.pos, range)) {
    return { ok: false, reason: 'out-of-range', events: empty };
  }

  // Consume the cooldown only once a real swing is committed.
  cd.lastAttackAt = now;

  const res: MeleeResolution = resolveMeleeDamage(player.quests.level, target.name, {
    ...(opts.bonusDmg !== undefined ? { bonusDmg: opts.bonusDmg } : {}),
    ...(opts.rand ? { rand: opts.rand } : {}),
    ...(opts.crit !== undefined ? { crit: opts.crit } : {}),
  });
  const hit = game.spawner.damageMob(target.id, res.dmg, now);
  if (!hit) return { ok: false, reason: 'no-target', events: empty };

  // `damageMob` already marked the corpse and armed the respawn timer, so the
  // payout runs through `creditKill` directly — routing it back through
  // `onMobKilled` would hit that function's already-dead guard and pay nothing.
  const events: GameEvent[] = hit.killed ? creditKill(game, player, hit.mob, opts.rand ?? Math.random) : empty;
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
): GameEvent[] {
  const mob = game.spawner.getMob(mobId);
  const player = game.players.get(playerId);
  if (!mob || !player) return [];
  // Guards double rewards: a mob that is already dead has been paid out.
  if (!game.spawner.killMob(mobId, now)) return [];
  return creditKill(game, player, mob, rand);
}

/**
 * Reward half of a kill: kill-quest progress, XP and corpse loot for a mob that
 * is ALREADY dead. Split out of `onMobKilled` because the melee path kills the
 * mob inside `Spawner.damageMob` (the same call that reported the lethal hit),
 * and re-killing it here would be rejected as a corpse — so the melee path
 * calls this directly instead of round-tripping through `onMobKilled`.
 */
function creditKill(
  game: GameState,
  player: GamePlayer,
  mob: Mob,
  rand: () => number,
): GameEvent[] {
  const out: GameEvent[] = [];
  const playerId = player.id;
  const mobId = mob.id;
  const zone = getZone(mob.pos.x, mob.pos.y, game.seed);
  const { questEvents, xp, drops, pickups } = applyKillRewards(
    player.quests,
    mob.name,
    zone,
    mob.level,
    mob.pos.x,
    mob.pos.y,
    rand,
  );
  game.pickups.push(...pickups);
  out.push({ kind: 'mob-die', payload: { id: mobId, killedBy: playerId } });
  out.push({ kind: 'xp-gain', payload: { playerId, amount: xp, level: player.quests.level, xpLeft: player.quests.xp } });
  for (const e of questEvents) out.push(questEvent(game, playerId, e));
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
 */
export function onBossKilled(
  game: GameState,
  playerId: number,
  boss: BossName,
  x: number,
  y: number,
  rand: () => number = Math.random,
): GameEvent[] {
  const out: GameEvent[] = [];
  const player = game.players.get(playerId);
  if (!player) return out; // no credited killer (e.g. add damage) -> no payout
  const { questEvents, xp, pickups, achievement } = applyBossKillRewards(
    player.quests,
    boss,
    x,
    y,
    rand,
  );
  game.pickups.push(...pickups);
  out.push({
    kind: 'boss-kill',
    payload: { playerId, boss: achievement.boss, xp: achievement.xp, x, y },
  });
  out.push({
    kind: 'xp-gain',
    payload: { playerId, amount: xp, level: player.quests.level, xpLeft: player.quests.xp },
  });
  for (const e of questEvents) out.push(questEvent(game, playerId, e));
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

  // 3. Aggro hysteresis -> events only on change.
  const changed = updateAggro(mobs, playerFighters(game));
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
