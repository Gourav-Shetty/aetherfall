<#
.SYNOPSIS
    Stop the local AETHERFALL shard cluster started by start-shards.ps1.

.DESCRIPTION
    Reads .ops/run/shard-<i>.pid and stops each process with the same two-phase
    behaviour the server implements for POSIX SIGTERM:

      1 ask the shard to drain over its CONTROL_PORT (POST /drain) and wait up
        to -TimeoutMs for it to finish its ordered shutdown
        (stop accepting -> finish the in-flight tick -> flush the DB -> close)
      2 force-kill anything still alive and clean up stale pid files

    The control port is read from the shard's own /healthz body (`controlPort`)
    rather than guessed, so a non-default layout still works.

    Exit code 0 when every shard stopped gracefully, 1 when a shard had to be
    force-killed, 2 when there was nothing to stop.

.PARAMETER TimeoutMs
    Per-shard budget for a graceful stop before it is killed (default 6000).

.PARAMETER Force
    Skip the drain request and stop every shard immediately.

.EXAMPLE
    ./ops/scripts/stop-shards.ps1
    ./ops/scripts/stop-shards.ps1 -TimeoutMs 10000
#>
[CmdletBinding()]
param(
  [int]$TimeoutMs = 6000,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
$RunDir = Join-Path $RepoRoot '.ops\run'

function Write-Step([string]$Message) { Write-Host "[stop] $Message" -ForegroundColor Cyan }
function Write-Fail([string]$Message) { Write-Host "[stop] $Message" -ForegroundColor Red }

if (-not (Test-Path $RunDir)) {
  Write-Step "nothing to stop (no $RunDir)"
  exit 2
}

$pidFiles = @(Get-ChildItem -Path $RunDir -Filter 'shard-*.pid' -ErrorAction SilentlyContinue)
if ($pidFiles.Count -eq 0) {
  Write-Step "nothing to stop (no shard-*.pid in $RunDir)"
  exit 2
}

# The shard reports the control port it actually bound; the default local
# layout maps shard-i -> 9190 + i, which is also the fallback here.
function Get-ShardControlPort([int]$index) {
  # Parenthesised: `9090 + $index, 9190 + $index` would parse as an array add.
  $candidates = @((9090 + $index), (9190 + $index))
  foreach ($mPort in $candidates) {
    try {
      $h = Invoke-RestMethod -Uri "http://localhost:$mPort/healthz" -TimeoutSec 1
      if ($h.PSObject.Properties.Name -contains 'controlPort' -and $h.controlPort) {
        return [int]$h.controlPort
      }
    } catch {
      # Not this port / already gone. Try the next candidate.
    }
  }
  return 0
}

$forced = 0
$stopped = 0
$stale = 0

foreach ($file in ($pidFiles | Sort-Object Name)) {
  if ($file.BaseName -notmatch '^shard-(\d+)$') { continue }
  $index = [int]$Matches[1]

  $raw = (Get-Content $file.FullName -Raw).Trim()
  $procId = 0
  if (-not [int]::TryParse($raw, [ref]$procId)) {
    Write-Step "$($file.BaseName): unreadable pid file, removing"
    Remove-Item $file.FullName -Force
    continue
  }

  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    Write-Step "$($file.BaseName): pid $procId not running (stale), cleaning up"
    Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
    $stale++
    continue
  }

  if (-not $Force) {
    $controlPort = Get-ShardControlPort $index
    if ($controlPort -gt 0) {
      try {
        Invoke-RestMethod -Method Post -Uri "http://localhost:$controlPort/drain" -TimeoutSec 2 | Out-Null
        Write-Step "$($file.BaseName): drain requested via control port $controlPort"
      } catch {
        Write-Step "$($file.BaseName): drain request failed, stopping directly"
      }
    } else {
      Write-Step "$($file.BaseName): no control port (restart with CONTROL_PORT to drain gracefully)"
    }
  }

  if (-not $Force) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
  }

  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    Write-Fail "$($file.BaseName): still alive after $TimeoutMs, force killing pid $procId"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    $forced++
  } else {
    Write-Step "$($file.BaseName): stopped cleanly"
    $stopped++
  }
  Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
}

Write-Step "stopped=$stopped forced=$forced stale=$stale"
if ($forced -gt 0) { exit 1 }
exit 0