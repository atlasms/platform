# @atlas/http-edge — the HTTP edge pattern

The synchronous edge for a service, shown on [`mam-service`](../mam-service/README.md): a thin Fastify
app where every cross-cutting concern comes from [`service-kit`](../service-kit/README.md) and routes
delegate to the domain service. The same shape fits any service (system plan §6).

## What [`buildApp`](src/app.ts) wires

- **Correlation** — adopt an incoming `x-correlation-id` (if a valid ULID) or mint one; echo it on the
  response and thread it through `runWithContext` so logs *and the emitted domain events* carry it.
- **Auth** — `verifyJwt` against a JWKS on protected routes; `requirePermission` for authorization.
- **Errors** — one `setErrorHandler` maps the whole surface: `AppError` → problem+JSON with its status;
  unknown → 500.
- **Routes** — public `GET /healthz` / `GET /readyz`; `GET /assets/:id`; `POST /assets/:id/approve|reject`.

## Run

```bash
# from reference/ (shared dep root): npm install once, then:
cd http-edge && node --import tsx --test test/http-edge.test.ts   # 7 tests (via Fastify inject(), no port)
```

## Tests prove (headless, via `app.inject()`)

- health endpoints are public and return liveness/readiness;
- `GET /assets/:id` returns the asset, or a **404 problem** (`code: NOT_FOUND`) for a miss;
- approve **without a token → 401** (`UNAUTHORIZED`) — with the correlation header set even on the failure path;
- approve **without the permission → 403** (`FORBIDDEN`);
- approve with a **valid token + permission → 200**, and the asset is approved + `asset.approved` emitted;
- an **incoming ULID `x-correlation-id` threads from the HTTP header onto the emitted domain event**;
- reject with a valid token → 200.

## Note

Tested with Fastify's `inject()` — no port is bound, so it runs anywhere. In production this is the
same app served over TLS behind the [API Gateway](../../docs/architecture/services/api-gateway.md).
