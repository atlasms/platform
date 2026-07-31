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

export class SqliteOutboxStore implements OutboxStore {
  constructor(private db: Db) {}

  /** Synchronous enqueue for use within a withTransaction block. */
  enqueue(rec: OutboxRecord): void {
    this.db
      .prepare('INSERT INTO outbox (id, subject, body) VALUES (?, ?, ?)')
      .run(rec.id, rec.message.subject, JSON.stringify(rec.message.body));
  }

  async add(rec: OutboxRecord): Promise<void> {
    this.enqueue(rec);
  }

  async listUnsent(limit: number): Promise<OutboxRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT id, subject, body FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ?',
      )
      .all(limit) as { id: string; subject: string; body: string }[];
    return rows.map((r) => ({
      id: r.id,
      message: { id: r.id, subject: r.subject, body: JSON.parse(r.body) },
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
