// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.

import {
  migrate,
  openDb,
  seenMigration,
  SqliteSeenStore,
  withTransactionAsync,
  type Db,
} from '@atlas/data';
import type { Migration } from '@atlas/data';
import { browseClauses } from './store.ts';
import type {
  AuditEvent,
  AuditStore,
  AuditTx,
  ChainHead,
  HistoryEntry,
  RetentionPolicy,
} from './store.ts';

export const sqliteMigrations: Migration[] = [
  seenMigration,
  {
    id: 'logging_audit_events',
    up: `CREATE TABLE IF NOT EXISTS audit_events (
           message_id     TEXT PRIMARY KEY,
           channel_id     TEXT NOT NULL,
           seq            INTEGER NOT NULL,
           type           TEXT NOT NULL,
           occurred_at    TEXT NOT NULL,
           actor_kind     TEXT,
           actor_id       TEXT,
           correlation_id TEXT,
           payload        TEXT NOT NULL,
           prev_hash      TEXT NOT NULL,
           hash           TEXT NOT NULL,
           UNIQUE (channel_id, seq)
         );
         -- Append-only, in the database. Two consumers racing to append seq N+1 to one channel
         -- collide on the UNIQUE above; the loser's transaction rolls back, its seen-mark with it,
         -- and JetStream redelivers — it then appends at N+2. Optimistic, and correct.
         CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
           BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
           BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;`,
  },
  {
    id: 'logging_entity_history',
    up: `CREATE TABLE IF NOT EXISTS entity_history (
           channel_id     TEXT NOT NULL,
           entity_type    TEXT NOT NULL,
           entity_id      TEXT NOT NULL,
           revision       INTEGER NOT NULL,
           action         TEXT NOT NULL,
           actor_kind     TEXT,
           actor_id       TEXT,
           at             TEXT NOT NULL,
           correlation_id TEXT,
           delta          TEXT NOT NULL,
           message_id     TEXT NOT NULL,
           PRIMARY KEY (channel_id, entity_type, entity_id, revision)
         );
         CREATE TRIGGER IF NOT EXISTS entity_history_no_update BEFORE UPDATE ON entity_history
           BEGIN SELECT RAISE(ABORT, 'entity_history is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS entity_history_no_delete BEFORE DELETE ON entity_history
           BEGIN SELECT RAISE(ABORT, 'entity_history is append-only'); END;`,
  },
  {
    // One row per channel (EP-19.4). Not append-only: a policy is configuration, and its
    // history is in the audit log like any other mutation's.
    id: 'logging_retention_policies',
    up: `CREATE TABLE IF NOT EXISTS retention_policies (
           channel_id TEXT NOT NULL PRIMARY KEY,
           data       TEXT NOT NULL
         )`,
  },
];

interface EventRow {
  message_id: string;
  channel_id: string;
  seq: number;
  type: string;
  occurred_at: string;
  actor_kind: string | null;
  actor_id: string | null;
  correlation_id: string | null;
  payload: string;
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
  at: string;
  correlation_id: string | null;
  delta: string;
  message_id: string;
}

const toEvent = (r: EventRow): AuditEvent => ({
  messageId: r.message_id,
  channelId: r.channel_id,
  seq: r.seq,
  type: r.type,
  occurredAt: r.occurred_at,
  ...(r.actor_kind !== null ? { actorKind: r.actor_kind as 'service' | 'user' } : {}),
  ...(r.actor_id !== null ? { actorId: r.actor_id } : {}),
  ...(r.correlation_id !== null ? { correlationId: r.correlation_id } : {}),
  payload: JSON.parse(r.payload),
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
  at: r.at,
  ...(r.correlation_id !== null ? { correlationId: r.correlation_id } : {}),
  delta: JSON.parse(r.delta),
  messageId: r.message_id,
});

export function sqliteAuditStore(path = ':memory:'): AuditStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const seen = new SqliteSeenStore(db);

  const tx: AuditTx = {
    async markSeen(messageId) {
      return seen.mark(db, messageId);
    },
    async head(channelId) {
      const row = db
        .prepare(
          'SELECT seq, hash FROM audit_events WHERE channel_id = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(channelId) as { seq: number; hash: string } | undefined;
      return row ? ({ channelId, seq: row.seq, hash: row.hash } satisfies ChainHead) : undefined;
    },
    async append(e) {
      db.prepare(
        `INSERT INTO audit_events
           (message_id, channel_id, seq, type, occurred_at, actor_kind, actor_id, correlation_id, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      );
    },
    async appendHistory(h) {
      db.prepare(
        `INSERT INTO entity_history
           (channel_id, entity_type, entity_id, revision, action, actor_kind, actor_id, at, correlation_id, delta, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      );
    },
    async putRetentionPolicy(p) {
      db.prepare(
        `INSERT INTO retention_policies (channel_id, data) VALUES (?, ?)
         ON CONFLICT (channel_id) DO UPDATE SET data = excluded.data`,
      ).run(p.channelId, JSON.stringify(p));
    },
  };

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async history(channelId, entityType, entityId) {
      const rows = db
        .prepare(
          `SELECT * FROM entity_history WHERE channel_id = ? AND entity_type = ? AND entity_id = ? ORDER BY revision`,
        )
        .all(channelId, entityType, entityId) as unknown as HistoryRow[];
      return rows.map(toHistory);
    },
    async chain(channelId) {
      const rows = db
        .prepare('SELECT * FROM audit_events WHERE channel_id = ? ORDER BY seq')
        .all(channelId) as unknown as EventRow[];
      return rows.map(toEvent);
    },
    async browse(channelId, filter) {
      const { where, params } = browseClauses(channelId, filter, '?');
      const rows = db
        .prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY seq DESC LIMIT ?`)
        .all(...(params as (string | number)[]), filter.limit) as unknown as EventRow[];
      return rows.map(toEvent);
    },
    async heads() {
      const rows = db
        .prepare(
          `SELECT e.channel_id, e.seq, e.hash FROM audit_events e
             JOIN (SELECT channel_id, max(seq) seq FROM audit_events GROUP BY channel_id) h
               ON h.channel_id = e.channel_id AND h.seq = e.seq
           ORDER BY e.channel_id`,
        )
        .all() as unknown as { channel_id: string; seq: number; hash: string }[];
      return rows.map((r) => ({ channelId: r.channel_id, seq: r.seq, hash: r.hash }));
    },
    async chainSince(channelId, afterSeq, limit) {
      const rows = db
        .prepare('SELECT * FROM audit_events WHERE channel_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(channelId, afterSeq, limit) as unknown as EventRow[];
      return rows.map(toEvent);
    },
    async count() {
      const events = (db.prepare('SELECT count(*) c FROM audit_events').get() as { c: number }).c;
      const history = (db.prepare('SELECT count(*) c FROM entity_history').get() as { c: number })
        .c;
      return { events, history };
    },
    async retentionPolicy(channelId) {
      const row = db
        .prepare('SELECT data FROM retention_policies WHERE channel_id = ?')
        .get(channelId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as RetentionPolicy) : undefined;
    },
    async close() {
      db.close();
    },
  };
}
