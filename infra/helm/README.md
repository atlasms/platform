# The Atlas Helm chart

`helm install` for a customer site. The chart under [`atlas/`](atlas/) is **generated** from
[`infra/k8s/base`](../k8s/base/) by [`scripts/build-helm-chart.mjs`](../../scripts/build-helm-chart.mjs)
— see [ADR-0006](../../docs/adr/0006-helm-chart.md) for why, and read that before editing anything
in it. Changing a template by hand fails `npm run k8s:check`; change the manifest and run
`npm run helm:build`.

Our own environments still use Kustomize ([ADR-0002](../../docs/adr/0002-deployment-target.md)):
`infra/k8s/overlays/dev` for a kind cluster, `infra/k8s/overlays/staging` for the environment
shaped like production.

## Install

```sh
# The credentials first: every service reads the database through this Secret, and the chart
# refuses to render without one rather than leaving you with seven crash-looping pods.
kubectl create namespace atlas
kubectl -n atlas create secret generic postgres-credentials \
  --from-literal=username=atlas --from-literal=password="$(openssl rand -base64 24)"

helm install atlas infra/helm/atlas --namespace atlas
```

A real deployment wants an origin and a certificate:

```sh
helm install atlas infra/helm/atlas --namespace atlas \
  --set ingress.enabled=true \
  --set ingress.host=atlas.example.com \
  --set ingress.tls.secretName=atlas-tls
```

There is no seeded account: create the first administrator with the runbook's bootstrap
procedure ([operations runbook](../../docs/operations/17-operations-runbook.md)).

## What the cluster has to provide

The chart installs the platform, not the platform's surroundings:

| Needed                             | Why                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| A default StorageClass             | Postgres, NATS, OpenSearch and RIM's staging area all claim volumes            |
| An Ingress controller              | Only if `ingress.enabled` — otherwise reach the gateway by `port-forward`      |
| A certificate, or cert-manager     | `ingress.tls.secretName` names a Secret; cert-manager users add their issuer   |
| A Secret with database credentials | Or `postgres.auth.username`/`password`, which has the chart create one         |

## An air-gapped site

Mirror every image into one registry and set it once. `image.registry` applies to the data plane
too — the half a chart usually forgets:

```sh
helm install atlas ./atlas-0.1.0.tgz --namespace atlas \
  --set image.registry=registry.internal \
  --set imagePullSecrets[0].name=registry-pull
```

`npm run helm:package` produces that tarball. Nothing is fetched at render time: the chart has no
dependencies and no repository.

## Using your own data plane

Each of the three data-plane components can be left uninstalled and pointed at what the site
already runs. Nothing else changes — the services only need the address to answer:

```yaml
postgres:
  enabled: false
  host: pg.internal
  port: 5432
  database: atlas
  user: atlas
  auth:
    existingSecret: atlas-db-credentials
    userKey: user
    passwordKey: pass

nats:
  enabled: false
  host: nats.internal

opensearch:
  enabled: false
  host: search.internal
  port: 9200
```

## What is deliberately not configurable

`replicas` lists only the workloads that can scale. IAM, RIM, MTS and the data plane are pinned in
the manifests, each for a stated reason — IAM generates its signing key ring per process, RIM's
staging area and MTS's work area are ReadWriteOnce volumes until HSM provides shared storage, the
data plane is single-writer — and a value that let you raise them would be a value that breaks the
install. Scaling IAM is [EP-10](../../docs/roadmap/21-epic-breakdown.md)
work, not a values change.

A deployment with more than one replica gets a PodDisruptionBudget, by a rule rather than a list;
one with a single replica must not have one, because a budget over the only pod blocks a node
drain.

## Checks

`npm run k8s:check` (in `npm run verify` and in CI) renders every Kustomize overlay AND the chart,
and holds both to the same conventions — probes, resource requests, memory limits, a read-only
root filesystem — plus the chart's own: images from the configured registry, no seeded account, no
credential as a literal environment value, the PDB rule in both directions, no Ingress unless
asked for and TLS with `/ws` and `/` when it is. It also asserts every workload in the manifests
is in the chart, so a new service cannot be missing from it.
