<#
.SYNOPSIS
    Start a 5-shard local AETHERFALL cluster (no docker daemon required).

.DESCRIPTION
    Boots N independent `node server/dist/index.js` processes with distinct
    PORT / METRICS_PORT / SHARD_ID and a shared SHARDS registry, exactly as
    described in docs/SHARDING.md#Operating. Ports default to the layout used by
    ops/scripts/smoke-test.ps1, ops/prometheus.yml and the Grafana dashboard:

        shard-0  ws://localhost:8081  metrics :9090
        shard-1  ws://localhost:8082  metrics :9091
        shard-2  ws://localhost:8083  metrics :9092
        shard-3  ws://localhost:8084  metrics :9093
        shard-4  ws://localhost:8085  metrics :9094

    Each shard writes its pid and stdout/stderr to
    .ops/run/shard-<i>.{pid,log,err.log}. Readiness is GET /healthz returning
    ok:true, polled per shard; a shard that never becomes ready is reported and
    the script exits non-zero.

    LOG_JSON=1 is enabled by -LogJson so the logs carry tick + request ids,
    which is what ops/scripts/smoke-test.ps1 greps for after a kill.

.PARAMETER Shards
    Number of shards to start (default 5).

.PARAMETER BasePort
    First WS port. Shard i listens on BasePort + i (default 8081).

.PARAMETER BaseMetricsPort
    First metrics port. Shard i exposes BaseMetricsPort + i (default 9090).

.PARAMETER BaseControlPort
    First drain control port (CONTROL_PORT). Shard i uses BaseControlPort + i.
    0 disables the HTTP drain endpoint (POSIX SIGTERM still works).
    Default 9190 -> shard-0 drains on http://localhost:9190/drain.

.PARAMETER MaxPlayersPerShard
    MAX_PLAYERS_PER_SHARD for every shard (default 500).

.PARAMETER LogJson
    Set LOG_JSON=1 so each shard emits structured JSON logs.

.PARAMETER DryRun
    Print the resolved plan and exit without spawning anything.

.EXAMPLE
    ./ops/scripts/start-shards.ps1
    ./ops/scripts/start-shards.ps1 -Shards 3 -LogJson
    ./ops/scripts/start-shards.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [int]$Shards = 5,
  [int]$BasePort = 8081,
  [int]$BaseMetricsPort = 9090,
  [int]$BaseControlPort = 9190,
  [int]$MaxPlayersPerShard = 500,
  [switch]$LogJson,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
$RunDir = Join-Path $RepoRoot '.ops\run'
$Entry = Join-Path $RepoRoot 'server\dist\index.js'

function Write-Step([string]$Message) { Write-Host "[shards] $Message" -ForegroundColor Cyan }
function Write-Fail([string]$Message) { Write-Host "[shards] $Message" -ForegroundColor Red }

if ($Shards -lt 1) {
  Write-Fail "-Shards must be >= 1"
  exit 2
}

$shardHosts = @()
for ($i = 0; $i -lt $Shards; $i++) { $shardHosts += "ws://localhost:$($BasePort + $i)" }
$shardsEnv = $shardHosts -join ','

Write-Step "repo=$RepoRoot"
Write-Step "shards=$Shards ws=$($BasePort)..$($BasePort + $Shards - 1) metrics=$($BaseMetricsPort)..$($BaseMetricsPort + $Shards - 1)"
Write-Step "SHARDS=$shardsEnv"

if ($DryRun) {
  for ($i = 0; $i -lt $Shards; $i++) {
    Write-Host ("[shards] plan shard-{0} PORT={1} METRICS_PORT={2} CONTROL_PORT={3} SHARD_ID=shard-{0}" -f `
      $i, ($BasePort + $i), ($BaseMetricsPort + $i), $(if ($BaseControlPort -gt 0) { $BaseControlPort + $i } else { 'off' }))
  }
  Write-Step "dry run: nothing started"
  exit 0
}

if (-not (Test-Path $Entry)) {
  Write-Fail "server build missing at $Entry - run 'npm run build --workspaces' first"
  exit 2
}

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

# Refuse to double-start: a live pid file means someone already has it up.
$alreadyUp = @()
for ($i = 0; $i -lt $Shards; $i++) {
  $pidFile = Join-Path $RunDir "shard-$i.pid"
  if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    $existing = 0
    if ([int]::TryParse($raw, [ref]$existing) -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
      $alreadyUp += $i
    }
  }
}
if ($alreadyUp.Count -gt 0) {
  Write-Fail "already running: shard(s) $($alreadyUp -join ',') - run ops/scripts/stop-shards.ps1 first"
  exit 1
}

$started = @()
for ($i = 0; $i -lt $Shards; $i++) {
  $id = "shard-$i"
  $log = Join-Path $RunDir "$id.log"
  $errLog = Join-Path $RunDir "$id.err.log"

  $env:PORT = [string]($BasePort + $i)
  $env:METRICS_PORT = [string]($BaseMetricsPort + $i)
  $env:SHARD_ID = $id
  $env:SHARDS = $shardsEnv
  $env:MAX_PLAYERS_PER_SHARD = [string]$MaxPlayersPerShard
  if (-not $env:AETHERFALL_VERSION) { $env:AETHERFALL_VERSION = '0.1.0-local' }
  if ($BaseControlPort -gt 0) { $env:CONTROL_PORT = [string]($BaseControlPort + $i) }
  else { Remove-Item Env:\CONTROL_PORT -ErrorAction SilentlyContinue }
  if ($LogJson) { $env:LOG_JSON = '1' } else { Remove-Item Env:\LOG_JSON -ErrorAction SilentlyContinue }

  $proc = Start-Process -FilePath 'node' -ArgumentList $Entry -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -NoNewWindow
  Set-Content -Path (Join-Path $RunDir "$id.pid") -Value $proc.Id
  $started += [pscustomobject]@{ shard = $id; pid = $proc.Id; port = (Get-Content Env:\PORT); metrics = [int](Get-Content Env:\METRICS_PORT); log = $log }
  Write-Step "started $id pid=$($proc.Id) ws=$($env:PORT) metrics=$($env:METRICS_PORT)"
}

# Readiness poll: /healthz must answer ok:true before we call the cluster up.
$deadline = (Get-Date).AddSeconds(30)
$ready = @{}
foreach ($s in $started) { $ready[$s.shard] = $false }
while ((Get-Date) -lt $deadline) {
  $allReady = $true
  foreach ($s in $started) {
    if ($ready[$s.shard]) { continue }
    try {
      $health = Invoke-RestMethod -Uri "http://localhost:$($s.metrics)/healthz" -TimeoutSec 2
      if ($health.ok) {
        $ready[$s.shard] = $true
        Write-Step "ready $($s.shard) players=$($health.players) tickMs=$($health.tickMs) control=$($health.controlPort)"
      } else { $allReady = $false }
    } catch { $allReady = $false }
  }
  if ($allReady) { break }
  Start-Sleep -Milliseconds 250
}

$notReady = @($started | Where-Object { -not $ready[$_.shard] })
if ($notReady.Count -gt 0) {
  foreach ($s in $notReady) { Write-Fail "$($s.shard) never became ready (see $($s.log))" }
  Write-Fail "cluster start failed"
  exit 1
}

Write-Step "cluster up: $Shards shard(s), SHARDS=$shardsEnv"
Write-Step "metrics: $(($started | ForEach-Object { "http://localhost:$($_.metrics)/metrics" }) -join ' ')"
if ($BaseControlPort -gt 0) {
  Write-Step "drain:   $(($started | ForEach-Object { "http://localhost:$($BaseControlPort + $started.IndexOf($_))/drain" }) -join ' ')"
}
Write-Step "logs: $RunDir"
exit 0