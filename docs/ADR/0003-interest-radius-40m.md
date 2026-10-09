# ADR-0003: Interest radius 40m

- Status: accepted
- Date: 2026-10-02
- Context: Snapshot fan-out is the server's dominant cost (50-bot trial:
  ~4.3k msgs/s, chat-dominated; snapshots scale linearly). Broadcasting every
  entity to every client makes bandwidth O(N²) in player density.

## Decision

Per-player interest culling at `INTEREST_RADIUS = 40` (world units, arena is
100×100): each 10Hz snapshot carries only entities within 40m of the viewer
(self always included). `InterestTracker` (`server/src/interest.ts`) keeps a
per-viewer known-set and emits `removed[]` so clients evict out-of-range or
despawned entities. Covered by `interest.test.ts` (cull, removed, despawn).

## Alternatives considered

- **No culling (broadcast all):** fine at 10 players, O(N²) collapse beyond
  ~50 in one arena. Rejected.
- **Chunk subscriptions (e.g. 16m tiles):** finer granularity but pop-in at
  chunk borders and more bookkeeping; radius check is one `hypot` per
  entity-viewer pair via the spatial hash. Rejected for now; chunk streaming
  stays a documented future step.
- **Much smaller radius (10–20m):** saves more bandwidth but entities pop in
  late at 8 u/s movement (20m = 2.5s of travel). 40m ≈ 5s of travel — no
  visible pop-in at current speeds.

## Consequences

- Good: snapshot traffic scales with local density, not total CCU; measured
  lossless at 50 bots (6060 snapshots, 0 errors).
- Good: `removed[]` keeps client entity maps exact — no ghost players.
- Bad: pairwise checks are O(V·E) per broadcast without spatial partitioning
  of viewers; acceptable at current scale (2.5ms avg tick @50 players) and
  the `SpatialHash` in `engine/` is the designated index when it stops being
  so. Revisit if tick p95 exceeds ~25ms (half the 50ms budget).
