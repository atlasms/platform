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
 * CAUTION: `DatabaseSync` is a single connection with no statement queue, so anything else that
 * touches `db` while this is awaiting joins THIS transaction. Await only work belonging to the
 * unit of work — never an unrelated I/O call — or use the synchronous `withTransaction`, which
 * makes that mistake impossible.
 */
export async function withTransactionAsync<T>(db: Db, fn: (db: Db) => Promise<T> | T): Promise<T> {
  db.exec('BEGIN');
  try {
    const result = await fn(db);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
