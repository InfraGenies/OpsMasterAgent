#requires -Version 5.1
<#
  Stops the server/web processes started by start-app.ps1 (by PID file,
  killing each process's full tree since npm/tsx/vite fan out into child
  node processes on Windows), then falls back to freeing this app's own
  dev ports (4000, 5173) if anything is still listening on them.
#>
param(
  [switch]$Quiet
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runDir = "$root\.run"

function Say($msg) { if (-not $Quiet) { Write-Host $msg } }

function Stop-Tracked([string]$name) {
  $pidFile = "$runDir\$name.pid"
  if (-not (Test-Path $pidFile)) {
    Say "$name`: no pid file, nothing tracked."
    return
  }
  $trackedId = (Get-Content $pidFile | Select-Object -First 1).Trim()
  if ($trackedId -match '^\d+$') {
    $proc = Get-Process -Id $trackedId -ErrorAction SilentlyContinue
    if ($proc) {
      Say "Stopping $name (pid $trackedId and its child processes)..."
      taskkill /PID $trackedId /T /F | Out-Null
    } else {
      Say "$name`: pid $trackedId not running."
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-Tracked "server"
Stop-Tracked "web"

# Fallback: free this app's own dev ports if something is still bound to
# them (e.g. started outside this script). Scoped to 4000/5173 only.
foreach ($port in 4000, 5173) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Say "Port $port still in use by pid $($c.OwningProcess) - stopping it too."
    taskkill /PID $c.OwningProcess /T /F | Out-Null
  }
}

Say "Stopped."
