# @atlas/data — data-plane conventions

The last foundation lib: a **migration runner**, a `withTransaction` unit of work, a JSON-row
repository, and a **SQL-backed outbox** — over `node:sqlite` (production maps 1:1 to Postgres/`pg`).
It retires the in-memory stores the service slices used, and demonstrates the **real** transactional
outbox the pattern promises.

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

## Run

```bash
# from reference/ (shared dep root): npm install once, then:
cd data && node --no-warnings --import tsx --test test/data.test.ts   # 6 tests
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
  (idempotent re-run).

## Note

`node:sqlite` is synchronous — ideal for a per-request unit of work — and is used with `--no-warnings`
(it's a recent Node built-in). Production swaps in Postgres behind the same `migrate` / `withTransaction`
/ `OutboxStore` shapes.
