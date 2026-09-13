# `@atlas/data-opensearch`

The OpenSearch client, and the two things every Atlas service that indexes needs from it: a
readiness answer and an index that exists. EP-07.4.

```ts
const search = openSearch({ node: process.env.ATLAS_OPENSEARCH_URL });
health.register('opensearch', () => searchHealthy(search)); // not critical — see below
await ensureIndex(search, { name: 'atlas-audit', mappings: { dynamic: 'strict', properties: … } });
```

## An index is a derived view — that is the whole design

The system of record is Postgres ([`@atlas/data-pg`](../data-pg/)): transactions, the outbox, the
append-only triggers, the consumer's seen-mark in the same transaction as its effect. **None of
that exists in a search engine**, and this package does not pretend otherwise — there is no
`withTransaction` here because there is nothing to offer.

What goes into OpenSearch is a projection of committed rows, keyed by the row's own id so a re-index
is an overwrite and never a duplicate, copied by a projector the owning service runs
([`apps/logging/src/projector.ts`](../../apps/logging/src/projector.ts) is the first). That is what
makes **"delete the index and let the projector rebuild it"** a supported operation rather than a
data-loss event, and it is why `ensureIndex` only ever _creates_: a changed mapping is a new index
and a rebuild, which is the honest shape of that change.

[ADR-0005](../../docs/adr/0005-audit-log-storage.md) records the decision for the audit log; the
same shape applies to MAM's search when it moves here.

## What is here

| Export                            |                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openSearch({ node })`            | A client with a 5 s request timeout and **no client-side retries** — a node that is down should be reported in one timeout, not four; callers retry on their own schedule |
| `searchHealthy(client)`           | `true` at green **or yellow** — a single node is never green — bounded so it fits a readiness probe's deadline                                                            |
| `ensureIndex(client, definition)` | Create if missing; idempotent; safe to race between replicas (`resource_already_exists` is success)                                                                       |

## Readiness: register it, don't gate on it

A service whose system of record is Postgres stays **ready** with the index down: its writes and
its record reads work, and a read that needs the index answers `503 UNAVAILABLE` — a retryable
answer, distinct from a 500 so it is neither logged as a crash nor surfaced to a user as one. The
check is still registered so `/readyz` reports it and an operator sees it.

## Tests

Against a real engine — `ATLAS_OPENSEARCH_URL` — skipped locally without one, **refused** in CI
without one (the same rule as `ATLAS_PG_URL`: a silent skip in CI is indistinguishable from a
pass). CI runs an `opensearchproject/opensearch:2.19.3` service, the tag the manifests and the dev
compose file pin.

```sh
docker compose -f infra/docker-compose.dev.yml up -d opensearch
ATLAS_OPENSEARCH_URL=http://localhost:59200 npm test -w @atlas/data-opensearch
```

## Not here, on purpose

Redis and Mongo clients (the rest of EP-07.4's title). Nothing on the platform uses either yet —
MAM's extensible metadata is Postgres JSON, the lockout and policy caches are in-process — and a
client with no consumer is a client nobody has tested against a real need. They arrive with their
first consumer.
