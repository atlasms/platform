# `@atlas/data-pg`

Postgres implementation of the [`@atlas/data`](../data/) conventions: a pooled unit of work, a
migration runner, and the transactional outbox. Postgres is the system of record
([04-messaging-and-data](../../docs/architecture/04-messaging-and-data.md)); `node:sqlite` is the
test double.

```ts
const pool = openPool({ connectionString: process.env.ATLAS_PG_URL });
await migrate(pool, [outboxMigration, ...serviceMigrations]);
const outbox = new PgOutboxStore(pool);

await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO assets ...');
  await outbox.enqueue(client, { id: envelope.messageId, message }); // ← same client
});
```

## Why `enqueue` demands a client

Because the alternative fails silently. If the outbox took a connection from the pool itself, the
event would be in a **different transaction** from the state change: roll back, and the row
disappears while the event survives and gets published. That is precisely the dual-write drift the
outbox exists to prevent, and it would look completely fine in review.

Making the client a required argument means the mistake cannot compile. `add()` — the plain
`OutboxStore` method — does use the pool, so it is for replay tooling and tests only. A test pins
the difference.

## Async, where `@atlas/data` is sync

`node:sqlite` is synchronous; `pg` cannot be. A synchronous driver can satisfy an async contract,
never the reverse, so shared behaviour is specified against the async shape and `@atlas/data`
gained `withTransactionAsync` to match. The synchronous `withTransaction` remains the better choice
where it fits — it makes "awaiting unrelated I/O mid-transaction" impossible.

## Two things Postgres needs that sqlite did not

**An advisory lock around migrations.** Several replicas start at once during a rolling deploy and
would otherwise race to apply the same migration. sqlite never needed this — one writer by
construction.

**Ordering by `seq`, not `created_at`.** Two rows in the same millisecond would otherwise come back
in an arbitrary order, and the relay publishes in list order.

## Tests

The shared outbox conformance suite (`@atlas/data/conformance`) — the same one the sqlite store
passes — plus Postgres-specific migration behaviour. **CI runs them against a real Postgres
service.** Locally they skip unless `ATLAS_PG_URL` is set:

```sh
docker compose -f infra/docker-compose.dev.yml up -d
ATLAS_PG_URL=postgres://atlas:atlas@localhost:55432/atlas npm test -w @atlas/data-pg
```

Each test runs in its own schema, so they are parallel-safe and cleanup is a single
`DROP SCHEMA … CASCADE`.

A skip is the right default on a laptop without Docker. In CI it is refused: a missing
`ATLAS_PG_URL` throws rather than skipping, because a silent skip there would mean the deployed
adapter quietly stopped being tested while the check stayed green.
