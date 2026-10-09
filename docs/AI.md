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
