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
`floor(100/7) + 1 = 15` hits, and with the first hit landing immediately that
is 14 further hits at 1.5s = **21s**, so an idle player always gets a chance to
react. The player's side is unchanged: 12 + 3/lvl keeps mob TTK at 3–5 swings.

Physical resistances on the three starter mobs were trimmed (`gloomfang`
0.10 → 0.05, `mistwisp` 0.25 → 0.15, `thornback` 0.30 → 0.20) so the early
fight does not stall against per-type mitigation.

**The onboarding layer changes none of those numbers.** It adds six tutorial
objectives, four ladder quests and one once-per-account starter drop. No mob HP,
no player damage, no minion cadence, no hit chance and no spawn table is
touched, so the 7-damage / 1.5s cadence / ~21s idle time-to-die budget above
still holds exactly — pinned by `game/onboarding.test.ts` ("the damage budget
is not weakened"), which reads the constants from `ai/npc.ts` rather than
from a copy, and by the existing `game/spawner-ai.test.ts` budget suite.

## Onboarding — the first five minutes

Ownership: `server/src/game/onboarding.ts` (the spine) +
`server/src/game/quests.ts` (the Road ladder + `QUEST_ROADMAP`) +
`client/src/onboarding.ts` (the trackers) + `client/src/panels.ts` (the three
panels).

The complaint this fixes is not "the mechanics are missing" — melee, loot, XP,
finishers and mob AI all work. It is that nothing told the player any of it.
This section is the explicit answer.

### The tutorial spine (6 objectives, strictly ordered)

Every objective is satisfied by a signal the live systems already emit and by
a **real predicate over real game state** — no timers, no click-throughs. A
signal is observed, the objective's `matches()` runs, and only then may the
next rung open.

| # | Objective id | What it teaches | Server predicate (real state) | Reward |
| - | ------------- | --------------- | ---------------------------- | ------ |
| 1 | `tut-first-steps` | Move | `hypot(player.pos − spawnAnchor) ≥ TUT_MOVE_DISTANCE` (12u), read by `tickGameplay` | 20 XP |
| 2 | `tut-first-blow` | Attack a mob | a `playerMeleeAttack` swing removed HP (`dmg > 0`) from a living spawner mob | 25 XP |
| 3 | `tut-finisher` | Finish a downed mob | `playerMeleeAttack` returned `finished:true` — a melee execution of a mob knocked down by a previous lethal swing | 40 XP |
| 4 | `tut-first-loot` | Pick up a dropped item | `collectPickup` succeeded (the pickup moved from the corpse into the bag) | 35 XP |
| 5 | `tut-don-a-mask` | Equip a mask | `GameSession.equipMask` accepted the equip and set the single mask slot | 45 XP |
| 6 | `tut-signature` | Use a vocation signature | `GameSession.useSignature` returned `ok` — off cooldown, real effect applied | 65 XP |

Total **230 XP**, which carries a level-1 player to level 3 on its own.

Where each observation is wired:

| Signal | Raised by | File |
| ------ | --------- | ---- |
| `position` | `tickGameplay`, per player per tick | `game/index.ts` |
| `melee-hit` / `finisher` | `playerMeleeAttack`, all four committed-swing returns | `game/index.ts` |
| `collected` | `collectPickup`, the one authoritative pickup path | `game/index.ts` |
| `mask-equipped` | `GameSession.equipMask` (after the slot is actually set) | `game/integrated.ts` |
| `signature-used` | `GameSession.useSignature` (after the cooldown check passes) | `game/integrated.ts` |

The systems layer cannot hold a `GameState`, so it pushes facts into the
tutorial registry owned by `onboarding.ts` (the same module-scoped
per-player-map pattern `server/src/index.ts` uses for `dialogues` /
`tokensByPid`). `game/index.ts` drains the buffer on the 20 Hz tick and turns
it into `quest-progress` / `quest-complete` / `levelup` — the events that
already existed. **No new `ServerMsg`/`ClientMsg` variant and no new event
kind is introduced.**

### Guarantees the state machine makes

- **No objective completes itself.** `met` is only ever set by
  `matches(sig, state)` running against a real signal. `onboarding.test.ts`
  proves both halves for all six objectives using the previous step's real
  payload as the "before" fixture.
- **No out-of-order completion.** `advanceTutorial()` only ever looks at the
  first unfinished objective; a gap stops the ladder there.
- **No duplicate reward.** `done` is checked before `met`, a finished
  objective is never revisited, and `drainOnboardingEvents` re-checks
  `QuestState.progress[id].done` before paying — so even a duplicated pending
  buffer (a dropped drain on a lagging tick) pays once.
- **No dead end.** A signal that arrives early is *latched*, not dropped: a
  returning player who already wears a mask is not stuck on step 1 with step 5
  satisfied.
- **The next step is never empty.** `nextOnboardingStep()` walks the roadmap
  and returns `null` only when *everything* is done, at which point the
  client shows the free-roam line rather than a blank panel.

### First-minute guarantee

The first minute must produce a kill, visible loot, XP and a clear next.

- **Kill** — mobs are ~14–22 u from the spawn anchor, so walking the tutorial's
  12 u ends the walk next to something to fight.
- **Visible loot** — drop tables are probabilistic by design (a `gloomfang`
  drops a fang 65% of the time), which is fatal at minute zero. Every
  account's **first corpse always leaves one `ember-shard`**
  (`FIRST_BLOOD_ITEM` / `FIRST_BLOOD_COUNT`, consumed once per player by
  `consumeFirstBloodGift`). No drop table, price or catalog entry is changed.
- **XP** — 20 (step 1) + 25 (step 2) + 30 (`xpForKill('meadow', 1)`) + 25
  (`road-first-blood`) + 35 (`road-pickups`) = **135 XP**, so level 2 lands
  inside the first minute and level 3 shortly after.
- **A clear next** — the objective tracker names one step, its live count and
  the control that achieves it, plus the step behind it.

## Quest order and pacing

### Before

Every auto-advancing family started OPEN at `t = 0` and ran in parallel:

- `slay5` (kill 5) · `gather10` (collect 10) · `explorer` (3 chunks) — all
  three live from the first second, no stated order.
- Maren chain: `ward-spark` → `ember-road` → `deep-delvers` →
  `chart-the-fall` → `heart-of-fall` (linear).
- Chapter STATIC: `porchlight` → `kiosk` → `arcade` → `meridian` →
  `exchange` (linear, in parallel with the chain).

Five simultaneous "do this" lines, none of them first, no level-up ceremony,
and a probabilistic first corpse.

### After

One spine (`QUEST_ROADMAP` on the server, `QUEST_PLAY_ORDER` on the client),
staged for presentation. Staging never gates accrual, so **every existing quest
stays reachable and completable on exactly its old rules and old thresholds** —
`slay5` is still kill 5, `gather10` is still collect 10, the Maren chain and
STATIC are byte-for-byte unchanged (their `quests_progress` rows persist).

| Stage | Track | Steps | Thresholds | Why here |
| ----- | ----- | ----- | ---------- | -------- |
| 1 | `tutorial` (`tut-*`) | 6 | 1 action each | Teaches the real mechanics before any of them are asked for |
| 2 | `road` (`road-*`) | 4 | kill 1 → collect 3 → kill 3 → explore 2 | The retuned first-hour ladder: short enough to complete, gated so there is always exactly one open step |
| 3 | `trio` | 3 | slay 5 → gather 10 → explore 3 | Now *stated* in an order instead of three simultaneous lines |
| 4 | `maren` | 5 | unchanged (3/5/6/4/8) | Offered at the shrine; it is the mid-game spine |
| 5 | `chapter` | 5 | unchanged (4/6/6/4/8) | Opt-in from a call-booth, so it closes the roadmap |

`WAYFARER_ROAD` is the retuned threshold table — the first step pays on the
very first corpse, and the collect step is satisfied by the loot a 3-beast hunt
leaves behind. Existing quest ids and thresholds were deliberately left alone:
they are persisted in `quests_progress`, and rewriting them would invalidate
live rows for no gameplay gain, while the pacing problem was *ordering and
feedback*, not the numbers on those five quests.

## Objective surfacing (client)

| Surface | File | Behaviour |
| ------- | ---- | --------- |
| Objective tracker | `client/src/panels.ts` → `ObjectiveTrackerPanel` | Always-on, compact: track name, objective, live `n/goal`, the control that achieves it, and the step behind it. Optional expanded six-step checklist. |
| Level-up banner | `LevelUpPanel` + `LevelUpBanner` | A centred plate with the level, the numbers that produced it, and the talent point when the systems path reports one. Holds ~2.6s on the caller's clock. |
| Death card | `DeathPanel` + `DeathExplain` | What happened, where you wake, and that nothing was lost. `pointer-events:none`, so the death overlay's Respawn button is never blocked. |
| Bundle | `mountOnboardingUi()` | One import + one call wires all three; `handleEvent(kind, payload)` routes the existing `quest-progress` / `quest-complete` / `levelup` / `respawn` events and `render(now)` drives the auto-dismiss clocks. |

**Accessibility.** Every animation is gated twice — by the existing
`data-a11y-motion="reduced"` attribute and by `@media (prefers-reduced-motion)`
— and the panels carry the same flag the rest of the HUD uses
(`mountOnboardingUi({ reducedMotion })`, kept in sync through `a11y.onChange`).
Reduced motion removes *movement only*: the banner still appears, the tracker
still updates, the bar transition is dropped, and the step list is still
readable. Screen-reader users get `role="status"` / `role="alertdialog"` plus
`aria-label` copy and the HUD's own `announceQuest` announcements.

## Progression feedback

A level-up used to be a bare `level` number in the XP bar — indistinguishable
from any other number tick. The server's existing `levelup` event now carries
the surrounding numbers the banner needs (`prevLevel`, `xpLeft`,
`xpForNext`), purely additive on the same event kind, and the systems path's
`talentPointsGained` is already there. The client turns any of it into
`LEVEL 4 · 120 / 400 XP · +1 talent point · /talent to spend it`.

Level-up still emits once per level, on the same `level*100` curve (or the
composed `xpToNextLevel` curve when `SYSTEMS=1`), and is still absorbed by
`absorbLegacyXp` so exactly one curve drives the HUD.

## Death loop

The respawn path is **untouched** — `sim.respawnPlayer` still owns the move and
the shard still broadcasts `respawn`. What was missing is the explanation, so
`deathNotice()` (server) and `DeathExplain` (client) describe one shape: you
wake at the Ward Shrine `(50, 50)` at full HP with 3 seconds of spawn
protection, and **no XP or items are lost**.

| Death fact | Value |
| ---------- | ----- |
| Respawn point | Ward Shrine, `(50, 50)` |
| Return HP | Full (`sim.respawnPlayer`) |
| Protection | `SPAWN_PROTECTION_MS` = 3000 ms |
| XP penalty | None |
| Item penalty | None |

## Onboarding constants

| System | Constant | Value |
| ------ | -------- | ----- |
| Tutorial | `TUT_MOVE_DISTANCE` (step 1) | 12 units |
| Tutorial | total XP | 230 |
| Tutorial | objectives | 6, strictly ordered |
| First loot | `FIRST_BLOOD_ITEM` / `FIRST_BLOOD_COUNT` | `ember-shard` × 1, once per account |
| Road | `WAYFARER_ROAD` steps | kill 1 / collect 3 / kill 3 / explore 2 |
| Road | total XP | 160 |
| Respawn | `RESPAWN_POINT` / `RESPAWN_PROTECTION_S` | (50, 50) / 3 s |

## Systems

- **Combat** (`game/combat.ts`): `tryMeleeAttack(now, attacker, target)` —
  range + cooldown + alive checks, flat damage `12 + (lvl-1)*3 + bonus`,
  death sets `respawnAt = now+5000`. `updateRespawns()` revives at spawn pos.
  `updateAggro()` targets nearest alive player ≤12u, drops >20u (hysteresis).
- **Inventory** (`game/inventory.ts`): 20 slots, stackable to 99, fill-partials-
  first; `addItem`/`removeItem` validate fully before mutating (no partials).
  Pickups are `kind:'pickup'` (matches shared `EntitySnapshot` union).
- **Quests** (`game/quests.ts`): `slay5` / `gather10` / `explorer` (3 distinct
  chunks beyond spawn) plus the gated `WAYFARER_ROAD` ladder. Completion
  auto-grants XP; `level*100` thresholds with carry-over. `onKill` /
  `onCollect` / `onExplore(state, seen, chunkKey)`, mirrored by
  `roadOnKill` / `roadOnCollect` / `roadOnExplore`. `QUEST_ROADMAP` is the
  presentation order only and gates nothing.
- **Onboarding** (`game/onboarding.ts`): the six-objective spine, its per-player
  signal registry, the first-corpse gift and the death notice. Pure state +
  event helpers; the only thing that leaves it is `QuestEvent[]`.
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
