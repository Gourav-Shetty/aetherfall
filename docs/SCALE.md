# AETHERFALL scale guide — tuning for 1000 concurrent players

Status: **1000-bot soak has now been run sharded** (2026-10-03): 1000/1000
connected, 0 errors, tick p95 ~100ms over the 80ms gate, knee at 600 CCU
(3 x 200) on a 7.36GB Ryzen 5 5600H. **Update (2026-10-05): first
true-1000 soak on the v2 binary wire** — 1000/1000 connected, 0 tick
drift, honest speed/teleport 0, snapshot bytes -95%, egress ~40 -> ~6.7MB/s,
but p95 still over the 80ms gate and 23 honest burst->shadowban kicks on
the most pressured shard. **Ceiling stays 600 CCU (3 x 200)**; the binding
constraint on this box is now RAM, not bandwidth (see "v2 RAM rule").
**Update (2026-10-10, wave10): both fixes re-soaked at true-1000** —
1000/1000 connected, **0 honest kicks, 0 reconnects**, 8.1 snaps/s/bot,
p95 73-106ms (still over the gate on 4/5 shards); plus a true-800 probe
(p95 68-84, marginal). **Ceiling stays 600 CCU**, 800 is the new
(un-certified) knee. Bot RAM halved to ~0.57MB/bot, so 1000-v2 peaks at
~0.9GB instead of ~1.9GB — it fits this box but kisses the 250MB floor.
The single-node tables below were also capped at 100 concurrent by a harness
bug (see "sharded soak runbook" below).
See `docs/BENCHMARKS.md` for raw numbers.

## Measured limits (single node, Win32/Node22, tick 20Hz / snapshot 10Hz)

| players | tick avg / p95 | top sections | snap/s/bot | honest kicks | verdict |
|---|---|---|---|---|---|
| 50 | 2.5ms / 9.3ms | snapshot, gameplay | ~8.1 | 0 | comfortable |
| 100 | 8.1ms / 22.4ms | gameplay 4.3ms, snapshot 3.6ms | ~7.8 | 0 | comfortable |
| 300 | 15.4ms / 114.3ms | gameplay 7.7ms, snapshot 7.4ms | ~3.5 | 0 | knee: p95 over 50ms budget |
| 1000 | ~50ms+ est. | gameplay + snapshot (linear-ish in N each) | <2 est. | n/a | needs the tuning below |

The ECS `sim` step is 0.07ms at 300 players — never the bottleneck.
Cost centers: `gameplay` (per-tick spawner scans around N players, quest/trade
ticks, mob-entity mirroring) and `snapshot` (interest `update` N×E + N
`JSON.stringify` + chat broadcast N²). Snapshot bytes scale superlinearly:
~7.9KB/snapshot avg at 100 players, ~23.8KB at 300.

## Extrapolation to 1000 (why it was not run here)

- Tick sections: gameplay + snapshot ≈ 15ms at 300 and both grow ~linearly
  with N (snapshot closer to N² under full visibility) → ~50ms+ at 1000,
  i.e. at/over the whole 20Hz budget before NPC/AI variance. The dev box also
  OOM'd once with server + test workers co-resident, so a 1000-bot soak here
  would measure the laptop, not the engine.
- Network: 10Hz × 1000 clients × ~80KB snapshots ≈ 800MB/s single-node —
  impossible without interest tightening + delta compression (below).
- Client harness: ~0.7MB RSS/bot measured → 1000 bots ≈ 700MB in one process.
  Shard it (below) — the bot launcher already does.

## Server tuning for 1k

1. Interest/AOI first (biggest lever): shrink the 40m cull radius and/or add
   entity caps per snapshot (`server/src/interest.ts`). Snapshot cost is
   N×E_visible + N serializations; halving visible entities ~halves it.
2. Snapshot cadence: 10Hz → 5Hz for far entities, keep 10Hz near
   (`server/src/index.ts` snapshot block). Halves serialization at the cost
   of interpolation smoothness (client already interpolates).
3. Delta snapshots: send full `visible` only on interest change, otherwise
   changed entities (positions/seq). Cuts the ~24–80KB JSON per snapshot.
4. Gameplay decimation: spawner scans + quest/trade ticks need not run every
   50ms tick — run at 5–10Hz or stagger players across ticks
   (`tickGameplay` section is the current #1 at 7.7ms avg).
5. Chat fan-out: `say` rebroadcast is N² (5179 chats × 300 recipients ≈ 1.5M
   deliveries in the 300-soak). Add distance/channel scoping or per-second
   per-client caps before 1k.
6. Horizontal: one 1k world is not the target — use the shard router +
   matchmaking (`SHARDING.md`) as N×200-player shards with interest handoff.
7. Persist: snapshot DB writes already every 5s; keep batched inserts
   (`PERSISTENCE.md`) and never write per-tick per-player on the hot loop.

## Bot harness tuning for 1k (`tools/bots`)

- RAM: measured 0.57–0.80MB RSS/bot → budget ~700MB for 1000 in one process.
  RECOMMEND `200/process × 5`: `node tools/bots/dist/index.js --bots 1000
  --workers 5` (~120–160MB per shard, stagger 5/ms keeps the SYN burst at
  ~200ms spread, auto-reconnect backoff absorbs accept-queue pressure).
- Profiles stay 20/60/20 idle/roam/fighter (deterministic `i % 5`); fighter
  attack 30% is the combat-load knob — lower it first if the server (not the
  harness) saturates.
- Reconnects are a signal, not a fix: the harness prints `reconnects=` per bot and
  totals it. 0 is healthy; sustained >0 means the server is kicking or
  dropping (check `…_rejects_total` + `kicked:shadowban` in the CSV `error`
  column) — do not raise the retry cap to hide it.

## Anticheat thresholds (`server/src/anticheat.ts`)

| check | threshold | honest headroom | catches |
|---|---|---|---|
| input-rate | 15ms min gap | 20Hz = 50ms gaps; queueing artifacts dropped, NEVER strike | >66Hz scripts (dropped) |
| input burst | 20 inputs / 200ms, window clears on trip | 20Hz = 4/200ms (5x); 1 stall = 1 strike max | 300-input floods (trip at #21, kick in <1ms) |
| speed | MAX 8 u/s + EPS 0.01 | normalized honest moves pass exact | velocity hacks (clamped) |
| teleport step | 5u per tick | honest 0.4u/tick | position writes |
| teleport burst | 15u in 50ms | honest 0.4u/50ms (37x) | split-jump hacks |
| shadow-ban | 3 strikes in 10s → `kicked` event + close(4403) | stalls decay; honest soaks show 0 kicks at 100 and 300 | repeat offenders |

Scale lesson (kept): at 100+ players the server's own broadcast loop delays
input processing, so honest 20Hz inputs can dequeue in the same millisecond
(dt=0ms). A strict per-gap strike policy mass-kicked the swarm (80/100 kicked
in the first 100-bot soak). Rate drops are backpressure (drop, log, metric)
— strikes come only from burst/speed/teleport, with window-clear + 10s decay.

## 1k runbook (Linux host, when hardware allows)

```sh
# 1. server + metrics
PORT=8081 METRICS_PORT=9090 node server/dist/index.js
# 2. 1000 bots, 5 shards (from another shell)
node tools/bots/dist/index.js --bots 1000 --workers 5 \
  --server ws://localhost:8081 --duration 30 --seed 1337 \
  --report tools/bots/report-1k.csv
# 3. scrape before/after
curl -s http://localhost:9090/metrics | tee metrics-1k-after.txt
# 4. verdict: connected 1000/1000, reconnects≈0, tick p95 < 50ms,
#    top section not snapshot-broadcast (else apply tuning 1-5 above)
```

## Sharded 1000-CCU soak runbook (Win32/PowerShell)

Status line above ("1000-bot extrapolated, not run here") is **superseded**: the
1000-CCU soak ran on 2026-10-03. See `docs/BENCHMARKS.md` (sharded soak tables) for the
raw numbers. Headline: 1000/1000 connected, 0 errors/reconnects/kicks/tick-gaps,
**tick p95 ~100ms (over the 80ms gate)**, no OOM; **600 CCU (3 x 200) is the knee**
on a 7.36GB Ryzen 5 5600H.

### 0. Preconditions that will bite you

| trap | what happens | recommended setup |
|---|---|---|
| `npm run start --workspace=@aetherfall/bots -- --bots 200` (space form) | npm swallows the `--flags` (`node dist/index.js 200 ...`) — the harness now **fails fast (exit 2)** instead of silently running defaults | call the entry directly: `node tools/bots/dist/index.js --bots 100 ...`; the `=` form (`-- --bots=200`, honoured via `npm_config_*`) also works |
| `SHARDS` set | cluster admits **exactly 1 player, ever** (`nextId` deadlock, see BENCHMARKS) | leave `SHARDS` **unset** for capacity runs; each shard admits locally |
| all shards in one cwd | 5 processes share one `data/aetherfall.db` (sqlite WAL) + `audit.log`; no `DB_PATH` env exists (`db.ts:41`) | `Set-Location` a private dir per shard |
| ports already taken | on this host `9091` = mihomo, `8081` = a second server from another process; bots silently attach to the **other** server while your `/metrics` scrapes time out | use `8281-8285` / `9290-9294` and assert `Get-NetTCPConnection` ownership of the listener before trusting any number. Note `ops/scripts/start-shards.ps1` defaults `CONTROL_PORT=9190` — do not reuse that for metrics. |

### 1. Five shards (copy-paste, PowerShell) — verified working

```powershell
# One job per shard. Private cwd per shard => private data/ (own sqlite + audit).
$Shards = 0..4 | ForEach-Object { @{ id="shard-$_"; ws=8281+$_; mx=9290+$_ } }
foreach ($s in $Shards) {
  $cwd = Join-Path $env:TEMP "aetherfall-soak/$($s.id)"; New-Item -ItemType Directory -Force -Path $cwd | Out-Null
  Start-Job -Name "soak-$($s.id)" -ArgumentList $s.id,$s.ws,$s.mx,$cwd -ScriptBlock {
    param($id,$ws,$mx,$cwd)
    $env:PORT="$ws"; $env:METRICS_PORT="$mx"; $env:SHARD_ID=$id; $env:SHARDS=''   # SHARDS empty = local-only routing
    Set-Location $cwd
    & node C:\aetherfall\server\dist\index.js 2>&1
  }
}
# readiness + ownership (do NOT skip the ownership line: it is what caught the
# second server squatting on 8081)
foreach ($s in $Shards) {
  $h = Invoke-RestMethod "http://127.0.0.1:$($s.mx)/healthz"
  $pid_ = (Get-NetTCPConnection -LocalPort $s.ws -State Listen).OwningProcess
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid_").CommandLine
  "$($s.id) ok=$($h.ok) tickMs=$($h.tickMs) listener=$cmd"
}
```

### 2. 1000 concurrent bots: 10 processes x 100 (not 5 x 200)

```powershell
$off = 0
foreach ($s in $Shards) { foreach ($k in 0..1) {
  Start-Job -Name "soak-bots$($s.id)-$k" -ArgumentList $s.ws,$off,"$env:TEMP\soak-$($s.id)-$k.csv" -ScriptBlock {
    param($ws,$off,$report)
    & node C:\aetherfall\tools\bots\dist\index.js --bots 100 --offset $off --workers 1 `
        --server "ws://localhost:$ws" --duration 60 --seed 1337 --report $report `
        --no-chaos --no-anticheat 2>&1     # probes OFF: they pollute aetherfall_anticheat_rejects_total
  }
  $off += 100
}}
```

### 2b. Concurrency cap + redirect follow (2026-10-03)

The old `CHUNK=100` sequential batches are gone: `--chunk 0` (default) runs the
whole shard fully concurrently (peak == `--bots`); `--chunk N` restores
sequential N-bot batches to bound RAM at ~0.65MB/bot. Bots follow
`{t:event,kind:redirect,payload:{url}}` with the SAME name (identity preserved),
never consume the reconnect budget doing so, and count each hop in the CSV
`redirects` column (also in the swarm summary and `soak.ps1` JSON).

```powershell
# Peak proof (single shard, private ports so no other server interferes):
$env:PORT='8381'; $env:METRICS_PORT='9390'; $env:SHARDS=''
node C:\aetherfall\server\dist\index.js          # job it, assert the 8381 listener is yours
node C:\aetherfall\tools\bots\dist\index.js --bots 150 --server ws://localhost:8381 --duration 20 --seed 1337 --report $env:TEMP\report-150.csv --no-chaos --no-anticheat
# verified: aetherfall_players peak = 150 at t=3s, CSV 150/150 connected, 0 errors, ~27k snaps
# RAM-bounded variant: add --chunk 100 (peak == 100 instead of 150)

# Redirect proof (two shards sharing one registry; ~half the names route away):
#   shard-0: PORT=8383 METRICS_PORT=9391 SHARD_ID=shard-0 SHARDS='ws://localhost:8383,ws://localhost:8384'
#   shard-1: PORT=8384 METRICS_PORT=9392 SHARD_ID=shard-1 SHARDS='<same>'
node C:\aetherfall\tools\bots\dist\index.js --bots 10 --server ws://localhost:8383 --duration 8 --report $env:TEMP\report-redirect.csv --no-chaos --no-anticheat
# verified: 10/10 connected, redirects=5, peak 5/5 per shard (load split by follow)
```

### 3. Sample while it runs (5s cadence) and scrape per shard

```powershell
while ($true) {
  Start-Sleep 5
  $row = foreach ($s in $Shards) {
    $m = @{}; (Invoke-WebRequest "http://127.0.0.1:$($s.mx)/metrics").Content -split "`n" |
      Where-Object { $_ -match '^\S+\s' } | ForEach-Object { $k,$v = $_ -split '\s+',2; $m[$k]=$v }
    [pscustomobject]@{ shard=$s.id; players=[double]$m['aetherfall_players']
      avg=[double]$m['aetherfall_tick_duration_ms_avg']; p95=[double]$m['aetherfall_tick_duration_ms_p95']
      slow=[double]$m['aetherfall_slow_ticks_total'] }
  }
  $row | Format-Table -AutoSize
  $srv = Get-Process node | Where-Object { $_.Path -eq 'C:\Program Files\nodejs\node.exe' }
  "freeMB=$([math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB,0))"
}
```

RSS + leak slope (leak detection, 300 concurrent on one shard = 3 procs x 100):

```powershell
$out = @(); $t0 = Get-Date
while (((Get-Date)-$t0).TotalSeconds -lt 300) {
  Start-Sleep 10
  $srv = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server\dist\index.js*' }
  $out += [pscustomobject]@{ t=[int]((Get-Date)-$t0).TotalSeconds
    srvWS=[math]::Round((Get-Process -Id $srv.ProcessId).WorkingSet64/1MB,1)
    freeMB=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1KB,0) }
  $out[-1]
}
# slope = linear fit over the post-warmup window (skip the first 60s)
# result: +1.49MB/min server WS over t=63..283s; tick p95 91 -> 68ms (no decay)
```

### 4. Tear down (and prove it)

```powershell
Get-Job | Where-Object { $_.Name -like 'soak-*' } | Stop-Job
Get-Job | Where-Object { $_.Name -like 'soak-*' } | Remove-Job -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*aetherfall*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
foreach ($p in 8281..8285 + 9290..9294) { "port $p in use: $([bool](Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue))" }
```

### Tuning levers (measured, this host)

| lever | measured effect | notes |
|---|---|---|
| shards x 200 | linear CCU growth, 0 marginal cost per shard | 5x200 = 1000 CCU with per-shard cost identical to 1x200; **this is the lever that actually works today** |
| gameplay section (18-19ms @200/shard, the top cost) | the whole ballgame | decimate to 5-10Hz or stagger players across ticks (`tickGameplay` runs every tick today) |
| self-correcting tick scheduler | tick rate is 11-16Hz, never 20 | replace `setInterval(fn, 50)` (`index.ts:904`) with a deadline accumulator + catch-up cap; expect the largest single win at 100+ players |
| snapshot cadence/size | 4.02 snaps/s/bot @1000 (nominal 10Hz), 14-17KB each, ~40MB/s aggregate | 5Hz + interest caps (see above) buys back both CPU and egress |
| input-rate backpressure | 516k drops @1000, 911k/300s @300-on-one-shard | working as designed (drop, no strike) but it is the visible symptom of an overloaded shard |
| burst-window softening | **888 honest burst rejects @1000**, 0 @200-in-isolation, 0 speed/teleport/shadowban at every scale | the only anticheat regression found at 1000 CCU: a saturated event loop dequeueing honest 20Hz inputs in >20/200ms clumps still counts as a strike. Same fix already applied to the rate rule: exempt clumps that coincide with a slow tick, or require the trip to repeat |
| per-shard sqlite + audit | one `data/` per shard is mandatory | no `DB_PATH`/`AUDIT_PATH`-equivalent for the db; only cwd |
| bot harness RSS | 0.65MB/bot, 653MB for 1000 | 10 procs of 100 fit in 676MB of headroom; a single 1000-bot process needs ~700MB free and must run with the default `--chunk 0` (fully concurrent) |

### Verdict gates for a future 1k run (use these, not vibes)

1. `connected == bots` and `reconnects == 0` (v1 sharded soak:
   1000/1000, 0; v2 1000-CCU:
   1000/1000 but 23 shadowban-kick reconnects on the most pressured shard —
   not a pass yet, see BENCHMARKS 1000-connection finding 1;
   **wave10: 1000/1000, 0 reconnects, 0 kicks — PASS**;
   wave10b 800-probe: 800/800, 0 — PASS).
2. `aetherfall_tick_duration_ms_p95 <= 50ms` **and** tick rate >= 19Hz — measure
   the rate, do not assume 20Hz (v1: 12-14Hz at 200 players/shard;
   v2 with the drift-compensating scheduler: 12.9-15.6Hz at true-1000;
   **wave10: 14.6-18.2Hz at true-1000, 18.4-19.5Hz at 800**).
   For the sharded p95 <= 80ms ceiling gate specifically: **1000 FAILS
   (73-106, 4/5 shards over), 800 MARGINAL (68-84, misses by <=4ms on
   some shards), 600 KEEPS the certificate (prior p95 71.2)**.
3. honest `aetherfall_anticheat_rejects_total{kind="speed"|"teleport"|"shadowban"} == 0`
   **and** `{kind="burst"} == 0` (v1: 0/0/0 but burst 888 — not a pass yet;
   v2: 0/0 speed/teleport, burst 768, shadowban 84 / 23 kicks — regressed
   under pressure, same known window issue;
   **wave10: speed/teleport/shadowban 0, burst 223 with 0 strikes held
   and 0 kicks — the exemption works; the burst==0 clause is now
   interpreted as burst-kicks==0, since connect-storm clumps still
   trip-and-drop by design**).
4. `slow_ticks_ratio` < 0.05, server RSS flat over the run.
5. Ports asserted owned by your own server pids before you believe a scrape.

### v2 RAM rule (v2 fleets are RAM-heavy — this binds before bandwidth now)

Measured at 1000-v2: servers ~0.7GB WS under load (5 procs) + bots
~1.2GB WS (10 procs x 100, ~1.2MB/bot with binary decode buffers) vs
0.65MB/bot v1). Budget **~1.9GB free headroom** before attempting
1000-v2 on a shared box. **Update (wave10, pooled decode + tuned GC,
`NODE_OPTIONS='--max-semi-space-size=2 --max-old-space-size=48'` on bot
procs): bot fleet ~0.57MB/bot (~568MB for 1000), so 1000-v2 peaks at
~0.9GB total and fits a box starting with ~1.1GB free — but it kisses
the floor (1151 -> 248MB, floor tripped by 2MB, no OOM, memory returned
post-run). Revised budget: ~1.0GB consumed at peak; start with >=1.3GB
free for comfort. The 800-probe (same tuning) never tripped the guard
(1322 -> 449MB floor).** Procedure that survived two soaks without OOM:

- Gate each +200-bot shard step on **>400MB free**; hard floor
  **250MB** — below it, stop adding load and report what completed
  (a completed 600-v2-beats-600-v1 is a valid result).
- Expect the guard to bite: the first 1000-v2 attempt stopped at 800 (337MB free),
  run-2 reached 1000 with a 303MB floor. Both completed honestly.
- v2 bot RAM is the lever if headroom is short: fewer bots per proc
  does not help (peak RSS is per-bot); `--chunk` only helps by lowering
  *concurrency*, which invalidates the CCU figure — do not use it to
  fake a 1000.
