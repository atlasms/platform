// Postgres consumer dedup.
//
// Implements @atlas/messaging's SeenStore and passes the same conformance suite as the sqlite and
// in-memory stores (@atlas/messaging/conformance) — including the atomicity case, which is the one
// that actually needs a real database to mean anything.

import type { Migration } from '@atlas/data';
import type { SeenStore } from '@atlas/messaging';
import type { PgClient, PgPool } from './db.ts';

export const seenMigration: Migration = {
  id: 'core_seen',
  up: `CREATE TABLE IF NOT EXISTS seen (
         id      text PRIMARY KEY,
         seen_at timestamptz NOT NULL DEFAULT now()
       );
       -- Pruning is the only scan: it asks for everything older than a cutoff, and the table is
       -- otherwise addressed purely by primary key.
       CREATE INDEX IF NOT EXISTS seen_seen_at_idx ON seen (seen_at);`,
};

export class PgSeenStore implements SeenStore {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  /**
   * Mark INSIDE the caller's transaction — the form that closes the crash window.
   *
   * `idempotent()` claims and then processes; a crash in between leaves the id marked and the
   * effect never applied, so redelivery is suppressed and the message is lost. Passing the client
   * the handler writes through puts the mark and the effect in ONE transaction: a crash rolls back
   * both, and redelivery genuinely retries. The dual of `PgOutboxStore.enqueue`, for the same
   * reason and with the same shape.
   *
   * Concurrency is handled by Postgres, not by us: a second transaction inserting the same id
   * blocks on the row lock until this one settles, then sees the conflict and reports 0. Which is
   * to say the ordering is decided by the database rather than by whichever caller got scheduled
   * first — the property `markSeen` promises.
   */
  async mark(client: PgClient, id: string): Promise<boolean> {
    const result = await client.query('INSERT INTO seen (id) VALUES ($1) ON CONFLICT DO NOTHING', [
      id,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * `SeenStore.markSeen` — atomic, but on its OWN connection.
   *
   * Prefer {@link mark}: this one commits independently of whatever the handler is doing, so it
   * gives dedup without the atomicity that makes dedup safe across a crash.
   */
  async markSeen(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO seen (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async forget(id: string): Promise<void> {
    await this.pool.query('DELETE FROM seen WHERE id = $1', [id]);
  }

  /**
   * Drop marks older than `before`, returning how many went.
   *
   * The retention window must exceed the longest redelivery the broker can produce. Prune a mark
   * while its message can still arrive and the duplicate is applied — so this is sized from the
   * stream's max delivery age, not from how large the table has become.
   */
  async prune(before: Date): Promise<number> {
    const result = await this.pool.query('DELETE FROM seen WHERE seen_at < $1', [before]);
    return result.rowCount ?? 0;
  }

  async count(): Promise<number> {
    // count(*) is int8, which pg hands back as a STRING — Number() or it compares as text.
    const { rows } = await this.pool.query<{ c: string }>('SELECT count(*) c FROM seen');
    return Number(rows[0]?.c ?? 0);
  }
}
