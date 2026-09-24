// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  PgSeenStore,
  seenMigration,
  withTransaction,
  type PgPool,
} from '@atlas/data-pg';
import type { TranscodeJob } from './job.ts';
import type { JobStore, JobTx } from './store.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  seenMigration,
  {
    id: 'mts_jobs',
    up: `CREATE TABLE IF NOT EXISTS transcode_jobs (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           asset_id   text NOT NULL,
           state      text NOT NULL,
           priority   integer NOT NULL,
           retry_at   timestamptz,
           created_at timestamptz NOT NULL,
           updated_at timestamptz NOT NULL,
           data       jsonb NOT NULL
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

export function pgJobStore(pool: PgPool): JobStore {
  const outbox = new PgOutboxStore(pool);
  const seen = new PgSeenStore(pool);

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        const tx: JobTx = {
          async putJob(job, ifState) {
            if (ifState !== undefined) {
              const result = await client.query(
                `UPDATE transcode_jobs
                 SET state = $1, priority = $2, retry_at = $3, updated_at = $4, data = $5
                 WHERE id = $6 AND state = $7`,
                [
                  job.state,
                  job.priority,
                  job.retryAt ?? null,
                  job.updatedAt,
                  JSON.stringify(job),
                  job.id,
                  ifState,
                ],
              );
              return result.rowCount === 1;
            }
            await client.query(
              `INSERT INTO transcode_jobs (id, channel_id, asset_id, state, priority, retry_at, created_at, updated_at, data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (id) DO UPDATE SET
                 state = EXCLUDED.state, priority = EXCLUDED.priority, retry_at = EXCLUDED.retry_at,
                 updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
              [
                job.id,
                job.channelId,
                job.assetId,
                job.state,
                job.priority,
                job.retryAt ?? null,
                job.createdAt,
                job.updatedAt,
                JSON.stringify(job),
              ],
            );
            return true;
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
          async markSeen(messageId) {
            return seen.mark(client, messageId);
          },
        };
        return fn(tx);
      });
    },
    async job(id) {
      const { rows } = await pool.query<{ data: TranscodeJob }>(
        'SELECT data FROM transcode_jobs WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
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
          params.push(value);
          clauses.push(`${column} = $${params.length}`);
        }
      }
      if (query.after !== undefined) {
        params.push(query.after);
        clauses.push(`id > $${params.length}`);
      }
      params.push(query.limit ?? 100);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await pool.query<{ data: TranscodeJob }>(
        `SELECT data FROM transcode_jobs ${where} ORDER BY id LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => r.data);
    },
    async nextQueued(now) {
      const { rows } = await pool.query<{ data: TranscodeJob }>(
        `SELECT data FROM transcode_jobs
         WHERE state = 'queued' OR (state = 'failed' AND retry_at <= $1)
         ORDER BY priority DESC, created_at, id LIMIT 1`,
        [now],
      );
      return rows[0]?.data;
    },
    async stale(before) {
      const { rows } = await pool.query<{ data: TranscodeJob }>(
        `SELECT data FROM transcode_jobs WHERE state = 'running' AND updated_at < $1 ORDER BY id`,
        [before],
      );
      return rows.map((r) => r.data);
    },
    async close() {
      await pool.end();
    },
  };
}
