#requires -Version 5.1
<#
  Ops Master Agent - one-command dev startup.
  Checks required tooling (Node.js 18+, optionally Docker) and offers to
  auto-install anything missing via winget, installs project dependencies,
  ensures a working local .env exists, then starts the server (:4100) and
  web UI (:5173) in the background.
  Run .\stop-app.ps1 to stop them. Safe to re-run - stops any previous
  instance first.

  Params:
    -NoBrowser   don't open the browser once healthy
    -Yes         auto-confirm any winget installs (no prompts; for CI/unattended runs)
    -NoInstall   never offer to install anything - just detect and print manual instructions
#>
param(
  [switch]$NoBrowser,
  [switch]$Yes,
  [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "XX  $msg" -ForegroundColor Red }

function Test-Winget { [bool](Get-Command winget -ErrorAction SilentlyContinue) }

function Sync-SessionPath {
  # A tool just installed by winget updates the Machine/User PATH in the
  # registry, but this already-running process won't see it until we
  # re-read and merge it in ourselves.
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = @($machine, $user) -join ";"
}

function Confirm-Action([string]$prompt) {
  if ($Yes) { return $true }
  $resp = Read-Host "$prompt [Y/n]"
  return ($resp -eq "" -or $resp -match '^[Yy]')
}

function Install-WithWinget([string]$id, [string]$displayName) {
  Step "Installing $displayName via winget (id: $id)..."
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Fail "$displayName install via winget failed (exit $LASTEXITCODE)."
    return $false
  }
  Sync-SessionPath
  Ok "$displayName installed."
  return $true
}

# ---------------------------------------------------------------------------
# 1. Required tooling
# ---------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  Warn "Node.js was not found on PATH."
  if (-not $NoInstall -and (Test-Winget) -and (Confirm-Action "Install Node.js LTS now via winget?")) {
    Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS" | Out-Null
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $node -or -not $npm) {
    Fail "Node.js is still not available on PATH."
    Write-Host "Install Node.js 18+ LTS from https://nodejs.org/ (or run: winget install OpenJS.NodeJS.LTS), then re-run this script."
    Write-Host "If you just installed it, close and reopen your terminal so PATH picks it up."
    exit 1
  }
}
$nodeVersion = (node --version).TrimStart("v")
$majorVersion = [int]($nodeVersion.Split(".")[0])
if ($majorVersion -lt 18) {
  Fail "Node.js $nodeVersion found, but 18+ is required."
  Write-Host "Upgrade from https://nodejs.org/ or run: winget upgrade OpenJS.NodeJS.LTS"
  exit 1
}
Ok "node v$nodeVersion, npm $(npm --version)"

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
  Ok "docker found: $((docker --version) -join ' ')"
} else {
  Warn "docker CLI not found - the pipeline still runs and demos fully (mock deploy/rollback path)."
  if (-not $NoInstall -and (Test-Winget) -and (Confirm-Action "Install Docker Desktop now via winget? (optional - only needed for live container deploys, and typically requires a restart + first-run setup)")) {
    Install-WithWinget "Docker.DockerDesktop" "Docker Desktop" | Out-Null
    Warn "Docker Desktop install started - it usually needs a system restart and manual first-run setup before the 'docker' command works."
  } else {
    Write-Host "Install Docker Desktop for live container deploys: https://www.docker.com/products/docker-desktop/ (or: winget install Docker.DockerDesktop)"
  }
}

# ---------------------------------------------------------------------------
# 2. Project dependencies (npm workspaces - installs shared/server/web at once)
# ---------------------------------------------------------------------------
if (-not (Test-Path "$root\node_modules")) {
  Step "node_modules missing - running npm install (first run, may take a minute)..."
  npm install
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed"; exit 1 }
} else {
  Ok "dependencies already installed"
}

# ---------------------------------------------------------------------------
# 3. Build the shared contracts package
#    apps/server and apps/web resolve @ops-master/shared via its dist/
#    output, so it must be built before either can start.
# ---------------------------------------------------------------------------
Step "Building @ops-master/shared..."
npm run build -w @ops-master/shared
if ($LASTEXITCODE -ne 0) { Fail "building @ops-master/shared failed"; exit 1 }
Ok "shared contracts built"

# ---------------------------------------------------------------------------
# 4. Ensure a working local server .env exists (mock mode, no keys required)
# ---------------------------------------------------------------------------
$envPath = "$root\apps\server\.env"
if (-not (Test-Path $envPath)) {
  Step "apps/server/.env missing - creating a local, mock-mode default (no API keys required to start)"
  $envLines = @(
    "# Auto-generated by start-app.ps1 - safe local defaults, runs fully offline.",
    "# Fill in real values any time; see apps/server/.env.example for details.",
    "ANTHROPIC_API_KEY=",
    "ANTHROPIC_MODEL=claude-sonnet-4-5",
    "MOCK_LLM=true",
    "",
    "SUPABASE_URL=",
    "SUPABASE_SERVICE_ROLE_KEY=",
    "",
    "DEPLOY_TARGET=compose",
    "DEPLOYMENTS_DIR=./deployments",
    "MOCK_DEPLOY=auto",
    "SKIP_LOAD_TEST=true",
    "",
    "PORT=4100",
    "APPROVAL_TIMEOUT_MINUTES=30"
  )
  Set-Content -Path $envPath -Value $envLines -Encoding utf8
  Ok "created apps/server/.env (mock mode)"
} else {
  Ok "apps/server/.env already present"
}

# ---------------------------------------------------------------------------
# 5. Stop any previous instance started by this script, then launch fresh
# ---------------------------------------------------------------------------
$runDir = "$root\.run"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
& "$root\stop-app.ps1" -Quiet

# Node's bundled CA list doesn't include roots that only the OS trusts (e.g.
# a corporate TLS-inspecting proxy/firewall) - without this, any outbound
# HTTPS call the server makes (Supabase, Anthropic) can fail with
# SELF_SIGNED_CERT_IN_CHAIN even though curl/the browser work fine on the
# same machine, and an uncaught fetch failure during startup
# (rehydratePendingApprovals) kills the whole process a few seconds after
# it reports "listening". --use-system-ca makes Node trust what Windows
# already trusts, matching curl/browser behavior; it only widens trust to
# OS-trusted roots, it never disables certificate verification.
$env:NODE_OPTIONS = "--use-system-ca"

Step "Starting server (http://localhost:4100)..."
$serverProc = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c npm run dev -w @ops-master/server" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput "$runDir\server.log" -RedirectStandardError "$runDir\server.err.log"
$serverProc.Id | Set-Content "$runDir\server.pid" -Encoding ascii

Step "Starting web UI (http://localhost:5173)..."
$webProc = Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c npm run dev -w @ops-master/web" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput "$runDir\web.log" -RedirectStandardError "$runDir\web.err.log"
$webProc.Id | Set-Content "$runDir\web.pid" -Encoding ascii

# ---------------------------------------------------------------------------
# 6. Wait for the server to report healthy
# ---------------------------------------------------------------------------
Step "Waiting for server to become healthy..."
$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $resp = Invoke-RestMethod -Uri "http://localhost:4100/api/health" -TimeoutSec 2
    if ($resp.ok) { $healthy = $true; break }
  } catch {}
}

Write-Host ""
if ($healthy) {
  Ok "Ops Master Agent is running"
} else {
  Warn "server did not report healthy within 20s - check .run\server.log and .run\server.err.log"
}
Write-Host "  Web UI:  http://localhost:5173" -ForegroundColor White
Write-Host "  Server:  http://localhost:4100/api/health" -ForegroundColor White
Write-Host "  Logs:    .run\server.log / .run\web.log"
Write-Host "  Stop:    .\stop-app.ps1"
Write-Host ""

if (-not $NoBrowser -and $healthy) {
  Start-Process "http://localhost:5173"
}
