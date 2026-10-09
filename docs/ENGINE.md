# ENGINE — ECS, Spatial, Pathfinding, Worldgen

`@aetherfall/engine` owns simulation primitives. It is pure logic: no I/O,
no sockets, no rendering. The server ticks it at 20 Hz; snapshots go out
at 10 Hz (protocol v1, see `docs/PROTOCOL.md`).

## 1. ECS (`engine/src/ecs.ts`)

Archetype-flavored, sparse-set storage.

- **Storage**: one `SparseSet<T>` per component name. Dense `entities[]` +
  `data[]` arrays plus a sparse `EntityId -> dense index` map. `add` /
  `get` are O(1); `remove` is O(1) swap-remove.
- **Entities**: integer ids with a freelist. `despawn` drops every component
  and recycles the id. `alive(id)` guards stale handles. (No generation
  counter in v1 — the server maps engine ids to network ids.)
- **Queries**: `query(...names)` returns ids having ALL components, driven
  from the smallest involved store. `queryWith(include, { exclude, filter })`
  adds NOT-filters and predicates. `view()` returns ids + payloads,
  `forEach()` iterates without allocating an id array.
- **Systems scheduler**: `addSystem(name, fn, { priority, runIf, disabled })`.
  `tick(dt)` runs enabled systems in ascending priority order and records
  per-system runs / lastMs / totalMs (`systemStats()`). `removeSystem`,
  `enableSystem` for hot toggling (e.g. disable AI when a shard is empty).
- **Snapshot**: `serialize()` returns JSON-safe
  `{ version, next, entities: [{ id, comps }] }` (deep-cloned via
  `structuredClone`); `deserialize()` replaces world contents and advances
  the id cursor past restored ids so fresh spawns never collide. Used for
  shard handoff / save-load.

Back-compat: the v0 `World` surface (`spawn`, `despawn`, `get`, `set`,
`query`, `count`) is preserved. `set` stays lenient (no-op on dead
entities); the strict `add` throws on dead entities.

## 2. Spatial hash (`engine/src/spatial.ts`)

Dynamic uniform grid, default cell 8 world units.

- **Incremental**: `insert` / `move` / `remove` are O(1). `move` only
  touches cell buckets when the cell key changes and deletes emptied cells.
  `rebuild(pos)` bulk-loads (kept for the v0 call shape).
- **Queries**: `near(x, y, r, max?)` scans overlapped cells, filters by exact
  Euclidean distance, returns ids sorted by ascending distance. `box(...)`
  is an exact AABB query for region streaming.
- **Interest management (protocol v1, 40 m radius)**: `chunkOf(x, y, size)`
  maps world coords to chunk coords; `subscribedChunks(x, y, r = 40, size)`
  lists chunks covering the interest circle (at origin: 4x4 = 16 chunks for
  size 32); `subscriptionKeys(...)` gives stable `"cx,cy"` sets and
  `SpatialHash.diffSubscriptions(prev, next)` diffs them into
  `{ entered, left }` so the server streams entities in/out as players move.

## 3. Pathfinding (`engine/src/path.ts`)

A\* on `grid[y][x]` tiles (`1` = blocked). Call shape
`astar(grid, sx, sy, tx, ty, opts?)` preserved from the v0 BFS fallback.

- Binary-heap open list, octile heuristic (admissible for 8-dir movement,
  exact `9*sqrt(2)` on the open-diagonal test).
- Diagonals on by default (`{ diagonal: false }` for 4-dir), with
  corner-cut prevention (both orthogonal sides must be free).
- Optional greedy LOS smoothing via Bresenham supercover
  (`{ smooth: false }` to disable); open-ground paths collapse to endpoints.
- `{ diagonalCost }` override, `{ maxExpansions }` budget cap (returns `[]`
  when exceeded), `[]` for unreachable / blocked endpoints / empty grids.
- Exported helpers for tests/tools: `BinaryHeap`, `octile`,
  `hasLineOfSight`, `smoothPath`, `isWalkable`.

## 4. Worldgen (`engine/src/worldgen.ts`)

Deterministic: pure functions of coordinates + seed, no call-order
dependence. Seeded RNG only via `mulberry32` from `@aetherfall/shared`.

- **Noise**: `hash2(ix, iy, seed)` integer lattice hash; `valueNoise`
  (smoothstep interpolation, [0,1]); `fbm(x, y, octaves, seed)`.
- **Biomes**: `getElevation` / `getMoisture` (fBm at different scales +
  offsets) feed `getBiome(x, y, seed)`:
  `ocean < beach < plains / desert / forest < mountain < snow`.
  Ocean counts as wall for movement (`biomeWalkable`).
- **Chunks**: `genChunk(cx, cy, size = 32, seed)` — border walls, interior
  from biome + per-tile hash sprinkle (mountain 22% … plains 6%).
  Same inputs => byte-identical tiles on any machine.
- **Dungeons**: `genDungeon(width, height, seed)` — solid rock, up to
  `area/220` non-overlapping rooms (min 1 guaranteed), carved L-corridors
  in placement order so the dungeon is fully connected by construction.
  Returns `{ width, height, tiles, rooms, seed }`.

## 5. Tests

`engine/src/*.test.ts` (`node:test` + `assert/strict`), compiled to
`dist/**/*.test.js` and run via `npm run test --workspace=@aetherfall/engine`
(`node --test dist/**/*.test.js`). 41 tests / 13 suites covering CRUD,
filters, scheduler, snapshot round-trip, exact-distance spatial queries,
chunk subscriptions, A\* optimality/corner rules/smoothing, noise bounds,
chunk determinism, room non-overlap, and dungeon connectivity (BFS from
room 0 reaches every room center).

## 6. Benchmarks

Measured via the perf tests on a Windows dev box (Node 22, run-to-run
variance ~2x; budgets in tests are 10-100x above observed):

| Bench | Result | Budget |
|---|---|---|
| ECS spawn 10k entities (3 comps each) | ~20–35 ms | < 5000 ms |
| ECS query 10k (3-comp match) | ~7–11 ms | < 1000 ms |
| ECS iterate + mutate 10k | ~7–13 ms | (info) |
| Spatial `near` over 10k entities (317 hits) | ~0.3–0.6 ms | < 500 ms |
| A\* 100x100 with wall + gap | ~5–6 ms, 3 waypoints | < 2000 ms |
| Worldgen 25x 32x32 chunks | ~11–14 ms (~0.5 ms/chunk) | < 2000 ms |

Tick-budget reading: a 20 Hz tick is 50 ms. ECS iterate (10k) + one spatial
radius query + one chunk gen ≈ 15 ms worst-case observed, leaving headroom
for game systems. A\* is per-request (mob pathing), not per-tick; at ~6 ms
for a 10k-cell worst case, budget ~5 concurrent path finds per tick.
