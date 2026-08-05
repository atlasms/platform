# Kubernetes manifests

The deployment target is Kubernetes ([ADR-0002](../../docs/adr/0002-deployment-target.md)), with
Kustomize for environment variance.

```
base/                environment-independent definitions
overlays/dev/        local kind cluster — NodePort, single replicas, local images
```

## Bring up a local environment

```sh
kind create cluster --config infra/k8s/kind-cluster.yaml
npm run k8s:up            # build images, load them into the node, apply the overlay
npm run smoke             # 7 checks against http://localhost:30080
```

`npm run k8s:up` is `k8s:build` + `k8s:load` + `k8s:deploy`. Rebuild and reload after a code change:
kind has no registry, so images are pushed onto the node directly and `imagePullPolicy: IfNotPresent`
stops the kubelet chasing a tag that exists nowhere.

```sh
kubectl get pods -n atlas
kubectl logs -n atlas -l app.kubernetes.io/name=api-gateway -f
kind delete cluster --name atlas-dev
```

## What the dev overlay changes, and why each is wrong for production

| Dev                          | Production                                    |
| ---------------------------- | --------------------------------------------- |
| **NodePort** on 30080        | Ingress with TLS, host routing, rate limiting |
| **1 gateway replica**        | ≥2, behind a PodDisruptionBudget              |
| **Local images, `:dev` tag** | Digests from a registry                       |
| **Plain env vars**           | Secrets, and a signing key ring IAM can share |

The NodePort is deliberately not dressed up as an ingress: simulating one would hide the TLS and
routing work rather than schedule it.

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

## Related

- [ADR-0002](../../docs/adr/0002-deployment-target.md) — why Kubernetes, and what it costs
- [`infra/docker/`](../docker/) — the image, and why there is no build step
- [operations runbook](../../docs/operations/17-operations-runbook.md) — install, upgrade, backup, DR
