// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.

import {
  migrate,
  openDb,
  outboxHeadersMigration,
  outboxMigration,
  seenMigration,
  SqliteOutboxStore,
  SqliteSeenStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import type { TranscodeJob } from './job.ts';
import type { JobStore, JobTx } from './store.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  // MTS consumes `transcode.job.create`, so it claims message ids in the same transaction as the
  // job the command creates (EP-03.3).
  seenMigration,
  {
    id: 'mts_jobs',
    up: `CREATE TABLE IF NOT EXISTS transcode_jobs (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           asset_id   TEXT NOT NULL,
           state      TEXT NOT NULL,
           priority   INTEGER NOT NULL,
           retry_at   TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         -- The worker's read: what to run next, highest priority then oldest.
         CREATE INDEX IF NOT EXISTS transcode_jobs_queue_idx
           ON transcode_jobs (state, priority DESC, created_at);
         -- The sweep's read: jobs left running by a worker that never came back.
         CREATE INDEX IF NOT EXISTS transcode_jobs_stale_idx ON transcode_jobs (state, updated_at);
         -- A channel's jobs, and one asset's.
         CREATE INDEX IF NOT EXISTS transcode_jobs_channel_idx ON transcode_jobs (channel_id, id);
         CREATE INDEX IF NOT EXISTS transcode_jobs_asset_idx ON transcode_jobs (asset_id, id)`,
  },
];

export function sqliteJobStore(path = ':memory:'): JobStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);
  const seen = new SqliteSeenStore(db);

  const tx: JobTx = {
    async putJob(job, ifState) {
      if (ifState !== undefined) {
        const result = db
          .prepare(
            `UPDATE transcode_jobs SET state = ?, priority = ?, retry_at = ?, updated_at = ?, data = ?
             WHERE id = ? AND state = ?`,
          )
          .run(
            job.state,
            job.priority,
            job.retryAt ?? null,
            job.updatedAt,
            JSON.stringify(job),
            job.id,
            ifState,
          );
        return Number(result.changes) === 1;
      }
      db.prepare(
        `INSERT INTO transcode_jobs (id, channel_id, asset_id, state, priority, retry_at, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           state = excluded.state, priority = excluded.priority, retry_at = excluded.retry_at,
           updated_at = excluded.updated_at, data = excluded.data`,
      ).run(
        job.id,
        job.channelId,
        job.assetId,
        job.state,
        job.priority,
        job.retryAt ?? null,
        job.createdAt,
        job.updatedAt,
        JSON.stringify(job),
      );
      return true;
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
    async markSeen(messageId) {
      return seen.mark(db, messageId);
    },
  };

  const parse = (row: { data: string } | undefined): TranscodeJob | undefined =>
    row ? (JSON.parse(row.data) as TranscodeJob) : undefined;

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async job(id) {
      return parse(db.prepare('SELECT data FROM transcode_jobs WHERE id = ?').get(id) as never);
    },
    async jobs(query = {}) {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      for (const [column, value] of [
        ['channel_id', query.channelId],
        ['state', query.state],
        ['asset_id', query.assetId],
      ] as const) {
        if (value !== undefined) {
          clauses.push(`${column} = ?`);
          params.push(value);
        }
      }
      if (query.after !== undefined) {
        clauses.push('id > ?');
        params.push(query.after);
      }
      params.push(query.limit ?? 100);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT data FROM transcode_jobs ${where} ORDER BY id LIMIT ?`)
        .all(...params) as { data: string }[];
      return rows.map((r) => parse(r) as TranscodeJob);
    },
    async nextQueued(now) {
      return parse(
        db
          .prepare(
            `SELECT data FROM transcode_jobs
             WHERE state = 'queued' OR (state = 'failed' AND retry_at <= ?)
             ORDER BY priority DESC, created_at, id LIMIT 1`,
          )
          .get(now) as never,
      );
    },
    async stale(before) {
      const rows = db
        .prepare(
          `SELECT data FROM transcode_jobs WHERE state = 'running' AND updated_at < ? ORDER BY id`,
        )
        .all(before) as { data: string }[];
      return rows.map((r) => parse(r) as TranscodeJob);
    },
    async close() {
      db.close();
    },
  };
}
