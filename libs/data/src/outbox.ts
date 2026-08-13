import type { Db } from './db.ts';
import type { Migration } from './migrations.ts';
import type { OutboxStore, OutboxRecord } from '@atlas/messaging';

// SQL-backed outbox implementing @atlas/messaging's OutboxStore, so the existing OutboxRelay drains
// it unchanged. `enqueue` is synchronous for use INSIDE a withTransaction alongside the domain write
// — that atomicity (row + event committed together, or neither) is the whole point of the pattern.
export const outboxMigration: Migration = {
  id: 'core_outbox',
  up: `CREATE TABLE IF NOT EXISTS outbox (
         id TEXT PRIMARY KEY,
         subject TEXT NOT NULL,
         body TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         sent_at TEXT
       )`,
};

/**
 * Message HEADERS were not persisted, so the outbox silently dropped them.
 *
 * `Message.headers` has been part of the contract all along; the store simply never stored the
 * column, so anything a publisher put there vanished between the transaction and the broker. It
 * surfaced with tracing (EP-13.3) — the `traceparent` written inside the request never reached the
 * consumer, so the async half of every workflow began a brand-new trace — but nothing about the
 * bug is tracing-specific: it applies to any header any publisher ever sets.
 *
 * A separate migration rather than an edit to the one above, because the original has already run
 * on deployed databases and `CREATE TABLE IF NOT EXISTS` would do nothing there.
 */
export const outboxHeadersMigration: Migration = {
  id: 'core_outbox_headers',
  up: `ALTER TABLE outbox ADD COLUMN headers TEXT`,
};

export class SqliteOutboxStore implements OutboxStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Synchronous enqueue for use within a withTransaction block. */
  enqueue(rec: OutboxRecord): void {
    this.db.prepare('INSERT INTO outbox (id, subject, body, headers) VALUES (?, ?, ?, ?)').run(
      rec.id,
      rec.message.subject,
      JSON.stringify(rec.message.body),
      // NULL rather than '{}' when there are none, so a row is byte-identical to what it was
      // before headers were stored and the column reads as "nothing was set" rather than
      // "something was set and it was empty".
      rec.message.headers === undefined ? null : JSON.stringify(rec.message.headers),
    );
  }

  async add(rec: OutboxRecord): Promise<void> {
    this.enqueue(rec);
  }

  async listUnsent(limit: number): Promise<OutboxRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT id, subject, body, headers FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ?',
      )
      .all(limit) as {
      id: string;
      subject: string;
      body: string;
      headers: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      message: {
        id: r.id,
        subject: r.subject,
        body: JSON.parse(r.body),
        // Omitted rather than set to undefined: under exactOptionalPropertyTypes those differ, and
        // a row written before this column existed must round-trip to the same message it did then.
        ...(r.headers === null ? {} : { headers: JSON.parse(r.headers) as Record<string, string> }),
      },
    }));
  }

  async markSent(id: string, at: number): Promise<void> {
    this.db
      .prepare('UPDATE outbox SET sent_at = ? WHERE id = ?')
      .run(new Date(at).toISOString(), id);
  }

  unsentCount(): number {
    return (
      this.db.prepare('SELECT count(*) c FROM outbox WHERE sent_at IS NULL').get() as { c: number }
    ).c;
  }
}
