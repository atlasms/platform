// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  withTransaction,
  type PgPool,
} from '@atlas/data-pg';
import type { AcceptanceRuleSet } from './acceptance.ts';
import type { RimStore, RimTx } from './store.ts';
import type { IngestJob, Upload } from './upload.ts';
import type { Pickup, Watcher } from './watcher.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'rim_uploads',
    up: `CREATE TABLE IF NOT EXISTS uploads (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           state      text NOT NULL,
           expires_at timestamptz NOT NULL,
           data       jsonb NOT NULL
         );
         -- The sweeper's read: open uploads past their expiry.
         CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads (state, expires_at);
         CREATE TABLE IF NOT EXISTS upload_parts (
           upload_id  text NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
           n          integer NOT NULL,
           size_bytes bigint NOT NULL,
           sha256     text NOT NULL,
           PRIMARY KEY (upload_id, n)
         )`,
  },
  {
    id: 'rim_ingest_jobs',
    up: `CREATE TABLE IF NOT EXISTS ingest_jobs (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           state      text NOT NULL,
           created_at timestamptz NOT NULL,
           data       jsonb NOT NULL
         );
         -- The queue's read (EP-15.6): a channel's jobs, newest first, by state.
         CREATE INDEX IF NOT EXISTS ingest_jobs_channel_idx ON ingest_jobs (channel_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS ingest_jobs_state_idx ON ingest_jobs (channel_id, state)`,
  },
  {
    id: 'rim_acceptance_rule_sets',
    up: `CREATE TABLE IF NOT EXISTS acceptance_rule_sets (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           enabled    boolean NOT NULL,
           data       jsonb NOT NULL
         );
         -- The engine's read: a channel's sets, every validation.
         CREATE INDEX IF NOT EXISTS acceptance_rule_sets_channel_idx ON acceptance_rule_sets (channel_id)`,
  },
  {
    // EP-15.2: folder watchers, the ledger of what each took, and who scans which.
    id: 'rim_watchers',
    up: `CREATE TABLE IF NOT EXISTS watchers (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           enabled    boolean NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS watchers_channel_idx ON watchers (channel_id);
         CREATE TABLE IF NOT EXISTS watch_pickups (
           watcher_id text NOT NULL,
           name       text NOT NULL,
           sha256     text NOT NULL,
           channel_id text NOT NULL,
           at         timestamptz NOT NULL,
           data       jsonb NOT NULL,
           PRIMARY KEY (watcher_id, name, sha256)
         );
         -- The scan's read: the latest pickup of a name.
         CREATE INDEX IF NOT EXISTS watch_pickups_name_idx ON watch_pickups (watcher_id, name, at DESC);
         CREATE TABLE IF NOT EXISTS watcher_leases (
           watcher_id text PRIMARY KEY,
           channel_id text NOT NULL,
           holder     text NOT NULL,
           expires_at timestamptz NOT NULL
         )`,
  },
];

export function pgRimStore(pool: PgPool): RimStore {
  const outbox = new PgOutboxStore(pool);

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        const tx: RimTx = {
          async putUpload(u) {
            await client.query(
              `INSERT INTO uploads (id, channel_id, state, expires_at, data) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at, data = EXCLUDED.data`,
              [u.uploadId, u.channelId, u.state, u.expiresAt, JSON.stringify(u)],
            );
          },
          async putPart(p) {
            await client.query(
              `INSERT INTO upload_parts (upload_id, n, size_bytes, sha256) VALUES ($1, $2, $3, $4)
               ON CONFLICT (upload_id, n) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256`,
              [p.uploadId, p.n, p.sizeBytes, p.sha256],
            );
          },
          async deleteUpload(id) {
            await client.query('DELETE FROM uploads WHERE id = $1', [id]);
          },
          async putJob(j, ifState) {
            if (ifState !== undefined) {
              const result = await client.query(
                'UPDATE ingest_jobs SET state = $1, data = $2 WHERE id = $3 AND state = $4',
                [j.state, JSON.stringify(j), j.id, ifState],
              );
              return result.rowCount === 1;
            }
            await client.query(
              `INSERT INTO ingest_jobs (id, channel_id, state, created_at, data) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data`,
              [j.id, j.channelId, j.state, j.createdAt, JSON.stringify(j)],
            );
            return true;
          },
          async putRuleSet(set) {
            await client.query(
              `INSERT INTO acceptance_rule_sets (id, channel_id, enabled, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, data = EXCLUDED.data`,
              [set.id, set.channelId, set.enabled, JSON.stringify(set)],
            );
          },
          async deleteRuleSet(id) {
            await client.query('DELETE FROM acceptance_rule_sets WHERE id = $1', [id]);
          },
          async putWatcher(w) {
            await client.query(
              `INSERT INTO watchers (id, channel_id, enabled, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, data = EXCLUDED.data`,
              [w.id, w.channelId, w.enabled, JSON.stringify(w)],
            );
          },
          async putPickup(p) {
            const result = await client.query(
              `INSERT INTO watch_pickups (watcher_id, name, sha256, channel_id, at, data) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (watcher_id, name, sha256) DO NOTHING`,
              [p.watcherId, p.name, p.sha256, p.channelId, p.at, JSON.stringify(p)],
            );
            return result.rowCount === 1;
          },
          async leaseWatcher(watcherId, channelId, holder, now, until) {
            const result = await client.query(
              `INSERT INTO watcher_leases (watcher_id, channel_id, holder, expires_at) VALUES ($1, $2, $3, $4)
               ON CONFLICT (watcher_id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
               WHERE watcher_leases.holder = EXCLUDED.holder OR watcher_leases.expires_at <= $5`,
              [watcherId, channelId, holder, until, now],
            );
            return result.rowCount === 1;
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
        };
        return fn(tx);
      });
    },
    async upload(id) {
      const { rows } = await pool.query<{ data: Upload }>(
        'SELECT data FROM uploads WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async parts(uploadId) {
      const { rows } = await pool.query<{ n: number; size_bytes: string; sha256: string }>(
        'SELECT n, size_bytes, sha256 FROM upload_parts WHERE upload_id = $1 ORDER BY n',
        [uploadId],
      );
      // bigint comes back as a string from pg; the sizes here are well within a JS integer.
      return rows.map((r) => ({
        uploadId,
        n: r.n,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
      }));
    },
    async job(id) {
      const { rows } = await pool.query<{ data: IngestJob }>(
        'SELECT data FROM ingest_jobs WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async jobs(channelId, query) {
      const clauses = ['channel_id = $1'];
      const params: (string | number)[] = [channelId];
      if (query.state !== undefined) {
        params.push(query.state);
        clauses.push(`state = $${params.length}`);
      }
      if (query.cursor !== undefined) {
        params.push(query.cursor);
        clauses.push(`id ${query.order === 'asc' ? '>' : '<'} $${params.length}`);
      }
      params.push(query.limit + 1);
      const direction = query.order === 'asc' ? 'ASC' : 'DESC';
      const { rows } = await pool.query<{ data: IngestJob }>(
        `SELECT data FROM ingest_jobs WHERE ${clauses.join(' AND ')} ORDER BY id ${direction} LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => r.data);
    },
    async jobsInState(state, before, limit) {
      const { rows } = await pool.query<{ data: IngestJob }>(
        'SELECT data FROM ingest_jobs WHERE state = $1 AND created_at < $2 ORDER BY created_at LIMIT $3',
        [state, before, limit],
      );
      return rows.map((r) => r.data);
    },
    async ruleSets(channelId) {
      const { rows } = await pool.query<{ data: AcceptanceRuleSet }>(
        'SELECT data FROM acceptance_rule_sets WHERE channel_id = $1 ORDER BY id',
        [channelId],
      );
      return rows.map((r) => r.data);
    },
    async ruleSet(id) {
      const { rows } = await pool.query<{ data: AcceptanceRuleSet }>(
        'SELECT data FROM acceptance_rule_sets WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async watchers(channelId) {
      const { rows } = await pool.query<{ data: Watcher }>(
        'SELECT data FROM watchers WHERE channel_id = $1 ORDER BY id',
        [channelId],
      );
      return rows.map((r) => r.data);
    },
    async watcher(id) {
      const { rows } = await pool.query<{ data: Watcher }>(
        'SELECT data FROM watchers WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async enabledWatchers() {
      const { rows } = await pool.query<{ data: Watcher }>(
        'SELECT data FROM watchers WHERE enabled ORDER BY id',
      );
      return rows.map((r) => r.data);
    },
    async pickup(watcherId, name) {
      const { rows } = await pool.query<{ data: Pickup }>(
        'SELECT data FROM watch_pickups WHERE watcher_id = $1 AND name = $2 ORDER BY at DESC LIMIT 1',
        [watcherId, name],
      );
      return rows[0]?.data;
    },
    async expiredUploads(now, limit) {
      const { rows } = await pool.query<{ data: Upload }>(
        `SELECT data FROM uploads WHERE state = 'open' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`,
        [now, limit],
      );
      return rows.map((r) => r.data);
    },
    async close() {
      await pool.end();
    },
  };
}
