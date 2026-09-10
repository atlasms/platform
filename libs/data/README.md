# @atlas/data — data-plane conventions

The last foundation lib: a **migration runner**, a `withTransaction` unit of work, a JSON-row
repository, a **SQL-backed outbox** and its counterpart, a **SQL-backed consumer dedup store** —
over `node:sqlite` (production maps 1:1 to Postgres/`pg`). It retires the in-memory stores the
service slices used, and demonstrates the **real** transactional outbox the pattern promises.

## API

```ts
import {
  openDb,
  migrate,
  withTransaction,
  jsonRepo,
  jsonTableMigration,
  SqliteOutboxStore,
  outboxMigration,
} from '@atlas/data';

const db = openDb('atlas.db'); // or ':memory:'
migrate(db, [jsonTableMigration('asset'), outboxMigration]); // idempotent, tracked in _migrations
const assets = jsonRepo(db, 'asset');
const outbox = new SqliteOutboxStore(db);

// the whole point — state change + event committed together, or neither:
withTransaction(db, () => {
  assets.put({ id, state: 'approved' });
  outbox.enqueue({ id: msg.id, message: { id: msg.id, subject, body: envelope } });
});
```

`SqliteOutboxStore` implements [`@atlas/messaging`](../messaging/README.md)'s `OutboxStore`, so the
existing `OutboxRelay` drains it unchanged — a **drop-in replacement** for `InMemoryOutboxStore` in
`mam-service` / `scheduling-service`.

## `SqliteSeenStore` — the other half of the guarantee

The outbox promises an event is published **at least once**; "at least" is what puts a duplicate on
the wire, and this is what stops the duplicate being applied twice. A service with one and not the
other has half the guarantee.

```ts
import { SqliteSeenStore, seenMigration } from '@atlas/data';

const seen = new SqliteSeenStore(db);

withTransaction(db, (tx) => {
  if (!seen.mark(tx, msg.id)) return; // already applied — skip
  assets.put({ id, state: 'approved' }); // the effect, in the SAME transaction
});
```

**Take the transaction handle.** `markSeen()` (the `SeenStore` port) claims on its own connection,
which dedupes but gives no atomicity across a crash: die between the claim and the handler's commit
and the id is marked with the effect never applied, so every redelivery is suppressed. `mark(tx, id)`
puts both in one unit of work, so a crash rolls back both and redelivery genuinely retries. Same
shape, and same reason, as `outbox.enqueue` — this is the outbox pattern run backwards.

`prune(before)` drops old marks; the table grows forever without it. **Size the window from the
broker's maximum redelivery age**, not from disk comfort: a mark pruned while its message can still
arrive lets the duplicate through.

## Run

```bash
# from reference/ (shared dep root): npm install once, then:
cd data && node --no-warnings --import tsx --test test/data.test.ts   # 23 tests
```

## Tests prove

- migrations apply **once** and are **idempotent** (re-run adds nothing); a **bad migration fails
  without half-applying** (not recorded);
- `jsonRepo` put/get/all/delete + upsert round-trip;
- **transactional outbox commits atomically** — the asset row and its outbox event persist together;
- **…and ROLLS BACK both on failure** — after an error mid-transaction, neither the asset nor the
  event survives, while prior committed data stays intact (the atomicity the in-memory version could
  only simulate);
- `SqliteOutboxStore` **drains through the `messaging` `OutboxRelay`** to a broker and marks sent
  (idempotent re-run);
- `SqliteSeenStore` passes the shared `seenStoreConformance` suite (`@atlas/messaging/conformance`),
  the same one the in-memory and Postgres stores run;
- **the mark and the domain write roll back together** — after a mid-transaction failure the id is
  unmarked, so the redelivery is processed rather than skipped for an effect that never happened;
- `prune` drops marks older than a cutoff and leaves the rest **still deduping**.

## Note

`node:sqlite` is synchronous — ideal for a per-request unit of work — and is used with `--no-warnings`
(it's a recent Node built-in). Production swaps in Postgres behind the same `migrate` / `withTransaction`
/ `OutboxStore` shapes.
