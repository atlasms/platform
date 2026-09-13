import { DatabaseSync } from 'node:sqlite';

// node:sqlite is synchronous, which is exactly what a per-request DB unit-of-work wants. Production
// uses Postgres/`pg`; the shapes here (migrations, withTransaction, outbox) map 1:1.
export type Db = DatabaseSync;

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Run `fn` in a transaction: COMMIT on success, ROLLBACK on any throw. The unit of work. */
export function withTransaction<T>(db: Db, fn: (db: Db) => T): T {
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * The same unit of work, awaiting an async body.
 *
 * Exists because the production store is Postgres, and Postgres is async — you can make a
 * synchronous driver satisfy an async contract, never the reverse. Shared behaviour (notably
 * outbox atomicity) is therefore specified against this shape, so one conformance suite can hold
 * both `node:sqlite` and `pg` to the same rules.
 *
 * `DatabaseSync` is ONE connection with no statement queue, so two of these in flight at once
 * would interleave — the second `BEGIN` lands inside the first transaction and sqlite refuses it.
 * They are serialized per connection here, which is what one connection means: a second
 * transaction waits for the first to commit or roll back, then runs against its result. That is
 * also what makes the double honest about a race the production store resolves with row locks —
 * two callers claiming one refresh token both run, in order, and the second finds it claimed.
 *
 * CAUTION still: a read on `db` outside any transaction while one is awaiting sees its
 * uncommitted state. Await only work belonging to the unit of work.
 */
export async function withTransactionAsync<T>(db: Db, fn: (db: Db) => Promise<T> | T): Promise<T> {
  const previous = queues.get(db) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => (release = resolve));
  queues.set(
    db,
    previous.then(() => mine),
  );
  await previous;
  try {
    db.exec('BEGIN');
    try {
      const result = await fn(db);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    release();
  }
}

/** The tail of each connection's transaction queue. */
const queues = new WeakMap<Db, Promise<void>>();
