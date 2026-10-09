# ADR-0005: Gameplay systems as pure functions, integrated by a thin adapter

- Status: accepted
- Date: 2026-10-02
- Context: At the time, the server had four parallel "rule" implementations —
  `game/` (combat, inventory, quests, trading), `ai/` (FSM/BT NPCs, bosses),
  `systems/` (damage types, economy, social, progression) — all mutating shared
  state in place from inside the 20Hz loop. Every one of them needed its own
  test doubles for clocks, randomness and persistence, and none of them could be
  replayed deterministically. The 20Hz tick had also become the hardest thing to
  reason about: "what changed" required reading the whole loop.

## Decision

The rules layer is a set of **pure functions**: state in, a *new* state object
plus a list of events out. `server/src/systems/*` states the contract explicitly
and every module obeys it.

- **No mutation of arguments.** `const next = resolveHit(a, target, hit)`; the
  caller threads `next.state` forward.
- **No clocks.** `now` is always an explicit millisecond parameter —
  `expireAuctions(state, now)` is a sweep, not a timer.
- **No ambient RNG.** `rand: () => number = Math.random` is the last parameter,
  so tests and replays pass `mulberry32(seed)` and get identical rolls.
- **No I/O, no sockets, no timers.** Integration is therefore trivial: the tick
  owns one state object and replays the returned `events` as `t:'event'`
  payloads.

```ts
{ ok: true, state, events, value } | { ok: false, reason }
```

## Alternatives considered

- **Classes with mutable state (`World` entities as the source of truth):**
  conventional, but combat rules then need a live `World`, a clock and an RNG to
  be testable at all. Rejected for the rules layer.
- **Immutable-with-`structuredClone` snapshots per tick:** simple to reason
  about, but a full clone of the entity set at 20Hz is measurable cost for state
  that is not part of the ECS at all. Rejected.
- **Keep mutation + extract the rules into pure helpers opportunistically:**
  lower risk, but leaves the rule of thumb unenforced and the boundary fuzzy.
  Rejected in favour of a hard contract for the new layer (the ECS itself keeps
  mutation, deliberately — see below).

## Consequences

- Good: the systems layer needs **no** doubles — 154 assertions run against
  plain object literals.
- Good: the same function serves the server tick, the tests and (later) a
  replay re-simulation, so a "why did the boss kill me" question has an answer
  that does not involve the socket.
- Good: protocol v1 is untouched. Events ride the existing
  `{t:'event', kind, payload}` shape, so this layer could have been written
  against v1 JSON, v2 binary or a replay file with no change to the rules.
- Bad: rules state is *not* ECS state. That is intentional — ECS state is
  spatial/movement data the snapshot path reads every tick, while systems state
  is slow-changing gameplay data read on events — but it means two worlds of
  truth exist and the adapter must keep them consistent. Mitigated by making the
  adapter explicit (`tickGameplay` owns the threading) instead of implicit.
- Bad: `events` is an untyped-ish list. Mitigated by a closed event kind union
  per module and the `{ok:false, reason}` shape so a failure never half-applies.