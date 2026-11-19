# World progression — integration handoff (deliberately NOT wired)

This folder adds the world's missing progression layer as **pure, tested data**:

| Module | What it gives you |
| ------ | ----------------- |
| `world_tiers.ts` | `tierAt(x,y)` (1-4), `tierStats(tier, base)` (HP/damage/XP), `tierPenalty(level, tier)` (soft wall) |
| `reputation.ts` | 3 original factions × 5 ranks, `awardFor`, `grantReputation`, `buyPerk` |
| `events.ts` | seeded `worldEventSchedule` / `worldEventAt` / `activeEventAt` / `nextEventAfter`, plus the immutable `WorldEventClock` adapter |
| `index.ts` | barrel of all three |

Nothing here reads a clock, holds mutable state, or touches the live tick loop.
`shared/src/world_tiers.ts` carries the wire vocabulary (`WorldTier`,
`FactionId`, `WorldEventView`, …) so the client can consume these later.

**This phase owns no call site in `server/src/index.ts` or
`server/src/game/index.ts`.** A future agent must add exactly two, described
below. Do not add them here.

---

## Call site 1 — `server/src/index.ts`, inside `tickOnce()`

`tickOnce()` is the single fixed-step clock (it calls `sim.step(dt)` and
`tickGameplay(__game, ...)`). Add one `world-event` check immediately **after
the `for (const e of tickGameplay(__game, Date.now()))` loop** that currently
ends with `emitGameEvent(e.kind, e.payload);` (around line 1242), and apply the
damage half of the penalty at the two existing `sim.damagePlayer(e.targetId,
e.amount, Date.now())` calls in the same function (the NPC lane ~1270 and the
mob-AI lane ~1312):

```ts
import { WorldEventClock } from './game/progression/events.js';
import { tierAt, tierPenalty, penalizedDamage } from './game/progression/world_tiers.js';

// Once at shard boot, alongside the other singletons:
const worldEvents = new WorldEventClock(worldSeed); // same seed as the sim
let lastWorldEventId = '';

// Inside tickOnce(), after the tickGameplay event loop:
const active = worldEvents.activeAt(Date.now());
if (active && active.id !== lastWorldEventId) {
  lastWorldEventId = active.id;
  emitGameEvent('world-event', active); // protocol-v1-safe t:'event' payload
}

// At each damagePlayer call in tickOnce (both the NPC and mob-AI loops):
const gp = __game.players.get(p.id);
const tier = tierAt(p.x, p.y, worldSeed);
const pen = tierPenalty(gp?.quests.level ?? 1, tier);
const amount = penalizedDamage(e.amount, pen);
if (!sim.damagePlayer(e.targetId, amount, Date.now())) continue;
```

Holding `lastWorldEventId` makes the event fire once on activation rather than
on every 20 Hz tick; the clock itself needs no cursor because it is a pure
function of the seed and the clock time.

## Call site 2 — `server/src/game/index.ts`, inside `creditKill()`

`creditKill(game, player, mob, rand, opts)` is the single reward path shared by
`onMobKilled`, the melee kill path, and (with its own block) `onBossKilled`.
Add the tier/XP/reputation step immediately after `zone` is computed and
before `applyKillRewards(...)` is called (around lines 438-463), then scale the
`xp` that is paid out:

```ts
import { tierAt, tierStats, tierPenalty, penalizedXp } from './progression/world_tiers.js';
import { awardFor, grantReputation } from './progression/reputation.js';

const zone = getZone(mob.pos.x, mob.pos.y, game.seed);
const tier = tierAt(mob.pos.x, mob.pos.y, game.seed);
const penalty = tierPenalty(player.quests.level, tier);

// If/when spawner HP is tier-scaled, use tierStats(tier, {hp: mobMaxHp(zone, mob.level), damage: 7, xp: xpForKill(zone, mob.level)});
const { questEvents, xp, drops, pickups } = applyKillRewards(/* unchanged args */);
const { state: rep, events: repEvents } = grantReputation(
  game.reputation, // new field on GameState — the future agent owns that addition
  awardFor(tier, 'kill'),
);
game.reputation = rep;
let totalXp = penalizedXp(xp, penalty);
for (const e of repEvents) out.push({ kind: 'event', payload: e }); // emit as t:'event'
```

The same `penalizedXp(xp, penalty)` treatment belongs in the `onBossKilled`
reward block, and `awardFor(tier, 'quest')` at the quest-completion sink. Tier 1
produces `penalty.xpMult === 1` and `penalty.damageTakenMult === 1`, so all of
these are no-ops in the existing meadow — that is what keeps the documented
`7 damage / 1.5s`, `12 + 3/level`, `TTK 3-5` budget intact. A level-1 meadow
minion keeps its 30 kill XP (`20 + 10 × level`).

### Out of scope for this handoff (do not add a third call site)

Scaling the mob's *spawned* HP/damage with `tierStats` belongs in
`server/src/game/spawner.ts` (not owned here). It can be deferred: the tier
tables are ready and pure, and the two call sites above already deliver the
XP and damage halves of the soft wall without touching the spawner.
