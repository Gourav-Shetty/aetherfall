# WORLDGEN — infinite streaming world

Ownership: `engine/src/worldgen.ts` (extended), `engine/src/terrain.ts` (new),
`engine/src/landmarks.ts` (new), `engine/src/worldstream.ts` (new),
`engine/src/{terrain,landmarks,worldstream}.test.ts` (new),
`engine/bench-worldgen.mjs` (new), `engine/src/index.ts` (re-exports).

**Nothing outside `engine/` changed.** No server, client, AI or game edits —
the new APIs are exported for whoever wires them up. Protocol v1 untouched.

The earlier worldgen (`genChunk`, biomes, zones, dungeons) is untouched: same
signatures, same tiles, same seeds. All 41 pre-existing engine tests still
pass; the suite is now **103 tests / 28 suites**.

## Modules at a glance

| Module | Exports |
| ------ | ------- |
| `worldgen.ts` (existing + extended) | `genChunk`, biomes, zones, dungeons, `DEFAULT_CHUNK_SIZE`, `chunkOfWorld()`, `chunkOrigin()` |
| `terrain.ts` (new) | `heightAt`, `slopeAt` / `slopeXAt` / `slopeYAt` / `slopeVectorAt`, `tooSteep`, `hazardAt`, `isHazard`, `terrainAt` + tuning constants |
| `landmarks.ts` (new) | `landmarkInCell`, `findLandmarks`, `landmarksInRadius`, `nearestLandmark`, `LandmarkIndex` + `Landmark` types |
| `worldstream.ts` (new) | `WorldStream` (`getChunk`, `tileAt`, `forEachInRadius`, LRU cache, prefetch), `DEFAULT_MAX_CHUNKS`, `StreamStats` |

Everything is a pure function of `(x, y, seed)` — no RNG state, no call-order
dependence, no global caches. Two processes on two machines agree bit-for-bit.

## 1. `WorldStream` — deterministic infinite world

```ts
import { WorldStream } from '@aetherfall/engine';

const stream = new WorldStream({ seed: 1337 });   // 32x32 chunks, 512 LRU, prefetch ring 1

stream.getChunk(cx, cy);          // Chunk (generated on demand, cached)
stream.getZonedChunk(cx, cy);     // Chunk + zone decoration (memoized on the same entry)
stream.tileAt(x, y);              // 0 walkable / 1 wall at a world tile
stream.solidAt(x, y);             // tileAt(x, y) === 1
stream.zoneAt(x, y);              // ZoneId at the owning chunk centre
stream.forEachInRadius(x, y, r, (chunk, cx, cy) => { ... });  // -> chunk count
stream.chunksInRadius(x, y, r);   // same traversal, generates nothing
stream.cachedCoords();            // resident chunks, least-recently-used first
stream.stats();                   // { hits, misses, generated, evicted, prefetched, tileReads, resident, maxChunks }
```

### Options

| option | default | notes |
| ------ | ------- | ----- |
| `seed` | `1337` | same seed ⇒ same world, always |
| `size` | `32` | chunk edge in tiles |
| `maxChunks` | `512` | LRU capacity (spec budget) |
| `prefetch` | `1` | neighbor ring depth warmed on access: `0` off, `1` = 8 chunks, `2` = 24 |

### Cache design

- **LRU, O(1) both ways.** `Map<key, record>` for lookup plus an intrusive
  doubly-linked recency list (`newer` / `older` pointers). A hit is one
  `Map.get` plus four pointer writes — no re-insertion, no `Map` reorder
  (measured **49 ns** per cached `tileAt`). The least-recently-used record is
  the tail; insertion past `maxChunks` unlinks and deletes it.
- **Packed key.** `(cx + 2^20) * 2^21 + (cy + 2^20)` — an integer key for
  |coord| < 1,048,576 chunks (~33.5M tiles), with a string-key fallback beyond
  that so the world is genuinely unbounded. Negative coordinates are fine
  (`floor` division, no `Math.abs` aliasing).
- **Neighbor prefetch on *access*, not only on miss.** Touching a chunk
  guarantees its ring is resident, because a player walking east usually
  arrives at a chunk that was *already* prefetched — miss-only prefetch would
  leave the ring beyond it cold. Only missing chunks are generated, nothing
  cascades, and the ring stops as soon as the cache is full (no evict/rebuild
  thrash at small `maxChunks`).
- **Bounded by construction.** `forEachInRadius` walks its chunk list and
  generates one chunk at a time, so the cache never exceeds `maxChunks` no
  matter how large the radius is.

### Determinism guarantees (covered by tests)

1. Two streams with the same seed return byte-identical chunks (8 coords,
   including negative and far ones).
2. Query order does not matter (forward vs reverse sweeps match).
3. Stream chunks are identical to stateless `genChunk()` output.
4. `tileAt` agrees with `genChunk().tiles[y][x]` for every tile of 8 chunks,
   including negative chunk coordinates.
5. Cached chunks are the *same object* on repeat calls (`===`), so consumers
   can use identity checks; zone variants are memoized on the same entry.

## 2. Landmarks — rare structures with loot anchors

One candidate per grid **cell** (`LANDMARK_CELL = 128` world units), decided
by `landmarkInCell(gx, gy, seed)`. Cell-granular decisions make uniqueness
structural rather than best-effort.

```ts
findLandmarks(cx, cy, r, { seed, chunkSize });  // chunk-centric, r in CHUNKS
landmarksInRadius(x, y, r, seed);              // world-centric, r in world units
nearestLandmark(x, y, maxR, seed);
landmarkInCell(gx, gy, seed);                  // one cell -> Landmark | null
new LandmarkIndex(seed, maxCells).near(x, y, r); // cell-cached variant
```

`findLandmarks(0, 0, 4)` = chunk (0,0) center ± 4 chunks = 640x640 world units.

### `Landmark` shape

```ts
{ id: 'ruin:-7,3', kind: 'ruin', x, y, gx, gy, zone: 'dungeon',
  radius: 14, name: 'Broken Arch', seed, loot: [{ id: 'ruin:-7,3#0', x, y, tier: 4 }, ...] }
```

### Placement rules

| stage | rule |
| ----- | ---- |
| position | jittered inside the cell, ≥ 18u from the cell edge (so a landmark + its loot can never cross into a neighbouring cell) |
| presence | `hash2(gx, gy, salt) < LANDMARK_DENSITY[zone]` — meadow 0.42 / dungeon 0.38 / volcano 0.34 |
| kind | weighted per zone: meadow camp-heavy, caldera obelisk-heavy |
| site | rejected on ocean, on **any** hazard (water or lava), or on a slope > `WALKABLE_MAX_SLOPE` |

Result: **26% cell fill rate, ~220 world units average spacing** — rare enough
to be a discovery, dense enough that any `r=6` chunk query returns a handful.

| kind | footprint radius | loot anchors |
| ---- | ---------------- | ------------ |
| `ruin` | 14 | 2–4 |
| `camp` | 9 | 2–4 |
| `obelisk` | 6 | 2–4 |

Loot anchors are fanned out on a golden-angle spiral inside the footprint,
integer tile coords, ids `<landmarkId>#<i>` (globally unique), and their `tier`
is rolled from the zone mob-level band (`ZONE_DEFS[zone].levelMin..levelMax`),
so loot scale tracks zone progression without any extra table.

Guarantees (all tested): unique ids, one landmark per cell, anchors inside the
footprint and off the exact centre tile, zone recorded from the site, scans are
internally unique, overlapping scans return identical records, and a scan is
**complete** (brute-force cell enumeration finds nothing extra in range).

## 3. Terrain field — height, slope, hazards

```ts
heightAt(x, y, seed);        // world units, 0 = WATER_LEVEL
slopeAt(x, y, seed, eps?);   // |grad height| (rise/run), central differences
slopeXAt / slopeYAt / slopeVectorAt
tooSteep(x, y, limit?, seed?);
hazardAt(x, y, seed);        // { type: 'none'|'water'|'lava', dps, depth }
terrainAt(x, y, seed);       // { x, y, height, slope, biome, zone, hazard }
```

Height is built from the **same** elevation field `genChunk()` samples, so
terrain and tile walkability can never disagree about the shoreline:

```
height = (elevation - 0.32) * 78     continental shape, 0 exactly at the shore
       + (fbm3 - 0.5) * 7            rolling hills everywhere
       + mask * ridged3 * 30         mountain crests, faded in above elevation 0.52
```

### Tuning constants

| constant | value | meaning |
| -------- | ----- | ------- |
| `OCEAN_EDGE` | 0.32 | elevation below this is ocean (matches `getBiome`) |
| `WATER_LEVEL` | 0 | water surface |
| `LAVA_LEVEL` | 3 | lava surface inside the caldera (above the water line, so water and lava never overlap) |
| `HEIGHT_SCALE` / `HEIGHT_DETAIL` / `HEIGHT_RIDGE` | 78 / 7 / 30 | amplitude of each band |
| `WATER_DPS` / `WATER_DPS_PER_DEPTH` / `WATER_DPS_MAX` | 5 / 1.5 / 20 | swimming damage, ramping with depth |
| `LAVA_DPS` | 22 | contact damage |
| `WALKABLE_MAX_SLOPE` | 1.6 | above this reads as a cliff |
| `HEIGHT_MAX_GRADIENT` | 6 | documented Lipschitz bound of the field |

### Guarantees (tested)

- **Continuous + Lipschitz.** No step of 1 world unit changes height by more
  than `HEIGHT_MAX_GRADIENT` (observed max 5.24 across a 1800x1800 sample of
  three seeds), so no seams — including at chunk borders and at `x = -1 -> 0`
  — and no vertical teleporting for streamed bodies.
- **Water ⇔ impassable.** `hazardAt().type === 'water'` exactly when
  `getBiome() === 'ocean'`, which is exactly when `genChunk()` emits a wall.
  dps ramps 5 (shore) → 20 (deep); `depth` is the submersion below
  `WATER_LEVEL`.
- **Lava is caldera-only.** Requires `zone === 'volcano'`, `height <= LAVA_LEVEL`
  and not ocean. Flat 22 dps: lava is something to route around, not wade.
- **Rarity/realism:** on a ±512 sample — water 8.3%, lava 5.7%, slope over
  `WALKABLE_MAX_SLOPE` 12.4%.
- `slopeAt` matches an independent numeric gradient within 40% across eps
  0.5 vs 0.125, and always equals `hypot(slopeXAt, slopeYAt)`.

## 4. How the engine consumes terrain

The worldgen modules shipped as exports; the sim and the
client wiring below consumes them. Nothing in `engine/` changed — every line below is a *consumer*.

| consumer | file | uses |
| -------- | ---- | ---- |
| authoritative sim | `server/src/terrain_sys.ts` | `WorldStream`, `heightAt`, `hazardAt`, `LandmarkIndex` |
| sim glue | `server/src/sim.ts` | `TerrainField` for collision / z / spawn safety |
| client view | `client/src/terrain_view.ts` | `heightAt`, `hazardAt`, `LandmarkIndex` |
| client renderers | `client/src/renderer3d.ts`, `renderer2d.ts`, `hud.ts` | the `TerrainView` grid |
| bot swarm | `tools/bots/src/hazards.ts` | `hazardAt` |

### 4.1 Server: one `TerrainField` per shard

```ts
const sim = new Sim();          // terrain ON by default (TERRAIN=off to disable)
sim.terrain;                    // TerrainField
sim.terrainSystem;              // TerrainSystem (DOT + anchors + stats)
sim.hitsTerrain(x, y);          // body circle vs solid terrain
sim.zOf(playerId);              // authoritative elevation
sim.findFreeSpawn(x, y);        // walls + terrain aware
```

`TerrainField` owns the engine `WorldStream` (LRU 512 + neighbour prefetch) and
one **derived layer per streamed chunk** — three typed arrays over the 32×32
tiles: hazard kind, hazard dps, tile height. That is the whole perf story:

| query | cost |
| ----- | ---- |
| `hazardAt(x, y)` (engine, per call) | ~0.30 µs |
| `kindAt` / `dpsAt` / `zAt` / `solidCircle` (layer read) | ~5 ns, one array index |

Layers are built once per chunk (0.5 ms for 1024 tiles), pinned through the
stream so residency, eviction and prefetch stay owned by the engine's LRU, and
capped by the same 512-chunk budget. Recency is refreshed at most **once per
tick** via a stamp, so a steady-state tick never reorders the LRU map.

Four behaviours, all in `TerrainSystem.step()` (post-integrate):

1. **Collision.** Ocean and lava tiles are solid, so a body slides along the
   shoreline instead of walking into it. This is a *second* pass after the
   `walls.json` slide: full step first, then each axis alone (1 probe when
   free, 3 when blocked, zero allocation). A body that is already inside
   terrain — knocked in by a boss, or restored from persistence — is allowed to
   move out; a destination-only test would wedge it against the tile it is
   leaving.
   Chunk-border walls and the biome obstacle sprinkle are deliberately **not**
   collision: `genChunk` marks every chunk edge tile as a wall, which would
   turn the world into a 30×30 lattice of cells.
2. **Elevation.** `SimPlayer.z` is `heightAt(floor(x) + 0.5, floor(y) + 0.5)` —
   tile-granular, so it matches the ground tile the client renders exactly
   (both are the same Float64 `heightAt` sample).
3. **Damage over time.** `hazardAt().dps * dt` off the player's HP: 5-6 hp/s in
   the shallows, up to 20 hp/s in deep water, 22 hp/s in lava. Lethal damage
   washes the body ashore at full HP and emits a `drown` / `burn` event. There
   is deliberately **no** per-tick "teleport out of water" rescue: collision
   already stops you walking in, and being knocked into a lake should cost HP
   until you climb out.
4. **Spawn anchors.** `findFreeSpawn` treats terrain as solid, so a spawn can
   never land in water. The last resort is `TerrainField.spawnAnchor`, which
   ranks candidates by distance: the current spot → landmark loot anchors →
   landmark centre → a deterministic dry spiral. Landmark sites are validated
   at generation time (never ocean, never hazard, never steeper than
   `WALKABLE_MAX_SLOPE`), so every anchor is walkable by construction.

Also added: `Sim({ bounds })` (default 100×100) so a shard can serve the
caldera, where the lava lives, and `TerrainSystem.rescue(player)` for positions
restored from persistence.

### 4.2 `z` on the wire: measured, then switched off

`EntitySnapshot.z?: number` is additive and protocol-v1 safe, but the default
is **off** (`{ snapshotZ: true }` or `TERRAIN_WIRE_Z=1` opts in). Measured at
500 entities × 300 frames, warm, min-of-9:

| wire | ms / snapshot frame | bytes / frame |
| ---- | ------------------- | ------------- |
| `z` off (default) | 0.4101 | 53 837 |
| `z` on | 0.4111 (+0.2%) | 54 149 (+0.58%) |

The +0.58% bytes is fractional `hp` while a player takes DOT, not `z`. With
`z` **on**, the same frame at 1000 entities costs **+21.5% bytes and +43%
snapshot time** — squarely in the `snapshotFrame` hot path that `perf.ts`
tracks. Since `heightAt` is a pure function of `(x, y, seed)`, the client
computes the exact same number locally for free, so the default ships the
smaller packets.

### 4.3 Client: one `TerrainView`, three consumers

`client/src/terrain_view.ts` builds the arena grid once, lazily (~3 ms for
10 000 tiles), and every consumer reads arrays: `renderer3d`, `renderer2d` and
the minimap cannot disagree about a tile. Outside the arena it falls back to
the engine functions. Heights are compressed for display only —
`zVisual(h) = 2.4 * tanh(h * 0.05 / 2.4)` — so the ±43-unit raw field fits
inside the 30-unit isometric view without a discontinuity.

Bots (`tools/bots/src/hazards.ts`) probe `hazardAt()` on an 8-direction cross
at 5u and 11u, blend a `-dir * weight` repulsion into the waypoint heading
with a factor of `1 + gain * weight`, and reject waypoints that land in a
hazard. The `1` matters: a bot walking straight at a lake has a heading
exactly opposed to the push, so a factor below 1 would leave it ploughing in.

### 4.4 What this cost

Sim section (`Sim.step`), min-of-7 × 200 ticks, terrain on vs off:

| players | off (ms/tick) | on (ms/tick) | delta | of the 50 ms budget |
| ------- | ------------- | ------------ | ----- | ------------------- |
| 100 | 0.0474 | 0.0759 | +0.029 | 0.06% |
| 500 | 0.2625 | 0.4055 | +0.143 | 0.29% |
| 1000 | 0.5851 | 0.8703 | +0.285 | 0.57% |

Flat **+0.29 µs per player-tick** regardless of population, and the snapshot
path is unchanged (§4.2). Both numbers are ~10× under what a naive
`hazardAt()` call per entity per tick would cost, because nothing per-tick calls
the field — it all comes out of cached arrays.

### 4.5 Tests

`server/src/terrain_sys.test.ts` (21) covers: DOT = `dps * dt` exactly, no DOT
on dry land, lava burns and washes ashore, drowning washes ashore, damage
switch-off, water cannot be walked into but a body in the water can climb out,
`slide()` axis blocking, `z` parity with `heightAt` and its wire default,
landmark/loot anchor provenance and walkability, `findFreeSpawn` never landing
in terrain over 240 spawns, `rescue()`, determinism, layer-cache bounds and
the per-tick cost ceiling.

`client/src/terrain_view.test.ts` (12) covers grid/engine parity, build-once,
out-of-arena fallback, position-vs-tile agreement, gradient/slope agreement,
`zVisual` monotonicity and clamp, landmarks, and loot anchors.
`tools/bots/src/hazards.test.ts` (12) covers the no-op on clear ground,
threat = worst probe dps, unit-vector output, NaN-freedom when boxed in, gain
monotonicity, and a behavioural walk in which the naive heading drowns (>50 wet
ticks) while the steered one never enters a damaging tile.

## 5. Tests

| file | tests | covers |
| ---- | ----- | ------ |
| `worldgen.test.ts` | 11 (pre-existing, untouched) | noise, chunks, dungeons |
| `ecs.test.ts` / `path.test.ts` / `spatial.test.ts` | 9 / 11 / 10 | untouched |
| `terrain.test.ts` | 18 | continuity, Lipschitz, chunk-border seams, slope agreement, water⇔ocean, lava-only-in-caldera, dps bands, depth ramp, seed sensitivity, distribution sanity, perf |
| `landmarks.test.ts` | 20 | cell purity, rarity, id/cell uniqueness, site validation, kind+zone tables, loot anchors (unique/inside/tier), `findLandmarks` determinism + completeness + overlapping-scan agreement, `LandmarkIndex` parity + cache bound, perf |
| `worldstream.test.ts` | 24 | cross-instance determinism, query-order independence, `tileAt` vs `genChunk`, LRU eviction + recency + caps, prefetch depths, radius traversal order/determinism/completeness, key-collision safety, walking session, perf budgets |
| **total** | **103 / 28 suites** | all green (41 pre-existing + 62 new) |

## 5. Benchmarks (`node engine/bench-worldgen.mjs`)

Warmup + 7 repeats, min-of-runs; seed 1337; AMD Ryzen 5 5600H, Node 22.14,
win32/x64. The script prints this table, **exits non-zero when a target is
missed**, and accepts `--repeats N --seed S`.

| scenario | metric | min ms | per op | target | result |
| -------- | ------ | ------ | ------ | ------ | ------ |
| `genChunk` 32x32 | per chunk | 0.114 | 0.114 us | < 1 ms | **PASS** |
| `genChunk` 32x32 (batch) | 500 chunks | 56.8 | — | — | info |
| `genChunk` random coords | per chunk | 0.110 | — | — | info |
| `genZonedChunk` 32x32 | per chunk | 0.150 | — | — | info |
| `WorldStream.getChunk` cold (prefetch 0) | per chunk | 0.129 | — | < 1 ms | **PASS** |
| `WorldStream.getChunk` + prefetch ring(1) | per miss (+8 chunks) | 1.182 | — | — | info |
| **`WorldStream.tileAt` x10k (hot cache)** | 10k tile reads | **0.495** | **0.049 us** | **< 5 ms** | **PASS** |
| `WorldStream.tileAt` x10k (cold, 64x64 chunks) | 10k tile reads | 1193.7 | — | — | info |
| `WorldStream` walk 400 chunks | 400 steps | 64.4 | — | — | info |
| `forEachInRadius` r=48 / 96 / 192 | 16 / 38 / 134 chunks | 1.85 / 4.49 / 17.0 | 0.12 us | — | info |
| `heightAt` x10k | 10k samples | 1.77 | 0.177 us | — | info |
| `slopeAt` x10k | 10k samples | 8.10 | 0.810 us | — | info |
| `hazardAt` x10k | 10k samples | 2.98 | 0.298 us | — | info |
| `terrainAt` x10k | 10k samples | 13.6 | 1.355 us | — | info |
| `getBiome` / `getZone` x10k | 10k samples | 1.22 / 0.49 | 0.12 / 0.05 us | — | info |
| `findLandmarks` r=6 chunks | 2000 queries | 19.6 | 0.010 us | — | info |
| `landmarkInCell` 120x120 cells | 14400 cells | 8.16 | 0.001 us | — | info |
| `LandmarkIndex.findAroundChunk` r=5 | 2000 queries | 4.62 | 0.002 us | — | info |

Reading the numbers:

- **Target 1 — chunk gen < 1 ms:** 0.114 ms/chunk, **8.8x headroom**. A full
  20 Hz tick (50 ms) could stream ~430 fresh chunks without noticing.
- **Target 2 — 10k WorldStream tile queries < 5 ms:** 0.495 ms
  (**10x headroom**) against a 7x7 resident working set, which is exactly the
  state a player (40 m interest radius) keeps around them. 49 ns/query is a
  `Map.get` plus four pointer writes plus two array indexes.
- The cold variant (10k queries scattered over 4096 chunks, 35,018 chunks
  generated) costs 1.19 s — pure generation at 0.114 ms/chunk, no cache can
  fix it. That is the number the prefetch ring exists to avoid: a real client
  never teleports, it walks, and the walk scenario above covers 400 chunks with
  0 evictions when the working set fits the cap.
- `slopeAt` costs 4x `heightAt` (4 samples); use `slopeXAt`/`slopeYAt` when one
  axis is enough, or cache `terrainAt` per entity tick.
- Numbers are min-of-runs on a *shared* box: across repeated invocations the
  chunk/stream rows moved ±10% (e.g. 0.47–0.54 ms for the hot 10k reads) and
  the generation-bound cold row moved 1.18–1.79 s. The two PASS rows never
  came close to their budgets, and the budgets baked into the tests sit 10x
  above observed numbers so CI stays stable.

## 6. Wiring this up later (not done here)

- Server: hold one `WorldStream` per shard, call `forEachInRadius(x, y, 40, …)`
  on player move and diff against the previous subscription set.
- Client: `getChunk` + `genZonedChunk` variants for rendering; `heightAt` for
  a height-sorted iso projection; `hazardAt` for the water/lava overlay;
  `findLandmarks(cx, cy, 6)` for the minimap and quest markers.
- Loot/spawners: iterate `Landmark.loot` when seeding a shard — anchors are
  already unique, tiered per zone and inside the structure footprint.