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
import { captureOf } from './capture.ts';
import type { Recorder } from './recorder.ts';
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
  {
    // EP-39 (ADR-0007): recorders, and the captures planned from them. A capture is COLUMNS: the
    // lease is one conditional UPDATE whose rule reads the recorder's other captures.
    id: 'rim_recorders',
    up: `CREATE TABLE IF NOT EXISTS recorders (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           enabled    boolean NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS recorders_channel_idx ON recorders (channel_id);
         CREATE TABLE IF NOT EXISTS captures (
           id           text PRIMARY KEY,
           recorder_id  text NOT NULL,
           channel_id   text NOT NULL,
           file_start   timestamptz NOT NULL,
           file_end     timestamptz NOT NULL,
           capture_from timestamptz NOT NULL,
           capture_to   timestamptz NOT NULL,
           slot         integer NOT NULL,
           part         integer NOT NULL,
           state        text NOT NULL,
           holder       text,
           lease_until  timestamptz,
           started_at   timestamptz,
           ended_at     timestamptz,
           job_id       text,
           reason       text,
           UNIQUE (recorder_id, file_start, part)
         );
         -- A recorder's captures in order: the listing, planning's "last", the lease rule's overlap.
         CREATE INDEX IF NOT EXISTS captures_recorder_idx ON captures (recorder_id, file_start);
         CREATE INDEX IF NOT EXISTS captures_state_idx ON captures (state, capture_to)`,
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
          async putRecorder(r) {
            await client.query(
              `INSERT INTO recorders (id, channel_id, enabled, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, data = EXCLUDED.data`,
              [r.id, r.channelId, r.enabled, JSON.stringify(r)],
            );
          },
          async insertCapture(c) {
            const result = await client.query(
              `INSERT INTO captures (id, recorder_id, channel_id, file_start, file_end, capture_from, capture_to, slot, part, state, holder, lease_until, started_at, ended_at, job_id, reason)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
               ON CONFLICT (recorder_id, file_start, part) DO NOTHING`,
              [
                c.id,
                c.recorderId,
                c.channelId,
                c.fileStart,
                c.fileEnd,
                c.captureFrom,
                c.captureTo,
                c.slot,
                c.part,
                c.state,
                c.holder ?? null,
                c.leaseUntil ?? null,
                c.startedAt ?? null,
                c.endedAt ?? null,
                c.jobId ?? null,
                c.reason ?? null,
              ],
            );
            return result.rowCount === 1;
          },
          async putCapture(c, ifState) {
            const result = await client.query(
              `UPDATE captures SET state = $1, holder = $2, lease_until = $3, started_at = $4,
                 ended_at = $5, job_id = $6, reason = $7 WHERE id = $8 AND state = $9`,
              [
                c.state,
                c.holder ?? null,
                c.leaseUntil ?? null,
                c.startedAt ?? null,
                c.endedAt ?? null,
                c.jobId ?? null,
                c.reason ?? null,
                c.id,
                ifState,
              ],
            );
            return result.rowCount === 1;
          },
          async deletePlanned(recorderId, after) {
            const result = await client.query(
              `DELETE FROM captures WHERE recorder_id = $1 AND state = 'planned' AND capture_from > $2`,
              [recorderId, after],
            );
            return result.rowCount ?? 0;
          },
          async leaseCapture(id, holder, now, until) {
            const result = await client.query(
              `UPDATE captures c SET state = 'running', holder = $1, lease_until = $2,
                 started_at = COALESCE(c.started_at, $3)
               WHERE c.id = $4
                 AND (c.state = 'planned' OR (c.state = 'running' AND (c.holder = $1 OR c.lease_until <= $3)))
                 AND NOT EXISTS (
                   SELECT 1 FROM captures o
                    WHERE o.recorder_id = c.recorder_id AND o.id <> c.id
                      AND o.state = 'running' AND o.holder = $1 AND o.lease_until > $3
                      AND o.capture_from < c.capture_to AND o.capture_to > c.capture_from)`,
              [holder, until, now, id],
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
    async recorders(channelId) {
      const { rows } = await pool.query<{ data: Recorder }>(
        'SELECT data FROM recorders WHERE channel_id = $1 ORDER BY id',
        [channelId],
      );
      return rows.map((r) => r.data);
    },
    async recorder(id) {
      const { rows } = await pool.query<{ data: Recorder }>(
        'SELECT data FROM recorders WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async enabledRecorders() {
      const { rows } = await pool.query<{ data: Recorder }>(
        'SELECT data FROM recorders WHERE enabled ORDER BY id',
      );
      return rows.map((r) => r.data);
    },
    async capture(id) {
      const { rows } = await pool.query('SELECT * FROM captures WHERE id = $1', [id]);
      return rows[0] ? captureOf(rows[0]) : undefined;
    },
    async captures(recorderId, from, limit) {
      const { rows } = await pool.query(
        'SELECT * FROM captures WHERE recorder_id = $1 AND file_start >= $2 ORDER BY file_start, part LIMIT $3',
        [recorderId, from, limit],
      );
      return rows.map(captureOf);
    },
    async lastCapture(recorderId) {
      const { rows } = await pool.query(
        `SELECT * FROM captures WHERE recorder_id = $1 AND state <> 'cancelled'
         ORDER BY file_start DESC, part DESC LIMIT 1`,
        [recorderId],
      );
      return rows[0] ? captureOf(rows[0]) : undefined;
    },
    async capturesDue(now, until, limit) {
      const { rows } = await pool.query(
        `SELECT * FROM captures
          WHERE capture_to > $1
            AND ((state = 'planned' AND capture_from <= $2)
              OR (state = 'running' AND lease_until <= $1))
          ORDER BY capture_from LIMIT $3`,
        [now, until, limit],
      );
      return rows.map(captureOf);
    },
    async capturesHeldBy(holder, state) {
      const { rows } = await pool.query(
        'SELECT * FROM captures WHERE holder = $1 AND state = $2 ORDER BY capture_from',
        [holder, state],
      );
      return rows.map(captureOf);
    },
    async unhandedBy(holder) {
      const { rows } = await pool.query(
        `SELECT * FROM captures WHERE holder = $1 AND state IN ('completed', 'partial')
           AND job_id IS NULL ORDER BY capture_from`,
        [holder],
      );
      return rows.map(captureOf);
    },
    async runningCaptures(channelId) {
      const { rows } = await pool.query(
        `SELECT * FROM captures WHERE channel_id = $1 AND state = 'running' ORDER BY file_start`,
        [channelId],
      );
      return rows.map(captureOf);
    },
    async captureCounts(channelId, since) {
      const { rows } = await pool.query<{ recorder_id: string; missed: string; partial: string }>(
        `SELECT recorder_id,
                count(*) FILTER (WHERE state = 'missed') AS missed,
                count(*) FILTER (WHERE state = 'partial') AS partial
           FROM captures WHERE channel_id = $1 AND file_start >= $2 GROUP BY recorder_id`,
        [channelId, since],
      );
      return rows.map((r) => ({
        recorderId: r.recorder_id,
        missed: Number(r.missed),
        partial: Number(r.partial),
      }));
    },
    async lastMissed(channelId, since) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (recorder_id) * FROM captures
          WHERE channel_id = $1 AND state = 'missed' AND file_start >= $2
          ORDER BY recorder_id, file_start DESC`,
        [channelId, since],
      );
      return rows.map(captureOf);
    },
    async capturesEndedIn(state, before, limit) {
      const { rows } = await pool.query(
        'SELECT * FROM captures WHERE state = $1 AND capture_to < $2 ORDER BY capture_to LIMIT $3',
        [state, before, limit],
      );
      return rows.map(captureOf);
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
