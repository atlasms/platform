// The Postgres transactional outbox.
//
// Implements @atlas/messaging's OutboxStore so the existing OutboxRelay drains it unchanged, and
// passes the same conformance suite as the sqlite store (@atlas/data/conformance).

import type { Migration } from '@atlas/data';
import type { Message, OutboxRecord, OutboxStore } from '@atlas/messaging';
import type { PgClient, PgPool } from './db.ts';

export const outboxMigration: Migration = {
  id: 'core_outbox',
  up: `CREATE TABLE IF NOT EXISTS outbox (
         id         text PRIMARY KEY,
         subject    text NOT NULL,
         body       jsonb NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         seq        bigserial NOT NULL,
         sent_at    timestamptz
       );
       -- The relay only ever asks for unsent rows in order. A partial index keeps that scan
       -- proportional to the backlog rather than to the table, which matters because the table is
       -- append-only and never truncated in flight.
       CREATE INDEX IF NOT EXISTS outbox_unsent_idx ON outbox (seq) WHERE sent_at IS NULL;`,
};

export class PgOutboxStore implements OutboxStore {
  constructor(private readonly pool: PgPool) {}

  /**
   * Enqueue INSIDE the caller's transaction.
   *
   * The client is a required argument, not an optional convenience. Taking a connection from the
   * pool here would put the event in a DIFFERENT transaction from the state change, so a rollback
   * would drop the row and keep the event — exactly the dual-write drift the outbox prevents.
   * Making the client mandatory means that mistake cannot compile.
   */
  async enqueue(client: PgClient, rec: { id: string; message: Message }): Promise<void> {
    await client.query('INSERT INTO outbox (id, subject, body) VALUES ($1, $2, $3)', [
      rec.id,
      rec.message.subject,
      JSON.stringify(rec.message.body),
    ]);
  }

  /**
   * `OutboxStore.add` — used outside a unit of work (tests, replay tooling).
   *
   * Prefer {@link enqueue}: this one commits on its own connection, so it gives none of the
   * atomicity the pattern exists for.
   */
  async add(rec: OutboxRecord): Promise<void> {
    await this.pool.query('INSERT INTO outbox (id, subject, body) VALUES ($1, $2, $3)', [
      rec.id,
      rec.message.subject,
      JSON.stringify(rec.message.body),
    ]);
  }

  async listUnsent(limit: number): Promise<OutboxRecord[]> {
    // Ordered by seq, not created_at: two rows in the same millisecond would otherwise come back
    // in an arbitrary order, and the relay publishes in list order.
    const { rows } = await this.pool.query<{ id: string; subject: string; body: unknown }>(
      'SELECT id, subject, body FROM outbox WHERE sent_at IS NULL ORDER BY seq LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      // jsonb comes back already parsed — no JSON.parse, unlike the sqlite store's text column.
      message: { id: r.id, subject: r.subject, body: r.body },
    }));
  }

  async markSent(id: string, at: number): Promise<void> {
    await this.pool.query('UPDATE outbox SET sent_at = $1 WHERE id = $2', [new Date(at), id]);
  }

  async unsentCount(): Promise<number> {
    const { rows } = await this.pool.query<{ c: string }>(
      'SELECT count(*) c FROM outbox WHERE sent_at IS NULL',
    );
    return Number(rows[0]?.c ?? 0);
  }
}
