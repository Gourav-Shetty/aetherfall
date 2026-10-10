# AETHERFALL play supervisor: keeps one shard alive for playtesting.
# Restarts on death, timestamps every death with exit code + last log lines
# so a silent death leaves evidence. Cap: 5 deaths in 60s stops the loop.
$ErrorActionPreference = 'Continue'
$Root = 'C:\aetherfall'
$env:PORT = '8081'
$env:METRICS_PORT = '9090'
$env:CONTROL_PORT = '9190'
$deaths = @()
while ($true) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = "$Root\.ops\play-server.log"
  $err = "$Root\.ops\play-server.err.log"
  $p = Start-Process node -ArgumentList 'server/dist/index.js' -WorkingDirectory $Root `
    -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  "$((Get-Date).ToString('o')) supervisor: started pid=$($p.Id)" | Add-Content "$Root\.ops\watchdog.log"
  $p.WaitForExit()
  $code = $p.ExitCode
  $now = Get-Date
  $deaths += $now
  $deaths = @($deaths | Where-Object { ($_ - $now).TotalSeconds -gt -60 })
  $tail = Get-Content $out -Tail 5 -ErrorAction SilentlyContinue
  $errTail = Get-Content $err -Tail 5 -ErrorAction SilentlyContinue
  "$($now.ToString('o')) supervisor: DIED exit=$code last5=[$($tail -join ' | ')] err5=[$($errTail -join ' | ')]" | Add-Content "$Root\.ops\watchdog.log"
  if ($deaths.Count -ge 5) {
    "$($now.ToString('o')) supervisor: 5 deaths in 60s, giving up" | Add-Content "$Root\.ops\watchdog.log"
    exit 1
  }
  Start-Sleep -Seconds 2
}
