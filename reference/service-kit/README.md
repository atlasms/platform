# @atlas/service-kit — the per-service template

The cross-cutting bits every service imports (system plan §6): typed config, an error taxonomy,
correlation context, health/readiness, a structured logger, and JWT/JWKS verification.

## API

```ts
import { loadConfig, NotFound, toProblem, runWithContext, correlationId,
         HealthRegistry, verifyJwt, requirePermission, generateTestKey, createLogger } from '@atlas/service-kit';

const cfg = loadConfig({ port: { env: 'PORT', type: 'number', default: 3000 },
                         name: { env: 'SERVICE', type: 'string', required: true } });

const claims = await verifyJwt(bearer, jwks, { issuer: 'iam' });   // throws Unauthorized on failure
requirePermission(claims, 'asset:approve');                        // throws Forbidden if missing

runWithContext({ correlationId: cid }, () => log.info('handling'));// logs auto-thread the id
app.get('/readyz', async () => health.readiness());
// HTTP edge: catch -> toProblem(err, correlationId()) -> { code, status, message }
```

## Run

```bash
npm install && npm test   # 8 tests (JWT/JWKS via jose, offline test keys)
```

## Tests prove

- `loadConfig` coerces number/boolean, applies defaults, and **fails fast with all problems** (422);
- the error taxonomy maps to a consistent problem+status; unknown errors become `INTERNAL`/500;
- `correlationId` **threads through async** work and clears outside the context;
- readiness stays `ready` on a **non-critical** failure and flips on a **critical** one;
- JWT **verifies against a JWKS** and enforces permissions; **expired / wrong-key / tampered** tokens
  are rejected as `Unauthorized`;
- the logger emits structured JSON carrying the ambient `correlationId`.

`generateTestKey()` also gives local dev a way to mint tokens without a running IAM.
