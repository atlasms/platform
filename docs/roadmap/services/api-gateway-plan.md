# API Gateway / BFF — Implementation Plan

> Build plan for the synchronous edge: the single authenticated entry point that routes,
> aggregates, and protects the domain services for Studio and third parties.
> Spec: [api-gateway](../../architecture/services/api-gateway.md) ·
> Card: [Catalog](../../architecture/03-service-catalog.md) ·
> Stack: **Node + Fastify** · Ships: **Phase 0 (backbone)**.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v0 | 0 | Routing to backbone + a stub service; JWT verification; CORS; health. |
| v1 | 1 | Routes to all MVP services; rate limiting; request aggregation (BFF reads). |
| v2 | 2–3 | Per-channel throttling; third-party API surface hardening; response caching. |

**Non-goals.** No business logic, no data ownership, no authz *decisions* (it verifies tokens and
forwards claims; services decide). Not the WebSocket path (that's its own service).

## 2. Build sequence

1. **Fastify skeleton** from `service-kit` — health/readiness, structured logs, OTel tracing,
   config schema, graceful shutdown.
2. **AuthN middleware** — verify JWT via IAM's JWKS (cached), reject/short-circuit unauthenticated
   requests, attach `sub`/permissions/`channelId` claims to the forwarded request context.
3. **Routing layer** — declarative route table mapping `/api/v1/<service>/*` to upstream services
   (discovery via Kubernetes DNS); timeouts, retries (idempotent GETs only), circuit-breaking.
4. **Cross-cutting middleware** — CORS, request-id/correlation-id propagation, body limits,
   rate limiting (token bucket in Redis), security headers.
5. **BFF aggregation endpoints** — a few read compositions Studio needs (e.g. asset detail + location
   + verdicts) to avoid client waterfalls; kept thin.
6. **Third-party surface** — expose the documented public API subset with its own auth/limits
   ([Third-Party Guide](../../integrations/10-third-party-developer-guide.md)).

## 3. Components / modules

- `auth` (JWKS client + verifier), `router` (route table + upstream clients), `ratelimit`,
  `aggregation` (BFF composers), `errors` (upstream error normalization), `observability` hooks.

## 4. Data plane & migrations

**None owned.** Uses Redis for rate-limit counters and JWKS/response cache only.

## 5. APIs & events

- Fronts every service's [OpenAPI stub](../../architecture/openapi/); the gateway's own surface is
  the union under `/api/v1`. Emits no domain events; may emit access logs to
  [Logging](logging-analytics-plan.md).

## 6. Dependencies & integration points

- **Requires first:** [IAM](iam-plan.md) (JWKS), the broker, `service-kit`.
- **Consumed by:** Studio and third parties. **Upstream:** all domain services.

## 7. Testing focus

- AuthN edge cases (expired/rotated keys, missing/invalid tokens, permission-version revocation).
- Upstream failure handling (timeout, 5xx, circuit open) → clean client errors, no hangs.
- Rate-limit correctness under concurrency; correlation-id propagation end to end.

## 8. Scaling & deployment

- **Stateless**, horizontally scaled behind the ingress LB; per-request overhead kept low (Fastify).
- Config: route table, upstream timeouts, rate-limit policies (per-channel in v2).

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Becomes a logic dumping ground | Enforce "routing + thin aggregation only" in review. |
| Single choke point | Stateless replicas + health-gated rollout; no per-request shared state beyond Redis. |
| JWKS rotation gaps | Cache with TTL + refresh-on-miss; test key rotation. |
