# OPS — runbook

Operating AETHERFALL: run a local cluster, ship it, roll it back, and debug it
when an alert fires. Written against the code in this tree, with every command
copy-pasteable from the repo root on a machine with **no docker daemon**.

- [Environment](#environment)
- [Local cluster](#local-cluster)
- [Deploy](#deploy)
- [Rollback](#rollback)
- [Observability](#observability)
- [Incidents](#incidents)
  - [Tick spike](#incident-tick-spike)
  - [Shard skew](#incident-shard-skew)
  - [Memory growth](#incident-memory-growth)
  - [Anticheat false positives](#incident-anticheat-false-positives)
  - [No players](#incident-no-players)
- [Graceful shutdown](#graceful-shutdown)

---

## Environment

| Var | Default | Meaning |
| --- | ------- | ------- |
| `PORT` | `8081` | authoritative WS port |
| `METRICS_PORT` | `9090` | `GET /metrics`, `GET /healthz`, `GET /walls` |
| `CONTROL_PORT` | *(off)* | `POST /drain` + `GET /healthz` — the Windows-safe SIGTERM (see [Graceful shutdown](#graceful-shutdown)) |
| `SHARD_ID` | `shard-0` | this process's shard id |
| `SHARDS` | *(local only)* | comma-separated WS hosts, e.g. `ws://localhost:8081,ws://localhost:8082` |
| `MAX_PLAYERS_PER_SHARD` | `500` | admission cap; full shards redirect to the least loaded |
| `LOG_JSON` | *(off)* | `1` = structured JSON logs with `tick` + `requestId` |
| `DRAIN_TIMEOUT_MS` | `5000` | hard budget for the whole drain |
| `DATABASE_URL` / `REDIS_URL` | *(unset)* | Postgres mirror / redis pub-sub (see [docs/PERSISTENCE.md](PERSISTENCE.md)) |
| `ADMIN_TOKEN` | dev default | `POST /walls` refuses the dev default in production mode |
| `AETHERFALL_VERSION` | `0.1.0` | label on `aetherfall_info{version=...}` |

Other runbooks: [SHARDING.md](SHARDING.md) (routing/matchmaking),
[SCALE.md](SCALE.md) (bot harness + load points), [BENCHMARKS.md](BENCHMARKS.md),
[PERSISTENCE.md](PERSISTENCE.md), [SECURITY.md](SECURITY.md).

---

## Local cluster

Five shards, one registry. No docker required — five `node` processes.

```bash
npm ci
npm run build --workspaces

# boot shard-0..shard-4 (ws :8081-:8085, metrics :9090-:9094, drain :9190-:9194)
./ops/scripts/start-shards.ps1 -LogJson

# ...or inspect the plan first
./ops/scripts/start-shards.ps1 -DryRun
```

The script polls `GET /healthz` on every shard and refuses to report success
until all of them answer `ok:true`. State lives in `.ops/run/`:

```
.ops/run/shard-0.pid        # pid of shard-0
.ops/run/shard-0.log        # stdout (JSON when -LogJson)
.ops/run/shard-0.err.log    # stderr
```

Verify one shard end to end (health + metrics + join + drain):

```bash
./ops/scripts/smoke-test.ps1 -Port 8081 -MetricsPort 9090 -ControlPort 9190
# -> # smoke-test PASS (14/14 checks)
```

Load test it:

```bash
./ops/scripts/soak.ps1 -Bots 20 -Duration 30 -Label local
# [soak] connected=20/20 ... snapshots=1920 (96/bot)
# [soak] PASS
```

> **Soak gotcha.** `tools/bots` does not follow shard redirects. With a 5-shard
> `SHARDS` registry, sticky routing sends ~4/5 of joins to *other* shards, so a
> run pointed at one shard looks like a perfect 20/20 connect rate with zero
> gameplay. `soak.ps1` fails on that (`only 0 snapshots/bot`) instead of
> reporting a green run. Soak a single-shard server (`-Shards 1`) or point
> `-Server` at the shard you mean to load.

Shut the cluster down (ordered drain per shard, then force-kill only if needed):

```bash
./ops/scripts/stop-shards.ps1            # exit 0 clean, 1 if anything was force-killed
./ops/scripts/stop-shards.ps1 -Force     # skip the drain request
```

### Single shard (what CI runs)

```bash
PORT=8081 METRICS_PORT=9090 CONTROL_PORT=9190 LOG_JSON=1 \
  node server/dist/index.js
```

---

## Deploy

1. **Build and gate locally** — the same checks CI runs:
   ```bash
   npm ci
   npm run build --workspaces
   npm run typecheck --workspaces
   npm run test --workspaces
   python3 ops/scripts/validate-ops.py     # alerts + dashboard vs real metrics
   ```

2. **Smoke the artefact** before it touches players:
   ```bash
   ./ops/scripts/start-shards.ps1 -Shards 1
   ./ops/scripts/smoke-test.ps1 -Port 8081 -MetricsPort 9090 -ControlPort 9190
   ```
   The smoke test kills the server at the end, so restart it (or pass
   `-SkipKill`) before the soak.

3. **Rolling replace, one shard at a time.** Draining a shard is what makes
   this safe: it stops accepting, tells live clients to come back, finishes the
   in-flight tick, flushes the DB, and exits — all inside `DRAIN_TIMEOUT_MS`.
   ```bash
   # POSIX
   kill -TERM "$(cat .ops/run/shard-0.pid)"
   # Windows / anywhere CONTROL_PORT is set
   curl -XPOST http://localhost:9190/drain
   # or both:
   ./ops/scripts/stop-shards.ps1
   ```
   Confirm the drain finished before starting the replacement:
   ```bash
   grep -o '"event":"drain-[a-z]*"' .ops/run/shard-0.log | tail -2
   # {"event":"drain-begin"} ... {"event":"drain-complete"}
   ```
   `drain-complete` carries `"timedOut":false` and the list of steps. A
   `"timedOut":true` means a step wedged — treat it as a bug, not noise.

4. **Watch the first two minutes** of the new shard:
   ```bash
   curl -s localhost:9090/metrics | grep -E '^aetherfall_(players|tick_rate_ratio|errors_total|process_resident_memory_bytes)'
   ```
   Expect `tick_rate_ratio` ≈ 1.0 (≈0.8 is the normal Windows timer baseline),
   `errors_total` flat at 0, RSS climbing then plateauing.

5. **Load-check before declaring done** (single shard):
   ```bash
   ./ops/scripts/soak.ps1 -Bots 20 -Duration 30 -Label post-deploy
   ```

Release artefacts: `npm run build --workspaces` then the `release` CI job, which
tars the compiled workspaces plus `ops/` and `BUILD-INFO.txt` (node/npm/commit)
and publishes on `v*` tags with a `.sha256` next to each tarball.

```bash
sha256sum -c aetherfall-*.tar.gz.sha256
tar -xzf aetherfall-*.tar.gz
```

---

## Rollback

The server holds no durable world state in memory: player rows, snapshots and
the audit log live in the DB, and `/walls` lives in `data/walls.json`. So a
rollback is "run the previous build" — no data migration to undo.

```bash
# 1. keep the evidence before the old process dies
curl -s localhost:9090/metrics > /tmp/metrics-$(date +%s).txt
curl -s localhost:9090/healthz
cp .ops/run/shard-0.log /tmp/shard-0-$(date +%s).log

# 2. drain (not kill) so the DB flush completes
curl -XPOST http://localhost:9190/drain        # POSIX: kill -TERM <pid>

# 3. roll back
git checkout <last-good-sha>
npm ci && npm run build --workspaces
PORT=8081 METRICS_PORT=9090 CONTROL_PORT=9190 LOG_JSON=1 node server/dist/index.js

# 4. verify
./ops/scripts/smoke-test.ps1 -Port 8081 -MetricsPort 9090 -ControlPort 9190 -SkipKill
```

Roll back immediately (no drain) when a deploy is corrupting state — accept that
the last buffered snapshot is lost:

```bash
kill -KILL "$(cat .ops/run/shard-0.pid)"
```

Rolling back `data/walls.json` (arena edits) means restoring the file and
replaying `POST /walls`; the admin surface only accepts writes with
`ADMIN_TOKEN` set.

---

## Observability

### Metric families

`GET :9090/metrics` (Prometheus text; every family carries `HELP` + `TYPE`).
Validated in CI by `ops/scripts/lib/check-metrics.mjs` and by
`server/src/metrics.test.ts`.

| Group | Metrics |
| ----- | ------- |
| Identity | `aetherfall_info{shard,version,protocol,backend}`, `aetherfall_uptime_seconds` |
| Tick | `aetherfall_ticks_total`, `aetherfall_tick_duration_ms_{last,avg,p50,p95,max}`, `aetherfall_tick_duration_histogram_ms{le,_sum,_count}`, `aetherfall_tick_section_ms_{avg,max}{section}` |
| Cadence | `aetherfall_tick_schedule_lag_ms{,_max}`, `aetherfall_tick_rate_hz`, `aetherfall_tick_rate_target_hz`, `aetherfall_tick_rate_ratio`, `aetherfall_tick_drift_ticks` |
| Slow ticks | `aetherfall_tick_ms{_bucket,_sum,_count}`, `aetherfall_slow_ticks_total`, `aetherfall_slow_ticks_ratio`, `aetherfall_recent_slow_tick_ms` |
| Population | `aetherfall_players`, `aetherfall_players_alive`, `aetherfall_player_hp_ratio`, `aetherfall_connections_total`, `aetherfall_shard_load_ratio` |
| Gameplay | `aetherfall_mobs_alive`, `aetherfall_mobs_killed_total`, `aetherfall_mobs_killed_5m`, `aetherfall_mobs_killed_per_min`, `aetherfall_quests_active`, `aetherfall_parties` |
| Wire | `aetherfall_frames_json_total`, `aetherfall_frames_binary_total`, `aetherfall_binary_frame_ratio`, `aetherfall_wire_bytes_total`, `aetherfall_wire_bytes_per_sec`, `aetherfall_wire_bytes_per_player_per_sec`, `aetherfall_snapshot_last_bytes`, `aetherfall_snapshots_sent_total`, `aetherfall_snapshot_encode_us_{last,avg,p95}`, `aetherfall_snapshot_duration_histogram_ms{le,_sum,_count}` |
| Security | `aetherfall_anticheat_rejects_total{kind}`, `aetherfall_anticheat_strikes`, `aetherfall_anticheat_strikes_max` |
| Errors | `aetherfall_errors_total{kind}`, `aetherfall_errors_per_min` |
| Process | `aetherfall_process_{resident_memory,heap_used,heap_total,external_memory}_bytes` |
| Lifecycle | `aetherfall_draining` (1 while draining) |

> `aetherfall_tick_schedule_lag_ms` is a **bounded per-tick overshoot** (a stall
> detector), not an accumulating deadline miss, and
> `aetherfall_tick_rate_ratio` is observed ÷ configured cadence. Both choices are
> deliberate: Windows' ~15.6 ms timer granularity pins a perfectly healthy 20 Hz
> loop at ~16 Hz, which would make an accumulating "lag since boot" grow
> without bound on an idle box. Alert on the ratio.

### Local Prometheus + Grafana

```bash
# no docker needed if prometheus is installed locally:
prometheus --config.file=ops/prometheus.yml

# with docker:
docker run --rm -p 9091:9090 -v "$PWD/ops:/etc/prometheus" \
  prom/prometheus:latest --config.file=/etc/prometheus/prometheus.yml
```

Targets: `localhost:9090..9094` (one per shard — `instance` is what the
shard-skew alert aggregates on). Rules: `ops/alerts.yml`. Dashboard:
`ops/dashboards/grafana.json` (16 panels, uid `aetherfall-server`):

```bash
curl -s -XPOST http://localhost:3000/api/dashboards/db \
  -H 'content-type: application/json' \
  -d "{\"dashboard\":$(cat ops/dashboards/grafana.json),\"overwrite\":true}"
```

### Alerts (`ops/alerts.yml`)

| Alert | Fires when | Severity |
| ----- | ---------- | -------- |
| `AetherfallTickP95High` | tick p95 > 40 ms for 5 m | warning |
| `AetherfallTickDrift` | `tick_rate_ratio` < 0.5 for 5 m | critical |
| `AetherfallNoPlayers` | fleet total 0 players, uptime > 5 m, for 5 m | warning |
| `AetherfallShardSkew` | max/min players per shard > 3 (total > 20), 5 m | warning |
| `AetherfallAnticheatSpike` | rejections > 25/min fleet-wide, 5 m | warning |
| `AetherfallMemoryHigh` | RSS > 1.2 GB for 10 m | warning |
| `AetherfallSnapshotBytesPerPlayerHigh` | > 25 kB/s per player, 5 m | warning |
| `AetherfallErrorRateHigh` | > 5 errors/min per shard, 5 m | critical |

Validate a change to either file before shipping it:

```bash
python3 ops/scripts/validate-ops.py
docker run --rm --entrypoint promtool -v "$PWD/ops:/work:ro" prom/prometheus:v3.0.0 check config /work/prometheus.yml
```

---

## Incidents

### Tick spike

**Symptom:** `AetherfallTickP95High`, or players report stutter. Tick p95 is
above 40 ms of the 50 ms budget.

1. Is it one shard or the fleet?
   ```bash
   curl -s localhost:9090/metrics | grep -E '^aetherfall_tick_duration_ms_(p95|max)'
   ```
   Per-instance lines: only the loaded shard is hot → capacity problem. Every
   shard hot at once → a deploy or a global input storm.

2. Which section? The tick is decomposed into `sim / gameplay / npc /
   snapshot / db`:
   ```bash
   curl -s localhost:9090/metrics | grep -E '^aetherfall_tick_section_ms_avg'
   ```
   * `snapshot` dominant → interest radius too large for the entity count.
     Check `aetherfall_mobs_alive` and `aetherfall_snapshot_encode_us_p95`.
     Lower the interest radius or add a shard.
   * `gameplay` dominant → a gameplay system is doing per-tick work that
     scales with players (`aetherfall_quests_active` is the usual culprit).
   * `sim` dominant → physics/SpatialHash. Confirm with the bots harness:
     `./ops/scripts/soak.ps1 -Bots 20 -Duration 20` and compare tickMs in
     `aetherfall_tick_section_ms_avg`.
   * `db` dominant → the 5-second snapshot save. `aetherfall_errors_total{kind="persist"}`
     non-zero means flushes are failing and snapshots are being lost.

3. Are ticks actually being skipped?
   ```bash
   curl -s localhost:9090/metrics | grep -E 'tick_rate_(hz|ratio)|schedule_lag_ms'
   ```
   `tick_rate_ratio` < 0.5 is `AetherfallTickDrift`: GC pauses or host CPU
   starvation, not game logic. Correlate with
   `aetherfall_process_resident_memory_bytes`.

4. Mitigate, in order of preference:
   * add a shard (players redistribute automatically, see
     [shard skew](#incident-shard-skew) if they do not);
   * cap `MAX_PLAYERS_PER_SHARD` so overflow admission redirects instead of
     overloading;
   * roll back if a deploy caused it — see [Rollback](#rollback).

5. Slow ticks are also logged with a section breakdown, rate-limited to 1/s:
   ```bash
   grep '\[perf\] slow tick' .ops/run/shard-0.log | tail -20
   ```

### Shard skew

**Symptom:** `AetherfallShardSkew` — the busiest shard holds > 3× the players of
the least busy one while the fleet total > 20. Sticky rendezvous hashing should
keep this near 1×.

1. Per-shard load and admission:
   ```bash
   for p in 9090 9091 9092 9093 9094; do
     printf '%s ' "$p"; curl -s localhost:$p/healthz | head -c 200; echo
   done
   ```
   Read `players`, `tickMs`, `shards[]`, `draining`, `controlPort`.

2. Interpret:
   * one shard `draining:true` → it is intentionally empty; the skew resolves
     when the deploy finishes. Do not "fix" it.
   * one shard `tickMs` much higher → it is the slow shard (see
     [tick spike](#incident-tick-spike)); players will still land there because
     routing is sticky by player id, not by load.
   * one shard missing from `shards[]` on the others → registry disagreement:
     `SHARDS` must be **identical** on every process:
     ```bash
     grep SHARDS .ops/run/shard-0.log .ops/run/shard-1.log | head
     ```
   * a shard not answering at all → restart it; the fleet self-heals because
     each shard only routes within its own registry view.

3. Force redistribution by cycling the overloaded shard (sticky routing means
   players re-hash onto their original shard on reconnect):
   ```bash
   curl -XPOST http://localhost:9190/drain
   ./ops/scripts/start-shards.ps1 -Shards 5    # re-registers it
   ```

### Memory growth

**Symptom:** `AetherfallMemoryHigh` — RSS above 1.2 GB for 10 minutes.

1. Classify: heap or arena?
   ```bash
   curl -s localhost:9090/metrics | grep -E 'process_(resident|heap_used|heap_total|external)'
   ```
   * heap_used climbing with heap_total flat → real leak in game state.
   * RSS high, heap_used flat → external/arena (socket buffers, snapshot
     strings); check `aetherfall_players` — RSS scales with players, ~2–3 MB each.
   * sawtooth that returns to baseline → GC working; not a leak. Confirm by
     watching 3 samples over 10 minutes.

2. Correlate with load before blaming the server:
   ```bash
   curl -s localhost:9090/metrics | grep -E '^(aetherfall_players|aetherfall_entities|aetherfall_mobs_alive)'
   curl -s localhost:9090/metrics | grep connections_total
   ```
   `connections_total` far above live players means join/leave churn — each
   disconnect must drop `interest`, `sim`, gameplay, anticheat and anticheat
   session state.

3. Capture a heap snapshot before restarting, or the evidence is gone:
   ```bash
   kill -USR2 "$(cat .ops/run/shard-0.pid)"     # starts the inspector
   ```
   Then load, reproduce, and take the snapshot from the inspector.

4. Mitigate: drain the shard. The drain flushes the DB, so a restart loses
   nothing but the in-memory world:
   ```bash
   curl -XPOST http://localhost:9190/drain
   ```
   Reduce the working set meanwhile with `MAX_PLAYERS_PER_SHARD`, and check
   `aetherfall_snapshot_last_bytes` — a runaway entity count inflates every
   per-viewer frame.

### Anticheat false positives

**Symptom:** `AetherfallAnticheatSpike` — more than 25 rejections/min. Honest
players are being dropped, or the counters look alarming after a deploy.

1. Break the rejections down by kind — they mean different things:
   ```bash
   curl -s localhost:9090/metrics | grep -E '^aetherfall_anticheat'
   ```
   | `kind` | Meaning | Usual cause |
   | ------ | ------- | ------------ |
   | `input-rate` | inputs closer than 15 ms | **lossy backpressure, never a strike.** A deploy or GC pause makes the server dequeue two honest 20 Hz inputs in the same millisecond. Benign — do not "fix" it. |
   | `burst` | > 30 inputs in 250 ms | a real flood, or a client that batches. Adds a strike. |
   | `speed` | requested move outside the clamp | a modified client. |
   | `teleport` | position jumped past the allowed step | modified client, or a legitimate `db.saveSnapshot`/teleport interaction. |
   | `shadowban` | the shadow-ban kick fired | the end state of the three above. |

2. Are real players being punished? Strikes are per-player and decay after
   `strikeDecayMs` without a new one; `aetherfall_anticheat_strikes` is the
   fleet total and `aetherfall_anticheat_strikes_max` is the worst player.
   ```bash
   curl -s localhost:9090/metrics | grep -E 'anticheat_strikes'
   ```
   If `strikes_max` sits at 2, the next burst kicks them. Check the audit log
   for who is being kicked:
   ```bash
   grep '"event":"kick"' data/audit.log | tail -20
   ```

3. Correlate with a deploy. A spike that starts exactly at the deploy boundary
   and is dominated by `input-rate` is the queueing artefact, not an attack —
   wait one tick budget (5 min) and re-check. A `speed`/`teleport` spike is
   probably real: look for one source IP across many names:
   ```bash
   grep '"event":"join"' data/audit.log | tail -200 | python3 -c \
     "import sys,json,collections;c=collections.Counter(json.loads(l).get('name','?') for l in sys.stdin);print(c.most_common(5))"
   ```

4. Verify the anticheat still holds (the soak runs both probes):
   ```bash
   ./ops/scripts/smoke-test.ps1 -Port 8081 -MetricsPort 9090 -SkipKill
   # ok - anticheat: teleport attempt is clamped :: moved=0.00u speed=0.00u/s
   ```

5. Emergency lever: raise the strike threshold for one deploy by lowering
   `MAX_PLAYERS_PER_SHARD` (fewer players → less queueing) and roll back if the
   spike persists. Never disable the checks in production; the probe above is
   the regression gate.

### No players

**Symptom:** `AetherfallNoPlayers` — the fleet is up but has served nobody for
5 minutes. Either genuinely off-peak, or routing is broken.

1. Distinguish idle from broken:
   ```bash
   curl -s localhost:9090/metrics | grep -E '^aetherfall_(uptime_seconds|players|connections_total|ticks_total)'
   ```
   `connections_total` > 0 and rising → players joined and left, this is a real
   spike (or a client bug). `connections_total` == 0 since boot → nobody has
   even tried: routing, firewall, or a wrong published port.

2. Check the process is actually serving:
   ```bash
   curl -s localhost:9090/healthz
   # {"ok":true,"shard":"shard-0","tick":1234,"players":0,"draining":false,"controlPort":9190,"shards":[...]}
   ```
   `tick` must advance between two calls.

3. Check the registry agrees across shards (`SHARDS` identical everywhere) and
   that the WS port is actually open:
   ```bash
   Test-NetConnection -ComputerName localhost -Port 8081
   grep -c '"event":"connection-open"' .ops/run/shard-0.log
   ```

4. If the shard is `draining:true`, a deploy is in progress — wait it out.

---

## Graceful shutdown

`SIGTERM` (POSIX) and `POST /drain` (`CONTROL_PORT`, works everywhere including
Windows) run the same ordered sequence:

1. `stop-accepting` — new connections are refused with WS **1013**; the
   `aetherfall_draining` gauge goes to 1 and `/healthz` reports `draining:true`
   so a load balancer can deregister the target.
2. `notify-clients` — live clients get `{t:'event',kind:'server-draining'}` and
   their sockets are closed with 1013 so they back off instead of erroring.
3. `stop-loop` — the fixed-step interval is cleared.
4. `flush-db` — `db.flushSnapshots()` then `db.close()`. **This is the step that
   makes a restart lossless** for the buffered world snapshot.
5. `close-listeners` / `close-control` — sockets released, process exits.

If any step hangs, the hard deadline fires at `DRAIN_TIMEOUT_MS` (default 5 s)
and the process exits anyway. The outcome is logged either way:

```bash
grep -o '"event":"drain-[a-z]*"' .ops/run/shard-0.log
grep '"event":"drain-complete"' .ops/run/shard-0.log
# {"steps":["stop-accepting","notify-clients","stop-loop","flush-db",
#           "close-listeners","close-control"],"failed":[],"timedOut":false,"durationMs":4}
```

Verify a mid-load shutdown (this is the CI gate, and worth running by hand after
touching the loop):

```bash
./ops/scripts/start-shards.ps1 -Shards 1 -LogJson
./ops/scripts/soak.ps1 -Bots 20 -Duration 25 -Label midkill -NoChaos -NoAnticheat &
sleep 10
curl -XPOST http://localhost:9190/drain        # kill it with 20 players live
grep '"event":"drain-complete"' .ops/run/shard-0.log
```

Expect `durationMs` in the single digits and `"timedOut":false`. The bots will
report `ws-error:` and reconnect attempts after the drain — that is the correct
observable outcome of a controlled shutdown, not a failure.

### Structured logs

`LOG_JSON=1` switches every line to a single JSON object:

```bash
curl -s localhost:9090/metrics > /dev/null
tail -3 .ops/run/shard-0.log
# {"ts":"2026-10-02T20:56:23.433Z","level":"info","msg":"drain-begin","pid":17060,
#  "shard":"shard-0","port":8081,"tick":260,"reason":"control-drain","timeoutMs":5000,
#  "event":"drain-begin"}
```

Fields: `ts`, `level`, `msg`, `pid`, `shard`, `port`, and:

- `tick` — the simulation tick, so every line can be correlated with
  `aetherfall_tick_*` and a spike is attributable to a tick id;
- `requestId` — one id per WS connection, on every line emitted while handling
  its frames (join, kick, wall change, drain). Grep one player's whole session:
  ```bash
  grep '"requestId":"r-murg2o03-3e"' .ops/run/shard-0.log
  ```
- `event` — the structured event name (`join`, `connection-open`,
  `connection-refused`, `wall-change`, `drain-begin`, `drain-complete`, ...).

Without `LOG_JSON` the same information is emitted as `[level] msg key=value`,
so local dev output is unchanged. Errors are serialized as
`{name, message, stack}` rather than `{}`, cycles become `[circular]`, and long
strings are tail-truncated — a log call can never throw into the tick loop.

The audit log (`data/audit.log`, rotated at 1 MB) is separate and
append-only: `join`, `kick`, `wall-change`, `wall-rejected`, `redirect`,
`queue`.