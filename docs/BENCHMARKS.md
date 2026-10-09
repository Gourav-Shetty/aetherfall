# AETHERFALL loadtest benchmarks (bots + replay)

Harness: `tools/bots` (swarm) + `tools/replay` (recorder + viewer stub).
Server under test: authoritative `ws://localhost:8081`, tick 20Hz, snapshot 10Hz
(includes NPC/mob gameplay systems at time of test).

## How to run

```sh
# 50-bot soak (documented baseline) — PowerShell:
$env:SERVER='ws://localhost:8081'; $env:BOTS='50'
node tools/bots/dist/index.js --duration 15

# sh/cmd equivalent:
SERVER=ws://localhost:8081 BOTS=50 node tools/bots/dist/index.js --duration 15

# 500-bot single-process blast (staggered 10 connects/ms, ~50ms spread):
node tools/bots/dist/index.js --bots 500 --server ws://localhost:8081 --duration 30

# Probes only (no swarm):
node tools/bots/dist/index.js --bots 0 --duration 1
# Skip probes: --no-chaos --no-anticheat

# Record snapshots for replay:
node tools/replay/dist/recorder.js --server ws://localhost:8081 --duration 30 --out tools/replay/recordings/run.ndjson
# Then open tools/replay/viewer.html in a browser and load the .ndjson file.
```

Bot behavior: waypoint steering + jitter at 20Hz input, 5% chat, 10% attack.
Per-bot CSV lands at `tools/bots/report.csv`
(columns: bot,name,connect_ms,welcome_ms,snapshots,msgs,inputs_sent,chats_sent,attacks_sent,disconnected,error;
`disconnected=1` at end of run = graceful close, not a failure).

## Results — 20-bot trial (15s, seed 1337, Win32/Node22)

| metric | value |
|---|---|
| connected | 20/20, 0 errors |
| connect ms avg / p50 / p95 | 24.4 / 25.0 / 42.0 |
| snapshots | 2435 total, 162.0/s (8.10/s/bot vs 10Hz nominal) |
| messages | 12920 total, 859.6/s |
| inputs sent | 4880 total, 324.7/s (chats 252, attacks 466) |
| chaos probe (300-input flood) | PASS — acceptedSeq=1/300, rate-limit ACTIVE |
| anticheat probe (move=9999) | PASS — moved 1.87u, speed 4.25u/s, CLAMPED |

## Results — 50-bot trial (15s, seed 1337, Win32/Node22)

| metric | value |
|---|---|
| connected | 50/50, 0 errors |
| connect ms avg / p50 / p95 | 39.3 / 43.0 / 47.0 |
| snapshots | 6075 total, 403.6/s (8.07/s/bot vs 10Hz nominal) |
| messages | 64055 total, 4255.6/s (chat broadcast fan-out dominates) |
| inputs sent | 12200 total, 810.5/s (chats 624, attacks 1242) |
| chaos probe | PASS — acceptedSeq=1/300, rate-limit ACTIVE |
| anticheat probe | PASS — moved 1.87u, speed 4.25u/s, CLAMPED |

## Results — 50-bot re-run + server-side metrics (15s, seed 1337, Win32/Node22)

Same harness as above, with the new `/metrics` endpoint
(`server/src/metrics.ts`, scraped at `http://localhost:9090/metrics`) observed
during the run. Re-run numbers (run-to-run jitter ±3%):

| metric | value |
|---|---|
| connected | 50/50, 0 errors |
| connect ms avg / p50 / p95 | 37.9 / 40.0 / 44.0 |
| snapshots | 6060 total, 401.8/s (8.04/s/bot vs 10Hz nominal) |
| messages | 66048 total, 4378.7/s |
| inputs sent | 12240 total, 811.5/s (chats 628, attacks 1246) |
| chaos probe | PASS — acceptedSeq=1/300, rate-limit ACTIVE |
| anticheat probe | PASS — moved 1.87u, speed 4.25u/s, CLAMPED |

Server-side counters after the run (includes 2 probe bots):

| metric (`/metrics` key) | value |
|---|---|
| tick avg / p95 (`aetherfall_tick_duration_ms_avg/p95`) | 2.52ms / 9.30ms @20Hz with 50 players + NPC/boss AI |
| connections (`aetherfall_connections_total`) | 52 (50 swarm + 2 probes) |
| snapshots sent (`aetherfall_snapshots_sent_total`) | 6136 |
| snapshot bytes (`aetherfall_snapshot_bytes_total`) | 24,078,811 (~3.9KB/snapshot avg — chat fan-out excluded) |
| input-rate rejects (`…_rejects_total{kind="input-rate"}`) | 427 (300-input flood + 20Hz bots racing the 15ms floor) |
| speed rejects (`…{kind="speed"}`) | 620 (diagonal inputs clamp 11.3→8 u/s by design, not disconnects) |
| teleport rejects (`…{kind="teleport"}`) | 0 (velocity clamp contains movement before the step check) |

Takeaway: headroom is large — 2.5ms avg tick vs the 50ms budget at 20Hz,
so the server is network/fan-out bound (chat rebroadcast), not sim-bound.
Scrape with Prometheus via `infra/prometheus.yml`
(`docker compose --profile observability up`).

## Notes

- Observed ~8.1 snapshots/s/bot vs 10Hz nominal and ~16 inputs/s/bot vs 20Hz
  nominal: Windows default timer granularity (15.6ms) dilates 50/100ms
  intervals (50ms -> ~62ms). Expect rates closer to nominal on Linux CI.
- Message fan-out is chat-dominated at scale (every `say` chat rebroadcasts
  to all N bots); snapshot traffic scales linearly and stayed lossless
  (no ws errors, no mid-run disconnects in either trial).
- Chaos probe confirms the server's 15ms input rate-limit: a 300-input
  zero-delay flood applied exactly 1 input (seq=1) and the server kept
  ticking. Anticheat probe confirms velocity-only movement: an illegal
  move=9999 was clamped to the 8 u/s speed budget.
- 500-bot single-process target: stagger keeps the accept burst at 10/ms;
  main risk is client-side timer dilation (see above), not server accept.
  Not yet run — recommended next step on a Linux host.

## Results — 100-bot soak, scale-hardened harness (20s, seed 1337, Win32/Node22)

Harness upgrades (`tools/bots`): sharded launcher (`--workers K` forks
K child processes, each a `--offset` slice; stagger 5/ms; auto-reconnect with
exponential backoff capped at 5 retries), realistic profiles (deterministic
20/60/20: `idle` 1Hz heartbeat / `roam` waypoint steering / `fighter`
steering + 30% attack), per-bot tick-drift tracking (snapshot tick gaps),
process RSS in the summary (`tools/bots/report-soak-100.csv`, columns add
`profile,reconnects,tick_gaps,max_tick_gap`).
Server upgrades: teleport-burst heuristic (15u/50ms), input-burst detector
(20 inputs/200ms, window clears on trip), shadow-ban strikes (3 in 10s ->
`kicked` event + close; input-rate drops never strike), per-section tick
profiler (`aetherfall_tick_section_ms_avg{section}` + histogram buckets).

| metric | value |
|---|---|
| connected | 100/100, 0 errors, 0 reconnects (profiles 20 idle / 60 roam / 20 fighter) |
| connect ms avg / p50 / p95 | 103.5 / 96.0 / 127.0 |
| snapshots | 15679 total, 777.9/s (7.78/s/bot vs 10Hz nominal) |
| messages | 189579 total, 9405.6/s (chat fan-out N² dominates) |
| inputs sent | 26463 total, 1312.9/s (chats 1545, attacks 2364) |
| tick drift (per-bot snapshot gaps) | total 0, max 0 |
| bot RSS | 56.5MB / 100 bots (0.57MB/bot this process) |
| chaos probe | PASS — flood SHADOWBAN-KICK (contained, 3 burst strikes -> kick) |
| anticheat probe | PASS — moved 1.87u, speed 4.25u/s, CLAMPED |

Server-side (`/metrics` cumulative, fresh server):

| metric | value |
|---|---|
| tick avg / p50 / p95 / max | 8.10ms / 5.06ms / 22.42ms / 140.01ms (50ms budget) |
| tick sections avg (top first) | gameplay 4.26ms, snapshot 3.55ms, npc 0.16ms, sim 0.12ms, db 0.00ms |
| connections | 100 |
| snapshots sent / bytes | 15779 / 125,387,370 (~7.9KB/snapshot avg) |
| input-rate rejects | 962 (server queueing artifacts dequeued same-ms; dropped, never strike) |
| burst rejects | 46 (single queueing stalls; window-clear + 10s decay -> 0 kicks) |
| speed / teleport / shadowban | 0 / 0 / 0 — honest bots 0 violations, 0 kicks |

Takeaway: 100 players is comfortable. Tick sections prove the sim/ECS is
NOT the bottleneck (0.12ms); gameplay systems + snapshot broadcast are.

## Results — 300-bot soak, scale-hardened harness (20s, seed 1337, 3x100 shards)

Same build, `--bots 300 --workers 3` (3 child processes, offsets 0/100/200).
This is the documented machine limit for single-node soaks (see `SCALE.md`).

| metric | value |
|---|---|
| connected | 300/300 (3x 100/100), 0 errors, 0 reconnects, 0 kicks |
| connect ms avg / p50 / p95 | shard0 (empty server) 81 / 82 / 91; shard1 643 / 415 / 1469; shard2 1172 / 1226 / 2281 (accept queue under saturation) |
| snapshots | ~21300 total, ~3.5/s/bot (tick overrun slows 10Hz emission; order preserved) |
| messages | ~8.5–10k/s per shard process |
| inputs sent | ~89800 total across shards (chats ~5179, attacks ~8022) |
| tick drift (per-bot snapshot gaps) | total 0, max 0 |
| bot RSS | 64–80MB per 100-bot process (~0.7MB/bot) |
| chaos / anticheat probes | PASS / PASS (same build, `--bots 0` run) |

Server-side (`/metrics` cumulative incl. probes, fresh server):

| metric | value |
|---|---|
| tick avg / p50 / p95 / max | 15.35ms / 0.19ms / 114.29ms / 144.53ms (p95 OVER the 50ms budget) |
| tick sections avg (top first) | gameplay 7.68ms (max 130.76ms), snapshot 7.44ms (max 84.61ms), npc 0.15ms, sim 0.07ms, db 0.00ms |
| connections | 302 (300 swarm + 2 probes) |
| snapshots sent / bytes | 21639 / 514,453,207 (~23.8KB/snapshot avg — superlinear in N) |
| input-rate rejects | 71127 (backpressure drops under tick overrun; 0 strikes by design) |
| burst rejects | 3 (chaos-probe flood trips only; honest 20Hz never reaches 20/200ms) |
| shadowban rejects | 238 (chaos probe: kick at 3rd strike + ~237 in-flight inputs dropped post-ban) |
| speed / teleport | 0 / 0 — honest bots 0 violations, 0 kicks at 300 |

Takeaway: the knee is between 100 and 300 on this host. Top tick systems are
`gameplay` (per-player spawner/quest work) then `snapshot` (N×E interest +
N serializations + chat N²). The ECS `sim` step is 0.07ms — irrelevant.
1000-bot was NOT run here (see `docs/SCALE.md` for extrapolation + tuning).

## Results — serialize-once snapshot hot path (perf work)

Goal: kill the two costs the earlier 100/300-bot soaks flagged in `snapshot` — the per-player O(N×E)
interest scan and, more importantly, `JSON.stringify` re-serializing every
entity once per viewer. The earlier conclusion ("snapshot (N×E interest +
N serializations)") was half right: profiling the section showed the scan was
only ~6% of it and serialization was ~92-98%.

Changes (all on the snapshot path, no gameplay/protocol change):

| change | file | effect |
|---|---|---|
| chunk-bucket interest index, one bucket pass per tick | `server/src/interest.ts` | `O(N×E)` → `O(N + E)` |
| snapshot buffer reuse (per-player `EntitySnapshot` mutated in place) | `server/src/sim.ts` | ~0 allocs/tick for players |
| entities serialized once per tick, fragments spliced per viewer | `server/src/index.ts` | N×`stringify` → 1×`stringify` |
| tick histogram + slow-tick (>50ms) log with section breakdown | `server/src/perf.ts` | diagnosis, on `/metrics` |

### Correctness

- `collect()` membership is identical to `filterInterest()` over 4800 randomized
  viewers incl. the exact-radius boundary (dist == r is visible), negative
  coords, cell-edge placement, and absent-self. Covered by
  `server/src/interest-index.test.ts`.
- `snapshotFrame()` is **byte-identical** to
  `JSON.stringify({t:'snapshot',tick,entities,removed})` over 81 cases (floats,
  1e21, 1e-7, empty sets, key order) — verified so no protocol change ships.
- Ordering guarantee intentionally dropped: entities now arrive in cell-scan
  order rather than ascending-entity order. The client keys entities by id
  (`entities.delete(id)` / map insert) and `removed[]` is order-independent, so
  this is not observable. Re-adding a sort to restore ordering was measured and
  **rejected**: it cost more than the scan it replaced (6.20ms vs 2.69ms/tick at
  300 players).

### Before / after (same host, same tree, perf hunks toggled; server `/metrics`)

100 bots, 20s, `--bots 100 --duration 20`, seed 1337:

| metric | baseline measurement | before (as landed) | after (final) | change |
|---|---|---|---|---|
| tick avg | 8.1ms | 11.06ms | **7.44ms** | −33% vs before |
| tick p95 | 22.4ms | 25.17ms | **15.57ms** | −38% vs before |
| tick max | — | 158.36ms | 143.37ms | −9% |
| `snapshot` section avg | — | 4.65ms | **1.91ms** | **−59%** |
| `gameplay` section avg | — | 5.99ms | 5.15ms | −14% (noise) |
| slow ticks (>50ms) | — | 1 | 1 | — |

300 bots, 25s, `--bots 300 --duration 25`, seed 1337:

| metric | baseline measurement | before (as landed) | after (final) | change |
|---|---|---|---|---|
| tick avg | 15.4ms | 13.27ms | **8.53ms** | −36% vs before |
| tick p95 | 114.3ms | 34.16ms | **17.99ms** | −47% vs before |
| tick max | 144.5ms | 138.96ms | **66.86ms** | −52% |
| `snapshot` section avg | 7.44ms | 6.17ms | **2.25ms** | **−64%** |
| `gameplay` section avg | 7.68ms | 6.66ms | 5.89ms | −11% (noise) |
| slow ticks (>50ms) | — | 5 | 4 | — |

P95 at 300 bots (17.99ms) is well inside the 50ms budget, and the
baseline's 114.3ms p95 no longer reproduces on this host — the knee moved out.

Bot-side, both scales: 100/100 and 300/300 connected, **0 errors, 0 reconnects,
0 tick drift (max gap 0)**, chaos probe PASS, anticheat probe PASS. Per-bot
detail: `tools/bots/report-perf-baseline-100.csv` (as-landed), `tools/bots/report-final100.csv`,
`tools/bots/report-final300.csv`.

> One run from that night was **discarded** and not committed: all 100 bots
> carried a `ws-error`, 500 reconnects (5/bot), and only 36 snapshots each
> vs 120 in the paired run. That is a bot-harness artifact (server process
> not held open for the run), not a server regression.

### Isolated microbenchmark (why the two landed changes were not enough)

300 entities, 300 viewers, interest stage only, per snapshot tick:

| variant | 100 players | 300 players |
|---|---|---|
| `filterInterest` (linear scan, before optimization) | 0.306ms | 2.694ms |
| `InterestIndex` **initial** (scan + per-viewer `hits.sort()`) | 1.007ms | 6.198ms |
| `InterestIndex` **without the sort** | **0.234ms** | **1.069ms** |

So the interest index is a genuine win (2.5x on that stage) — but only once the
per-viewer sort is removed. Serialization stage, same setup:

| variant | 100 players | 300 players |
|---|---|---|
| `JSON.stringify` per viewer (before optimization) | 4.58ms | 40.46ms |
| serialize-once + splice fragments | **0.31ms** | **3.78ms** |

byte-identical output, 10-15x on the stage that actually dominates. This is why
the snapshot hot path was rewritten around serialization rather than the scan.

### New `/metrics` series (`server/src/perf.ts`)

```
aetherfall_tick_ms_bucket{le="1"|"2"|"5"|"10"|"25"|"50"|"100"|"+Inf"}   cumulative tick histogram
aetherfall_tick_ms_sum / aetherfall_tick_ms_count
aetherfall_slow_ticks_total        ticks over the 50ms budget
aetherfall_slow_ticks_ratio        fraction of ticks over budget
aetherfall_slow_tick_ms_avg        mean duration of slow ticks only
aetherfall_tick_ms_max             worst single tick since boot
aetherfall_slow_tick_logs_suppressed   slow ticks counted but not logged (1/s rate limit)
aetherfall_recent_slow_tick_ms{tick,players}                     last 8 slow ticks
aetherfall_recent_slow_tick_section_ms{tick,section="sim|gameplay|npc|snapshot|db"}
```

Every slow tick (>50ms) is counted; the per-section breakdown for that exact tick
is logged at most once per second so a spike is attributable without a profiler:

```
[perf] slow tick 54 total=120.26ms (sim=0.25 gameplay=108.02 npc=0.60 snapshot=11.39 db=0.00) players=73
```

Takeaway: with serialization hoisted, `gameplay` (~5.2ms at 100, ~5.9ms at 300)
is again the top tick system and the only remaining lever for pushing past 300
players on one shard. `sim` stays irrelevant (0.13ms). Snapshot scaling is now
roughly linear in N rather than superlinear.

## Results — 100-bot soak with melee wired (20s, seed 1337, Win32/Node22)

Before this, `input.attack` only reached `npcs.damageFromPlayer`, so no world
(spawner) mob ever died. No kills meant no `mob-die` / `xp-gain` /
`pickup-spawn` events, so the profile below is taken with the new kill path
**running** — bots now actually kill mobs (~2360 attacks over the run), which
adds loot rolls, XP and quest updates the earlier server build never did at all.

Same harness and seed as the serialize-once numbers (`--bots 100 --duration 20`), fresh
server, `/metrics` scraped after the run:

| metric | serialize-once baseline (no mob kills) | melee wired |
|---|---|---|
| tick avg | 7.44ms | **2.98ms** |
| tick p95 | 15.57ms | **14.01ms** |
| tick max | 143.37ms | **104.75ms** |
| `gameplay` section avg | 5.15ms | **1.81ms** |
| `snapshot` section avg | 1.91ms | 0.88ms |
| `sim` section avg | 0.12ms | 0.13ms |
| slow ticks (>50ms) / total ticks | 1 / — | **2 / 954** |
| tick p95 vs 20ms target | pass | **pass (14.01ms)** |

Bot-side: 100/100 connected, **0 errors, 0 reconnects, 0 tick drift (max gap 0)**,
profiles 20 idle / 60 roam / 20 fighter. 15,679 snapshots (780/s), 26,258 inputs
(1,306/s, of which 2,359 attacks), 93,414 messages. Per-bot detail:
`tools/bots/report-melee-100.csv`.

What the melee path costs and why it is near-free:

- **Targeting is grid-bucketed, not a mob scan.** `Spawner.nearestMobWithin`
  touches only the cells the reach circle overlaps (`MOB_CELL_SIZE = 8`, so
  <=9 cells for a melee query), and spawner mobs are static — the index is
  written once at spawn and patched on remove/move, never rebuilt per tick.
  A linear scan over the same population would have been O(mobs) *per attack
  input*, i.e. O(attacks x mobs) per tick; the grid makes it O(cells).
- **Swing cooldown gates the damage path.** `ATTACK_COOLDOWN_MS` (800ms) means
  at most 1.25 damage resolutions per player per second regardless of how many
  input frames arrive, so a client spamming `attack` at 20Hz costs one lookup
  per frame and one resolution per 800ms.
- **Per-kill fan-out was reduced, not increased.** Reward events carrying
  `playerId` (xp-gain, quest-*, levelup, pickup-spawn) are delivered to the
  credited player only; only world-visible events (mob-die, spawn/respawn/
  aggro) broadcast. Before the split, one player's loot and XP state was fanned
  out to all N sockets per kill.

The `gameplay` section also got ~3.3ms cheaper than the serialize-once baseline despite doing strictly
more work per tick, which is consistent with the earlier note that serialization
(not gameplay math) was the dominant term and that the section average is noisy
at this scale. The honest read is: **p95 is unchanged-to-slightly-better
(15.57ms -> 14.01ms) and still well inside both the 20ms target and the 50ms
budget**, so wiring melee did not regress the hot path. `sim` remains
irrelevant (0.13ms).

Kill-event wire verification (single probe client, 22s, walked onto mobs and
swung): `mob-die` 2, `xp-gain` 2, `pickup-spawn` 1, `quest-progress` 4, plus
`mob-spawn` / `mob-aggro` / `mob-respawn` — i.e. the events the client was
inferring from snapshot diffs now arrive from the server directly.

## Results — drift-compensating tick scheduler (100-bot soak, 20s, seed 1337, Win32/Node22)

Replaces `setInterval(fn, 50)` with a `setTimeout` chain off an absolute
deadline (`nextTick = last + 50ms`; `server/src/tick.ts`, wired in
`server/src/index.ts`, skip/catch-up counters in `server/src/metrics.ts`).
Brief lateness (<=2 periods) runs bounded catch-up steps; deeper lag skips and
counts instead of spiralling. Soak: fresh single-shard server
(`SHARDS` unset — a cluster registry redirects bots away, which splits the
load and invalidates the numbers), `--bots 100 --duration 20`, scraped via
`/metrics` (`ticks_total` deltas for Hz, rolling 512-sample gauge for p95):

| metric | before (`setInterval`) | after (drift-compensating scheduler) |
|---|---|---|
| tick Hz idle | ~15-16 (Windows 15.6ms granularity rounds 50ms -> ~62ms) | **20.06** (`ticks_total` over 10s) |
| tick Hz loaded (100 bots, 20s) | 15.96 (100-bot row in the scale ladder below) | **19.57** executed/s over the 20.4s window; trailing gauge 18.6-19.3 (ratio 0.93-0.97) |
| `tick_drift_ticks` | grows without bound | **0.000** after 2 soaks + probes (skip path accounts the schedule clock) |
| tick avg / p50 / p95 / max (loaded, rolling gauge) | 8.44ms avg / 17.0ms p95 (100-bot row below) | **3.9-4.4ms avg / 2.9-8.3ms p50 / 17.0-23.8ms p95** (p95 inside the 50ms budget; 4 slow ticks / ~1900, all connect-burst `gameplay`) |
| skip / catch-up accounting | n/a (spiral) | **skipped 24 / catch-up 9** over 2 soaks, both bounded; worst single overshoot 467ms (connect storm) |

Bot-side (both runs): 100/100 connected, **0 errors, 0 reconnects,
0 redirects, 0 tick drift (max gap 0)**; snapshots **9.60/s/bot** (vs
7.8-8.1 pre-fix — emission now tracks the 10Hz nominal instead of the dilated
timer); chaos + anticheat probes PASS. Per-bot rows: `tools/bots/report.csv`.
Unit cover: `server/src/tick.test.ts` (9 tests: deadline math, bounded
catch-up, skip counting, fake-timer scheduler, live 19-21Hz over 2s).

Takeaway: the server is now a ~20Hz server (was 12-16Hz wearing a 20Hz
label). The remaining ~0.4-1.4Hz gauge shortfall is per-sleep Windows timer
granularity the chain cannot remove — it compensates on average instead, which
is exactly what drift ≈ 0 says.

## Sharded 1000-CCU soak + leak slope — 2026-10-03

Host: HP Pavilion Gaming 15 (Ryzen 5 5600H, **7.36GB RAM visible / ~2.1-2.9GB
free**, 6C/12T, Win11, Node 22.14). Server + bot binaries were built from a
clean `git archive HEAD` sandbox (`fc4ca7f`, `shared+engine+server+bots` tsc
exit 0); the dirty working tree (build red) was deliberately **not** used.

Shard layout actually run: 5 processes, `PORT=8281..8285`, `METRICS_PORT=9290..9294`,
`SHARD_ID=shard-0..4`, **`SHARDS` unset** (each shard admits locally — see
"Multi-shard mode does not admit" below), one cwd per shard so each gets its
own `data/` (own sqlite WAL + `audit.log`; there is no `DB_PATH` env override,
`db.ts:41` resolves `process.cwd()/data`).

### Scale ladder (the knee)

| run | shards x players | CCU | tick avg | tick p95 (gauge) | tick Hz | ticks >50ms | server RSS | bot RSS | verdict |
|---|---|---|---|---|---|---|---|---|---|
| run-100 | 1 x 100 | 100 | 8.44ms | 17.0ms | 15.96 | 0.15% | 107MB | 58MB | comfortable |
| run-150 | 1 x 150 | 150 | 15.92ms | 28.4ms | 15.89 | 0.92% | 107MB | 116MB | ok |
| run-200 | 1 x 200 | 200 | 27.64ms | 64.1ms | 14.22 | 10.5% | 107MB | 128MB | tick budget blown |
| run-400 | 2 x 200 | 400 | 31.7/32.9ms | 71.1ms | 12.8/12.3 | ~19% | 219MB | 265MB | over 50ms budget |
| run-600 | 3 x 200 | 600 | 34.3/36.6/37.7ms | 71.2ms | 11.8/11.5/11.5 | 18-25% | 332MB | 395MB | **knee for p95<=80ms** |
| run-1000 | 5 x 200 | 1000 | 28.25ms | 100.2ms | ~11-13 | n/a (see below) | 460MB | 653MB | over 80ms budget |
| leak300 | 1 x 300 | 300 | 39.1ms | 68.0ms | n/a | n/a | 132MB | 213MB | input-starved |

`tick avg`/`tick Hz`/exceedance are counter-differenced over the load window
(`aetherfall_tick_ms_sum/_count/_bucket`), so the idle boot period is excluded;
`tick p95` is the rolling 512-sample gauge `aetherfall_tick_duration_ms_p95` at
the last sample of the run. Raw: `docs/soak-1000/steady-state.csv`,
`docs/soak-1000/shard-metrics.csv`.

Two things this table says that the earlier single-node soaks could not:

1. **No configuration held the 20Hz tick.** Measured tick rate is 11-16Hz at
   *every* load, including 100 players on an otherwise idle box (15.96Hz with a
   8.44ms average tick). The loop is `setInterval(fn, 1000/TICK_HZ)`
   (`server/src/index.ts:904`) with no drift compensation, so Windows timer
   coalescing + GC pauses push the period out to ~62-90ms. `tick Hz` is now a
   first-class number: a shard is only "20Hz" if `tickHz >= 19`.
2. **Per-shard cost, not whole-box cost, is the ceiling.** 1x200 (3 processes)
   and 5x200 (15 processes) cost the same per shard: 27.64ms vs 27.0-27.6ms
   avg. Adding shards scales CCU linearly; it does not make a shard cheaper.

### 1000 CCU, 5 shards x 200 (60s port-clean rerun)

| metric | value |
|---|---|
| bots connected | **1000 / 1000** (10 processes x 100, unique `--offset` 0..900) |
| bot errors / reconnects / kick errors / tick gaps | 0 / 0 / 0 / 0 |
| connect latency | p50 **178ms**, p95 **1340ms**, max 2096ms |
| per-shard tick avg | 27.0 / 27.2 / 27.4 / 27.6 / 27.3 ms |
| per-shard tick p95 | 97.2 / 100.6 / 101.9 / 98.9 / 103.5 ms |
| per-shard tick max | 234.6 / 412.8 / 257.2 / 461.7 / 259.2 ms |
| top sections (avg) | gameplay 18.2-19.3ms, snapshot 7.5-8.2ms |
| snapshots | 241131 total = **4.02/s/bot** (server nominal 10Hz), 14.4-17.1KB each |
| snapshot egress | ~40MB/s aggregate over loopback (8MB/s per shard) |
| anticheat, honest bots | speed **0**, teleport **0**, shadowban **0**, burst **888**, input-rate drops 516k |
| RSS | servers 460MB WS / 508MB private (5 procs), bots 653MB WS / 719MB private (10 procs, 0.65MB/bot) |
| free RAM floor | 676MB (no OOM, no guard trip) |
| honest probes (separate run, 200-player load) | chaos PASS (`acceptedSeq=1`, abuser SHADOWBAN-KICKed), teleport PASS (clamped, 0.00u) |

Verdict: **1000 CCU connects and plays cleanly but misses the 80ms p95 gate** —
it is a 12-14Hz server wearing a 20Hz label. 600 CCU (3 x 200) is the honest
ceiling on this host for p95 <= 80ms. Per-bot rows:
`tools/bots/report-soak-1000.csv`.

### Memory growth / leak slope (300 concurrent, 1 shard, 300s)

`leak300-samples.csv` (raw `docs/soak-1000/rss-samples-leak300.csv`), sampled 10x/s
over the t=63..283s loaded window (first 60s dropped as JIT/connect churn):

| series | t=63s | t=283s | slope |
|---|---|---|---|
| server RSS (WS) | 126.7MB | 131.7MB | **+1.49MB/min** (+4.9MB total) |
| server RSS (private) | 136.4MB | 141.3MB | +1.48MB/min |
| bot RSS (3 procs) | 209.0MB | 205.1MB | +1.67MB/min (within noise; plateau 213MB) |
| tick avg | 44.1ms | 39.1ms | improving (JIT warm) |
| tick p95 | 91.1ms | 68.0ms | improving |

**No leak signature, but not cleared.** Latency and memory both *improve* over
5 minutes (tick p95 91 -> 68ms), so nothing is accumulating on the hot path:
`metrics.tickSamples` is capped at 512, `perf` histograms are fixed-size, and
`anticheat` frees its per-player maps on disconnect (`anticheat.ts:227-234`).
The residual +1.5MB/min server slope is flat-but-rising allocator/sqlite-page
growth (in-run disk: `aetherfall.db` 5.27MB, WAL 0 after clean close,
`audit.log` 0.16MB) and **5 minutes cannot separate that from GC sawtooth** —
treat as NEEDS-LONGER-RUN: repeat `leak.ps1 -Duration 43200` before claiming
"no leak". If the slope survives 12h it is ~1GB/shard.

Also at 300 players on one shard the rate limiter eats the client stream:
911,574 input-rate drops over 300s (~3,000/s, ~50% of honest 20Hz inputs).
The anticheat stays honest about it (`drop, log, metric`, no strike) — but a
shard at that load is visibly input-starved, which is a capacity statement, not
a cheat.

### Two blockers found (both in the harness, not the engine)

1. **The bot harness caps concurrency at 100 per process.** `runShard()`
   (`tools/bots/src/index.ts:548`) awaits each 100-bot chunk to completion
   before starting the next, so `--bots 150` never exceeds 100 in flight and
   silently takes 2x the wall clock. Measured (`docs/soak-1000/harness-cap-samples.csv`,
   `--bots 150 --duration 12`): players 100,100,100,100,91 -> 50 -> 0, conns
   100 -> 150. Consequences: `--bots 300` in one process was **never** a
   300-concurrency run, and `5 x 200` workers peaked at **500**, not 1000. Every
   concurrency figure above therefore uses >=1 process per 100 bots with
   distinct `--offset`. Fix: make `CHUNK >= bots` (or launch all chunks and
   await `Promise.all` once).
2. **Multi-shard mode does not admit players.** With `SHARDS` set, the sticky
   route is keyed on `nextId` (`server/src/index.ts:193` -> `457-481`), a
   per-process counter that only advances on **admit** (`pid = nextId++` after
   the redirect `return`). A shard that does not own id 1 therefore re-routes
   the same id forever and never admits anyone. Measured with 5 shards booted
   and a client that *does* follow redirects: 12 clients -> 67 redirect hops ->
   **1 admitted** (id 1 on shard-4); a second wave of 12 -> 72 hops -> **0**.
   `ops/scripts/start-shards.ps1:129` sets `SHARDS` for every shard, so the
   ops cluster is in this state today (its smoke test passes because it only
   asserts `/healthz`). With the stock harness the same setup is 100% failure:
   20 bots, 100 reconnects, 0 snapshots
   (`tools/bots/report-redirect-20.csv`). Fix: derive the route key from
   the authenticated identity (or a stable hash of `name`), and advance `nextId`
   before the redirect, not after it.

## Results — v1-vs-v2 100-bot soak (30s, seed 1337, Win32/Node22)

First 100-bot soak of the shipped protocol-v2 binary wire (commit `7784800`),
paired back-to-back with v1 on isolated ports (8481/9490 vs 8482/9491,
`SHARDS` unset, single-shard verified via `/healthz`). Same build (`npm run
build --workspaces` exit 0), same profiles (20 idle / 60 roam / 20 fighter),
same seed — only `--proto` differs. Server counters are `/metrics` pre/post
deltas over the ~33-34s load window; tick avg/p50/p95/max and section numbers
are the rolling gauges at run end.

| metric | v1 (`--proto 1`) | v2 (`--proto 2`) |
|---|---|---|
| connected / errors / reconnects / redirects | 100/100, 0 / 0 / 0 | 100/100, 0 / 0 / 0 |
| connect ms avg / p50 / p95 | 244.2 / 246.0 / 269.0 | 402.8 / 391.0 / 449.0 |
| tick avg / p50 / p95 / max | 18.64 / 16.86 / 42.30 / 71.27ms | 27.55 / 24.59 / 68.58 / 201.81ms |
| tick sections avg (gameplay / snapshot / npc / sim / db) | 11.12 / 6.42 / 0.64 / 0.44 / 0.01ms | 17.78 / 8.29 / 0.85 / 0.59 / 0.01ms |
| tick Hz (counter delta) / gauge / drift | 18.89 / 18.93 / 0.04 (skip 38, catch-up 10) | 16.78 / 19.00 / 0.36 (skip 111, catch-up 64) |
| snapshots sent (server) / received (bots) | 27900 / 27795 (9.20/s/bot) | 24405 / 24300 (7.97/s/bot) |
| snapshot bytes total / B per snapshot | 253,451,568 / 9084 | 8,964,484 / 367 (**-96.0%**) |
| wire frames (json / binary) | 151801 / 0 | 7 / 122790 (7 = the v1 JSON probes) |
| wire bytes total / B per player per s | 262,666,452 / 79,248 | 13,934,365 / 4,110 (**-94.8%**) |
| bot-measured bytesDown total / per bot | 263,613,434 / 2,636,134 | 14,661,927 / 146,619 (**-94.4%**) |
| messages / inputs sent (chats, attacks) | 157780 / 42979 (2460, 3867) | 127730 / 42813 (2449, 3853) |
| anticheat rejects (input-rate / burst / shadowban) | 3769 / 69 / 238 | 9874 / 90 / 238 |
| anticheat honest (speed / teleport) | 0 / 0 | 0 / 0 |
| tick drift (per-bot gaps, max gap) | 0, 0 | 0, 0 |
| slow ticks (>50ms) / ratio | 20 / 3.1% | 74 / 12.7% |
| server RSS (metrics gauge / monitor med-max) | 115MB / 105-115MB | 123MB / 118-124MB |
| bot RSS | 66.5MB | 111.9MB (binary decode buffers) |
| chaos / anticheat probes | PASS / PASS | PASS / PASS |

Per-bot rows: `tools/bots/report-v1-100.csv`,
`tools/bots/report-v2-100.csv`.

Takeaway: the wire win reproduces at 100 players — **~95% fewer bytes**
(96.0% per snapshot payload, 94.8% per player per second server egress,
94.4% bot-measured ingress), matching the 4-bot smoke's 92.9% and the
synthetic 92-93%. Both lanes play cleanly: 100/100 connected, 0 errors,
0 reconnects, 0 tick drift, honest speed/teleport rejects 0, probes PASS
(shadowban 238 in both runs is the chaos-probe flood being contained, same
as the earlier 100-bot soak).

Caveats, read before quoting the tick columns:

- This box was RAM-starved for both runs (free RAM swinging 200-650MB; another
  shard server plus desktop apps resident). The v2 run went second
  under heavier pressure (388MB free at start vs ~490MB), so its slower
  tick/connect is confounded: `gameplay` +6.7ms cannot be the codec (same
  sim work, same seed) — that is box contention. The codec-attributable
  cost is the `snapshot` section (+1.9ms avg at 100 viewers) and
  `snapshot_encode_us_avg` (806us v1 vs 5585us v2).
- Both runs miss the 50ms p95 budget on this host (42.30ms v1, 68.58ms v2
  rolling gauge) — box-limited, not wire-limited. The byte result is the
  headline; the tick delta needs a quiet-box rerun to separate codec cost
  from contention.
- The first v1 attempt died ~1s after the 100 joins (every bot exactly 5
  snapshots, then `ws-error` + 5 refused reconnects) with no server crash in
  the logs — box pressure kill, same signature as a discarded harness
  artifact from an earlier session (server not held open: `ws-error` on every
  row, mass reconnects). A 20-bot canary then a 100-bot diag
  reran clean, and this table's v1 run is the fresh-server rerun. That
  dead attempt's CSV was discarded, not committed.

## Results — egress-profile: snapshot send-stage join (100/300 split + 100-bot before/after)

Context: the 1000-CCU run showed ~40MB/s egress as the ceiling driver, with
serialize-once (`snapshotFrame`/`entityJson`) + `InterestIndex` landed and v2
binary cutting bytes 93% but opt-in. This profiles the v1 snapshot pipeline
per snapshot tick as **collect** (interest `collectIndices` + known-set diff)
vs **encode** (serialize-once pre-pass + per-viewer frame splice) vs **send**
(socket write + accounting), then optimizes the winner once.

Method: new `aetherfall_snapshot_split_ms_avg/max{stage}` series
(`server/src/perf.ts` `observeSnapSplit`, wired in the `index.ts` viewer
loop; ~30 `performance.now()` calls per snapshot tick, negligible). Section
avgs below are lifetime `/metrics` means; the `snapshot` section is observed
every tick (0 on non-snapshot ticks), so its true per-snapshot-tick mean is
2x the shown value. `snapshot_encode_us` was narrowed to true encode
(pre-pass + splice) — it previously spanned the whole viewer loop including
collect and send. Microbenchmarks ran in `%TEMP%` (not committed) against the
built `InterestIndex` and real `ws` loopback sockets. Ports 8381/9390,
`SHARDS` unset, fresh server per run, seed 1337, 20/60/20 profiles.

### Stage split (pre-optimization build)

100 bots, 20s, steady state (100/100, 0 errors, 0 drift, probes PASS):

| stage | ms/snapshot-tick | share | max |
|---|---|---|---|
| collect | 1.526 | 19.0% | 19.307 |
| encode | 0.573 | 7.1% | 20.209 |
| send | **5.941** | **73.9%** | 33.739 |
| other (`fullSnapshot` + `index.build`, residual) | ~0.31 | ~4% | — |

Split sum 8.04 vs 2x snapshot-section avg 8.35 — consistent. Wire 7.56MB/s,
8.20KB/snapshot, `snapshot_encode_us` avg/p95 573/1353us.

300 players, steady window via 3x100 staggered waves (offsets 0/100/200,
`--no-chaos --no-anticheat`; a 300-simultaneous burst was discarded — it
collapsed on the join storm: 574 accepts, gameplay section max 1184ms from
admission fan-out, tick 10.4Hz, never a steady snapshot load). Hot-window
differenced split (t+70..t+82, 226 snapshot ticks, 300 players held):

| stage | ms/snapshot-tick | share |
|---|---|---|
| collect | 3.12 | 22% |
| encode | 0.94 | 7% |
| send | **9.93** | **71%** |

Wire gauge 31.3MB/s, 18.4KB/snapshot (superlinear in N: 8.2 -> 18.4KB from
100 -> 300). Storm-tick snapshots hit 55-73ms at 219-300 players. Microbench
sub-split at 300 (clustered, worst case): known-set diff 5.32 > collectIdx
4.05 > splice 1.94 > pre-pass 0.76ms/tick.

**Dominant stage at both loads: send (socket write), ~71-74% of snapshot
wall-clock.** It scales with bytes x viewers and owns the tail (max
33.7ms at 100, 93.3ms at 300) — this is the tick-budget form of the egress
ceiling (bandwidth itself is unchanged by anything byte-identical).

### The one optimization: pooled-join `snapshotFrame` (`server/src/index.ts`)

The old `+=` loop built a rope of one segment per visible entity that
`ws.send` then flattened (a second O(bytes) pass) before utf8-encoding.
`frameParts` (module scratch, sized once, reused every tick) + a single
`join('')` materializes one flat string: `ws` skips the flatten pass. No
protocol change, binary path untouched.

Rejected first: a build-only microbench showed join 3-11x SLOWER than `+=`
(ropes win construction). End-to-end with real `ws.send` on 10KB frames the
ranking flips: join+send(string) **23.27us vs rope+send(string) 33.61us
(-31%)**, rope+send(Buffer) 27.58us. Ship the end-to-end winner.

Byte-identity (v1 `snapshotFrame` contract): 20000-case differential fuzz
old-vs-new (floats incl. 1e21/1e-7, unicode names, empty/non-empty
`removed`, ticks to 1e9) — 0 mismatches; live raw-frame capture asserted
`raw === JSON.stringify(JSON.parse(raw))` (canonical fixed point, which the
old code satisfies by contract): **30/30 before, 30/30 after**. v2 decode
parity: `encodeView` branch byte-untouched; server suite 588/588 green
incl. `proto2.integration` + `net/binary` (soaks were 100% v1,
`binaryFrames=0`, so no mixed-fleet change).

### Before / after — 100 bots, 20s (fresh server each)

| metric | before | after (join) | change |
|---|---|---|---|
| split send | 5.941ms | **4.598ms** | **-22.6%** |
| split encode | 0.573ms | 1.011ms | +0.44ms (expected: eager copy migrates here) |
| split collect | 1.526ms | 1.206ms | -21% (run variance + ~15x fewer rope allocs -> less GC; not headlined) |
| split net per snapshot tick | 8.04ms | **6.82ms** | **-15.2%** |
| `snapshot` section avg | 4.176ms | **3.563ms** | **-14.7%** |
| `snapshot_encode_us` avg / p95 | 573 / 1353us | 1011 / 3129us | up by construction (now true encode) |
| tick avg / p50 / p95 | 12.55 / 12.23 / 46.58ms | **11.41 / 8.90 / 40.83ms** | -9% / -27% / -12% |
| snapshots delivered | 8.75/s/bot | **8.95/s/bot** | +2.3% |
| bots / errors / drift / probes | 100/100, 0, 0, PASS | 100/100, 0, 0, PASS | unchanged |

Takeaway: one focused change on the dominant stage buys ~15% snapshot-tick
headroom and ~12% tick p95 at 100 players with byte-identical wire output.
It does NOT move the bandwidth ceiling (bytes are identical by design —
40MB/s at 1000-CCU still needs v2/binary or fewer viewers per tick); it
moves the tick-budget ceiling. Next lever on this path is collect (known-set
diff allocation churn, ~56% of collect at 300) — owned by `interest.ts`,
deliberately out of scope for this single-file change.

## Results — 1000-connection v2 run: 1000-CCU soak (5x200, --proto 2, 60s, seed 1337, Win32/Node22)

First 1000-CCU soak on the v2 binary wire (commit `e9a0543`, `PROTO=2`
forced on all shards). Layout: 5 shards `8381-8385` / `9390-9394`
(`SHARD_ID=shard-0..4`, `SHARDS` unset, private cwd per shard), 2 bot
procs x 100 per shard (offsets 0..900, `--proto 2 --duration 60
--no-chaos --no-anticheat`), shard starts staggered 10s. Probes OFF, so
every anticheat reject below is honest load, not probe traffic.
Per-shard `/metrics` sampled at 5s cadence (`docs/soak-v2-1000/samples.csv`);
per-shard numbers are counter-differenced over each shard's loaded
window (first to last sample with players > 0); tick p95 is reported
both ways — the rolling 512-sample gauge at the last loaded sample
(same rolling-gauge methodology as the sharded soak above) and a windowed p95 interpolated from
`aetherfall_tick_ms_bucket` pre/post deltas. Per-bot rows:
`tools/bots/report-v2-1000.csv` (1000 rows).

True-1000 proof: samples show all 5 shards at 200 players in the same
5s tick (ts=53 and ts=63 both total exactly 1000).

| shard | win | Hz | tick avg | p95 gauge / bucket | max | gameplay / snapshot | snap/s/bot | snap KB | wire B/p/s | bin ratio | burst / shadowban | slow ratio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shard-0 | 65s | 15.57 | 47.67ms | 127.1 / 88.5 | 242.9ms | 29.42 / 16.47ms | 7.04 | 0.77 | 7367 | 1.0000 | 48 / 0 | 0.42 |
| shard-1 | 60s | 13.98 | 54.97ms | 130.3 / 92.1 | 367.8ms | 34.35 / 18.62ms | 6.45 | 0.73 | 6511 | 1.0000 | 105 / 0 | 0.53 |
| shard-2 | 60s | 12.90 | 59.90ms | 133.4 / 95.2 | 346.5ms | 38.20 / 19.41ms | 6.14 | 0.73 | 6227 | 1.0000 | 169 / 0 | 0.57 |
| shard-3 | 60s | 13.67 | 57.02ms | 105.8 / 91.9 | 437.8ms | 35.59 / 19.41ms | 6.72 | 0.75 | 6905 | 1.0000 | 172 / 0 | 0.53 |
| shard-4 | 65s | 14.58 | 47.13ms | 85.6 / 85.7 | 401.0ms | 29.54 / 15.90ms | 6.52 | 0.75 | 6725 | 1.0000 | 274 / 84 | 0.40 |

Raw: `docs/soak-v2-1000/shard-metrics.csv` (this table + connect + rejects),
`docs/soak-v2-1000/samples.csv` (5s series).

Bot-side (1000 rows): **1000/1000 connected**, connect avg/p50/p95
691/540/1874ms, snapshots 419069 total, **tick drift 0 (max gap 0)**,
reconnects 23, redirects 0, proto mix v2 1000/1000, binary frames
2733334, bytesDown 440.9MB. Errors: 977 clean, **23
`kicked:shadowban`** — all on shard-4 (the last-launched, lowest-RAM
shard), each reconnected once and finished the run (~427 snapshots).

### v2-1000 vs v1-1000 (1000-connection runs)

| metric | v1 1000-CCU (earlier sharded soak) | v2 1000-CCU | delta |
|---|---|---|---|
| connected / tick drift | 1000/1000, 0 gaps | 1000/1000, 0 gaps | same |
| per-shard tick avg | 27.0-27.6ms | 47.1-59.9ms | ~2x (see confounders) |
| per-shard tick p95 (gauge) | 97-104ms | 86-133ms | overlapping, both over the 80ms gate |
| tick Hz | ~11-13 | 12.9-15.6 | drift-compensating scheduler dividend |
| gameplay / snapshot sections | 18-19 / 7.5-8.2ms | 30-38 / 16-19ms | same ranking, higher under pressure |
| snaps/s/bot | 4.02 | 6.1-7.0 | +60% (20Hz emission tracks nominal) |
| snapshot KB each | 14.4-17.1 | 0.73-0.77 | **-95%** |
| aggregate egress | ~40MB/s | ~6.7MB/s | **-83%** |
| wire B/player/s | ~79,000 (v1) | 6200-7400 | **~-91%** (scales with N: 4.1k at 100 bots -> ~6.8k at 200) |
| anticheat honest speed / teleport | 0 / 0 | 0 / 0 | same, gate holds |
| anticheat burst (honest) | 888, 0 kicks | 768, **23 kicks** (all shard-4) | the earlier burst-window issue escalated to kicks on the most pressured shard |
| anticheat input-rate drops | 516k | 544k | same backpressure symptom |
| server RSS (5 procs WS) | 460MB | ~712MB late-run, 355MB settled | pressure bloat, shared pages; methodology differs, do not ratio |
| bot RSS | 653MB (0.65/bot) | ~1220MB est (1.2/bot, binary decode buffers) | v2 bots cost ~2x RAM — this is what tripped the RAM guard |
| free-RAM floor | 676MB | 303MB | guard (400MB launch gate, 250MB floor) held, no OOM |

Verdict: **v2 at true-1000 connects and plays cleanly (1000/1000, 0
drift, speed/teleport 0) with 95% fewer snapshot bytes and 83% less
egress — but misses the 80ms p95 gate on this host, same as v1 did.**
The ~2x tick-avg gap vs the earlier v1 1000-CCU soak is confounded and must NOT be read as
pure codec cost: free-RAM floor was 303MB (vs 676MB in the v1 soak), and the
v2 bot fleet itself needs ~2x RAM, so the whole box ran hotter. The paired
v1-vs-v2 100-bot soak above
already isolated the attributable codec cost (+1.9ms snapshot section
at 100 players); a quiet-box rerun is still needed to separate codec
from contention at 1000. **Ceiling stays 600 CCU (3x200)** for
p95 <= 80ms; this run adds the RAM rule that actually binds first on
this box: budget ~1.9GB headroom for 1000-v2 (servers ~0.7 + bots
~1.2GB), gate +200 bots on >400MB free, floor 250MB.

Two pressure findings to carry forward:

1. **Honest burst -> shadowban kicks under saturation.** Burst
   rejects rise monotonically with launch order (48/105/169/172/274
   per shard 0..4) and on the most pressured shard 23 bots accumulated
   3 strikes in 10s and were kicked (all recovered via reconnect).
   The earlier v1 1000-CCU soak saw 888 burst rejects but 0 kicks; the mechanism is the same
   one already fixed for the rate rule — a saturated event loop dequeues
   honest 20Hz inputs in >20/200ms clumps. Fix as prescribed in
   `SCALE.md`: exempt clumps coinciding with a slow tick, or require
   the trip to repeat.
2. **A prior 800-v2 replication (same night, discarded run) showed the
   same pattern**: RAM guard stopped the 5th shard at 337MB free,
   800/800 connected clean, 2 honest shadowban kicks on the
   last-launched shard. The kick gradient follows box pressure, not
   chance — it reproduced twice.

Methods traps hit during this run (for the next soak run):

- `"http://127.0.0.1:(9390+$i)/metrics"` does NOT interpolate in
  PowerShell (needs `$()`); it silently scrapes a garbage URL. Assert
  non-empty scrapes before trusting any number.
- The sampler regex `[a-z_]+` never matches `p95`/`p50` keys (digits);
  use `[a-z_0-9]+`.
- `Out-File` writes `\r\n`: split CSV lines on `/\r?\n/`, and the last
  header field carries `\r` (every lookup on it misses).
- `aetherfall_tick_ms_bucket` is cumulative: per-bucket density is the
  consecutive difference, and idle ticks must be subtracted from the
  lowest buckets before interpolating p95.
- `Start-Job` children die when the invoking shell session ends; use
  `Start-Process` (detached) for shards/bots/sampler across calls.
- Bot CSV quotes empty errors as `""` — strip quotes before counting.

### Verification — v2-default 200-CCU single shard (2026-10-05, commit `da7bbe5`)

Fresh `npm run build --workspaces` (exit 0, all workspaces). Single shard
`8381` / `9390` (`SHARD_ID=shard-0`, `SHARDS` unset, private cwd, **no
`PROTO` env — negotiated v2 default**), 2 procs x 100 bots (`--offset`
0/100, `--proto 2 --duration 60 --seed 1337 --no-chaos --no-anticheat`).
Probes OFF, so every reject below is honest load. Server counters are
lifetime on a fresh boot (short idle head/tail included); the loaded
mid-run gauge is called out where it differs.

| metric | value |
|---|---|
| bots connected | **200/200** (100+100), 0 errors, 0 reconnects, 0 redirects |
| connect ms avg / p50 / p95 | 70.8 / 68.0 / 85.0 (proc A); 102.2 / 113.0 / 116.0 (proc B) |
| tick avg / p50 / p95 / max (lifetime) | 15.33 / 0.23 / 18.81 / 59.83ms; loaded mid-run gauge **19.16 / 48.05ms** (inside the 50ms budget) |
| slow ticks (>50ms) | 57 / 1944 (2.9%) |
| tick Hz / drift | ~19 (9.7 snaps/s/bot vs 10Hz nominal); `tick_drift_ticks` -0.04 |
| tick sections avg (gameplay / snapshot / npc / sim / db) | 9.45 / 5.26 / 0.38 / 0.23 / 0.00ms |
| snapshots sent / bytes | 117237 / 90,260,247 (**770B each**) |
| wire frames (json / binary) | 0 / 745983 (**ratio 1.0000 — v2 default negotiates with no server pin**) |
| wire bytes total / per bot | 121,440,156 / ~10.1KB/s/bot at 9.7 snaps/s/bot (higher per-bot than the 1000-CCU run's ~6.8KB only because a quiet shard emits at full 10Hz) |
| anticheat honest (speed / teleport / shadowban) | **0 / 0 / 0** |
| anticheat burst (honest) / input-rate drops | 31, 0 kicks / 10614 (backpressure drops, no strike by design) |
| tick drift (per-bot gaps) | 0, max 0 |
| bot RSS | 108.6 / 104.8MB per 100-bot proc (~1.05-1.09MB/bot v2 vs 0.65 v1) |
| free-RAM floor / settled | 600MB / 1026MB (guard 400MB gate / 250MB floor never tripped) |

50-bot canary on the same default config (pre-run): 50/50, 0 errors,
binary 37474 / json 0 (ratio 1.0), honest speed/teleport/burst/shadowban
all 0, tick avg 2.18 / p95 8.0ms. Per-bot rows:
`tools/bots/report-v2-verify-200-a.csv` /
`report-v2-verify-200-b.csv` (offsets 0/100).

Vs the v1 1x200 single-shard measurement: tick avg 27.64 -> ~19ms loaded, p95
64.1 -> 48.1ms, slow 10.5% -> 2.9%. Directionally v2-200 beats v1-200,
but do NOT read it as pure codec win: the v1 run used
(`setInterval`, 14.2Hz) on a busier box; this run has the drift-compensating
scheduler
(~19Hz emission) and a quieter box. The wire win needs no such caveat:
770B/snapshot vs 14-17KB is the v2 codec.

A full 1000-CCU re-run was deliberately NOT attempted: the box held
~0.8-1.1GB free vs the ~1.9GB measured v2 budget (servers ~0.7 +
bots ~1.2GB), so the RAM guard forbids it. The 1000-connection table
above stands as the 1000 evidence — re-verified for this commit:
CSV parses to exactly 1000 rows / 419069 snapshots / 23 reconnects /
0 gaps / proto v2 1000-1000 / 420.5MB down / 23 `kicked:shadowban`
errors, `samples.csv` shows exactly 1000 concurrent at ts=53 and ts=63,
and the (since torn-down) live shards showed 200 conns each, json 0,
binary ~500k+/shard, burst 48/105/169/172/274 + shadowban 84 matching
`shard-metrics.csv` cell-for-cell.

### Verification — slow-tick burst exemption, 100-bot soak (20s, seed 1337, Win32/Node22)

Fix for the honest-kick mechanism above (`checkInputBurst(..., slowTick)`,
`SLOW_TICK_EXEMPT_MS = 500` in `server/src/index.ts`, wired to the
`perf.ts` >50ms slow-tick signal plus scheduler skip/catch-up): burst trips
inside the catch-up window drop without striking. Fresh single-shard server
on isolated ports (8481/9490, `SHARDS` unset), `--bots 100 --duration 20
--seed 1337` with probes ON (`--proto 1` default), `/metrics` lifetime
counters on the fresh boot (≈ load window + ~3s idle):

| metric | value |
|---|---|
| bots connected | **100/100**, 0 errors, 0 kicked (`report.csv`: 100 rows, 0 errors) |
| connect ms avg / p50 / p95 | 77.6 / 75.0 / 90.0 |
| snapshots | 19199 total, 954.6/s (9.55/s/bot vs 10Hz nominal) |
| inputs sent | 29100 total (chats 1674, attacks 2624) |
| tick drift (per-bot gaps) | total 0, max 0 |
| tick avg / p50 / p95 / max | 9.12 / 8.02 / **19.70** / 204.96ms (p95 inside the 50ms budget) |
| slow ticks (>50ms) | 2 / 460 (0.43% — tick 19: 205ms connect-burst `gameplay`; tick 402: 55ms) |
| tick Hz / drift / skip / catch-up | 19.93 / 0.000 / 14 / 1 |
| input-rate rejects | 1351 (backpressure drops, no strike by design) |
| burst rejects | **14** (= the chaos-probe flood's 300/21 trips exactly → **honest burst trips 0**) |
| speed / teleport / shadowban | **0 / 0 / 0** — honest bots 0 violations, 0 strikes, 0 kicks |
| strikes gauge / max | 0 / 0 |
| chaos probe | **PASS** — sent=300 acceptedSeq=1/300 snaps=25, rate-limit ACTIVE (flood fully dropped, 0 strikes — it fell in a slow-tick window, so containment held without a kick, exactly the designed contract) |
| anticheat probe | **PASS** — moved 0.00u, speed 0.00u/s, CLAMPED |

Unit cover: `server/src/anticheat.test.ts` (+2: slow-tick clump drops with
0 strikes across 11 repeated stalls and never kicks; identical clump on
healthy ticks strikes to kick). Full server suite: **596/596 green**.
The chaos-probe expectation needed no change — it already passes on either
containment mode (drop-limited or kicked).

## Results — pooled v2 bot decode: 100-bot before/after (20s, seed 1337, Win32/Node22)

Target: the v2-1000 run showed bot-side ~1.2MB RSS/bot vs ~0.65MB on v1,
which trips the box RAM guard at 1000 bots. Suspected cause: per-frame
allocations in the v2 decode path (string tables, entity record objects,
baseline `Map` clones, dequantized entity copies — all discarded by bots
that only track the baseline + tick drift).

Method: fresh single-shard server per run on isolated ports (8481/9490,
`SHARDS` unset), `--bots 100 --duration 20 --seed 1337 --proto 2
--no-chaos --no-anticheat`, detached server across calls (`Start-Process`,
per the methods-trap note: `Start-Job` children die with the invoking
shell). Same box, same night. Per-bot rows: `tools/bots/report-perf-pool-before-100.csv`
(before), `tools/bots/report-perf-pooled-100.csv` (pooled, plain),
`tools/bots/report-perf-pool-after-100.csv` (pooled + tuned);
`tools/bots/report-perf-v1-100.csv` is the same-night v1 reference.

| metric | before (HEAD, plain node) | pooled, plain node | pooled + tuned GC | v1 reference (plain node) |
|---|---|---|---|---|
| connected / errors / reconnects / drift | 100/100, 0 / 0 / 0 | 100/100, 0 / 0 / 0 | 100/100, 0 / 0 / 0 | 100/100, 0 / 0 / 0 |
| snapshots | 18888 total, 9.38/s/bot | 19153 total, 9.50/s/bot | 18885 total, 9.38/s/bot | 29488 total, 9.79/s/bot (30s run) |
| bot RSS | 98.2MB (**0.982**/bot) | 96.5MB (**0.965**/bot) | **62.7MB (0.627/bot)** | 64.0MB (0.640/bot) |
| bot heap / ext | — | 39.8 / 3.0MB (peak-sized) | 17.4 / 2.7MB | 14.6 / 4.2MB |
| pooled-lane share | n/a (classic decode) | 108223/116024 single-pass, 7801 chat/ack skipped | 105489/113490 single-pass, 8001 skipped | n/a (JSON) |

Target **met**: 0.982 → **0.627MB/bot** (−36%), at parity v1 levels (0.640),
with delivery unchanged (9.38–9.50 vs 9.38 snaps/s/bot, 0 errors, 0 drift).
Two 30s tuned repros held 0.670/9.74 and 0.672/9.73 with flat RSS traces
(59→67MB, old-space pinned 9–16MB), so the headline is not GC-timing luck.

### What was pooled (`shared/src/protocol2.ts` decode path only, encode untouched)

`P2SnapshotDecoder`, one instance per bot connection, holding frame scratch
overwritten index-aligned every frame (same pattern as the server
`snapshotFrame`/`frameParts` scratch):

- **Decode scratch buffers**: two `P2Reader`s reused via the new additive
  `reset()` (no reader allocs), one `string[]` table reused across frames
  (index 0 stays `''`), one `P2EntityUpdate[]` record pool + one `number[]`
  removed pool handed to the message by reference (length-managed, no
  per-frame array alloc).
- **Entity record objects**: `readPooledRecord` overwrites the pooled slot
  (`p`/`v` sub-objects reused when a record carries them on consecutive
  frames; absent optionals `delete`d so pooled content has exactly the
  classic own-keys). Steady state allocates zero records.
- **String-intern table, capped**: decode strings intern through a
  `P2_MAX_STRINGS` cache (cleared on overflow, same policy as the encoder
  utf-8 memo) — but **only for snapshot tables** (repeating entity names).
  Chat/event tables carry one-shot text; interning those pinned every
  distinct kill payload in every bot (found via a 73→105MB/30s slope with
  flat heap — fixed before measuring).
- **Baseline in place**: `applySnapshotInPlace` mutates the receiver `Map`
  (field writes into the stored `P2Quant`, keyframe sweep via a reused id
  set) and never builds the dequantized entities map the bots discard. Same
  `need-keyframe` acceptance as `applySnapshot`, which is untouched (the
  client render path in `client/src/net2.ts` still uses it).
- **Single-decode dispatch**: `decodeServerFrame` on the decoder runs one
  framing pass for every binary type (the classic path runs `decodeFrame`
  twice per message). Welcome/chat/event/ack bodies mirror the classic
  validators exactly; only snapshot records come from pool scratch.

`tools/bots/src/index.ts` (receive path only): the binary lane routes every
frame through one per-bot decoder (`decodeServerFrame` + `applySnapshotInPlace`);
chat/ack frames — whose content the swarm never reads — are counted and
released without a decode (observably identical to decode-then-ignore).
Send path and `encodeInputBinary` untouched. Additive diagnostics only:
`pooledLane` counters, heap/ext on the memory line, `BOT_MEMLOG=1` gated
5s sampler (rss/heap/ext + v8 space sizes).

Content contract: pooled decode carries exactly the classic values (same
validation, same errors), so re-encoding a pooled message is byte-identical.
Covered by `shared/src/protocol2.pool.test.ts` (11 tests: classic-parity
over keyframe/delta/removal/unknown-id streams, scratch-identity reuse,
in-place baseline identity + content over 120 ticks, keyframe sweep,
need-keyframe parity, intern cap + no-retention of one-shot text,
malformed parity, dispatch parity for all five server frame types, reset)
and `tools/bots/src/decode.test.ts` (routing + frame-for-frame receive
parity incl. `Buffer` input, cleared-name marker, keyframe replacement).

### Why pooling alone only bought −0.02, and what bought the other −0.34

Honest split, same soak: pooling 0.982 → 0.965; runtime tuning
(`NODE_OPTIONS='--max-semi-space-size=2 --max-old-space-size=48'`) →
0.627. Heap-space sampling (`BOT_MEMLOG=1`) showed why: live old-space
settles ~10–12MB, but 7k small binary messages/s keep 10MB of garbage
between scavenges, V8 sizes old-space to a ~30–43MB high-water mark, and
RSS never returns the pages. v1's fewer-but-bigger JSON strings go to the
large-object space and free cheaply; v2's small-message churn promotes
through new-space instead. The flags trade frequent sub-ms scavenges for a
pinned heap (delivery held: 9.38–9.74 snaps/s/bot, 0 drift either way), and
are documented here as the scale-run invocation, not baked into the
default `start` script (a 48MB old-space cap would be the wrong default for
200-bot processes). Remaining coder-side churn is content-necessary
(per-event JSON payload strings) plus the send path (`encodeInputBinary`
writers per input — deliberately untouched: shared encode is out of scope
and `ws` retains send buffers until flush, so writer reuse would need
completion-callback plumbing).

Methods traps hit (one discarded run): a 100-bot attempt showed every bot
`ws-error` + 5 refused reconnects with no server crash in the logs — the
known box-pressure-kill signature (same as the discarded v1 attempt in the
v1-vs-v2 section). Its CSV was discarded, not committed; the rerun on a
fresh server went 100/100 clean. `PID` is read-only in PowerShell — use
another variable name for server pids.
