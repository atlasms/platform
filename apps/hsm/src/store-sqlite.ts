// The node:sqlite adapter — the double, held to the same conformance suite as Postgres.

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
import type { FileEntry, Replica } from './file.ts';
import type { Operation } from './operation.ts';
import type { HsmStore, HsmTx } from './store.ts';
import type { StorageTarget } from './targets.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'hsm_storage_targets',
    up: `CREATE TABLE IF NOT EXISTS storage_targets (
           id         TEXT PRIMARY KEY,
           channel_id TEXT,
           scope      TEXT NOT NULL,
           tier       TEXT NOT NULL,
           is_default INTEGER NOT NULL,
           enabled    INTEGER NOT NULL,
           version    INTEGER NOT NULL,
           data       TEXT NOT NULL
         );
         -- At most one default per (scope, tier): where new files of that tier go.
         CREATE UNIQUE INDEX IF NOT EXISTS storage_targets_default_idx
           ON storage_targets (scope, tier) WHERE is_default = 1 AND enabled = 1;`,
  },
  {
    id: 'hsm_files',
    up: `CREATE TABLE IF NOT EXISTS files (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           asset_id   TEXT NOT NULL,
           kind       TEXT NOT NULL,
           variant    TEXT NOT NULL,
           target_id  TEXT NOT NULL,
           version    INTEGER NOT NULL,
           deleted_at TEXT,
           data       TEXT NOT NULL
         );
         -- One LIVE file per (asset, kind, variant); a deleted row stays for audit.
         CREATE UNIQUE INDEX IF NOT EXISTS files_live_idx
           ON files (asset_id, kind, variant) WHERE deleted_at IS NULL;
         CREATE INDEX IF NOT EXISTS files_asset_idx ON files (channel_id, asset_id);
         CREATE TABLE IF NOT EXISTS file_replicas (
           file_id    TEXT NOT NULL REFERENCES files(id),
           target_id  TEXT NOT NULL,
           channel_id TEXT NOT NULL,
           data       TEXT NOT NULL,
           PRIMARY KEY (file_id, target_id)
         );`,
  },
  {
    id: 'hsm_operations',
    up: `CREATE TABLE IF NOT EXISTS operations (
           id          TEXT PRIMARY KEY,
           channel_id  TEXT NOT NULL,
           state       TEXT NOT NULL,
           holder      TEXT,
           lease_until TEXT,
           retry_at    TEXT,
           created_at  TEXT NOT NULL,
           data        TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS operations_due_idx ON operations (state, retry_at, created_at);`,
  },
];

const parse = <T>(row: { data: string } | undefined): T | undefined =>
  row ? (JSON.parse(row.data) as T) : undefined;

export function sqliteHsmStore(path = ':memory:'): HsmStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);

  const writeOp = (op: Operation): unknown[] => [
    op.channelId,
    op.state,
    op.holder ?? null,
    op.leaseUntil ?? null,
    op.retryAt ?? null,
    op.createdAt,
    JSON.stringify(op),
    op.id,
  ];

  const tx: HsmTx = {
    async putFile(f, ifVersion) {
      const params = [
        f.channelId,
        f.assetId,
        f.kind,
        f.variant ?? '',
        f.storage.targetId,
        f.version,
        f.deletedAt ?? null,
        JSON.stringify(f),
        f.id,
      ];
      if (ifVersion === undefined) {
        try {
          const r = db
            .prepare(
              `INSERT INTO files (channel_id, asset_id, kind, variant, target_id, version, deleted_at, data, id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...(params as (string | number | null)[]));
          return Number(r.changes) === 1;
        } catch (err) {
          if (String((err as Error).message).includes('UNIQUE')) return false;
          throw err;
        }
      }
      const r = db
        .prepare(
          `UPDATE files SET channel_id = ?, asset_id = ?, kind = ?, variant = ?, target_id = ?, version = ?,
             deleted_at = ?, data = ? WHERE id = ? AND version = ?`,
        )
        .run(...(params as (string | number | null)[]), ifVersion);
      return Number(r.changes) === 1;
    },
    async putReplica(r) {
      db.prepare(
        `INSERT INTO file_replicas (file_id, target_id, channel_id, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (file_id, target_id) DO UPDATE SET data = excluded.data`,
      ).run(r.fileId, r.targetId, r.channelId, JSON.stringify(r));
    },
    async deleteReplicas(fileId) {
      db.prepare('DELETE FROM file_replicas WHERE file_id = ?').run(fileId);
    },
    async putTarget(t, ifVersion) {
      const params = [
        t.channelId ?? null,
        t.channelId ?? '',
        t.tier,
        t.isDefault ? 1 : 0,
        t.enabled ? 1 : 0,
        t.version,
        JSON.stringify(t),
        t.id,
      ];
      if (ifVersion === undefined) {
        const r = db
          .prepare(
            `INSERT INTO storage_targets (channel_id, scope, tier, is_default, enabled, version, data, id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          )
          .run(...(params as (string | number | null)[]));
        return Number(r.changes) === 1;
      }
      const r = db
        .prepare(
          `UPDATE storage_targets SET channel_id = ?, scope = ?, tier = ?, is_default = ?, enabled = ?,
             version = ?, data = ? WHERE id = ? AND version = ?`,
        )
        .run(...(params as (string | number | null)[]), ifVersion);
      return Number(r.changes) === 1;
    },
    async insertOperation(op) {
      const r = db
        .prepare(
          `INSERT INTO operations (channel_id, state, holder, lease_until, retry_at, created_at, data, id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .run(...(writeOp(op) as (string | number | null)[]));
      return Number(r.changes) === 1;
    },
    async putOperation(op, ifState, ifHolder) {
      const r = db
        .prepare(
          `UPDATE operations SET channel_id = ?, state = ?, holder = ?, lease_until = ?, retry_at = ?,
             created_at = ?, data = ?
           WHERE id = ? AND state = ? AND (? IS NULL OR holder = ?)`,
        )
        .run(
          ...(writeOp(op) as (string | number | null)[]),
          ifState,
          ifHolder ?? null,
          ifHolder ?? null,
        );
      return Number(r.changes) === 1;
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
    async file(id) {
      return parse<FileEntry>(
        db.prepare('SELECT data FROM files WHERE id = ?').get(id) as { data: string } | undefined,
      );
    },
    async liveFile(assetId, kind, variant) {
      return parse<FileEntry>(
        db
          .prepare(
            'SELECT data FROM files WHERE asset_id = ? AND kind = ? AND variant = ? AND deleted_at IS NULL',
          )
          .get(assetId, kind, variant ?? '') as { data: string } | undefined,
      );
    },
    async filesOf(channelId, assetId) {
      const rows = db
        .prepare(
          `SELECT data FROM files WHERE channel_id = ? AND asset_id = ? AND deleted_at IS NULL
           ORDER BY kind, variant`,
        )
        .all(channelId, assetId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as FileEntry);
    },
    async replicasOf(fileId) {
      const rows = db
        .prepare('SELECT data FROM file_replicas WHERE file_id = ? ORDER BY target_id')
        .all(fileId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Replica);
    },
    async target(id) {
      return parse<StorageTarget>(
        db.prepare('SELECT data FROM storage_targets WHERE id = ?').get(id) as
          { data: string } | undefined,
      );
    },
    async targets(channelId) {
      const rows = db
        .prepare(`SELECT data FROM storage_targets WHERE scope = '' OR scope = ?`)
        .all(channelId ?? '') as { data: string }[];
      return rows
        .map((r) => JSON.parse(r.data) as StorageTarget)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async defaultTarget(channelId, tier) {
      const row = db
        .prepare(
          `SELECT data FROM storage_targets
            WHERE tier = ? AND is_default = 1 AND enabled = 1 AND (scope = ? OR scope = '')
            ORDER BY CASE WHEN scope = '' THEN 1 ELSE 0 END LIMIT 1`,
        )
        .get(tier, channelId) as { data: string } | undefined;
      return parse<StorageTarget>(row);
    },
    async operation(id) {
      return parse<Operation>(
        db.prepare('SELECT data FROM operations WHERE id = ?').get(id) as
          { data: string } | undefined,
      );
    },
    async operationsDue(now, limit) {
      const rows = db
        .prepare(
          `SELECT data FROM operations
            WHERE state = 'queued' OR (state = 'failed' AND retry_at <= ?)
            ORDER BY created_at, id LIMIT ?`,
        )
        .all(now, limit) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Operation);
    },
    async operationsLapsed(now) {
      const rows = db
        .prepare(`SELECT data FROM operations WHERE state = 'running' AND lease_until < ?`)
        .all(now) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Operation);
    },
    async progress(id, holder, bytesDone, leaseUntil) {
      const current = parse<Operation>(
        db
          .prepare(`SELECT data FROM operations WHERE id = ? AND state = 'running' AND holder = ?`)
          .get(id, holder) as { data: string } | undefined,
      );
      if (!current) return false;
      const next: Operation = { ...current, bytesDone, leaseUntil };
      const r = db
        .prepare(
          `UPDATE operations SET lease_until = ?, data = ? WHERE id = ? AND state = 'running' AND holder = ?`,
        )
        .run(leaseUntil, JSON.stringify(next), id, holder);
      return Number(r.changes) === 1;
    },
    async close() {
      db.close();
    },
  };
}
