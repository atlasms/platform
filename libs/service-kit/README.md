# @atlas/service-kit — the per-service template

The cross-cutting bits every service imports (system plan §6): typed config, an error taxonomy,
correlation context, health/readiness, a structured logger, JWT/JWKS verification, metrics, alerts,
and tracing.

**Everything here lands in every image.** That is why the two wire formats are written by hand
rather than pulled in: Prometheus exposition, and W3C Trace Context + OTLP
([ADR-0004](../../docs/adr/0004-tracing-implementation.md) — the OTel SDK measured at 27–71 MB
against a 117 MB offline bundle). Both are stable, fully specified, and small.

## API

```ts
import {
  loadConfig,
  NotFound,
  toProblem,
  runWithContext,
  correlationId,
  HealthRegistry,
  verifyJwt,
  requirePermission,
  generateTestKey,
  createLogger,
} from '@atlas/service-kit';

const cfg = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  name: { env: 'SERVICE', type: 'string', required: true },
});

const claims = await verifyJwt(bearer, jwks, { issuer: 'iam' }); // throws Unauthorized on failure
requirePermission(claims, 'asset:approve'); // throws Forbidden if missing

runWithContext({ correlationId: cid }, () => log.info('handling')); // logs auto-thread the id
app.get('/readyz', async () => health.readiness());
// HTTP edge: catch -> toProblem(err, correlationId()) -> { code, status, message }
```

## Tracing (EP-04.7)

```ts
const tracer = createTracer({ service: 'mam', endpoint: process.env.ATLAS_OTLP_ENDPOINT });

// Inbound. `adoptRemote: false` at the PUBLIC edge only — see below.
tracer.server(`${method} ${routeTemplate}`, req.headers, { adoptRemote: true }, (span) => {
  span.setAttribute('http.response.status_code', 200);
  span.end();
});

fetch(url, { headers: { traceparent: span.traceparent() } }); // the hop that makes it distributed
```

Three things that are decisions, not defaults:

- **No endpoint means no export.** Spans are still created and `traceparent` still propagates, so a
  site with no collector pays only the cost of an id — and its traces are already joined up the day
  one appears.
- **The gateway starts the trace; everything else adopts it.**
  [api-gateway.md §12](../../docs/architecture/services/api-gateway.md) specifies this, and it also
  stops a public client pinning every request to one trace id or forcing the sampled flag to flood
  the collector. Internal hops adopt, because re-deciding sampling mid-trace leaves holes.
- **The queue is bounded and drops the oldest.** The collector is remote and can be gone; an
  unbounded queue turns its outage into this service's OOM kill. Telemetry must never take down the
  thing it observes.

Span names are **route templates**, never raw paths — the same cardinality rule the metrics follow.
The gateway is the exception that proves it: its Fastify template is the catch-all `/*`, so it
renames the span to `POST /auth → iam` once routing has matched.

## Run

```bash
npm install && npm test   # 57 tests
```

## Tests prove

- `loadConfig` coerces number/boolean, applies defaults, and **fails fast with all problems** (422);
- the error taxonomy maps to a consistent problem+status; unknown errors become `INTERNAL`/500;
- `correlationId` **threads through async** work and clears outside the context;
- readiness stays `ready` on a **non-critical** failure and flips on a **critical** one;
- JWT **verifies against a JWKS** and enforces permissions; **expired / wrong-key / tampered** tokens
  are rejected as `Unauthorized`;
- the logger emits structured JSON carrying the ambient `correlationId`;
- `traceparent` **round-trips**, refuses all-zero ids and version `ff`, **continues** other unknown
  versions, and reads `sampled` as a bit rather than comparing the octet to `"01"`;
- an upstream sampling decision is **honoured, never re-decided** — the failure that produces traces
  with holes in the middle;
- the export queue is **bounded**, drops the oldest, and a dead collector loses spans rather than
  retrying forever.

`generateTestKey()` also gives local dev a way to mint tokens without a running IAM.
