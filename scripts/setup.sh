#!/usr/bin/env bash
# Atlas — full development setup on a fresh machine (SETUP.md, automated).
#
#   scripts/setup.sh                 check requirements, install, verify, cluster, deploy, smoke
#   scripts/setup.sh --check         requirements only; exit 1 if something is missing
#   scripts/setup.sh --no-cluster    stop after `npm run verify` (no Docker needed)
#   scripts/setup.sh --skip-verify   skip the unit suites (you just ran them)
#   scripts/setup.sh --no-smoke      deploy but do not run the smoke suite
#   scripts/setup.sh --compose       also start infra/docker-compose.dev.yml and run the adapter suites
#
# Idempotent: every step checks before it acts (a cluster that exists is kept, `npm ci` is what it
# is). Linux, macOS and Git Bash on Windows; scripts/setup.ps1 is the same for PowerShell 7.
# Requirement thresholds mirror SETUP.md §1 — change them there first.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK_ONLY=false
NO_CLUSTER=false
SKIP_VERIFY=false
NO_SMOKE=false
COMPOSE=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --no-cluster) NO_CLUSTER=true ;;
    --skip-verify) SKIP_VERIFY=true ;;
    --no-smoke) NO_SMOKE=true ;;
    --compose) COMPOSE=true ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- thresholds (SETUP.md §1) --------------------------------------------------------------
MIN_NODE=24
MIN_NPM=11
MIN_GIT_MINOR=40          # 2.40
MIN_DOCKER=24
KIND_PINNED=0.30.0
MIN_KUBECTL_MINOR=30      # 1.30
MIN_CPU=4
MIN_RAM_GB=8
MIN_DISK_GB=25
MIN_DOCKER_VM_GB=6

CLUSTER=atlas-dev
SERVICES="iam mam websocket api-gateway logging scheduling rim"

# --- output -----------------------------------------------------------------------------------
failures=0
warnings=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf '  \033[31m✖\033[0m %s\n' "$*"; failures=$((failures + 1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }
# "v24.16.0" → 24 ; "2.47.1.windows.1" → 2 47
major() { echo "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'; }
minor() { echo "$1" | sed -E 's/^[^0-9]*[0-9]+\.([0-9]+).*/\1/'; }

# --- 1. requirements ------------------------------------------------------------------------------
step "Requirements (SETUP.md §1)"

if have git; then
  v=$(git --version | sed -E 's/git version //')
  if [ "$(major "$v")" -gt 2 ] || { [ "$(major "$v")" -eq 2 ] && [ "$(minor "$v")" -ge $MIN_GIT_MINOR ]; }; then
    ok "git $v"
  else fail "git $v — need ≥ 2.$MIN_GIT_MINOR"; fi
else fail "git not found"; fi

if have node; then
  v=$(node --version)
  if [ "$(major "$v")" -ge $MIN_NODE ]; then ok "node $v"; else fail "node $v — need ≥ $MIN_NODE (the code is strip-only TypeScript; Node 22 cannot run it)"; fi
else fail "node not found — install Node.js ≥ $MIN_NODE"; fi

if have npm; then
  v=$(npm --version)
  if [ "$(major "$v")" -ge $MIN_NPM ]; then ok "npm $v"; else fail "npm $v — need ≥ $MIN_NPM (lockfile v3)"; fi
else fail "npm not found"; fi

if have docker; then
  # `docker --version` needs no daemon; `docker version` fails when it is down.
  v=$(docker --version | sed -E 's/Docker version ([^,]+),.*/\1/')
  if [ "$(major "$v")" -ge $MIN_DOCKER ]; then ok "docker $v"; else fail "docker $v — need ≥ $MIN_DOCKER"; fi
  if docker info >/dev/null 2>&1; then
    ok "docker daemon reachable"
    # The VM's memory is what the cluster actually gets on Docker Desktop.
    vm_bytes=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
    vm_gb=$((vm_bytes / 1024 / 1024 / 1024))
    if [ "$vm_gb" -ge $MIN_DOCKER_VM_GB ]; then ok "docker VM memory ${vm_gb} GB"
    elif [ "$vm_bytes" -gt 0 ]; then fail "docker VM memory ${vm_gb} GB — give Docker ≥ ${MIN_DOCKER_VM_GB} GB (Docker Desktop → Resources), or OpenSearch is evicted"
    fi
  else
    fail "docker daemon not reachable — start Docker Desktop / dockerd, and be in the docker group on Linux"
  fi
else fail "docker not found"; fi

if have kind; then
  v=$(kind --version | sed -E 's/kind version v?//')
  if [ "$v" = "$KIND_PINNED" ]; then ok "kind $v"; else warn "kind $v — CI pins $KIND_PINNED; the Kubernetes version inside the node differs"; fi
else fail "kind not found — v$KIND_PINNED, https://kind.sigs.k8s.io"; fi

if have kubectl; then
  v=$(kubectl version --client -o json 2>/dev/null | sed -nE 's/.*"gitVersion": *"v([0-9.]+)".*/\1/p' | head -1)
  [ -n "$v" ] || v=$(kubectl version --client 2>/dev/null | sed -nE 's/.*v([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)
  if [ -n "$v" ] && [ "$(minor "$v")" -ge $MIN_KUBECTL_MINOR ]; then ok "kubectl $v"; else fail "kubectl ${v:-?} — need ≥ 1.$MIN_KUBECTL_MINOR"; fi
else fail "kubectl not found"; fi

if have ffprobe; then ok "ffprobe $(ffprobe -version 2>/dev/null | head -1 | sed -E 's/ffprobe version ([^ ]+).*/\1/') (RIM's probe test will run)"
else warn "ffprobe not found — RIM's probe adapter test skips locally (CI installs ffmpeg)"; fi
if have gh; then ok "gh $(gh --version | head -1 | sed -E 's/gh version ([^ ]+).*/\1/')"; else warn "gh not found — optional, for the PR flow"; fi

# hardware
case "$(uname -s)" in
  Darwin*) cpus=$(sysctl -n hw.ncpu); ram_gb=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )) ;;
  # Linux, and Git Bash on Windows (MSYS provides /proc/meminfo too).
  *)       cpus=$(nproc 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-0}")
           ram_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 / 1024 )) ;;
esac
if [ "${cpus:-0}" -ge $MIN_CPU ]; then ok "$cpus CPUs"; else fail "$cpus CPUs — need ≥ $MIN_CPU"; fi
if [ "${ram_gb:-0}" -ge $MIN_RAM_GB ]; then ok "${ram_gb} GB RAM"; else fail "${ram_gb} GB RAM — need ≥ $MIN_RAM_GB"; fi
disk_gb=$(df -Pk "$ROOT" | awk 'NR==2 {print int($4/1024/1024)}')
if [ "${disk_gb:-0}" -ge $MIN_DISK_GB ]; then ok "${disk_gb} GB free on this volume"; else fail "${disk_gb} GB free — need ≥ $MIN_DISK_GB"; fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures requirement(s) not met — see SETUP.md §1–2." >&2
  exit 1
fi
[ "$warnings" -gt 0 ] && echo "  ($warnings warning(s); optional tools)"
if $CHECK_ONLY; then echo; echo "Requirements OK."; exit 0; fi

# --- 2. install ---------------------------------------------------------------------------------------
step "npm ci"
npm ci

# --- 3. verify ----------------------------------------------------------------------------------------
if ! $SKIP_VERIFY; then
  step "npm run verify (lint, typecheck, every unit suite — no infrastructure)"
  npm run verify
fi

# --- 4. optional: the compose infrastructure and the adapter suites ----------------------------------
if $COMPOSE; then
  step "docker compose: postgres, nats, opensearch — and the adapter suites against them"
  docker compose -f infra/docker-compose.dev.yml up -d postgres nats opensearch
  for i in $(seq 1 60); do
    if docker compose -f infra/docker-compose.dev.yml ps --format '{{.Health}}' postgres nats opensearch 2>/dev/null | grep -qv healthy; then sleep 3; else break; fi
    [ "$i" -eq 60 ] && { fail "compose services did not become healthy"; exit 1; }
  done
  ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas \
  ATLAS_NATS_URL=nats://localhost:54222 \
  ATLAS_OPENSEARCH_URL=http://localhost:59200 \
  npm test
fi

if $NO_CLUSTER; then echo; echo "Done (no cluster). SETUP.md §5 for the platform."; exit 0; fi

# --- 5. the cluster -----------------------------------------------------------------------------------
step "kind cluster '$CLUSTER'"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  ok "exists — kept (kind delete cluster --name $CLUSTER to start over)"
else
  kind create cluster --config infra/k8s/kind-cluster.yaml
fi
kubectl cluster-info --context "kind-$CLUSTER" >/dev/null

step "npm run k8s:up (build 7 images, load, apply the dev overlay)"
npm run k8s:up

step "waiting for rollouts"
kubectl -n atlas rollout status statefulset/postgres --timeout=180s
kubectl -n atlas rollout status statefulset/nats --timeout=180s
kubectl -n atlas rollout status statefulset/opensearch --timeout=300s   # first start is a ~1 GB pull
for d in $SERVICES; do
  # A rebuilt image under the same tag is not picked up by `apply`; restart so the pod runs this build.
  kubectl -n atlas rollout restart "deployment/$d" >/dev/null
  kubectl -n atlas rollout status "deployment/$d" --timeout=180s
done
kubectl -n atlas get pods

# --- 6. smoke -----------------------------------------------------------------------------------------
if ! $NO_SMOKE; then
  step "npm run smoke"
  npm run smoke
fi

echo
echo "Atlas is up."
echo "  gateway   http://localhost:30080      websocket ws://localhost:30081"
echo "  studio    npm start -w @atlas/studio  →  http://localhost:4200   (dev / dev-password)"
echo "  tear down kind delete cluster --name $CLUSTER"
