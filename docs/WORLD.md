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
