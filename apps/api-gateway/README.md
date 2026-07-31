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

## Failure shapes

- **Unrouted path** → `404 NOT_FOUND`, as a problem+JSON body.
- **Unreachable upstream** → `502` naming the service, not a mystery 500.
- **Every response** — including 401/404 — carries a correlation id and produces an access-log
  record. An unroutable request is still traceable.

## Tests

```bash
npx nx test @atlas/api-gateway   # 13 tests
```

Headless throughout via `app.inject()`: no ports, no sockets, no flakiness. `fetch` is injected so
the forwarded identity can be asserted directly.

## Not implemented yet

- **EP-08.3** rate limiting / request-size limits — wants a shared store to be correct across
  replicas, so it belongs with the data plane rather than in-memory here.
- **EP-08.5** aggregated `GET /reference` — needs services to aggregate from.
- **BFF views** (`/api/v1/bff/{view}`) — needs MAM/HSM/MTS to exist.
