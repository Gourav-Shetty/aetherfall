<#
.SYNOPSIS
    Run the bot swarm against a local AETHERFALL shard and collect the CSV.

.DESCRIPTION
    Thin, documented wrapper around `tools/bots` (see docs/SCALE.md). It boots
    nothing: start the cluster first with ops/scripts/start-shards.ps1, then run
    this to load it. Every bot argument is forwarded, so the full harness is
    available (`--workers`, `--input-hz`, `--seed`, `--chaos`/`--no-chaos`,
    `--anticheat`/`--no-anticheat`, `--reconnect`/`--no-reconnect`).

    The report CSV lands in .ops/soak/soak-<label>.csv and a JSON summary is
    written next to it, so CI (and docs/OPS.md) can assert on connect rate,
    reconnects and tick drift without parsing the CSV.

.PARAMETER Bots
    Concurrent bot count (default 20).

.PARAMETER Server
    Shard WS URL (default ws://localhost:8081).

.PARAMETER Duration
    Seconds to hold the load (default 30).

.PARAMETER Workers
    Fork N bot processes; ~200 bots per process is the recommended ceiling
    (default 1).

.PARAMETER Chunk
    Per-process concurrency cap forwarded as --chunk (default 0 =
    fully concurrent, peak == Bots). Set -Chunk 100 to restore sequential
    100-bot batches and bound RAM at ~0.65MB/bot.

.PARAMETER Proto
    Wire protocol forwarded as --proto (default 1 = JSON; 2 = binary with
    automatic JSON fallback when the server declines).

.PARAMETER Seed
    Deterministic bot RNG seed (default 1337).

.PARAMETER InputHz
    Input rate per active bot; the server floor is 15 (default 20).

.PARAMETER Label
    Name for the report files (default a timestamp).

.PARAMETER NoChaos / NoAnticheat
    Disable the packet-flood / teleport probes.

.PARAMETER OutDir
    Where the CSV + summary go (default <repo>/.ops/soak).

.PARAMETER MaxFailRate
    Exit non-zero when more than this fraction of bots failed to connect
    (default 0.1 = 10%).

.PARAMETER MaxTickGaps
    Exit non-zero when the swarm observed more than this many missing server
    ticks in total (default 0 - honest clients must see zero drift).

.PARAMETER MinSnapshotsPerBot
    Exit non-zero when the average bot saw fewer snapshot frames than this
    (default 5). This catches the "TCP connected but nothing served" trap:
    with a multi-shard SHARDS registry, sticky routing redirects ~4/5 of joins
    to another shard, and a single-shard bot run that ignores redirects looks
    like a perfect 20/20 connect rate with zero gameplay.

.PARAMETER PassThru
    Emit the summary object on the pipeline as well as setting the exit code.

.EXAMPLE
    ./ops/scripts/soak.ps1 -Bots 20 -Duration 15 -Label ci
    ./ops/scripts/soak.ps1 -Bots 400 -Workers 2 -Duration 60 -NoChaos
    ./ops/scripts/soak.ps1 -Bots 20 -Server ws://localhost:8083   # soak shard-2
    ./ops/scripts/soak.ps1 -Bots 150 -Duration 20 -Label peak150  # peak == 150 (chunk 0)
    # Bypass (single process, fully concurrent) - the only supported harness path:
    node tools/bots/dist/index.js --bots 150 --server ws://localhost:8081 --duration 20 --seed 1337 --report .ops/soak/soak-peak150.csv --no-chaos --no-anticheat
    # Bound RAM instead (~0.65MB/bot): sequential 100-bot batches, peak == 100:
    node tools/bots/dist/index.js --bots 150 --chunk 100 --server ws://localhost:8081 --duration 20 --report .ops/soak/soak-chunk100.csv --no-chaos --no-anticheat
    # NEVER via npm with space-form flags (npm swallows them -> exit 2):
    #   npm run start --workspace=@aetherfall/bots -- --bots 150   # FAILS FAST, use node directly
    #   npm run start --workspace=@aetherfall/bots -- --bots=150   # = form works (npm_config_*)
#>
[CmdletBinding()]
param(
  [int]$Bots = 20,
  [string]$Server = 'ws://localhost:8081',
  [int]$Duration = 30,
  [int]$Workers = 1,
  [int]$Seed = 1337,
  [int]$InputHz = 20,
  [int]$Chunk = 0,
  [int]$Proto = 1,
  [string]$Label = '',
  [switch]$NoChaos,
  [switch]$NoAnticheat,
  [string]$OutDir = '',
  [double]$MaxFailRate = 0.1,
  [int]$MaxTickGaps = 0,
  [int]$MinSnapshotsPerBot = 5,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
$BotsEntry = Join-Path $RepoRoot 'tools\bots\dist\index.js'
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot '.ops\soak' }
if (-not $Label) { $Label = (Get-Date -Format 'yyyyMMdd-HHmmss') }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$csv = Join-Path $OutDir "soak-$Label.csv"
$summaryPath = Join-Path $OutDir "soak-$Label.json"

if (-not (Test-Path $BotsEntry)) {
  Write-Host "[soak] bots build missing at $BotsEntry - run 'npm run build --workspaces'" -ForegroundColor Red
  exit 2
}

# Fail fast: a soak against a dead server just burns the clock. The metrics port
# mirrors the local cluster layout (ws 8081..8085 <-> metrics 9090..9094).
$wsPort = [regex]::Match($Server, ':(\d+)').Groups[1].Value
if ($wsPort -and ($Server -match 'localhost|127\.0\.0\.1')) {
  $metricsPort = 9090 + ([int]$wsPort - 8081)
  try {
    $null = Invoke-RestMethod -Uri "http://localhost:$metricsPort/healthz" -TimeoutSec 3
  } catch {
    Write-Host "[soak] shard at $Server is not answering /healthz on $metricsPort - start it first" -ForegroundColor Red
    exit 2
  }
}

$botArgs = @(
  $BotsEntry,
  '--bots', "$Bots",
  '--server', $Server,
  '--duration', "$Duration",
  '--workers', "$Workers",
  '--seed', "$Seed",
  '--input-hz', "$InputHz",
  '--chunk', "$Chunk",
  '--proto', "$Proto",
  '--report', $csv
)
if ($NoChaos) { $botArgs += '--no-chaos' }
if ($NoAnticheat) { $botArgs += '--no-anticheat' }

Write-Host "[soak] bots=$Bots duration=${Duration}s workers=$Workers chunk=$Chunk proto=$Proto server=$Server seed=$Seed" -ForegroundColor Cyan
Write-Host "[soak] report=$csv"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
& node @botArgs
$exit = $LASTEXITCODE
$sw.Stop()

# Parse the CSV the harness just wrote into a JSON summary.
$rows = @()
if (Test-Path $csv) {
  $all = @(Get-Content $csv | Where-Object { $_.Trim() -ne '' })
  if ($all.Count -gt 1) {
    $header = $all[0] -split ','
    foreach ($line in $all[1..($all.Count - 1)]) {
      $cells = $line -split ','
      $row = [ordered]@{}
      for ($i = 0; $i -lt $header.Count; $i++) { $row[$header[$i]] = $cells[$i] }
      $rows += $row
    }
  }
}

$toNum = { param($v) $d = 0.0; if ([double]::TryParse([string]$v, [ref]$d)) { return $d } return 0.0 }
$connected = @($rows | Where-Object { (& $toNum $_['connect_ms']) -ge 0 }).Count
$errors = @($rows | Where-Object {
  # The CSV quotes every field, so an empty error cell arrives as "".
  $e = ([string]$_['error']).Trim().Trim('"')
  $e -ne ''
}).Count
$reconnects = ($rows | ForEach-Object { & $toNum $_['reconnects'] } | Measure-Object -Sum).Sum
$redirects = ($rows | ForEach-Object { & $toNum $_['redirects'] } | Measure-Object -Sum).Sum
$tickGaps = ($rows | ForEach-Object { & $toNum $_['tick_gaps'] } | Measure-Object -Sum).Sum
$maxGap = ($rows | ForEach-Object { & $toNum $_['max_tick_gap'] } | Measure-Object -Maximum).Maximum
$totalSnapshots = ($rows | ForEach-Object { & $toNum $_['snapshots'] } | Measure-Object -Sum).Sum
$snapshotsPerBot = if ($rows.Count -gt 0) { $totalSnapshots / $rows.Count } else { 0 }
$failRate = if ($rows.Count -gt 0) { 1.0 - ($connected / $rows.Count) } else { 1.0 }

$summary = [ordered]@{
  label           = $Label
  bots            = $Bots
  server          = $Server
  durationSec     = $Duration
  workers         = $Workers
  seed            = $Seed
  exitCode        = $exit
  wallSec         = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  rows            = $rows.Count
  connected       = $connected
  errors          = $errors
  failRate        = [math]::Round($failRate, 4)
  reconnects      = $reconnects
  redirects       = $redirects
  tickGaps        = $tickGaps
  maxTickGap      = $maxGap
  snapshots       = $totalSnapshots
  snapshotsPerBot = [math]::Round($snapshotsPerBot, 2)
  csv             = $csv
}
$summary | ConvertTo-Json | Set-Content -Path $summaryPath

Write-Host "[soak] connected=$connected/$($rows.Count) errors=$errors reconnects=$reconnects redirects=$redirects tickGaps=$tickGaps maxTickGap=$maxGap"
Write-Host ("[soak] snapshots={0} ({1}/bot)" -f $totalSnapshots, [math]::Round($snapshotsPerBot, 1))
Write-Host "[soak] summary=$summaryPath"

if ($rows.Count -eq 0) {
  Write-Host '[soak] FAIL: no bot rows were produced' -ForegroundColor Red
  if (-not $PassThru) { exit 1 }
  return $summary
}
if ($exit -ne 0) {
  Write-Host "[soak] FAIL: bot harness exited $exit" -ForegroundColor Red
  if (-not $PassThru) { exit $exit }
  return $summary
}
if ($failRate -gt $MaxFailRate) {
  Write-Host ("[soak] FAIL: connect fail rate {0}% > {1}%" -f [math]::Round($failRate * 100, 1), [math]::Round($MaxFailRate * 100, 1)) -ForegroundColor Red
  if (-not $PassThru) { exit 1 }
  return $summary
}
if ($snapshotsPerBot -lt $MinSnapshotsPerBot) {
  Write-Host ("[soak] FAIL: only {0} snapshots/bot (min {1}) - the swarm connected but was never served" -f [math]::Round($snapshotsPerBot, 2), $MinSnapshotsPerBot) -ForegroundColor Red
  Write-Host '[soak]      a multi-shard SHARDS registry redirects most joins elsewhere; soak a single-shard server or point -Server at one shard' -ForegroundColor Yellow
  if (-not $PassThru) { exit 1 }
  return $summary
}
if ($tickGaps -gt $MaxTickGaps) {
  Write-Host "[soak] FAIL: $tickGaps missing server ticks observed (max $MaxTickGaps)" -ForegroundColor Red
  if (-not $PassThru) { exit 1 }
  return $summary
}

Write-Host '[soak] PASS' -ForegroundColor Green
if ($PassThru) { return $summary }
exit 0