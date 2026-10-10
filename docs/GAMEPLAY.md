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
| Combat    | `MELEE_DAMAGE` (minion hit)      | 7            |
| Combat    | `MELEE_COOLDOWN` (minion swing)  | 1500 ms      |
| Combat    | `LEASH_RANGE` (minion give-up)  | 20 units     |
| Spawner   | `SPAWN_SAFE_RADIUS` (no mobs)    | 12 units     |
| Sim       | `SPAWN_PROTECTION_MS`            | 3000 ms      |
| Inventory | `MAX_SLOTS` / `MAX_STACK`        | 20 / 99      |
| Inventory | pickup radius                    | 2.5 units    |
| Quests    | `slay5` kill 5 mobs → +60 XP     |              |
| Quests    | `gather10` collect 10 → +80 XP   |              |
| Quests    | `explorer` 3 new chunks → +100 XP |              |
| Quests    | level threshold                  | level × 100 XP |
| Chat      | `CHAT_RATE_LIMIT_MS` / max len   | 1000 ms / 200 |
| Spawner   | `MOBS_PER_CHUNK`                 | 4            |
| Guilds    | max name / max members           | 24 chars / 50 |

### Spawn safety

A fresh login must not land inside a mob pile, and the first ten seconds must
not end in a death screen with no warning. Three rules enforce that:

- **No hostile spawns in the safe discs.** `spawnChunk` skips any mob inside
  `SPAWN_SAFE_RADIUS` (12u) of a spawn anchor. The anchors are one shared table
  (`engine/src/spawn-anchors.ts`): world spawn `(0,0)`, the shrine `(50,50)` and
  four outlying rings — the same list `Sim.addPlayer` places a joining player
  on, so the clear zone holds **by construction** rather than by two hand-kept
  lists agreeing. See "Spawn anchors" in docs/WORLD.md.
  `pruneSpawnSafe()` runs each tick as a backstop for knockback or legacy
  saves that pushed a mob back inside.
- **3s of spawn protection** (`SPAWN_PROTECTION_MS`) on join and on respawn.
  Protected players are filtered out of the NPC targeting set *and* re-checked
  inside `Sim.damagePlayer`, so a stale AI event cannot punch through it. The
  HUD shows a `🛡` badge with the remaining time.
- **Leash.** A minion kited more than `LEASH_RANGE` (20u) from its patrol
  anchor drops its target and walks home. Without it a chase could be dragged
  back to spawn and camped on new players.

### Damage budget

A single minion hit deals **7** every **1.5s**, inside the 6–14 band that keeps
a hit from feeling trivial without being lethal. Time-to-die for a naked
100 HP level-1 player standing still against one minion is
`ceil(100/7) - 1 = 13` hits ≈ **21s**, so an idle player always gets a chance to
react. The player's side is unchanged: 12 + 3/lvl keeps mob TTK at 3–5 swings.

Physical resistances on the three starter mobs were trimmed (`gloomfang`
0.10 → 0.05, `mistwisp` 0.25 → 0.15, `thornback` 0.30 → 0.20) so the early
fight does not stall against per-type mitigation.

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

## Close-quarters finish loop

Mobs and NPCs reduced to 0 HP go DOWNED and crawl instead of dying. Only a
melee swing inside finish reach finishes them (instant kill + bonus XP).
Projectile-equivalent hits knock down but never finish, and an unanswered
knockdown stands back up — so the killer must walk up and take the risk.

| System    | Constant                         | Value        |
| --------- | -------------------------------- | ------------ |
| Finish    | `DOWNED_DURATION_MS` (crawl)     | 3000 ms      |
| Finish    | `FINISH_RANGE` (melee only)      | 2.2 units    |
| Finish    | `FINISHER_BONUS_XP` (per finish) | 15 XP        |
| Finish    | `DOWNED_RECOVER_FRAC` (stand-up) | 0.3 × max HP |
| Throw     | `THROW_RANGE`                    | 6 units      |
| Throw     | `THROW_STUN_MS`                  | 1000 ms      |
| Throw     | unarmed pickup radius            | 1.5 units    |
| Feel      | `HIT_STOP_MS` (kill freeze)      | 90 ms        |
| Feel      | blood decals kept per renderer   | last 200     |

## Systems

- **Downed** (`game/melee/downed.ts`, canonical numbers in
  `systems/combat_ext.ts`): lethal melee swings call `Spawner.downMob()` /
  `NPCManager` downed entry (hp 0, crawl timer, aggro dropped) and announce
  `mob-downed`. `playerMeleeAttack` / `NPCManager.damageFromPlayer` finish a
  downed target in melee reach (`mob-die`/`boss-kill` + `FINISHER_BONUS_XP` +
  `hit-stop`); `ranged:true` swings refuse with `reason:'downed'` (spawner) or
  `-1` (NPCs). `tickGameplay` / `NPCManager.tick` recover expired knockdowns
  (`mob-up`, partial HP) — nothing bleeds out on its own.
- **Thrown sidearms** (`game/melee/throw.ts`, `playerThrowWeapon`): spends the
  first weapon in inventory, melee-curve damage + 1s stun (`mob-stun`) inside
  `THROW_RANGE`, weapon lands as a `makePickup` at `landingPos()` (hit or
  miss, announced via `weapon-throw` + `pickup-spawn`). Throws never finish.
  `playerPickupRadius()` / `collectPickup()` wire the armed (2.5u) / unarmed
  (1.5u) radius through `tryPickup` + `removePickup` + `onCollect` quest hooks.
- **Feel**: every kill emits `hit-stop` (client freezes its sim 90ms in both
  renderers, gated by the reduced-motion setting); both renderers keep the last
  200 kill positions as fading floor splats (`addBlood`, 30s fade) and render
  `mob-downed` targets crawling; finisher kills shake harder
  (`shake(1.0)` ≈ 12px canvas).
