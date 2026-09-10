import type { Db } from './db.ts';
import type { Migration } from './migrations.ts';
import type { SeenStore } from '@atlas/messaging';

// SQL-backed consumer dedup implementing @atlas/messaging's SeenStore.
//
// This is the RECEIVING half of the outbox's promise. The outbox guarantees an event is published
// at least once; "at least" is what puts a duplicate on the wire, and this is what stops the
// duplicate being applied twice. The two tables are a pair, and a service that has one without the
// other has only half the guarantee.

export const seenMigration: Migration = {
  id: 'core_seen',
  up: `CREATE TABLE IF NOT EXISTS seen (
         id TEXT PRIMARY KEY,
         seen_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
};

/**
 * Durable, atomic dedup on `node:sqlite`.
 *
 * Atomic via `INSERT OR IGNORE` and the PRIMARY KEY: the conflict is resolved by the database in
 * one statement, so there is no window between deciding and recording. `changes` then reports
 * whether this caller was the one that inserted — which is the whole answer `markSeen` owes.
 */
export class SqliteSeenStore implements SeenStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Mark inside the caller's unit of work — the form that actually closes the crash window.
   *
   * `idempotent()` claims, then processes, and a crash in between leaves the id marked with the
   * effect never applied: redelivery is suppressed and the message is lost. Passing the SAME `db`
   * the handler writes through puts the mark and the effect in ONE transaction, so a crash rolls
   * back both and redelivery genuinely retries. That is the dual of the outbox, and it is why this
   * takes a handle rather than reaching for its own.
   *
   * Synchronous, so it composes inside `withTransaction`.
   */
  mark(db: Db, id: string): boolean {
    const result = db.prepare('INSERT OR IGNORE INTO seen (id) VALUES (?)').run(id);
    return Number(result.changes) > 0;
  }

  async markSeen(id: string): Promise<boolean> {
    return this.mark(this.db, id);
  }

  async forget(id: string): Promise<void> {
    this.db.prepare('DELETE FROM seen WHERE id = ?').run(id);
  }

  /**
   * Drop marks older than `before`, returning how many went.
   *
   * Without this the table grows forever, which is the leak the in-memory store has and a durable
   * store would merely make permanent. The retention window is a real decision, not a default: it
   * must exceed the longest redelivery the broker can produce, because a mark pruned while its
   * message can still arrive means the duplicate gets applied. Size it from the stream's max
   * delivery age, not from disk comfort.
   */
  prune(before: Date): number {
    const result = this.db
      .prepare('DELETE FROM seen WHERE seen_at < ?')
      .run(before.toISOString().replace('T', ' ').slice(0, 19));
    return Number(result.changes);
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) c FROM seen').get() as { c: number }).c;
  }
}
