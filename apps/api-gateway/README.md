# @atlas/api-gateway — the single ingress

Authenticate once, establish correlation, proxy to the owning service with a signed internal
identity header set, log access. **It adds no domain endpoints of its own.**

Spec: [api-gateway.md](../../docs/architecture/services/api-gateway.md) ·
plan: [api-gateway-plan.md](../../docs/roadmap/services/api-gateway-plan.md).

## Why downstream services do not see the JWT

The gateway verifies the token **locally against the JWKS** — it never calls IAM per request — then
forwards an internal header set:

| Header                 | Meaning                                    |
| ---------------------- | ------------------------------------------ |
| `x-atlas-user`         | authenticated subject                      |
| `x-atlas-channel`      | channel scope from the token               |
| `x-atlas-scopes`       | space-separated permissions                |
| `x-atlas-perm-version` | permission version the token was issued at |
| `x-correlation-id`     | issued if absent, **adopted** if present   |

`authorization` is deliberately **not** forwarded. Re-parsing the JWT in every service would be
duplicated trust and a second place to get verification wrong. A test pins this.

**The gateway does not make resource decisions.** It authenticates; the owning service authorizes
with the full resource context via `canEnforce` from
[`@atlas/policy`](../../libs/policy/README.md).

## Revocation beats token TTL

`minPermVersion` refuses any token below the current permission version, so a revoked grant cannot
outlive its access token ([FR-IAM-8](../../docs/requirements/05-functional-requirements.md#iam)).
It is updated from `permissions.changed`.

## Rate limiting (EP-08.3)

Two token buckets, both configurable ([§11](../../docs/architecture/services/api-gateway.md)):

| Scope         | Default   | Keyed on                          |
| ------------- | --------- | --------------------------------- |
| **address**   | 600 / min | source address, checked pre-auth  |
| **principal** | 300 / min | verified `sub`, checked post-auth |

Refusals are `429 RATE_LIMITED` with `Retry-After`, and counted as
`atlas_gateway_rate_limited_total{scope}`.

**This is not the anti-brute-force mechanism.** Atlas installs in broadcast facilities, where
everyone arrives from one public address — a source limit tight enough to stop password guessing
would lock out the gallery at shift change. Source address here means _a building_, not _a person_.
Guessing is bounded by IAM's per-account lockout
([#240](https://github.com/atlasms/platform/issues/240)), which can afford to be strict because it
is keyed on the thing under attack. `/auth` therefore carries **no** tighter default, though a
deployment whose clients have distinct addresses can set one per route.

The address limit is checked **before** the token is verified. After would leave an unlimited supply
of garbage-token requests — each costing a signature verification — never reaching a limit.

`x-forwarded-for` is **ignored** unless `ATLAS_TRUST_PROXY=true`. With the gateway exposed directly
(NodePort, no ingress in `infra/k8s/base`) that header is attacker-controlled, and honouring it lets
a client pick its own rate-limit key and rotate it per request.

### The limits are per replica

`infra/k8s/base/api-gateway.yaml` runs **2 replicas**, so the deployment tolerates **2×** what is
configured. This README previously deferred the whole story for that reason — _"wants a shared store
to be correct across replicas"_ — which was the wrong call twice over:

- A cluster-wide counter needs Redis or equivalent. That is **new infrastructure and an ADR**, not a
  config change, and waiting for it left the gateway with **no limit at all**. Bounded at 2× beats
  unbounded, and an operator who wants a precise ceiling halves the setting.
- The **request-size** half never needed shared state, and deferring it alongside left a live bug:
  an oversized body returned **500** rather than 413 (see below).

The startup log states the per-replica caveat, so an operator who sets 600 and measures 1200 finds
the explanation without reading source.

## Request-size limits

`ATLAS_BODY_LIMIT_BYTES` (default 1 MiB) → `413 PAYLOAD_TOO_LARGE`.

Fastify enforced its own 1 MiB default all along, but raised `FST_ERR_CTP_BODY_TOO_LARGE`, which
`toProblem` did not recognise and mapped to `INTERNAL`/**500** — telling the caller the server had
failed, and putting a 5xx on the error-rate dashboard for what is squarely a client error.

## The aggregated reference snapshot (EP-08.5)

`GET /api/v1/reference` is the **one path the gateway answers itself** rather than proxying, and it
earns the exception: the aggregate does not exist in any single service, so there is nothing to
forward it to.

Each owning service serves its own (EP-04.8); this fans out, merges, and returns one document — so
Studio holds one snapshot rather than one per service and revalidates once rather than N times.

- **`configVersion` is the SUM** of the contributors. Monotonic because each contributor is, and
  collision-free for the same reason: two combinations can only share a sum if one contributor went
  _down_, which a persisted counter never does. That is why EP-04.8 persists MAM's rather than
  keeping it in memory.
- **`sources` names each contributor's own version**, so an operator can see _which_ service moved.
- Authentication happens at the gateway; the established identity is **forwarded**, so each upstream
  applies its own authorization. The gateway does not decide who may read MAM's tags — MAM does.

### A partial snapshot is never served

If any contributor is unreachable the whole request is **503**, naming the service:

```json
{
  "code": "INTERNAL",
  "status": 503,
  "message": "reference source \"mam\" is unavailable: fetch failed"
}
```

The snapshot is what validation reads
([§5 step 4](../../docs/architecture/configuration-and-reference-data.md)), so a missing service does
not degrade the answer — it _changes_ it: "is this a known classification?" starts returning no for
every term that service owned, and valid writes get rejected.

A client cannot tell a partial snapshot from a complete one. It **can** tell a failure, and
`SnapshotClient` already keeps the last good snapshot when a refresh fails — which is exactly
[FR-PLat-7](../../docs/requirements/05-functional-requirements.md#platform)'s _"a stale snapshot
keeps the system fully operational"_. Failing hands the situation to the one component equipped
for it.

## Failure shapes

- **Unrouted path** → `404 NOT_FOUND`, as a problem+JSON body.
- **Unreachable upstream** → `502` naming the service, not a mystery 500.
- **Over the rate limit** → `429 RATE_LIMITED` with `Retry-After` (never `0`).
- **Body over the cap** → `413 PAYLOAD_TOO_LARGE`.
- **Every response** — including 401/404/429 — carries a correlation id and produces an access-log
  record. An unroutable request is still traceable.

## Tests

```bash
npx nx test @atlas/api-gateway   # 47 tests
```

Headless throughout via `app.inject()`: no ports, no sockets, no flakiness. `fetch` is injected so
the forwarded identity can be asserted directly, and the limiter takes an injected clock so refill
behaviour is asserted without sleeping.

## Not implemented yet

- **BFF views** (`/api/v1/bff/{view}`) — needs MAM/HSM/MTS to exist.
- **Cluster-wide** rate limiting — see the per-replica note above; wants a shared counter and an ADR.
