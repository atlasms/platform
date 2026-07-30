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
