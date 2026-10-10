# AI (NPC + Bosses + Dialogue)

Owner: `server/src/ai/*` + engine integration in `server/src/index.ts`.
NPCs tick at **10Hz** (every 2nd sim tick, `dt=0.1`) inside the existing
20Hz authoritative loop. No new timers, no protocol changes: NPCs ride
`snapshots` as `kind:'mob'`, telegraphs/damage go out as `event` messages.

## Modules

- `behavior.ts` — behavior-tree primitives: `ActionNode`, `ConditionNode`,
  `SequenceNode`, `SelectorNode` (+ `InverterNode`), factories
  `action/condition/sequence/selector`, and a `Blackboard` for per-tick data.
  Sequences/Selectors resume `running` children instead of restarting.
- `fsm.ts` — `NPCState = idle|patrol|chase|attack|flee|dead`.
  `nextState(state, perception)` is a pure transition function; `NPCFSM`
  adds the idle-dwell timer. Priority: `dead > flee (low HP) > combat >
  acquisition > recovery`. Leash = 2.5x aggro range.
- `bosses.ts` — `GolemBoss` (slow chase + AOE slam: 900ms circle telegraph
  `r=4.5`, 25 dmg, 4s cd) and `WispBoss` (drifts at ~6u, 500ms blink
  telegraph, then 700ms burst telegraph `r=3.5`, 18 dmg, 5s cd).
  Both enrage under 30% HP. `update(dt, targets)` returns events;
  `damage` events are resolved against players by `npc.ts`.
- `dialogue.ts` — `QuestGiverDialogue`: rule-based Elder Maren tree
  (`greeting -> quest_offer -> accepted -> done_check`, plus
  `where/reward/not_done/bye` branches, keyword routing in `freeform()`).
  `generateFlavorLine()` optionally rephrases a line via local Ollama
  (`http://localhost:11434/api/generate`, 900ms timeout); any failure
  returns the local text — dialogue always works offline.
- `npc.ts` — `NPCManager`: 3 `gloomfang` minions + Golem + Wisp.
  Each minion runs **BT action selection** (root selector:
  die > flee > strike > pursue > patrol) then the **FSM** authorizes the
  locomotion state; movement uses engine `SpatialHash.near()` for target
  acquisition and `astar()` on a 50x50 (2u cells) arena grid, repathed
  every 0.6s with straight-line fallback. Melee: 1.8u range, 8 dmg, 1s cd.
  Dead minions respawn after 5s. NPC ids start at 900001 (no player clash).
- Tests: `behavior.test.ts` (selector/sequence incl. `running` resume),
  `fsm.test.ts` (all transitions + `NPCFSM` timer integration).

## Runtime wiring (`index.ts`)

- `fullSnapshot() = sim.snapshot() + npcs.snapshot()` feeds welcome,
  interest-filtered snapshots, and DB saves — clients see mobs through the
  normal 40u interest filter.
- `input.attack=true` calls `npcs.damageFromPlayer()` (12 dmg, 3u).
- NPC damage to players clamps HP; death respawns at (50,50) full HP with a
  `respawn` event.
- Chat `@maren <words>` talks to Elder Maren (per-player dialogue state,
  dropped on disconnect).

## Tuning

Aggro 14u, melee 1.8u/8dmg/1s, flee at <=25% HP, Golem 400HP/2.2u/s,
Wisp 220HP/4.0u/s. Telegraph `ttlMs` matches the windup that follows, so
clients can render the circle for exactly the warning duration.

## Vision cones (`ai/vision.ts` + `engine/src/los.ts`)

Hotline Miami-style sight. Each minion carries a `facing` (radians,
0 = +X, updated on every step/attack/stare) and a **90-degree cone**
(45 degrees each side, edges inclusive). Detection of a target needs all
three legs, evaluated cheapest-first inside the existing 10Hz NPC tick:

1. **Cone + range** — inside the facing cone and within range: **14u** in
   the open (meadow), **12u** where the rock closes in (dungeon highlands
   + volcano, via engine `getZone()` of the NPC's own position).
2. **Line-of-sight** — `engine/src/los.ts` checks BOTH occluder sources
   and both must be clear: the tile grid (`gridLos`, 1u-step raycast over
   the NPC path grid) and the `data/walls.json` rects (`rectLos`, exact
   segment-vs-AABB). The raycast caps at `LOS_MAX_STEPS = 14` samples and
   both legs early-out on the first occluder.
3. **Moving-or-close** — target speed >= 0.5u/s (caller velocity when
   supplied, else per-tick position deltas; first sighting reads as still)
   OR within **4u**. Still targets beyond 4u are unseen — sneaking works.

Once ALERT (chase/attack/search) the movement leg is dropped (`canTrack`):
a spotted target is tracked by cone+LoS+range only, so freezing mid-chase
does not shake a pursuer — break the cone, break LoS, or outrun the leash.
`NPCManager.setWalls()` installs the authoritative rects for the LoS leg
(empty = open arena default); snapshots carry `dir: facing` for clients.

## Alert states (`ai/fsm.ts`: suspicious / search)

`PATROL -> SUSPICIOUS -> ALERT (chase+attack) -> SEARCH -> PATROL`:

- **SUSPICIOUS** — attacks/gunshots within **18u** queue a noise
  (`notifyNoise()`; every `damageFromPlayer` swing queues one, even on a
  miss). Calm (idle/patrol) minions in earshot stare toward it for **1.5s**
  (no movement), then stand down to patrol — unless vision acquires first.
- **ALERT** — the existing chase+attack pair. On first acquisition the mob
  emits a **TAUNT** `emote` event (`emote:'laugh'`, `label:'Taunt'`, with
  `fromId/x/y/expiresAt/seq`), which rides the normal emote broadcast lane
  (`{t:'event',kind:'emote',payload}` — the id reuses the composed-systems
  set so current clients render the bubble). One taunt per acquisition;
  re-acquiring after search taunts again.
- **SEARCH** — losing sight (instead of snapping back to patrol) sweeps
  **last-seen + 2 neighbors** (+3u E, +3u S, clamped to the arena) at 2.0u/s
  for **6s**, re-acquiring through the tracking leg while sweeping, then
  patrols.

## Surrender (`shouldSurrender` + FSM `surrender`)

A solo mob (no other living minion within **10u**) at **<=25% HP** rolls
once per life at **40%** (per-minion id-seeded `mulberry32` stream, so sims
stay reproducible). Winners enter **SURRENDER**: hands up, stands still
(stare tracks the threat), `surrender` event broadcast (wire-safe: old
clients ignore unknown kinds). A lethal hit downs it per the combat rules
(a melee finisher kills); a non-lethal hit breaks the surrender (re-aggros,
never re-rolls this life);
otherwise it holds until the **20s** timeout lapses, then patrols. Allied
mobs never elect surrender — they flee as before.

Tests: `ai/vision.test.ts` (cone/range edges, moving-or-close, both LoS
legs), `ai/alert.test.ts` (noise->suspicious->patrol, taunt-once,
search sweep + 6s lapse, seeded 40% bounds, mechanics, FSM coverage),
`engine/src/los.test.ts` (rect/grid/combined + perf contract).

## Spawner mob AI (`game/spawner-ai.ts`)

Owner: `server/src/game/spawner-ai.ts` + one call in the existing 10Hz slot in
`index.ts`. Everything else (spawn, loot, ids, `pruneSpawnSafe`) is untouched.

The worldgen population — `gloomfang`, `ashcrawler`, `thornback`, `mistwisp`,
`MOBS_PER_CHUNK` (4) per 32x32 chunk in an infinite world — used to have **no
behaviour at all**: `Spawner.moveMob()` was only ever called from tests and
`m.targetId` was only ever set to `null`, so every mob the player actually fought
was a statue. The rich AI above only drove 3 fixed minions at (30,30)/(65,25)/
(50,70), all outside the sight cone of spawn, which is why a new player
essentially never met an AI-driven enemy.

`SpawnerAI` reuses the existing machinery rather than a parallel system:

| Piece      | Reused from                                        |
| ---------- | -------------------------------------------------- |
| Sight      | `ai/vision.ts` — cone, sneak leg, `canDetect`/`canTrack` |
| Occlusion  | `engine/src/los.ts` — `gridLos` (worldgen tiles) + `rectLos` (`walls.json`) |
| States     | `ai/fsm.ts` — `NPCFSM` per mob (idle/patrol/chase/attack/search) |
| Budget     | `ai/npc.ts` — `MELEE_DAMAGE` 7, `MELEE_COOLDOWN` 1.5s, `LEASH_RANGE` 20 |
| Movement   | `Spawner.moveMob` (re-files the spatial index) + `genChunk` tile rejection |
| Tile grid  | `genChunk` (the same walkability the spawner itself uses), cached per chunk |

### Behaviour

1. **Idle/patrol** — a fresh mob dwells for 2–3s (the FSM idle timer), then
   drifts between waypoints drawn from an id-seeded stream inside a **3–6u**
   patrol radius, pausing 0.4–1.6s at each. Facing tracks the walk, so the cone
   sweeps the neighbourhood and mobs notice approaching players without anyone
   having to walk into them. A mob that cannot make progress for 1.5s re-rolls
   its waypoint (wall rejection, not a statue).
2. **Acquire** — `canDetect` for calm mobs (cone + range + LoS + the
   moving-or-close leg), `canTrack` once alert. Sight pull is **12u**
   (`SPAWNER_SIGHT_RANGE`, the same `AGGRO_RANGE` the legacy proximity pass uses)
   and melee reach is **2.2u** (`combat.MELEE_RANGE`) so neither side
   out-ranges the other.
3. **Chase/attack** — 5.0u/s chase, 7 damage per hit on a **1.5s** cooldown,
   the exact budget in docs/GAMEPLAY.md "Damage budget" (14 hits ≈ 21s to kill
   a naked idle player). Chase speed is below the player's 8u/s
   (`sim.MAX_SPEED`) so walking away always works: the **leash**, not the speed,
   ends a fight.
4. **Leash** — kited further than `LEASH_RANGE` (20u) from `mob.spawnPos`, the
   mob clears its target and walks home at 3.5u/s. Re-acquisition is blocked
   until it is actually back, so a kite cannot re-tug it forever. Losing sight
   routes chase → `search`, which sweeps the last-known point at 2.0u/s and
   then stands down to patrol.
5. **Spawn-safe discs** — three layers, all keyed off `isSpawnSafeZone` /
   `SPAWN_SAFE_POINTS` (which is the shared spawn-anchor table, one disc per
   anchor — see "Spawn anchors" in docs/WORLD.md):
   - a step whose destination lands inside a 12u disc is **refused**, so no mob
     can be walked into the clear zone;
   - a player standing inside a disc is **not targetable**, so chasing one ends
     the moment they cross the line;
   - when that happens an alert mob **breaks off and walks home** rather than
     freezing on the boundary — a mob pressed against the clear zone still reads
     as "camped on spawn". Patrol waypoints are projected out of the discs too.
6. **Spawn protection** — a player with `spawnProtectedUntil` in the future is
   never acquired and never hit (re-checked at swing time); `Sim.damagePlayer`
   re-checks it again in `index.ts`, so the window holds end to end.
7. **Dead / downed / stunned** — corpses, knockdowns (3s crawl) and thrown
   sidearm stuns hold still and swing nothing, exactly like `ai/npc.ts`.

### Performance

Runs on the existing 10Hz NPC cadence, one call, reusing the `views` array the
NPC tick already builds. Two early-outs: no players at all does nothing; and
the awake set is gathered from the **player** side through the spawner's cell
index (`forEachMobNear`), so cost is `O(players x nearby mobs)` rather than
`O(all mobs x players)`. Measured on a pathological 6 379-mob world:
**0.002 ms/tick** idle, **0.107 ms/tick** with 20 distant players, **0.205 ms/
tick** with 20 players clustered (≈2 ms per wall-second, 0.2% of a core, well
inside the 50 ms slow-tick budget). A realistic 391-mob shard costs 0.19 ms.

### Ownership notes

- The driver writes **its own** target (`SpawnerAiDebug.targetId`), never
  `mob.targetId`. That field belongs to the legacy 20Hz proximity pass
  (`game.tickGameplay` → `combat.updateAggro`), which knows nothing about cones,
  line of sight, sneak or spawn protection. Letting a 10Hz driver overwrite it
  would make the two rules flip-flop every tick and spam `mob-aggro`.
- Mobs that were in play and then were not are rested through a small
  `activeIds` set, so a mob that walks out of range resets its brain (fresh
  patrol, no stale target) when a player comes back.
- The engine-entity mirror (`mob-spawn` → `world.spawn`) is re-synced for the
  handful of mobs the driver actually moved (`takeMoved()`), so `pos` never
  drifts from the authoritative body.

Tests: `game/spawner-ai.test.ts` — acquisition + hit inside 10s, the attack
cadence floor, the sneak rule (and its control), leash return, the spawn-disc
lure, spawn protection, patrol + wander bound, downed/stunned inertness, the
early-outs, and the "kill still drops loot and emits the same events" regression.
