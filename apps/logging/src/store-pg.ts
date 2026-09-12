// The Postgres adapter — production. Same port, same conformance suite as the sqlite double.

import type { Migration } from '@atlas/data';
import { PgSeenStore, seenMigration, withTransaction, type PgPool } from '@atlas/data-pg';
import type { AuditEvent, AuditStore, AuditTx, ChainHead, HistoryEntry } from './store.ts';

export const pgMigrations: Migration[] = [
  seenMigration,
  {
    id: 'logging_audit_events',
    up: `CREATE TABLE IF NOT EXISTS audit_events (
           message_id     text PRIMARY KEY,
           channel_id     text NOT NULL,
           seq            bigint NOT NULL,
           type           text NOT NULL,
           occurred_at    timestamptz NOT NULL,
           actor_kind     text,
           actor_id       text,
           correlation_id text,
           payload        jsonb NOT NULL,
           prev_hash      text NOT NULL,
           hash           text NOT NULL,
           UNIQUE (channel_id, seq)
         );
         CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events (correlation_id);
         -- Append-only, in the database. Two consumers racing to append seq N+1 to one channel
         -- collide on the UNIQUE; the loser's transaction rolls back, its seen-mark with it, and
         -- JetStream redelivers — it then appends at N+2. Optimistic, and correct.
         CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger AS $$
           BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
         $$ LANGUAGE plpgsql;
         DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
         CREATE TRIGGER audit_events_append_only
           BEFORE UPDATE OR DELETE ON audit_events
           FOR EACH ROW EXECUTE FUNCTION audit_append_only();`,
  },
  {
    id: 'logging_entity_history',
    up: `CREATE TABLE IF NOT EXISTS entity_history (
           channel_id     text NOT NULL,
           entity_type    text NOT NULL,
           entity_id      text NOT NULL,
           revision       integer NOT NULL,
           action         text NOT NULL,
           actor_kind     text,
           actor_id       text,
           at             timestamptz NOT NULL,
           correlation_id text,
           delta          jsonb NOT NULL,
           message_id     text NOT NULL,
           PRIMARY KEY (channel_id, entity_type, entity_id, revision)
         );
         DROP TRIGGER IF EXISTS entity_history_append_only ON entity_history;
         CREATE TRIGGER entity_history_append_only
           BEFORE UPDATE OR DELETE ON entity_history
           FOR EACH ROW EXECUTE FUNCTION audit_append_only();`,
  },
];

interface EventRow {
  message_id: string;
  channel_id: string;
  seq: string; // bigint comes back as a string
  type: string;
  occurred_at: Date;
  actor_kind: string | null;
  actor_id: string | null;
  correlation_id: string | null;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

interface HistoryRow {
  channel_id: string;
  entity_type: string;
  entity_id: string;
  revision: number;
  action: string;
  actor_kind: string | null;
  actor_id: string | null;
  at: Date;
  correlation_id: string | null;
  delta: HistoryEntry['delta'];
  message_id: string;
}

const toEvent = (r: EventRow): AuditEvent => ({
  messageId: r.message_id,
  channelId: r.channel_id,
  seq: Number(r.seq),
  type: r.type,
  // Stored as timestamptz; the record's canonical form used the ISO string, so hand it back as one.
  occurredAt: r.occurred_at.toISOString(),
  ...(r.actor_kind !== null ? { actorKind: r.actor_kind as 'service' | 'user' } : {}),
  ...(r.actor_id !== null ? { actorId: r.actor_id } : {}),
  ...(r.correlation_id !== null ? { correlationId: r.correlation_id } : {}),
  payload: r.payload,
  prevHash: r.prev_hash,
  hash: r.hash,
});

const toHistory = (r: HistoryRow): HistoryEntry => ({
  channelId: r.channel_id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  revision: r.revision,
  action: r.action,
  ...(r.actor_kind !== null ? { actorKind: r.actor_kind as 'service' | 'user' } : {}),
  ...(r.actor_id !== null ? { actorId: r.actor_id } : {}),
  at: r.at.toISOString(),
  ...(r.correlation_id !== null ? { correlationId: r.correlation_id } : {}),
  delta: r.delta,
  messageId: r.message_id,
});

export function pgAuditStore(pool: PgPool): AuditStore {
  const seen = new PgSeenStore(pool);

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        // Built per transaction and closed over THIS client — a write through the pool would land
        // in a different transaction and lose the atomicity the seen-mark depends on.
        const tx: AuditTx = {
          async markSeen(messageId) {
            return seen.mark(client, messageId);
          },
          async head(channelId) {
            const { rows } = await client.query<{ seq: string; hash: string }>(
              'SELECT seq, hash FROM audit_events WHERE channel_id = $1 ORDER BY seq DESC LIMIT 1',
              [channelId],
            );
            const row = rows[0];
            return row ? ({ seq: Number(row.seq), hash: row.hash } satisfies ChainHead) : undefined;
          },
          async append(e) {
            await client.query(
              `INSERT INTO audit_events
                 (message_id, channel_id, seq, type, occurred_at, actor_kind, actor_id, correlation_id, payload, prev_hash, hash)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                e.messageId,
                e.channelId,
                e.seq,
                e.type,
                e.occurredAt,
                e.actorKind ?? null,
                e.actorId ?? null,
                e.correlationId ?? null,
                JSON.stringify(e.payload),
                e.prevHash,
                e.hash,
              ],
            );
          },
          async appendHistory(h) {
            await client.query(
              `INSERT INTO entity_history
                 (channel_id, entity_type, entity_id, revision, action, actor_kind, actor_id, at, correlation_id, delta, message_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                h.channelId,
                h.entityType,
                h.entityId,
                h.revision,
                h.action,
                h.actorKind ?? null,
                h.actorId ?? null,
                h.at,
                h.correlationId ?? null,
                JSON.stringify(h.delta),
                h.messageId,
              ],
            );
          },
        };
        return fn(tx);
      });
    },
    async history(channelId, entityType, entityId) {
      const { rows } = await pool.query<HistoryRow>(
        `SELECT * FROM entity_history WHERE channel_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY revision`,
        [channelId, entityType, entityId],
      );
      return rows.map(toHistory);
    },
    async chain(channelId) {
      const { rows } = await pool.query<EventRow>(
        'SELECT * FROM audit_events WHERE channel_id = $1 ORDER BY seq',
        [channelId],
      );
      return rows.map(toEvent);
    },
    async count() {
      const e = await pool.query<{ c: string }>('SELECT count(*) c FROM audit_events');
      const h = await pool.query<{ c: string }>('SELECT count(*) c FROM entity_history');
      return { events: Number(e.rows[0]?.c ?? 0), history: Number(h.rows[0]?.c ?? 0) };
    },
    async close() {
      await pool.end();
    },
  };
}
