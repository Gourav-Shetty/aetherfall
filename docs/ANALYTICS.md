# Analytics (replay metrics)

Owner: `tools/replay/src/analyze.ts` (metrics + artifact writers),
`tools/replay/src/container.ts` (`.bin` codec), `tools/capture/dashboard.html`
(in-page panels). Reads recordings only — no `client/src` or `server/src`
changes, no protocol changes, zero runtime dependencies.

Turns a recording into deterministic metrics: player-path heatmap data, movement
speed, time-to-first-kill, deaths and damage per player, mob density over time,
and disconnect points. Output is JSON + CSV, plus optional SVG heatmaps.

## Recording first

The recorder is the source of the data. `--drive` is what makes a recording
analyzable: without it the client connects and stands still, so there is no path,
no combat, and therefore no kills or damage to measure.

```bash
# terminal 1 — server
npm run dev:server

# terminal 2 — 45s driven session, events included
npm run record --workspace=@aetherfall/replay -- \
  --server ws://localhost:8081 --duration 45 \
  --out recordings/session.ndjson --all --drive --seed 1337
# wrote 4754 records (360 snapshots, 2480 events) -> recordings/session.ndjson

# analyze it
npm run analyze --workspace=@aetherfall/replay -- --in recordings/session.ndjson \
  --json ../../docs/analytics/session.metrics.json \
  --csv  ../../docs/analytics/session.timeline.csv \
  --players-csv ../../docs/analytics/session.players.csv \
  --svg-dir ../../docs/analytics \
  --bin recordings/session.bin
```

Recorder flags: `--all` (record chat + `event` records; without it there are no
kill/xp/aggro events), `--drive` (20Hz seeded patrol inputs + melee when a mob is
in reach), `--format bin` (write the container instead of ndjson), `--seed`
(patrol seed — same seed walks the same path). Env fallback: `SERVER`,
`DURATION`, `SEED`.

## analyze CLI

```
node dist/analyze.js --in <recording> [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--in`, `--input` | `recordings/trial.ndjson` | recording to read (positional path also works) |
| `--json` | `<stem>.metrics.json` | full report path |
| `--csv` | `<stem>.timeline.csv` | timeline series CSV |
| `--players-csv` | `<stem>.players.csv` | per-player summary CSV |
| `--svg-dir` | off | write the three SVGs into this directory |
| `--bin` | off | also write the compact `.bin` container |
| `--cell` | `4` | heatmap cell size in world units |
| `--arena x0,y0,x1,y1` | auto-fit | pin the heatmap grid instead of fitting to the data |
| `--bucket-ms` | `1000` | mob-density bucket width |
| `--gap-factor` | `3` | stall threshold as a multiple of the median frame interval |
| `--gap-min-ms` | `500` | floor for the stall threshold |
| `--credit-radius` | `3` | damage-attribution radius (units) |
| `--max-speed` | `24` | drop speed samples above this (3x server `MAX_SPEED`) |
| `--precision` | `4` | decimal places in output numbers |
| `--top-cells` | `12` | heatmap `topCells` entries |
| `--stdout` / `--quiet` | off | print the JSON to stdout / suppress the summary |

Env fallback: `REPLAY_IN`, `REPLAY_QUIET`, `REPLAY_STDOUT`.

Both `.ndjson`/`.jsonl` and `.bin` are accepted; the container is detected by its
`AFRB` magic, not the file extension. Malformed lines are counted in
`malformedLines` and skipped rather than aborting the run.

## Metric definitions

Timestamps are milliseconds from record start; `tMs` values in the report are
relative to the first record.

**Client identity.** The `welcome` record's `id` is the recording client
(`self`). Headline `combat` counters are scoped to that client; `players[]`
carries per-player totals for everyone visible in the recording.

**`movement`** — speed is derived from consecutive position samples:
`distance / dt` in units per second. A sample is dropped when the stream stalled
(inter-frame gap over the threshold) or when the displacement exceeds
`--max-speed` or the jump gate (`max(32, 32 * medianInterval)` units). Those two
cases are respawn teleports and interest-filter re-entries: they are not
movement, and counting them would report hundreds of u/s. `excludedJumps` says
how many were dropped. `avgSpeed` is the mean over samples, `p95Speed` the 95th
percentile, `movingFraction` the share of samples at or above 0.5 u/s.

**`heatmap`** — a `cols x rows` integer grid over the arena, one sample added per
entity per frame. `playerGrid` counts player occupancy, `mobGrid` counts mob and
`npc` occupancy. Bounds auto-fit to the observed positions, snapped outward to
whole cells, so a recording that strays past 100x100 is not silently clipped;
pass `--arena` to pin a fixed grid. `topCells` lists the busiest cells ordered by
player samples, then mob samples, then position.

**`combat.kills` / `deaths`** — kills come from `mob-die` events (`killedBy`) and
from mobs observed reaching 0 HP, because AI-NPC deaths broadcast no event.
`deaths` counts HP reaching 0 plus `respawn` events, deduplicated within a 500ms
window so a single death is not double-counted when the server emits both.

**`combat.damageDealt` / `damageTaken`** — HP deltas between consecutive
snapshots. Protocol v1 carries no attacker id, so mob damage is credited to the
nearest player within `--credit-radius`; damage with nobody in range is reported
as `uncreditedDamage` and warned about rather than being assigned to whoever
happened to be closest on the shard. `damageTaken` sums player HP losses.

**`combat.timeToFirstKillMs`** — time from the first record to the first kill.

**`mobDensity`** — frames are grouped into `--bucket-ms` buckets; `mobs` is the
mean visible mobs per frame in the bucket and `peakMobs` the maximum. `avg`,
`peak`, `min` and `peakAtMs` summarize across buckets.

**`disconnects`** — client-side break points only: `snapshot-gap` when the
inter-frame gap exceeds `max(--gap-min-ms, --gap-factor x medianInterval)`, plus
the client's own `despawn` / `kicked` / `redirect` / `bad-proto` events. A
`despawn` for *any other* player id is normal churn (bots rotating) and is
listed in `playerExits` instead, so a busy shard does not read as a broken
recording.

## Determinism

Same input bytes plus same options produce byte-identical JSON, CSV and SVG:

- records are sorted by timestamp (stable, ties broken by kind then input index)
- JSON object keys are sorted recursively; array order is explicit, never
  incidental
- all numbers are rounded to `--precision`, with `-0` and non-finite values
  normalized
- no wall-clock timestamps, absolute paths, or hash-ordered iteration in output
- SVG coordinates are fixed to 2 decimals; heat colors come from a quantized
  6-step palette, so a value maps to the same color every run
- `.bin` encoding is a fixed little-endian layout with no compression or
  timestamps

Verified by tests: analyzing the same fixture twice, and re-running over a file
with its lines reversed, both produce identical bytes. `tools/capture/dashboard.html`
mirrors these definitions in-page and is cross-checked against the CLI report.

## `.bin` container

`AFRB` magic, little-endian, 16-byte header (`magic`, `u16 version`, `u16 flags`,
`u32 recordCount`, `u32 reserved`), then records: `u32 tMs`, `u8 kind`, and a
kind-specific body. Entities are packed numerically (`u32 id`, `u8 kind`, six
`f64`s for position/velocity/HP, an optional-field bitmask, then only the present
optional fields). Only chat text and free-form event payloads stay UTF-8 JSON.

Encoding is lossless: decoding a container and analyzing it yields the same report
as analyzing the ndjson it came from. About 2.3x smaller than the ndjson for the
session recording (4.5MB -> 2.0MB), since the packed numbers drop most of the
JSON punctuation.

## Dashboard

`tools/capture/dashboard.html` keeps its bot-CSV panels and adds a replay section:
a file picker for `.ndjson`/`.bin`, eight metric cards, a canvas heatmap
(switchable player path / mob density, adjustable cell size), a multi-series
timeline, a disconnect table, and a per-player combat table. It auto-loads
`tools/replay/recordings/trial.ndjson` when served over HTTP; under `file://`
fetch is blocked, so use the picker.

The in-page analyzer duplicates the CLI metric definitions in plain JS so the
page works from `file://` with no build step. When a metric is not mirrored
there, the CLI is the source of truth.

## Committed artifacts

`docs/analytics/` holds the output of the 45s driven session
(`recordings/session.ndjson`, digest `2bb9a5682addaa36`):

| File | Contents |
| --- | --- |
| `session.metrics.json` | full report — the canonical artifact |
| `session.timeline.csv` | one row per frame: mobs, players, HP, speed, cumulative combat |
| `session.players.csv` | one row per player: distance, speed, kills, deaths, damage |
| `session-path-heatmap.svg` | player occupancy heatmap |
| `session-mob-density.svg` | mob density heatmap |
| `session-timeline.svg` | mobs / players / speed / HP over the run |

Regenerate with the command block above. Because output is deterministic, an
unchanged recording reproduces these files byte for byte, so a diff here means
either the recording or the metric code changed.

## Sample metrics

From the committed session (45s, `recorder` id 101, 240 other players present):

```
records=4754 frames=360 events=2480 chats=1914 duration=45.0s
client=recorder (#101) players=241
speed avg=4.9541u/s p95=7.2035u/s max=21.8988u/s dist=11227.1045u
       moving=77.2% samples=18488 skippedJumps=101
combat kills=0 deaths=0 dealt=0 taken=0 ttff=n/a
mobs spawns=0 respawns=0 killed=0 density avg=22.9453 peak=27.125@16s
heatmap cell=4u 26x26 occupied=522/676 max=487 player samples/cell
disconnects=1 first=snapshot-gap@35.4s otherPlayersLeft=200
```

Warnings from that run, all expected: 101 dropped displacement samples, 200
other-player exits, no `mob-die` events, and 108 uncredited damage.

Worth noting about that run: `kills=0` with `deaths=0` is honest, not a bug. The
`--drive` client patrols toward waypoints and swings at whatever is within 2.2u,
and the mobs it reaches were never brought to 0 HP during the window, so there is
nothing to count. The 101 dropped jumps are bots dying and respawning across the
arena plus interest-filter re-entries; left in, they would have pushed `maxSpeed`
from 21.9 u/s to over 250 u/s and dragged `avgSpeed` off the real figure. The
200 other-player exits are bots rotating, which is why `playerExits` is kept
separate from `disconnects`.

## Tests

`node --test dist/**/*.test.js` in `tools/replay` — `analyze.test.ts` (arg
parsing, malformed input, metric math against a hand-computed fixture,
determinism including reversed input order, CSV shape, SVG structure, container
round-trip, stall/teleport exclusion, kill inference, heatmap auto-fit) and
`recorder.test.ts` (arg parsing, record filter, `driveInput` determinism and
reach gating). Fixture: `fixtures/mini.ndjson`, a 14-record synthetic session
covering movement, a mob kill, damage in both directions, a death and respawn, a
snapshot stall, a client despawn, and a chat line.