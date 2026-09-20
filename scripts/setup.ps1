#requires -Version 7.2
<#
.SYNOPSIS
  Atlas — full development setup on a fresh Windows machine (SETUP.md, automated).

.DESCRIPTION
  Checks the requirements in SETUP.md §1, then: npm ci, npm run verify, the kind cluster, the
  images and the dev overlay, the rollouts, the smoke suite. Idempotent: a cluster that exists is
  kept. scripts/setup.sh is the same for bash. Requirement thresholds mirror SETUP.md §1 — change
  them there first.

.PARAMETER Check
  Requirements only; exit 1 if something is missing.
.PARAMETER NoCluster
  Stop after `npm run verify` (no Docker needed).
.PARAMETER SkipVerify
  Skip the unit suites (you just ran them).
.PARAMETER NoSmoke
  Deploy but do not run the smoke suite.
.PARAMETER Compose
  Also start infra/docker-compose.dev.yml and run the adapter suites against it.

.EXAMPLE
  pwsh scripts/setup.ps1
  pwsh scripts/setup.ps1 -Check
  pwsh scripts/setup.ps1 -NoCluster
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$NoCluster,
  [switch]$SkipVerify,
  [switch]$NoSmoke,
  [switch]$Compose
)

$ErrorActionPreference = 'Stop'
# Native exit codes are checked by hand (`Run` below): a probe like `docker info` must be allowed to fail.
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # the ✔/✖ below, on a console still on a code page
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

# --- thresholds (SETUP.md §1) --------------------------------------------------------------
$MinNode = 24
$MinNpm = 11
$MinGit = [version]'2.40'
$MinDocker = 24
$KindPinned = '0.30.0'
$MinKubectl = [version]'1.30'
$MinCpu = 4
$MinRamGb = 8
$MinDiskGb = 25
$MinDockerVmGb = 6

$Cluster = 'atlas-dev'
$Services = 'iam', 'mam', 'websocket', 'api-gateway', 'logging', 'scheduling', 'rim'

# --- output -----------------------------------------------------------------------------------
$script:failures = 0
$script:warnings = 0
function Ok($m)   { Write-Host "  ✔ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow; $script:warnings++ }
function Fail($m) { Write-Host "  ✖ $m" -ForegroundColor Red; $script:failures++ }
function Step($m) { Write-Host "`n== $m" -ForegroundColor White }
function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }
# "v24.16.0" → [version]24.16.0 ; "2.47.1.windows.1" → 2.47.1
function Ver($text) {
  if ($text -match '(\d+)\.(\d+)(?:\.(\d+))?') {
    $patch = if ($Matches[3]) { $Matches[3] } else { '0' }
    return [version]"$($Matches[1]).$($Matches[2]).$patch"
  }
  return $null
}
# A native command whose non-zero exit must not stop the script (Stop only fires for cmdlets).
function Run { param([scriptblock]$Block) & $Block; if ($LASTEXITCODE -ne 0) { throw "command failed ($LASTEXITCODE): $Block" } }

# --- 1. requirements ------------------------------------------------------------------------------
Step 'Requirements (SETUP.md §1)'

if (Have git) {
  $v = Ver (git --version)
  if ($v -ge $MinGit) { Ok "git $v" } else { Fail "git $v — need ≥ $MinGit" }
} else { Fail 'git not found' }

if (Have node) {
  $v = Ver (node --version)
  if ($v.Major -ge $MinNode) { Ok "node $v" } else { Fail "node $v — need ≥ $MinNode (the code is strip-only TypeScript; Node 22 cannot run it)" }
} else { Fail "node not found — install Node.js ≥ $MinNode" }

if (Have npm) {
  $v = Ver (npm --version)
  if ($v.Major -ge $MinNpm) { Ok "npm $v" } else { Fail "npm $v — need ≥ $MinNpm (lockfile v3)" }
} else { Fail 'npm not found' }

if (Have docker) {
  $v = Ver (docker --version)
  if ($v.Major -ge $MinDocker) { Ok "docker $v" } else { Fail "docker $v — need ≥ $MinDocker" }
  docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    Ok 'docker daemon reachable'
    # The VM's memory is what the cluster actually gets on Docker Desktop.
    $vmBytes = [long](docker info --format '{{.MemTotal}}' 2>$null)
    $vmGb = [math]::Floor($vmBytes / 1GB)
    if ($vmGb -ge $MinDockerVmGb) { Ok "docker VM memory $vmGb GB" }
    elseif ($vmBytes -gt 0) { Fail "docker VM memory $vmGb GB — give Docker ≥ $MinDockerVmGb GB (Docker Desktop → Settings → Resources), or OpenSearch is evicted" }
  } else {
    Fail 'docker daemon not reachable — start Docker Desktop (WSL 2 backend)'
  }
} else { Fail 'docker not found — Docker Desktop with the WSL 2 backend' }

if (Have kind) {
  $v = Ver (kind --version)
  if ("$v" -eq $KindPinned) { Ok "kind $v" } else { Warn "kind $v — CI pins $KindPinned; the Kubernetes version inside the node differs" }
} else { Fail "kind not found — v$KindPinned, winget install Kubernetes.kind" }

if (Have kubectl) {
  $v = Ver ((kubectl version --client 2>$null) -join ' ')
  if ($v -and $v -ge $MinKubectl) { Ok "kubectl $v" } else { Fail "kubectl $v — need ≥ $MinKubectl" }
} else { Fail 'kubectl not found — winget install Kubernetes.kubectl' }

if (Have ffprobe) { Ok "ffprobe $(Ver ((ffprobe -version 2>$null) | Select-Object -First 1)) (RIM's probe test will run)" }
else { Warn 'ffprobe not found — RIM''s probe adapter test skips locally (CI installs ffmpeg); winget install Gyan.FFmpeg' }
if (Have gh) { Ok "gh $(Ver ((gh --version) | Select-Object -First 1))" } else { Warn 'gh not found — optional, for the PR flow' }

# hardware
$cpus = [Environment]::ProcessorCount
$ramGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$drive = (Get-Item $root).PSDrive
$diskGb = [math]::Floor($drive.Free / 1GB)
if ($cpus -ge $MinCpu) { Ok "$cpus CPUs" } else { Fail "$cpus CPUs — need ≥ $MinCpu" }
if ($ramGb -ge $MinRamGb) { Ok "$ramGb GB RAM" } else { Fail "$ramGb GB RAM — need ≥ $MinRamGb" }
if ($diskGb -ge $MinDiskGb) { Ok "$diskGb GB free on $($drive.Name):" } else { Fail "$diskGb GB free on $($drive.Name): — need ≥ $MinDiskGb" }

if ($script:failures -gt 0) {
  Write-Host "`n$($script:failures) requirement(s) not met — see SETUP.md §1–2." -ForegroundColor Red
  exit 1
}
if ($script:warnings -gt 0) { Write-Host "  ($($script:warnings) warning(s); optional tools)" }
if ($Check) { Write-Host "`nRequirements OK."; exit 0 }

# --- 2. install ---------------------------------------------------------------------------------------
Step 'npm ci'
Run { npm ci }

# --- 3. verify ----------------------------------------------------------------------------------------
if (-not $SkipVerify) {
  Step 'npm run verify (lint, typecheck, every unit suite — no infrastructure)'
  Run { npm run verify }
}

# --- 4. optional: the compose infrastructure and the adapter suites ----------------------------------
if ($Compose) {
  Step 'docker compose: postgres, nats, opensearch — and the adapter suites against them'
  Run { docker compose -f infra/docker-compose.dev.yml up -d postgres nats opensearch }
  $deadline = (Get-Date).AddMinutes(3)
  do {
    $health = docker compose -f infra/docker-compose.dev.yml ps --format '{{.Health}}' postgres nats opensearch 2>$null
    if (($health | Where-Object { $_ -ne 'healthy' }).Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw 'compose services did not become healthy' }
    Start-Sleep -Seconds 3
  } while ($true)
  $env:ATLAS_PG_URL = 'postgres://atlas:atlas@localhost:55432/atlas'
  $env:ATLAS_NATS_URL = 'nats://localhost:54222'
  $env:ATLAS_OPENSEARCH_URL = 'http://localhost:59200'
  Run { npm test }
}

if ($NoCluster) { Write-Host "`nDone (no cluster). SETUP.md §5 for the platform."; exit 0 }

# --- 5. the cluster -----------------------------------------------------------------------------------
Step "kind cluster '$Cluster'"
if ((kind get clusters 2>$null) -contains $Cluster) {
  Ok "exists — kept (kind delete cluster --name $Cluster to start over)"
} else {
  Run { kind create cluster --config infra/k8s/kind-cluster.yaml }
}
Run { kubectl cluster-info --context "kind-$Cluster" *> $null }

Step 'npm run k8s:up (build 7 images, load, apply the dev overlay)'
Run { npm run k8s:up }

Step 'waiting for rollouts'
Run { kubectl -n atlas rollout status statefulset/postgres --timeout=180s }
Run { kubectl -n atlas rollout status statefulset/nats --timeout=180s }
Run { kubectl -n atlas rollout status statefulset/opensearch --timeout=300s }   # first start is a ~1 GB pull
foreach ($d in $Services) {
  # A rebuilt image under the same tag is not picked up by `apply`; restart so the pod runs this build.
  Run { kubectl -n atlas rollout restart "deployment/$d" *> $null }
  Run { kubectl -n atlas rollout status "deployment/$d" --timeout=180s }
}
kubectl -n atlas get pods

# --- 6. smoke -----------------------------------------------------------------------------------------
if (-not $NoSmoke) {
  Step 'npm run smoke'
  Run { npm run smoke }
}

Write-Host ''
Write-Host 'Atlas is up.'
Write-Host '  gateway   http://localhost:30080      websocket ws://localhost:30081'
Write-Host '  studio    npm start -w @atlas/studio  →  http://localhost:4200   (dev / dev-password)'
Write-Host "  tear down kind delete cluster --name $Cluster"
