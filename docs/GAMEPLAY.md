# Gameplay Systems

Ownership: `server/src/game/*` + additive engine hooks via ECS components.
Protocol v1 is untouched — gameplay surfaces only as `t:'event'` messages
(`mob-spawn`, `mob-respawn`, `mob-aggro`, `quest-progress`, `quest-complete`,
`levelup`, `trade-done`, `trade-failed`). No new `ServerMsg`/`ClientMsg` variants.

Server wiring: `server/src/index.ts` has a `// GAMEPLAY-HOOK` section —
`createGameState(1337)` once, per-tick `tickGameplay(game, now)` (alias
`applyGameplay(game, now)`), results broadcast as events.
Mobs are mirrored as engine entities with `pos` + `mob` components.

## Tuning numbers

| System    | Constant                         | Value        |
| --------- | -------------------------------- | ------------ |
| Combat    | `MELEE_RANGE`                    | 2.2 units    |
| Combat    | `ATTACK_COOLDOWN_MS`             | 800 ms       |
| Combat    | `BASE_DMG` (+3 per lvl +bonus)   | 12           |
| Combat    | `MAX_HP` (mobs +20/lvl)          | 100          |
| Combat    | `RESPAWN_DELAY_MS`               | 5000 ms      |
| Combat    | `AGGRO_RANGE` / `DEAGGRO_RANGE`  | 12 / 20      |
| Inventory | `MAX_SLOTS` / `MAX_STACK`        | 20 / 99      |
| Inventory | pickup radius                    | 2.5 units    |
| Quests    | `slay5` kill 5 mobs → +60 XP     |              |
| Quests    | `gather10` collect 10 → +80 XP   |              |
| Quests    | `explorer` 3 new chunks → +100 XP |              |
| Quests    | level threshold                  | level × 100 XP |
| Chat      | `CHAT_RATE_LIMIT_MS` / max len   | 1000 ms / 200 |
| Spawner   | `MOBS_PER_CHUNK`                 | 4            |
| Guilds    | max name / max members           | 24 chars / 50 |

## Systems

- **Combat** (`game/combat.ts`): `tryMeleeAttack(now, attacker, target)` —
  range + cooldown + alive checks, flat damage `12 + (lvl-1)*3 + bonus`,
  death sets `respawnAt = now+5000`. `updateRespawns()` revives at spawn pos.
  `updateAggro()` targets nearest alive player ≤12u, drops >20u (hysteresis).
- **Inventory** (`game/inventory.ts`): 20 slots, stackable to 99, fill-partials-
  first; `addItem`/`removeItem` validate fully before mutating (no partials).
  Pickups are `kind:'pickup'` (matches shared `EntitySnapshot` union).
- **Quests** (`game/quests.ts`): `slay5` / `gather10` / `explorer` (3 distinct
  chunks beyond spawn). Completion auto-grants XP; `level*100` thresholds with
  carry-over. `onKill` / `onCollect` / `onExplore(state, seen, chunkKey)`.
- **Trading** (`game/trading.ts`): `open → locked(a+b) → confirmed(a+b) → done
  | cancelled`. Offers reset both locks (anti-scam). `tryCompleteTrade()`
  validates holdings + receiver space on simulated clones BEFORE mutating,
  with rollback paths — atomic, no partial swaps (see `trading.test.ts`).
- **Guilds** (`game/guilds.ts`): `GuildStore.create/join/leave/setRole/kick/
  disband`; leader-only admin; leader-leave auto-promotes officer→member→
  disband; `toJSON/fromJSON` for persistence.
- **Chat** (`game/chat.ts`): channels `global|guild|say` (protocol v1 names),
  1 msg/sec per sender (`ChatRateLimiter`), `maskText()` whole-word profanity
  stub with pluggable `addBannedWords()`.
- **Spawner** (`game/spawner.ts`): deterministic per-chunk mobs from engine
  `genChunk()` walkable tiles + `mulberry32` — identical on every server.
  `ensureAround(x, y)` is idempotent; `killMob(id, now)` arms the 5s timer.

## Follow-ups (not this change)

- Include mobs in `snapshot()` entities (needs interest-filter coordination).
- Route dropped mob loot → `makePickup` + `tryPickup` + `onCollect` quest hook.
- Wire `attack` input → `tryMeleeAttack` + `onKill` quest hook with damage events.
- Persist `GuildStore.toJSON()` / quest state via the persistence layer.
