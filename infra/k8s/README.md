# Kubernetes manifests

The deployment target is Kubernetes ([ADR-0002](../../docs/adr/0002-deployment-target.md)), with
Kustomize for environment variance.

```
base/                environment-independent definitions
overlays/dev/        local kind cluster — NodePort, single replicas, local images
overlays/staging/    the production shape — registry images, an Ingress, PDBs, sized data plane
```

## Bring up a local environment

```sh
kind create cluster --config infra/k8s/kind-cluster.yaml
npm run k8s:up            # build images, load them into the node, apply the overlay
npm run smoke             # 24 checks against http://localhost:30080 (and ws://localhost:30081)
```

`npm run k8s:up` is `k8s:build` + `k8s:load` + `k8s:deploy`. Rebuild and reload after a code change:
kind has no registry, so images are pushed onto the node directly and `imagePullPolicy: IfNotPresent`
stops the kubelet chasing a tag that exists nowhere.

> ⚠️ **`kubectl apply` alone will not pick up a rebuilt image.** The tag does not change and
> `IfNotPresent` means the kubelet keeps what it has, so the old pod keeps running and you test
> stale code while believing otherwise. `kubectl -n atlas rollout restart deployment/<name>` after
> `k8s:load`, or delete the pod.

> ⚠️ **OpenSearch is a ~1 GB image the node pulls from Docker Hub on first use** — `k8s:load`
> only pushes the images this repo builds, and `kind load docker-image` refuses this one under
> Docker Desktop's containerd image store (`ctr: content digest … not found`). The first
> `opensearch-0` start is a pull; `rollout status statefulset/opensearch --timeout=300s` covers it.
> An air-gapped bundle ships the image and loads it with `kind load image-archive`.

> ⚠️ **`rollout status` returning is not "reachable through the Service".** The pod is Ready a few
> hundred milliseconds to a couple of seconds before kube-proxy has programmed its endpoint, and a
> request through the gateway in that window is `502 upstream "mam" unreachable`. The smoke suite
> gates on it (third test, 30 s budget) rather than the workflow, because `npm run smoke` straight
> after `k8s:up` has the same race on a laptop.

**CI runs all of this** ([`smoke.yml`](../../.github/workflows/smoke.yml)) on every push to `main`
and on any PR touching `infra/`, the npm scripts or a service `main.ts`. It uses these same
scripts and this same cluster config on purpose: a bespoke build loop in CI could stay correct
while the ones a developer runs rot, which is how #298 happened — `k8s:up` deployed a websocket
image it had never built, and every unit test was green.

```sh
kubectl get pods -n atlas
kubectl logs -n atlas -l app.kubernetes.io/name=api-gateway -f
kind delete cluster --name atlas-dev
```

## What the dev overlay changes, and why each is wrong for production

| Dev                            | Production                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| **NodePorts** on 30080 / 30081 | ONE ingress: /ws to the websocket service, the rest to the gateway |
| **1 gateway replica**          | ≥2, behind a PodDisruptionBudget                                   |
| **Local images, `:dev` tag**   | Digests from a registry                                            |
| **Plain env vars**             | Secrets, and a signing key ring IAM can share                      |

The NodePort is deliberately not dressed up as an ingress: simulating one would hide the TLS and
routing work rather than schedule it.

## The staging overlay (EP-07.5): the production shape, as code

`overlays/staging` is the first environment shaped like production, and the one an install is
copied from. It differs from dev in exactly the rows of the table above: images come from a
**registry by release tag** (`registry.example` is the placeholder, replaced once; CD pins a digest
with `kustomize edit set image atlas/iam=registry/atlas/iam@sha256:…`), the gateway and MAM run at
the base's **two replicas behind PodDisruptionBudgets**, the data plane has **real sizes** (Postgres
50 Gi/4 Gi, OpenSearch 100 Gi/4 Gi, NATS 20 Gi, RIM's staging 200 Gi), the credentials are a Secret
**generated from a file git never sees** (`postgres.env`, copied from the committed `.example`; a
secrets backend replaces the generator with the Secret it manages — the base only ever names
`postgres-credentials`), the platform is reached through **one Ingress with TLS** (`/ws` to the
websocket service, `/` to the gateway; ingress-nginx annotations for the upgrade's idle timeout
and a body cap above the gateway's), and there is **no seeded account**.

```sh
cp infra/k8s/overlays/staging/postgres.env.example infra/k8s/overlays/staging/postgres.env   # then edit
kubectl apply -k infra/k8s/overlays/staging
```

**`npm run k8s:check`** ([`scripts/check-k8s.mjs`](../../scripts/check-k8s.mjs), part of
`verify` and CI) renders every overlay with `kubectl kustomize` — so a patch whose path moved
fails in CI, not on the cluster — and asserts the conventions on the rendered documents: every
Atlas workload has both probes, cpu and memory requests and a memory limit, and every service
runs with a read-only root filesystem; and staging is shaped like production — a registry and a
release tag or digest on every image (never `:dev`), no NodePort, no `ATLAS_SEED_*`, exactly one
Ingress with TLS routing `/ws` and `/`, a PDB for every deployment with more than one replica,
and the credentials Secret generated. The dev overlay keeps its shortcuts; that is what it is for.

Not here: the cluster itself, storage classes, DNS and the TLS certificate — those are the
environment's (a managed cluster, or the runbook's on-prem install), and ADR-0002 keeps the
toolchain at `kubectl`. IAM still runs one replica everywhere: its signing key ring is per
process until it is loaded from a Secret.

## Why the WebSocket service has its own port

It does **not** sit behind the gateway. The gateway proxies with `fetch`, which cannot perform a
protocol upgrade, so `/ws` was never going to be another row in its routing table — and teaching it
to pipe raw sockets was the worse of the two options. This service authenticates its own tokens
already (websocket.md §10 requires validation at upgrade, so the gateway would add no security to
this path), a stateless proxy tier would hold a second socket open for the life of every connection,
and §8 wants connections sticky per node, which an ingress addressing pods directly makes easier
rather than harder.

**In production that is one ingress and one origin**: a path rule sends `/ws` to `websocket` and
everything else to `api-gateway`. The browser never learns there are two backends. The second
NodePort exists only because kind has no ingress controller, and Studio's dev proxy hides it again —
[`apps/studio/proxy.conf.json`](../../apps/studio/proxy.conf.json) forwards `/ws` to 30081 with
`"ws": true`, so the application code sees one origin in both environments.

One consequence worth stating: WebSocket connections do **not** pass through the gateway's rate
limiting (EP-08.3). What bounds them instead are the service's own caps — `ATLAS_WS_MAX_CONNECTIONS`
node-wide (503) and `ATLAS_WS_MAX_PER_USER` per principal (429), the same two axes the gateway
splits its own limits along.

## Deliberate choices in `base/`

**IAM is pinned to one replica, and that is correctness, not capacity.** It generates its signing
key ring per process, so a second replica would mint tokens the first cannot verify. Scaling it
requires loading the ring from a Secret (EP-10).

**No CPU limits, memory limits everywhere.** CPU is compressible — a limit throttles a service that
is merely busy, adding latency for no safety. Memory is not: an unbounded leak takes the node with
it.

**Liveness and readiness ask different questions.** Liveness is "is this process wedged?", and
restarting is the only cure — so it must not depend on anything external, or a dependency outage
becomes a cluster-wide restart loop. Readiness is "should traffic come here?", and that _does_
include dependencies: the gateway reports not-ready when it cannot reach IAM, because without IAM
it cannot verify a single token.

**`terminationGracePeriodSeconds: 30`** with signal handling in each `main.ts`. Kubernetes stops
routing and sends SIGTERM at the same moment, so a request already in flight can still arrive;
draining Fastify is what stops every rollout dropping requests.

**Containers run as non-root with a read-only root filesystem and all capabilities dropped.**

**One Postgres database, a schema per service** (EP-07.6). Every service opens its pool on its own
schema — `ATLAS_PG_SCHEMA`, default the service name — so `outbox`, `seen`, `_migrations` and the
domain tables are the service's, not the database's. A dev cluster that ran the platform before
this carries the old tables in `public`, orphaned and unread — but the **audit index is not
orphaned**: the projector resumes from the index's own `max(seq)`, and a fresh `logging` schema
starts `seq` at 1, so against the old index it believes it is caught up and `GET /logs` goes quiet.
`kind delete cluster` is the clean-up; short of that, delete the index and restart the sink
(`kubectl -n atlas exec opensearch-0 -- curl -s -X DELETE localhost:9200/atlas-audit`) — the
rebuild is the operation ADR-0005 designed for.

## Shipping to an air-gapped site

```sh
npm run bundle -- --version 0.1.0
```

Produces a self-contained directory with image tarballs, **rendered** manifests, checksums and an
installer that needs no network and no kustomize — see
[the offline bundle](../../docs/operations/offline-bundle.md).

## Related

- [ADR-0002](../../docs/adr/0002-deployment-target.md) — why Kubernetes, and what it costs
- [`infra/docker/`](../docker/) — the image, and why there is no build step
- [operations runbook](../../docs/operations/17-operations-runbook.md) — install, upgrade, backup, DR
