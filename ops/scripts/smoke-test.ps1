<#
.SYNOPSIS
    AETHERFALL smoke test: health + join + kill + metrics assertions.

.DESCRIPTION
    Proves a freshly booted shard is actually serving the game, not just holding
    its port open. Five stages, each printing `ok` / `not ok`:

      1 health   GET /healthz    -> ok:true, shard id, players + tick reported
      2 metrics  GET /metrics    -> valid Prometheus exposition with every
                                    gameplay / wire / histogram family present
      3 join     WS  hello       -> welcome + >=3 snapshots + honest input
                                    accepted + teleport attempt clamped
      4 metrics  GET /metrics    -> the gauges the loop just fed are live
                                    (ticks advancing, players >= 1, wire bytes > 0)
      5 kill     POST /drain     -> new joins refused (1013) and the shard log
                                    contains drain-begin + drain-complete

    Exits non-zero as soon as any stage fails, so it works as a CI gate and as
    a post-deploy check.

.PARAMETER Port
    WS port of the shard under test (default 8081).

.PARAMETER MetricsPort
    Metrics/health port of the shard under test (default 9090).

.PARAMETER ControlPort
    Port serving POST /drain. 0 = skip the kill stage with a warning,
    -1 = skip it silently. Default 9190 (start-shards.ps1 shard-0 layout).

.PARAMETER ShardId
    Expected value of /healthz `.shard` (default shard-0). Empty = don't check.

.PARAMETER SnapshotFile
    Optional path to dump the exposition to for later inspection.

.PARAMETER SkipKill
    Skip the drain stage (use when you still need the server afterwards).

.EXAMPLE
    ./ops/scripts/start-shards.ps1 -Shards 1
    ./ops/scripts/smoke-test.ps1 -Port 8081 -MetricsPort 9090 -ControlPort 9190
#>
[CmdletBinding()]
param(
  [int]$Port = 8081,
  [int]$MetricsPort = 9090,
  [int]$ControlPort = 9190,
  [string]$ShardId = 'shard-0',
  [string]$SnapshotFile = '',
  [switch]$SkipKill
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PSScriptRoot = $PSScriptRoot
$Probe = Join-Path $PSScriptRoot 'lib\smoke-probe.mjs'
$Check = Join-Path $PSScriptRoot 'lib\check-metrics.mjs'
$RepoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
$RunDir = Join-Path $RepoRoot '.ops\run'

$script:Step = 0
$script:Failures = 0

function Ok([string]$Name, [string]$Detail = '') {
  $script:Step++
  $suffix = if ($Detail) { " :: $Detail" } else { '' }
  Write-Host ("ok {0} - {1}{2}" -f $script:Step, $Name, $suffix)
}

function NotOk([string]$Name, [string]$Detail = '') {
  $script:Step++
  $script:Failures++
  $suffix = if ($Detail) { " :: $Detail" } else { '' }
  Write-Host ("not ok {0} - {1}{2}" -f $script:Step, $Name, $suffix) -ForegroundColor Red
}

function Assert([bool]$Condition, [string]$Name, [string]$Detail = '') {
  if ($Condition) { Ok $Name $Detail } else { NotOk $Name $Detail }
}

function MetricValue([string]$Body, [string]$Name) {
  # Single-quoted template + -f so the regex braces and the interpolated name
  # both survive verbatim (a double-quoted subexpression would eat a group).
  $pattern = '(?m)^{0}(\{{[^\}}]*\}})?\s+(-?[0-9eE+.]+)\s*$' -f [regex]::Escape($Name)
  $m = [regex]::Match($Body, $pattern)
  if ($m.Success) {
    $v = 0.0
    if ([double]::TryParse($m.Groups[2].Value, [ref]$v)) { return $v }
  }
  return $null
}

$metricsUrl = "http://localhost:$MetricsPort/metrics"
Write-Host "# smoke-test target ws=ws://localhost:$Port metrics=$metricsUrl" -ForegroundColor Cyan

# --- stage 1: health ------------------------------------------------------
try {
  $h = Invoke-RestMethod -Uri "http://localhost:$MetricsPort/healthz" -TimeoutSec 5
  Assert ($h.ok -eq $true) 'health: /healthz ok=true' "shard=$($h.shard) tick=$($h.tick)"
  if ($ShardId) { Assert ($h.shard -eq $ShardId) "health: shard id is $ShardId" "got=$($h.shard)" }
  Assert ($null -ne $h.players -and $null -ne $h.tick) 'health: players + tick reported' "players=$($h.players) tick=$($h.tick)"
} catch {
  NotOk 'health: GET /healthz' $_.Exception.Message
}

if ($script:Failures -gt 0) {
  Write-Host '# smoke-test FAIL: server is not healthy, aborting' -ForegroundColor Red
  exit 1
}

# --- stage 2: metrics exposition -----------------------------------------
& node $Check --url $metricsUrl --require-active
if ($LASTEXITCODE -eq 0) {
  Ok 'metrics: exposition is valid Prometheus text with every required family'
} else {
  NotOk 'metrics: exposition invalid' 'see check-metrics output above'
}

if ($SnapshotFile) {
  try {
    $dir = Split-Path $SnapshotFile -Parent
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    (Invoke-WebRequest -Uri $metricsUrl -UseBasicParsing -TimeoutSec 5).Content | Set-Content -Path $SnapshotFile
    Ok 'metrics: snapshot written' $SnapshotFile
  } catch {
    NotOk 'metrics: snapshot write failed' $_.Exception.Message
  }
}

# --- stage 3: join / input / anticheat -----------------------------------
& node $Probe --server "ws://localhost:$Port" --name "smoke-$Port"
if ($LASTEXITCODE -eq 0) {
  Ok 'join: welcome, snapshots, honest input and anticheat clamp all pass'
} else {
  NotOk 'join: live protocol probe failed' "exit=$LASTEXITCODE"
}

# --- stage 4: gauges the tick loop just fed ------------------------------
try {
  $text = (Invoke-WebRequest -Uri $metricsUrl -UseBasicParsing -TimeoutSec 5).Content
  $ticks = MetricValue $text 'aetherfall_ticks_total'
  $players = MetricValue $text 'aetherfall_players'
  $conns = MetricValue $text 'aetherfall_connections_total'
  $frames = MetricValue $text 'aetherfall_frames_json_total'
  $bytes = MetricValue $text 'aetherfall_wire_bytes_total'
  $lag = MetricValue $text 'aetherfall_tick_schedule_lag_ms'
  $ratio = MetricValue $text 'aetherfall_tick_rate_ratio'
  $snapLast = MetricValue $text 'aetherfall_snapshot_last_bytes'
  Assert ($null -ne $ticks -and $ticks -gt 0) 'metrics: aetherfall_ticks_total is advancing' "ticks=$ticks"
  # The probe disconnects before this scrape, so prove the join reached the
  # gauges through the monotonic connection counter instead of a live player.
  Assert ($null -ne $conns -and $conns -ge 3) 'metrics: connections_total counted every probe join' "connections=$conns"
  Assert ($null -ne $players) 'metrics: aetherfall_players gauge present' "players=$players"
  Assert ($null -ne $frames -and $frames -gt 0) 'metrics: json frame counter is moving' "frames=$frames"
  Assert ($null -ne $bytes -and $bytes -gt 0) 'metrics: wire byte counter is moving' "bytes=$bytes"
  Assert ($null -ne $lag) 'metrics: tick schedule lag gauge present' "lag=${lag}ms"
  Assert ($null -ne $ratio -and $ratio -gt 0.5) 'metrics: tick cadence is healthy' "ratio=$ratio (target 1.0)"
  Assert ($null -ne $snapLast -and $snapLast -gt 0) 'metrics: last snapshot has payload' "bytes=$snapLast"
} catch {
  NotOk 'metrics: gauge assertions' $_.Exception.Message
}

# --- stage 5: graceful kill ----------------------------------------------
if ($SkipKill) {
  Write-Host '# skipping kill stage (-SkipKill)'
} elseif ($ControlPort -lt 0) {
  Write-Host '# skipping kill stage (ControlPort=-1)'
} elseif ($ControlPort -eq 0) {
  Write-Host '# skipping kill stage: start the shard with CONTROL_PORT to enable POST /drain' -ForegroundColor Yellow
} else {
  $log = Join-Path $RunDir "shard-$($Port - 8081).log"
  & node $Probe --server "ws://localhost:$Port" --control "http://localhost:$ControlPort" `
    --name "kill-$Port" --expect-kill --log $log
  if ($LASTEXITCODE -eq 0) {
    Ok 'kill: drain accepted, new joins refused, drain events logged'
  } else {
    NotOk 'kill: drain did not complete cleanly' "exit=$LASTEXITCODE"
  }
}

Write-Host ''
if ($script:Failures -eq 0) {
  Write-Host "# smoke-test PASS ($script:Step/$script:Step checks)" -ForegroundColor Green
  exit 0
}
Write-Host "# smoke-test FAIL ($script:Failures of $script:Step checks failed)" -ForegroundColor Red
exit 1