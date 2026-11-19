# AETHERFALL World

Ownership: `engine/src/worldgen.ts` (zones/tiles) + `server/src/game/content.ts`
(mobs, loot/XP curves, items/weapons, quest chain) + `server/src/game/loot.ts`
(drop tables + pickup spawn, wired to combat `onKill`) + quest dialogue in
`server/src/ai/dialogue.ts` (Elder Maren) + bosses in `server/src/ai/bosses.ts`
(spawned/AI'd by `server/src/ai/npc.ts`).

Protocol v1 untouched — loot/quests surface only as `t:'event'` messages
(`mob-die`, `xp-gain`, `pickup-spawn`, `quest-progress`, `quest-complete`,
`levelup`, and for bosses `boss-kill` / `boss-die` / `telegraph`).

## Zone map

Overworld zones are radial bands from spawn `(0,0)` with a noise-jittered
border (±15u, deterministic per seed) so transitions look organic:

```
                        r < 70                    70 <= r < 150              r >= 150
                 +----------------------+-------------------------------+------------------------------+
                 |  EMBER MEADOW        |  HOLLOW DEEP                  |  ASHFALL CALDERA           |
                 |  `meadow`            |  `dungeon` (highlands)        |  `volcano`                   |
                 +----------------------+-------------------------------+------------------------------+
  walk tiles     | grass, flower,       | stone, moss, crack,           | basalt, ember, ash,        |
                 | bush, pond-bank      | pillar-base                   | obsidian-fleck             |
  wall tiles     | bramble, water       | rubble, dark-rock             | lava, obsidian-wall        |
  obstacle dens. | 0.06                 | 0.14                          | 0.18                         |
  mob levels     | 1-2                  | 3-5                           | 5-8                          |
```

Helpers: `getZone(x, y, seed)`, `zoneForChunk(cx, cy, ...)`, `zoneTileKind()`,
`zoneWallKind()`, `genZonedChunk()` (walkability + decoration variants),
`genThemedDungeon()` / `dungeonTileKind()` (instanced-dungeon dressing).

## Spawn anchors (one table, read by both sides)

Ownership: `engine/src/spawn-anchors.ts` — the **single source of truth** for
where a player can appear and where hostiles may not spawn. The sim and the
spawner both import it, so the join path and the safe discs cannot drift apart
again.

| Anchor | x | y | Role |
| ------ | - | - | ---- |
| `origin` | 0 | 0 | World spawn (zone-map centre, radial `r`) |
| `shrine` | 50 | 50 | Death respawn (`Sim.respawnPlayer` default) |
| `west-meadow` | 12 | 38 | Meadow ring, west of the origin |
| `south-meadow` | 44 | 14 | Meadow ring, south shore |
| `east-ridge` | 88 | 48 | Dungeon-band ridge, east |
| `north-ridge` | 50 | 88 | North ridge between the two arena fixtures |

Readers:

- `Sim.addPlayer(id, name)` with **no** x/y places the player on
  `SPAWN_ANCHORS[id % 6]` (`spawnAnchorFor(id)`) — this is the live join path
  (`server/src/index.ts`). An explicit x/y still wins, per axis, and
  `findFreeSpawn` still nudges the body out of walls/terrain.
- `game/spawner.ts` derives `SPAWN_SAFE_POINTS = SPAWN_ANCHORS` (identity, not a
  copy) and keeps `SPAWN_SAFE_RADIUS = 12`. `spawnChunk` refuses to place a
  hostile inside a disc, `pruneSpawnSafe()` re-clears them each tick, and
  `spawner-ai` refuses to step / hunt / sweep into one.
- `game/index.ts` `ensurePlayer(game, id, name)` defaults to the same
  `spawnAnchorFor(id)` instead of a literal.
- Persisted players are **exempt**: the join path overwrites `p.x/p.y` from
  `db.getPlayer(pid)` right after admission, and that restore always wins.

Invariants (asserted in `server/src/game/spawn-anchors.test.ts`):

1. `(0,0)` and `(50,50)` stay in the table — docs, the respawn path and old saves
   hard-code them.
2. Every anchor is **>= `BOSS_WAKE_RANGE` (30u)** from every boss roost
   `(80,80) (20,80) (86,16) (14,86)`, so standing on an anchor never wakes a
   dormant boss, and >= 14u (legacy minion aggro) from `(30,30) (65,25) (50,70)`.
   Boss roosts and their 30u wake discs are deliberately anchor-free.
3. Anchors are **>= `2 * SPAWN_SAFE_RADIUS` (24u)** apart — the closest pair is
   36.5u, so two discs can never merge into one oversized no-mob region.
4. Every anchor is a free spot on the default terrain field (dry ground), so
   `findFreeSpawn` never pushes a joining player off its own disc.
5. Coverage stays modest: the six discs are **27%** of the 100x100 arena and the
   spawner still keeps **83%** of its mobs there (53 of 64 over the full 4x4
   chunks); every chunk of the arena keeps at least two.

What it replaced: `Sim.addPlayer` used to scatter players with
`10 + (id*7)%80` / `10 + (id*13)%80`. Player 1 landed at `(17,23)` — 28.6u from
the origin, outside both declared safe points — while every spawn-safety test
passed because they all spawned at the protected `(0,0)`. The feature was dead
in production; the table above makes the spawn coordinate and the disc that
protects it the same fact.

## Mob spawn tables (`MOB_SPAWN_TABLE`)

| Zone | Mob | Lv | Wt |
| ---- | --- | -- | -- |
| meadow | gloomfang | 1-2 | 40 |
| meadow | mistwisp | 1-2 | 25 |
| meadow | thornback | 1-2 | 20 |
| meadow | meadow-sprite | 1-1 | 15 |
| dungeon | ashcrawler | 3-4 | 30 |
| dungeon | thornback | 3-5 | 25 |
| dungeon | hollow-knight | 3-5 | 25 |
| dungeon | gloomfang | 3-4 | 20 |
| volcano | cinder-imp | 5-7 | 30 |
| volcano | ashcrawler | 5-8 | 25 |
| volcano | caldera-wyrm | 6-8 | 20 |
| volcano | void-wisp | 5-8 | 15 |
| volcano | magma-golem | 7-8 | 10 |

`rollSpawnForZone(rand, zone)` does the weighted pick + level roll (caller owns
the RNG, so spawns stay deterministic per seed). The spawner (`spawner.ts`)
rolls per mob position and sets HP via `mobMaxHp(zone, level)`.

## Balance: TTK 3-5 hits, HP scaling, XP

Player melee damage (`combat.damageFor`): `12 + (level-1)*3 + weapon bonus`.

Mob HP (`mobMaxHp`): `base + level * perLevel`, per zone:

| Zone | base | perLevel | e.g. HP |
| ---- | ---- | -------- | ------- |
| meadow | 36 | 12 | lvl1 = 48, lvl2 = 60 |
| dungeon | 40 | 16 | lvl3 = 88, lvl4 = 104 |
| volcano | 50 | 18 | lvl5 = 140, lvl8 = 194 |

Resulting TTK (ceil) vs same-level player with expected weapon:

| Matchup | Mob HP | Player dmg | TTK |
| ------- | ------ | ---------- | --- |
| meadow lvl1 (+0) | 48 | 12 | 4 |
| meadow lvl2 (+2 dagger) | 60 | 17 | 4 |
| dungeon lvl3 (+5) | 88 | 23 | 4 |
| dungeon lvl4 (+6 ward-blade) | 104 | 27 | 4 |
| volcano lvl5 (+8 ember-axe) | 140 | 32 | 5 |
| volcano lvl8 (+12 greatsword) | 194 | 45 | 5 |

XP: level-up threshold is `level * 100` (`xpForNextLevel`, shared with
`quests.ts`). Kill XP (`xpForKill`): `20 + 10 * mobLevel + zone bonus`
(meadow +0, dungeon +10, volcano +25).

## Items (10)

| id | name | kind | notes |
| -- | ---- | ---- | ----- |
| ember-shard | Ember Shard | material | quest + crafting stock, 5g |
| gloom-fang | Gloom Fang | material | meadow trophy, 4g |
| moss-cap | Moss Cap | material | highland fungus, 6g |
| healing-herb | Healing Herb | consumable | +25 HP, 8g |
| minor-potion | Minor Potion | consumable | +50 HP, 15g |
| mana-mote | Mana Mote | material | wisp residue, 7g |
| iron-ore | Iron Ore | material | smith stock, 6g |
| ash-coal | Ash Coal | material | caldera fuel, 9g |
| obsidian-chip | Obsidian Chip | material | volcano glass, 12g |
| ward-token | Ward Token | quest | Maren's mark, unsellable |

## Weapons (5, damage = flat melee bonus)

| id | name | dmg | lvlReq | zone |
| -- | ---- | --- | ------ | ---- |
| wisp-touched-dagger | Wisp-Touched Dagger | +4 | 1 | meadow |
| ward-blade | Ward Blade | +6 | 1 | meadow (chain reward) |
| ember-axe | Ember Axe | +8 | 3 | dungeon |
| deep-halberd | Deep Halberd | +10 | 4 | dungeon |
| caldera-greatsword | Caldera Greatsword | +12 | 5 | volcano |

## Masks (8, one perk each — `server/src/game/masks.ts`)

Wearable relics of the Fall. Exactly **one equip slot** (`/mask equip <id>` replaces
whatever is worn); perks apply immediately through stat aggregation
(`maskEquippedItem` → `aggregateStats`) and typed helpers at their consumption
site, and every change emits `mask-equipped` / `mask-unequipped` events.
Drops: bosses 25%, elites (level 6+) 5% — rolled in `loot.ts` beside the normal
table (never inside `LOOT_TABLE`, which the catalog checker requires to resolve
in shared). The vendor stocks all 8 (`vendor-stock` is 10 + 5 + 8 = 23 rows).

| id | name | theme | perk (one) | price |
| -- | ---- | ----- | ---------- | ----- |
| seraph-shard | Seraph Shard | autor | +15% melee damage | 150g |
| dusk-maw | Dusk Maw | beast | silent footsteps (no noise events) | 120g |
| gallow-beak | Gallow Beak | bird | faster executions (finish reach +1u) | 130g |
| choir-horn | Choir Horn | horn | longer throw range (+4u) | 130g |
| vesper-plume | Vesper Plume | bird | see-through-walls ping every 1s | 160g |
| tithe-scale | Tithe Scale | scale | one extra loot roll on kills | 170g |
| cinder-hide | Cinder Hide | beast | −30% hazard damage taken | 140g |
| halo-rind | Halo Rind | autor | +1 talent point while worn | 200g |

Perk routing: melee mult in `GameSession.meleeDamage`; finish bonus in the
melee `canFinishMob` reach; throw bonus in `ThrowOptions.range`; extra rolls in
`rollLootForKill`/`applyKillRewards` (`bonusRolls`, threaded from the killer's
mask through `playerMeleeAttack`/`onMobKilled`/`onBossKilled`); the boon point
is spent before pool points with an anti-farm latch; the plume emits a private
`wall-ping` at most 1/s from the session tick. Silence / hazard-ward resolve
through pure gates (`maskMuffles`, `hazardDamageTaken`) at their consumers.

## Quest chain (5, Elder Maren)

Linear prerequisites; progress via `chainOnKill` / `chainOnCollect` /
`chainOnExplore` (gated — locked quests accrue nothing). Completion grants
`rewardXp` immediately (shared `level*100` thresholds).

| # | id | kind | goal | XP | reward | dialogue node | zone |
| - | -- | ---- | ---- | -- | ------ | ------------- | ---- |
| 1 | ward-spark | kill | 3 | 40 | — | `quest_offer` | meadow |
| 2 | ember-road | collect | 5 | 60 | — | `ember_road` | meadow |
| 3 | deep-delvers | kill | 6 | 90 | — | `deep_delvers` | dungeon |
| 4 | chart-the-fall | explore | 4 | 120 | — | `chart_fall` | dungeon |
| 5 | heart-of-fall | kill | 8 | 200 | ward-blade | `heart_fall` | volcano |

Talk via `@maren <words>`; keywords route per quest (`ember/shard`,
`deep/delve/dungeon/...`, `chart/explore/...`, `heart/caldera/boss/...`).
`QUEST_DIALOGUE` (content.ts) mirrors `dialogueNodeForQuest()` (dialogue.ts).

## Loot flow (`loot.ts` -> combat `onKill`)

1. `tryMeleeAttack()` returns `{ ok: true, killed: true }`.
2. Caller runs `applyKillRewards(state, mobName, zone, level, x, y, rand)`:
   base-trio `onKill` + `chainOnKill`, kill XP via `addXp`, `rollLootForKill`.
3. `pickupsForLoot()` scatters one `makePickup()` per drop stack by the corpse.
4. Game layer `onMobKilled(game, playerId, mobId, now, rand)` wraps all of the
   above + `spawner.killMob` (5s respawn) and emits `mob-die`, `xp-gain`,
   quest events, `pickup-spawn` (protocol-v1-safe).

Drop highlights: gloomfang → gloom-fang 65%; hollow-knight → ember-axe 4%;
caldera-wyrm → deep-halberd 3%; magma-golem → caldera-greatsword 5%.
Zone fallbacks (`zone:<id>`) cover unlisted mobs.

## Bosses (4, `ai/bosses.ts` -> `ai/npc.ts`)

Boss controllers are engine-agnostic FSMs: `update(dt, targets)` returns
events, and `NPCManager` applies movement/damage and turns those events into
protocol-v1 `t:'event'` traffic. `NPCManager.tick()` still runs at **10Hz**
(every other 20Hz sim tick), so boss logic costs no 20Hz budget.

| Boss | Kind | Zone | HP | Anchor | Wake | Loot table |
| ---- | ---- | ---- | -- | ------ | ---- | ---------- |
| Stone Golem | `golem` | arena fixture | 400 | (80, 80) | always | none |
| Void Wisp | `wisp` | arena fixture | 220 | (20, 80) | always | none |
| Ember Wyrm | `ember-wyrm` | volcano | 3200 | (86, 16) | 30u | `ember-wyrm` |
| Crypt Warden | `crypt-warden` | dungeon | 2200 | (14, 86) | 30u | `crypt-warden` |

**Lazy spawn.** The two newer bosses (Ember Wyrm and Crypt Warden) are dormant at boot: they cost nothing
until a living player comes within 30u of the anchor, at which point they wake
at full HP on their anchor. On death the corpse stays visible for 2s (so players
can see what dropped the loot), then the slot resets: full HP immediately if a
player is still camped, otherwise back to dormant until someone returns. The
Golem/Wisp keep their original always-active behaviour.

### Ember Wyrm (`volcano`)

Chases the nearest player (speed 3.4). Every 6s within 14u it locks a
**charge line** at the target's position, telegraphs it for 800ms, then dashes
the whole corridor and leaves fire at the impact.

| Phase | Detail |
| ----- | ------ |
| `chase` | move 3.4 u/s toward nearest player; charge cd 6s |
| `chargeWindup` | 800ms telegraph (`wyrm-charge`), line locked at kickoff |
| `recover` | 1s punish window, then cd resets |

- Impact: 30 dmg in a `width+1.0` = 3.5u circle at the landing point, plus 30
  dmg along the whole dash corridor (capsule, `width` 2.5).
- Fire pool: `wyrm-fire`, r 3, 5s, **8 dmg per second** per player standing in
  it (npc.ts applies `tickDamage` on a 1s cadence, not per 10Hz tick).
- Enrage (<30% HP): charge cd /1.35, windup /1.35, width x1.3, damage x1.35,
  and a **second pool dropped mid-corridor** to cut off straight-back kiting.

### Crypt Warden (`dungeon`)

Slow chase (1.8 u/s) + circle slam, with two shield phases and add pressure.

| Phase | Detail |
| ----- | ------ |
| `chase` | move 1.8 u/s; slam cd 4.5s; summon cd 18s |
| `windup` | 900ms `warden-slam` circle telegraph (r 4) |
| `recover` | 1s |
| `shield` | 4.5s full immunity, summons 2 husks on arming |

- Slam: 22 dmg, r 4, same `shape:'circle'` wire shape as the Golem.
- Adds: 2 `crypt-husk` per summon, 35 HP, one per 18s **plus** one pair per
  shield. World caps living husks at **8** and husks despawn on death instead of
  respawning, so a long fight cannot stack adds (this keeps the 10Hz tick flat).
- Shields at **66%** and **33%** HP. Player hits are routed through
  `CryptWardenBoss.takeDamage()`, which returns **0** while shielded — `update()`
  alone cannot enforce immunity, so all boss damage goes via `damageBoss()`.
- Shield immunity is 2 x 4.5s = 9s of the fight's wall clock.

### Telegraph wire format

`client/src/telegraph.ts` accepts **only** `shape:'circle'` with
`0 < r <= 30` and `0 < ttlMs <= 5000`. So `npc.ts` converts everything to
circles on the way out (`wireTelegraph` clamps into that envelope):

- `charge` (line) → a chain of circles spaced `2r` apart along the corridor
  (max 4) **plus** one circle at the landing point sized to the real impact
  radius. The renderer keeps only 12 telegraph rings, hence the cap.
- `pool` → one circle for the pool's full 5s (pool TTL is 5s so it fits the cap).
- `summon` → a 1.2u / 400ms circle marking where each husk appears.
- `shield` → a 3.5u aura circle while immune, 400ms flicker when it drops.
- Golem/Wisp circles are unchanged (`golem-slam`, `wisp-blink`, `wisp-burst`).

### Boss TTK budget (60-90s duo, verified by test)

`bosses.test.ts` runs the real controllers in a headless 10Hz sim
(`fightSim`): the duo is glued to the boss (range is never the limiter),
`uptime` is the fraction of the fight spent actually swinging, adds soak damage
before the boss and shield windows soak time. `bossDuoTtkSec()` in
content.ts is the closed-form version of the same math.

| Matchup | dmg | uptime 0.45 | 0.50 | 0.55 | 0.60 |
| ------- | --- | ----------- | ---- | ---- | ---- |
| Ember Wyrm, lvl7/+10 duo | 40 | 71.2s | 64.0s | 58.2s | 53.4s |
| Ember Wyrm, lvl6/+8 duo | 35 | 81.3s | 73.2s | 66.5s | 61.0s |
| Ember Wyrm, lvl8/+12 duo | 45 | 63.3s | 56.9s | 51.8s | 47.5s |
| Crypt Warden, lvl4/+6 duo | 27 | 86.1s | 78.4s | 72.1s | 66.8s |
| Crypt Warden, lvl5/+6 duo | 30 | 78.4s | 71.4s | 64.1s | 59.5s |

Design point is **uptime <= 0.55** (telegraph dodging is meant to cost ~half
the clock). A duo that never dodges kills the Wyrm in ~53s and the Warden in
~67s. Solo is 114-160s, so these are genuinely group fights.

Normal-mob TTK is untouched by boss work — `content.test.ts` still enforces
3-5 hits and the current tables give 4 (meadow/dungeon) to 5 (volcano).

## Boss loot + achievement

`BOSS_KILL_XP = 200` flat per boss kill (`xpForBossKill()`), plus a
`boss-kill` achievement event `{ type:'boss-kill', boss, xp }`. Boss kills also
count for the base-trio + chain `kill` quests.

| Table | Guaranteed | Rolls |
| ----- | ----------- | ----- |
| `ember-wyrm` | obsidian-chip x2-3 | ash-coal 50% (1-2), caldera-greatsword 10% |
| `crypt-warden` | iron-ore x1-2 | minor-potion 30%, deep-halberd 5% |

Flow: `NPCManager` reports `boss-kill` → `onBossKilled(game, playerId, boss,
x, y, rand)` → `applyBossKillRewards()` → `boss-kill` + `xp-gain` +
`pickup-spawn` events. The killer is whoever landed the most recent hit
(`damageFromPlayer(x, y, amount, attackerId)`); uncredited deaths pay nothing.

`ember-wyrm` falls back to the `volcano` zone table and `crypt-warden` to
`dungeon` (`BOSS_ZONE` / `bossZoneFor()`), so both shower materials even if the
named entries are retuned.

## Chapter "STATIC" (voicemail missions + parole interludes + twist)

Ownership: `server/src/story/chapter.ts` (missions, gating, payoff) +
`server/src/story/calls.ts` (voicemails) + parole/reveal dialogue in
`server/src/ai/dialogue.ts` (`STATIC_PAROLE_A/B_NODES`, `STATIC_REVEAL_NODES`,
`StaticSceneDialogue`) + client `StaticChapterTracker` (`client/src/quests.ts`)
+ `PhoneBoothPanel` / `QuestLogPanel` / `IntroCardOverlay` (`client/src/panels.ts`).

Original neon-noir plot written for AETHERFALL (all names and places are
original; only the delivery shape — cryptic calls, walk-and-talk paroles,
final twist — nods to the genre). After the Fall, Emberfall's dead
ward-stone conduits still hum. Public call-booths ring at odd hours with
voicemails from `UNKNOWN NUMBER`, each one a job: go to a landmark, do the
work, lift any receiver for the next message.

| # | Mission | Act | Landmark | Zone |
| - | ------- | --- | -------- | ---- |
| 1 | Porchlight (`static-porchlight`) | kill 4 | Brazen Porch | meadow |
| 2 | Kiosk Tithe (`static-kiosk`) | collect 6 ember-shards | Flicker Kiosk Row | meadow |
| 3 | Arcade Sweep (`static-arcade`) | kill 6 | Sunken Arcade | dungeon |
| 4 | Meridian Walk (`static-meridian`) | explore 4 points | Glass Meridian | dungeon |
| 5 | Exchange Silence (`static-exchange`) | kill 8 | Ashfall Exchange | volcano |

Progression is strictly sequential in the existing `QuestState.progress` map
(`static-*` keys; `quests_progress.quest_id` is free-form TEXT so no schema
change): `staticOnKill` / `staticOnCollect` / `staticOnExplore` accrue only
the unlocked mission, XP follows the 40/60/90/120/200 curve, and progress
surfaces as the usual `quest-progress` / `quest-complete` events the
quest-log panel already feeds.

Paroles (skippable, one room + two NPCs + 6 lines each): after mission 2, the
Copper Kettle back room — fence Bram Vey and night courier Sella Qinn argue
over who pays through dead booths; after mission 4, the Rust Chapel vestry —
keeper Pale Odo and relay-sweeper Tilda Vess admit the voice sounds like
someone Elder Maren lost.

Twist + payoff: the caller is **Wren Halloway**, Maren's signal-tender
apprentice, believed lost when the ward-relay collapsed during the Fall. She
has lived inside the Ashfall Exchange ever since, splicing her voice through
dead conduits and hiring strangers booth by booth to clear the shard-choked
lines so the relay can finally shut down. Finishing mission 5 grants the
unique mask **Hollow Receiver** (`hollow-receiver`, "For the one who
answered. — W.H.") and the title **Callerbound**. Chapter intro cards
(`EMBERFALL // AFTER THE FALL` / `CHANNEL 0 — STATIC` / `PICK UP.`) render
as a VHS-style overlay: skippable (ENTER advances, ESC skips) and
reduced-motion safe (chromatic-aberration shadow removed under
`prefers-reduced-motion` / `data-a11y-motion="reduced"`).

## World tiers and reputation

Ownership: `server/src/game/progression/` (`world_tiers.ts`, `reputation.ts`,
`events.ts` + tests) and the wire vocabulary in `shared/src/world_tiers.ts`.
**This layer is pure and currently unwired** — no call site was added to
`server/src/index.ts` or `server/src/game/index.ts`; the exact two handoff
points are written down in `server/src/game/progression/README.md`. Until a
future agent adds them, the balance tables above are exactly the live values.

### Tier table

`tierAt(x, y)` reads the existing spawn anchors, boss roosts and `getZone()`
(no new geography). A position is tier 1 inside a 24u disc around any anchor
(twice the 12u no-mob radius); otherwise the distance to the nearest anchor
sets the base band, the zone raises the floor, and a boss roost raises it
again. The six anchors stay tier 1 even where `getZone()` calls them
`dungeon`; all four roosts are tier 4.

| Tier | Nearest anchor | Zone floor | Boss roost proximity | HP × | Damage × | XP × | Recommended level |
| ---- | -------------- | ---------- | -------------------- | ---- | -------- | ---- | ----------------- |
| 1 | ≤ 24u (sanctuary) | meadow | — | 1.00 | 1.00 | 1.00 | 1 |
| 2 | 25-52u | dungeon ≥ 2 | — | 1.35 | 1.20 | 1.30 | 4 |
| 3 | 53-82u | volcano ≥ 3 | inside 30u wake disc ≥ 3 | 1.70 | 1.45 | 1.70 | 6 |
| 4 | > 82u | — | inside 16u crown = 4 | 2.00 | 1.65 | 2.10 | 8 |

Tier 1 is byte-for-byte the old balance: a meadow minion keeps 48 HP, 7 damage
per 1.5s and 30 kill XP, and a level-1 player still kills it in 4 swings
(`12 + 3/level`). `tierStats(tier, base)` only touches mob HP/damage/XP, with
hard caps of ×2.00 / ×1.65 / ×2.10. `tierPenalty(level, tier)` is the "soft
wall": instead of blocking or teleporting an under-levelled visitor it applies
`+12%` incoming damage per missing level (capped ×2.5) and `−15%` XP per missing
level (floored at ×0.35). At or above the recommended level both multipliers
are exactly 1.

### Faction reputation

Three original factions of the Fall, each with five named ranks and **one**
purchasable perk. `awardFor(tier, 'kill' | 'quest')` pays tier-scaled,
faction-weighted reputation (the Vigil guards, the Choir remembers, the Ledger
maps); lifetime total decides rank, unspent balance buys the perk.

| Faction | Ranks (thresholds, lifetime rep) | Perk (spend) |
| ------- | -------------------------------- | ------------ |
| The Ashen Vigil | Cinder Sentry 0 → Ember Warden 50 → Dawnvow Knight 150 → Last-Light Captain 350 → Vigil of the Fall 750 | Oath of the Last Watch: +25 max HP (120 rep, rank 2) |
| The Hollow Choir | Muted Mourner 0 → Vesper Cantor 45 → Requiem Bearer 135 → Dirge Archivist 315 → Voice of the Unfallen 675 | One Name Kept: +8% XP (150 rep, rank 2) |
| The Fault Ledger | Soot Clerk 0 → Shard Runner 60 → Rift Surveyor 180 → Breach Factor 400 → Keeper of the Ledger 850 | Wayfinder's Bargain: 10% off vendor prices (180 rep, rank 2) |

### World events

A deterministic, seeded calendar — one event every **5 minutes** of tick time,
first firing after the opening five minutes. Every third slot (index 2, 5, 8,
…) is a `roost-awakening` (boss wakes for 2 min at one of the four roosts);
the other slots are `shard-surge` events (1.5-2.25× XP for 3 min at one of five
landmarks: Brazen Porch, Flicker Kiosk Row, Sunken Arcade, Glass Meridian,
Ashfall Exchange). Slot N is derived from `mulberry32(seed ^ mix(N))` alone, so
`activeEventAt(seed, now)` and `nextEventAfter(seed, now)` are constant-time
and identical after every restart. The server-facing adapter is
`WorldEventClock`, but nothing calls it yet.

## Chapter Two: PARTITION (story-only, unwired into live sessions)

Ownership: `server/src/story/chapter-two.ts` (arc + gating + payoff),
`server/src/story/couriers.ts` (landmark hint NPCs), `server/src/story/world-state.ts`
(reactive facts + call-site notes), client `ChapterTwoTracker` in
`client/src/quests.ts` and the Chapter Two block in `QuestLogPanel`
(`client/src/panels.ts`). Same contract as STATIC: PURE data/helpers, no
clocks, no tick-loop edits, no protocol change, `partition-*` keys in the
existing `QuestState.progress` map.

Direct sequel to STATIC. The Ashfall Exchange relay is quiet, but the dead
booths stopped carrying voices and started keeping a ledger. **The Collator**
is an indexing process Maren's relay team built to map the Fall; during the
collapse it was split across the booth network so it would not fold under the
weight of mapping the dead. Wren Halloway was the human lock that held the
partitions apart — taking her Hollow Receiver transferred the lock to the
player.

| # | Mission | Act | Landmark | Zone |
| - | ------- | --- | -------- | ---- |
| 1 | Dead Air (`partition-dead-air`) | explore 3 carriers | Ashfall Exchange | volcano |
| 2 | Call Log (`partition-call-log`) | collect 5 shard-ledgers | Flicker Kiosk Row | meadow |
| 3 | Glass Register (`partition-glass-register`) | kill 6 index-husks | Glass Meridian | dungeon |
| 4 | Sunken Archive (`partition-sunken-archive`) | explore 4 pillars | Sunken Arcade | dungeon |
| 5 | Custody (`partition-custody`) | kill 8 collator-wards | Ashfall Exchange | volcano |

Sequential gating is a predicate over quest state: mission 1 opens only when
`isStaticChapterDone()` is true, and mission N > 1 only when mission N-1 is
done. XP follows 60/90/120/160/240. Twist: the voice that hired the player for
STATIC missions 1-4 was partly the Collator impersonating Wren from her
training logs; Maren partitioned it deliberately once it began indexing the
names of the dead. Completing mission 5 grants the unique title **Warden of
the Quiet** and mask **Ledger Lens**, with an idempotent claim latch so neither
can be granted twice.

Couriers (one per landmark, 5-line skippable trees reusing
`StaticSceneDialogue`): Intake Clerk Voss, Tallies Munn, Surveyor Idda, Diver
Corren, Switchboard Aide Pell. They click in when STATIC ends and go quiet as
their own mission completes.

Reactive facts (`derivePartitionWorldFlags`): completing the chapter opens the
**Quiet Register** landmark at the shrine anchor (50,50), wakes the
**collator-roost** controller (72,62), and makes the Ledger Lens stockable —
`courierRoutesOpen` flips as soon as STATIC is done. `world-state.ts` lists the
unwired call sites in `game/index.ts`, `index.ts`, `ai/npc.ts` and
`game/content.ts`; the tick loop is deliberately untouched. The client quest
panel shows a Chapter Two block fed by the same `quest-progress` /
`quest-complete` events, with no wire-format change.
