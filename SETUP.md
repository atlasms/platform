# Setting up Atlas on a new machine

Everything a developer does by hand to go from an empty machine to a running platform: the unit
suites, the local Kubernetes cluster with all services, the smoke suite green, and Studio signed
in. **`scripts/setup.sh` (Linux/macOS/Git Bash) and `scripts/setup.ps1` (Windows PowerShell 7)
automate every step below**, starting with the requirements check — read this file once to know
what they do, then run one of them.

This is the _development_ environment. Production installation, upgrade and DR are in the
[operations runbook](docs/operations/17-operations-runbook.md); sizing for a deployment tier is
in [hardware requirements](docs/requirements/07-hardware-requirements.md).

## 1. Minimum requirements

### Hardware

The whole platform runs on one machine inside Docker: a single-node kind cluster hosting Postgres,
NATS JetStream, OpenSearch (a JVM with a 512 MB heap, a ~1 GB image), seven Node services, and —
outside the cluster — the Angular dev server and the test runners. The cluster's pods request about
4 GB between them; the rest is the OS, Docker itself, your editor and Node.

|         | Minimum                                        | Recommended                                   |
| ------- | ---------------------------------------------- | --------------------------------------------- |
| CPU     | 4 cores, x86-64 or arm64                       | 8 cores                                       |
| RAM     | **8 GB**, with **6 GB** given to the Docker VM | 16 GB, 8 GB to the Docker VM                  |
| Disk    | **25 GB free** (SSD)                           | 40 GB free — images, volumes and caches grow  |
| Network | Broadband for the first setup (~3 GB pulled)   | —                                             |
| OS      | Windows 11 (WSL 2), macOS 13+, Ubuntu 22.04+   | Whatever the team runs; CI is `ubuntu-latest` |

On Windows and macOS the Docker VM's memory is a setting (Docker Desktop → Resources), not what
the host has: with the default 2 GB the OpenSearch pod is evicted and nothing behind the gateway
reaches readiness.

### Software

| Tool                       | Version                      | Why this version                                                                                                                                                                                                      |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Git**                    | ≥ 2.40                       | `.gitattributes` normalises to LF; Windows checkouts need a Git that honours it.                                                                                                                                      |
| **Node.js**                | **≥ 24.0** (`engines`)       | The code is TypeScript that Node **strips natively** (no build step, anywhere); it uses `node:sqlite` and `node:test`. Node 22 cannot run it. Docker images use `node:24-alpine`.                                     |
| **npm**                    | ≥ 11 (ships with Node 24)    | `package-lock.json` is lockfile v3; `npm ci` is what CI and `lock:check` run.                                                                                                                                         |
| **Docker**                 | Engine ≥ 24 / Desktop ≥ 4.30 | Builds the service images and hosts the kind node. Desktop on Windows needs the **WSL 2** backend.                                                                                                                    |
| **kind**                   | **v0.30.0**                  | The version CI pins (`.github/workflows/smoke.yml`); a different minor changes the Kubernetes version inside the node.                                                                                                |
| **kubectl**                | ≥ 1.30                       | Within one minor of the cluster kind creates. Docker Desktop bundles one.                                                                                                                                             |
| **PowerShell 7** (Windows) | ≥ 7.2                        | For `scripts/setup.ps1`. Windows PowerShell 5.1 is not enough (`&&`, ternaries).                                                                                                                                      |
| ffmpeg / ffprobe           | any recent (optional)        | RIM's probe adapter test runs the real binary over a clip ffmpeg generates; without the tools that one test **skips** on a laptop (and **fails in CI**, which installs them). The RIM _image_ gets its own via `apk`. |
| GitHub CLI `gh`            | ≥ 2.40 (optional)            | The PR flow and `scripts/seed-github-backlog.mjs`. Not needed to build or run.                                                                                                                                        |

Nothing else: no Python, no global Nx, no Angular CLI (both come with `npm ci`), no database
installed on the host.

## 2. Install the tools

<details><summary><b>Windows 11</b></summary>

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e            # 24.x; or use fnm/nvm-windows
winget install --id Docker.DockerDesktop -e     # then enable the WSL 2 backend and give the VM ≥ 6 GB
winget install --id Kubernetes.kind -e
winget install --id Kubernetes.kubectl -e       # Docker Desktop also bundles kubectl
winget install --id Microsoft.PowerShell -e     # PowerShell 7
winget install --id Gyan.FFmpeg -e              # optional
winget install --id GitHub.cli -e               # optional
```

Log out and in again so the new `PATH` reaches every shell. Docker Desktop must be **running**
(whale in the tray) before anything below.

</details>

<details><summary><b>macOS</b></summary>

```sh
brew install git node@24 kind kubectl ffmpeg gh
brew install --cask docker     # Docker Desktop; start it, give the VM ≥ 6 GB
```

</details>

<details><summary><b>Ubuntu / Debian</b></summary>

```sh
sudo apt-get install -y git ffmpeg
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
# Docker Engine: https://docs.docker.com/engine/install/ — then `sudo usermod -aG docker $USER` and re-login
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.30.0/kind-linux-amd64 && chmod +x kind && sudo mv kind /usr/local/bin/
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && chmod +x kubectl && sudo mv kubectl /usr/local/bin/
```

</details>

Check:

```sh
git --version && node --version && npm --version && docker version && kind --version && kubectl version --client
```

## 3. Clone and install

```sh
git clone https://github.com/atlasms/platform.git atlas
cd atlas
npm ci          # NOT `npm install`: the lock file is the contract, and `lock:check` in CI enforces it
```

`npm ci` takes 2–5 minutes the first time. It installs Nx, Angular, Fastify and every workspace
package's dependencies; nothing is hoisted by hand and nothing is built.

## 4. Verify without any infrastructure

```sh
npm run verify
```

This is what CI's first job runs: the lock check, formatting, the generated-types check, the
Tier-0 enum and table-convention checks, the project graph, lint, typecheck and **every unit
suite** (AGENTS.md §3 keeps the count), on `node:sqlite` doubles and an in-memory broker. It
needs no Docker. Ten to fifteen minutes cold; Nx caches the rest.

Suites that need a real adapter — Postgres, NATS, OpenSearch, ffprobe — **skip** when their
environment variable or binary is absent, and **fail in CI** when it is, so they cannot quietly
go untested. To run them locally:

```sh
docker compose -f infra/docker-compose.dev.yml up -d postgres nats opensearch
ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas \
ATLAS_NATS_URL=nats://localhost:54222 \
ATLAS_OPENSEARCH_URL=http://localhost:59200 \
npm test
```

(PowerShell: `$env:ATLAS_PG_URL = '…'` on separate lines.) The ports are deliberately non-default
so they never collide with a Postgres you already run; [infra/README.md](infra/README.md) has the
table.

## 5. Bring up the platform

```sh
kind create cluster --config infra/k8s/kind-cluster.yaml   # once; `kind get clusters` lists it
npm run k8s:up                                              # build 7 images, load them into the node, apply the dev overlay
```

`k8s:up` is `k8s:build` + `k8s:load` + `k8s:deploy`. The first run builds every image from
`infra/docker/Dockerfile` (RIM's gets `ffmpeg`) and the node pulls OpenSearch (~1 GB) from Docker
Hub — budget ten minutes. Then wait for everything to be ready:

```sh
kubectl -n atlas rollout status statefulset/postgres --timeout=180s
kubectl -n atlas rollout status statefulset/nats --timeout=180s
kubectl -n atlas rollout status statefulset/opensearch --timeout=300s
for d in iam mam websocket api-gateway logging scheduling rim; do
  kubectl -n atlas rollout status deployment/$d --timeout=180s
done
kubectl -n atlas get pods      # all Running, 1/1
```

The gateway answers on `http://localhost:30080`, the WebSocket server on `ws://localhost:30081`
(kind maps both NodePorts to the host — `infra/k8s/kind-cluster.yaml`).

## 6. Smoke

```sh
npm run smoke      # 23 checks against the live cluster
```

The suite signs in as the dev overlay's seed account, writes through the gateway, and reads the
results back through the audit history, the WebSocket bridge, and RIM's real ffprobe. Its third
check waits for every upstream to answer _through the gateway_ (a pod is Ready before kube-proxy
has its endpoint), so it is safe to run straight after `k8s:up`.

## 7. Studio

```sh
npm start -w @atlas/studio      # http://localhost:4200
```

The dev server proxies `/auth` and `/api` to the gateway and `/ws` to the WebSocket port
([`apps/studio/proxy.conf.json`](apps/studio/proxy.conf.json)), so Studio talks to the real
cluster. Sign in with the dev seed account:

| Username | Password       | Channel | Grants                                                                    |
| -------- | -------------- | ------- | ------------------------------------------------------------------------- |
| `dev`    | `dev-password` | `ch12`  | every scope the smoke suite uses (assets, schedules, users, ingest, logs) |

The account exists only in the dev overlay ([`infra/k8s/overlays/dev/seed-user.yaml`](infra/k8s/overlays/dev/seed-user.yaml));
a real environment seeds none. Tokens live in memory only, so **a page reload signs you out** —
deliberate ([apps/studio/README.md](apps/studio/README.md#signing-in)).

## 8. Optional

- **Observability** (Prometheus, Loki, Tempo, Grafana): create the `grafana-admin` secret first
  (no default credentials ship), `npm run k8s:observability`, then
  `kubectl port-forward -n atlas-observability svc/grafana 3000:3000` —
  [infra/k8s/observability/README.md](infra/k8s/observability/README.md), [ADR-0003](docs/adr/0003-observability-stack.md).
- **GitHub**: `gh auth login`, then the PR flow in [`docs/roadmap/20-delivery-process.md`](docs/roadmap/20-delivery-process.md).
  Commit subjects must match `^(feat|fix|…)(\(scope\))?!?: .+` with **no spaces in the scope**
  (`feat(EP-10.4,EP-10.6):`) — CI checks them.
- **Editor**: the repo is formatted by Prettier (`npm run format`) and linted by ESLint; both have
  editor integrations, and both run in CI.

## 9. Day-to-day

| I changed…                             | Then                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| a library or service                   | `npx nx affected -t lint typecheck test --base=main`                                                                                        |
| a service I want to see on the cluster | `npm run k8s:up` **and** `kubectl -n atlas rollout restart deployment/<name>` — the tag does not change, so `apply` alone keeps the old pod |
| a manifest under `infra/k8s`           | `npm run k8s:check` (every overlay renders and keeps its conventions), then `npm run k8s:deploy`                                            |
| an OpenAPI file or a JSON Schema       | `npm run api:types`, and a `libs/contracts/CHANGELOG.md` entry for a schema                                                                 |
| everything, before a PR                | `npm run verify && npm run smoke`                                                                                                           |

Tear down: `kind delete cluster --name atlas-dev` (the cluster and its volumes),
`docker compose -f infra/docker-compose.dev.yml down -v` (the compose data).

## 10. Troubleshooting

| Symptom                                                                             | Cause → fix                                                                                                                            |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SyntaxError` / `ERR_UNKNOWN_FILE_EXTENSION ".ts"` running anything                 | Node < 24. `node --version`.                                                                                                           |
| `npm ci` says the lock file is out of sync                                          | Someone ran `npm install` with a different npm. Use npm ≥ 11; never commit a lock file from `npm install`.                             |
| `failed to connect to the docker API` / `Cannot connect to the Docker daemon`       | Docker Desktop is not running, or your user is not in the `docker` group (Linux).                                                      |
| `kind create cluster` hangs or the node is `NotReady`                               | The Docker VM has too little memory. Give it ≥ 6 GB and recreate the cluster.                                                          |
| `opensearch-0` stays `Pending`/`Evicted`, gateway readiness fails                   | Same: memory. Also the first start is a ~1 GB pull — `rollout status statefulset/opensearch --timeout=300s`.                           |
| `kind load docker-image` refuses OpenSearch (`ctr: content digest … not found`)     | Docker Desktop's containerd image store. Only the images this repo builds are loaded; the node pulls OpenSearch itself. Nothing to do. |
| I rebuilt a service but the cluster runs old code                                   | `imagePullPolicy: IfNotPresent` and an unchanged tag. `kubectl -n atlas rollout restart deployment/<name>` after `k8s:load`.           |
| Smoke: `502 upstream "mam" unreachable` on the first request                        | kube-proxy had not programmed the endpoint yet. The suite's gate covers it; rerun.                                                     |
| Smoke: all 23 tests skip                                                            | The seed account's login returned 401 — the dev overlay is not applied, or `iam` is not ready.                                         |
| A port is taken: 30080, 30081 (cluster), 4200 (Studio), 55432/54222/59200 (compose) | Another Atlas checkout or an unrelated process. `kind delete cluster --name atlas-dev`, or stop the other process.                     |
| `format:check` fails on files I did not touch (Windows)                             | CRLF checkout. `git config core.autocrlf false` and re-checkout; `.gitattributes` keeps the repo LF.                                   |
| RIM's `probe.test.ts` is skipped                                                    | No `ffmpeg` on the PATH. Fine locally; CI installs it.                                                                                 |
