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
