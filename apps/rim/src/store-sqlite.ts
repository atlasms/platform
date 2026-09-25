// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.

import {
  migrate,
  openDb,
  outboxHeadersMigration,
  outboxMigration,
  SqliteOutboxStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import type { AcceptanceRuleSet } from './acceptance.ts';
import type { RimStore, RimTx } from './store.ts';
import type { IngestJob, Upload } from './upload.ts';
import type { Pickup, Watcher } from './watcher.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'rim_uploads',
    up: `CREATE TABLE IF NOT EXISTS uploads (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           state      TEXT NOT NULL,
           expires_at TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         -- The sweeper's read: open uploads past their expiry.
         CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads (state, expires_at);
         CREATE TABLE IF NOT EXISTS upload_parts (
           upload_id  TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
           n          INTEGER NOT NULL,
           size_bytes INTEGER NOT NULL,
           sha256     TEXT NOT NULL,
           PRIMARY KEY (upload_id, n)
         )`,
  },
  {
    id: 'rim_ingest_jobs',
    up: `CREATE TABLE IF NOT EXISTS ingest_jobs (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           state      TEXT NOT NULL,
           created_at TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         -- The queue's read (EP-15.6): a channel's jobs, newest first, by state.
         CREATE INDEX IF NOT EXISTS ingest_jobs_channel_idx ON ingest_jobs (channel_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS ingest_jobs_state_idx ON ingest_jobs (channel_id, state)`,
  },
  {
    id: 'rim_acceptance_rule_sets',
    up: `CREATE TABLE IF NOT EXISTS acceptance_rule_sets (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           enabled    INTEGER NOT NULL,
           data       TEXT NOT NULL
         );
         -- The engine's read: a channel's sets, every validation.
         CREATE INDEX IF NOT EXISTS acceptance_rule_sets_channel_idx ON acceptance_rule_sets (channel_id)`,
  },
  {
    // EP-15.2: folder watchers, the ledger of what each took, and who scans which.
    id: 'rim_watchers',
    up: `CREATE TABLE IF NOT EXISTS watchers (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           enabled    INTEGER NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS watchers_channel_idx ON watchers (channel_id);
         CREATE TABLE IF NOT EXISTS watch_pickups (
           watcher_id TEXT NOT NULL,
           name       TEXT NOT NULL,
           sha256     TEXT NOT NULL,
           channel_id TEXT NOT NULL,
           at         TEXT NOT NULL,
           data       TEXT NOT NULL,
           PRIMARY KEY (watcher_id, name, sha256)
         );
         -- The scan's read: the latest pickup of a name.
         CREATE INDEX IF NOT EXISTS watch_pickups_name_idx ON watch_pickups (watcher_id, name, at DESC);
         CREATE TABLE IF NOT EXISTS watcher_leases (
           watcher_id TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           holder     TEXT NOT NULL,
           expires_at TEXT NOT NULL
         )`,
  },
];

export function sqliteRimStore(path = ':memory:'): RimStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);

  const tx: RimTx = {
    async putUpload(u) {
      db.prepare(
        `INSERT INTO uploads (id, channel_id, state, expires_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at, data = excluded.data`,
      ).run(u.uploadId, u.channelId, u.state, u.expiresAt, JSON.stringify(u));
    },
    async putPart(p) {
      db.prepare(
        `INSERT INTO upload_parts (upload_id, n, size_bytes, sha256) VALUES (?, ?, ?, ?)
         ON CONFLICT (upload_id, n) DO UPDATE SET size_bytes = excluded.size_bytes, sha256 = excluded.sha256`,
      ).run(p.uploadId, p.n, p.sizeBytes, p.sha256);
    },
    async deleteUpload(id) {
      db.prepare('DELETE FROM upload_parts WHERE upload_id = ?').run(id);
      db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
    },
    async putJob(j, ifState) {
      if (ifState !== undefined) {
        const result = db
          .prepare('UPDATE ingest_jobs SET state = ?, data = ? WHERE id = ? AND state = ?')
          .run(j.state, JSON.stringify(j), j.id, ifState);
        return Number(result.changes) === 1;
      }
      db.prepare(
        `INSERT INTO ingest_jobs (id, channel_id, state, created_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data`,
      ).run(j.id, j.channelId, j.state, j.createdAt, JSON.stringify(j));
      return true;
    },
    async putRuleSet(set) {
      db.prepare(
        `INSERT INTO acceptance_rule_sets (id, channel_id, enabled, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, data = excluded.data`,
      ).run(set.id, set.channelId, set.enabled ? 1 : 0, JSON.stringify(set));
    },
    async deleteRuleSet(id) {
      db.prepare('DELETE FROM acceptance_rule_sets WHERE id = ?').run(id);
    },
    async putWatcher(w) {
      db.prepare(
        `INSERT INTO watchers (id, channel_id, enabled, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, data = excluded.data`,
      ).run(w.id, w.channelId, w.enabled ? 1 : 0, JSON.stringify(w));
    },
    async putPickup(p) {
      const result = db
        .prepare(
          `INSERT INTO watch_pickups (watcher_id, name, sha256, channel_id, at, data) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (watcher_id, name, sha256) DO NOTHING`,
        )
        .run(p.watcherId, p.name, p.sha256, p.channelId, p.at, JSON.stringify(p));
      return Number(result.changes) === 1;
    },
    async leaseWatcher(watcherId, channelId, holder, now, until) {
      const result = db
        .prepare(
          `INSERT INTO watcher_leases (watcher_id, channel_id, holder, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (watcher_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
           WHERE watcher_leases.holder = excluded.holder OR watcher_leases.expires_at <= ?`,
        )
        .run(watcherId, channelId, holder, until, now);
      return Number(result.changes) === 1;
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
  };

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async upload(id) {
      const row = db.prepare('SELECT data FROM uploads WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Upload) : undefined;
    },
    async parts(uploadId) {
      const rows = db
        .prepare('SELECT n, size_bytes, sha256 FROM upload_parts WHERE upload_id = ? ORDER BY n')
        .all(uploadId) as { n: number; size_bytes: number; sha256: string }[];
      return rows.map((r) => ({ uploadId, n: r.n, sizeBytes: r.size_bytes, sha256: r.sha256 }));
    },
    async job(id) {
      const row = db.prepare('SELECT data FROM ingest_jobs WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as IngestJob) : undefined;
    },
    async jobs(channelId, query) {
      const clauses = ['channel_id = ?'];
      const params: (string | number)[] = [channelId];
      if (query.state !== undefined) {
        clauses.push('state = ?');
        params.push(query.state);
      }
      if (query.cursor !== undefined) {
        clauses.push(query.order === 'asc' ? 'id > ?' : 'id < ?');
        params.push(query.cursor);
      }
      params.push(query.limit + 1);
      const direction = query.order === 'asc' ? 'ASC' : 'DESC';
      const rows = db
        .prepare(
          `SELECT data FROM ingest_jobs WHERE ${clauses.join(' AND ')} ORDER BY id ${direction} LIMIT ?`,
        )
        .all(...params) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as IngestJob);
    },
    async jobsInState(state, before, limit) {
      const rows = db
        .prepare(
          'SELECT data FROM ingest_jobs WHERE state = ? AND created_at < ? ORDER BY created_at LIMIT ?',
        )
        .all(state, before, limit) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as IngestJob);
    },
    async ruleSets(channelId) {
      const rows = db
        .prepare('SELECT data FROM acceptance_rule_sets WHERE channel_id = ? ORDER BY id')
        .all(channelId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as AcceptanceRuleSet);
    },
    async ruleSet(id) {
      const row = db.prepare('SELECT data FROM acceptance_rule_sets WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as AcceptanceRuleSet) : undefined;
    },
    async watchers(channelId) {
      const rows = db
        .prepare('SELECT data FROM watchers WHERE channel_id = ? ORDER BY id')
        .all(channelId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Watcher);
    },
    async watcher(id) {
      const row = db.prepare('SELECT data FROM watchers WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Watcher) : undefined;
    },
    async enabledWatchers() {
      const rows = db.prepare('SELECT data FROM watchers WHERE enabled = 1 ORDER BY id').all() as {
        data: string;
      }[];
      return rows.map((r) => JSON.parse(r.data) as Watcher);
    },
    async pickup(watcherId, name) {
      const row = db
        .prepare(
          'SELECT data FROM watch_pickups WHERE watcher_id = ? AND name = ? ORDER BY at DESC LIMIT 1',
        )
        .get(watcherId, name) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Pickup) : undefined;
    },
    async expiredUploads(now, limit) {
      const rows = db
        .prepare(
          `SELECT data FROM uploads WHERE state = 'open' AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
        )
        .all(now, limit) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Upload);
    },
    async close() {
      db.close();
    },
  };
}
