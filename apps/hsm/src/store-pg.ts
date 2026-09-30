// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  withTransaction,
  type PgPool,
} from '@atlas/data-pg';
import type { FileEntry, Replica } from './file.ts';
import type { Operation } from './operation.ts';
import type { HsmStore, HsmTx } from './store.ts';
import type { StorageTarget } from './targets.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'hsm_storage_targets',
    up: `CREATE TABLE IF NOT EXISTS storage_targets (
           id         text PRIMARY KEY,
           channel_id text,
           scope      text NOT NULL,
           tier       text NOT NULL,
           is_default boolean NOT NULL,
           enabled    boolean NOT NULL,
           version    integer NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS storage_targets_default_idx
           ON storage_targets (scope, tier) WHERE is_default AND enabled;`,
  },
  {
    id: 'hsm_files',
    up: `CREATE TABLE IF NOT EXISTS files (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           asset_id   text NOT NULL,
           kind       text NOT NULL,
           variant    text NOT NULL,
           target_id  text NOT NULL,
           version    integer NOT NULL,
           deleted_at timestamptz,
           data       jsonb NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS files_live_idx
           ON files (asset_id, kind, variant) WHERE deleted_at IS NULL;
         CREATE INDEX IF NOT EXISTS files_asset_idx ON files (channel_id, asset_id);
         CREATE TABLE IF NOT EXISTS file_replicas (
           file_id    text NOT NULL REFERENCES files(id),
           target_id  text NOT NULL,
           channel_id text NOT NULL,
           data       jsonb NOT NULL,
           PRIMARY KEY (file_id, target_id)
         );`,
  },
  {
    id: 'hsm_operations',
    up: `CREATE TABLE IF NOT EXISTS operations (
           id          text PRIMARY KEY,
           channel_id  text NOT NULL,
           state       text NOT NULL,
           holder      text,
           lease_until timestamptz,
           retry_at    timestamptz,
           created_at  timestamptz NOT NULL,
           data        jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS operations_due_idx ON operations (state, retry_at, created_at);`,
  },
];

export function pgHsmStore(pool: PgPool): HsmStore {
  const outbox = new PgOutboxStore(pool);

  const opParams = (op: Operation): unknown[] => [
    op.channelId,
    op.state,
    op.holder ?? null,
    op.leaseUntil ?? null,
    op.retryAt ?? null,
    op.createdAt,
    JSON.stringify(op),
    op.id,
  ];

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
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
              // ON CONFLICT DO NOTHING covers both the id and the live (asset, kind, variant) index.
              const r = await client.query(
                `INSERT INTO files (channel_id, asset_id, kind, variant, target_id, version, deleted_at, data, id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
                params,
              );
              return r.rowCount === 1;
            }
            const r = await client.query(
              `UPDATE files SET channel_id = $1, asset_id = $2, kind = $3, variant = $4, target_id = $5,
                 version = $6, deleted_at = $7, data = $8 WHERE id = $9 AND version = $10`,
              [...params, ifVersion],
            );
            return r.rowCount === 1;
          },
          async putReplica(rep) {
            await client.query(
              `INSERT INTO file_replicas (file_id, target_id, channel_id, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (file_id, target_id) DO UPDATE SET data = EXCLUDED.data`,
              [rep.fileId, rep.targetId, rep.channelId, JSON.stringify(rep)],
            );
          },
          async deleteReplicas(fileId) {
            await client.query('DELETE FROM file_replicas WHERE file_id = $1', [fileId]);
          },
          async putTarget(t, ifVersion) {
            const params = [
              t.channelId ?? null,
              t.channelId ?? '',
              t.tier,
              t.isDefault,
              t.enabled,
              t.version,
              JSON.stringify(t),
              t.id,
            ];
            if (ifVersion === undefined) {
              const r = await client.query(
                `INSERT INTO storage_targets (channel_id, scope, tier, is_default, enabled, version, data, id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
                params,
              );
              return r.rowCount === 1;
            }
            const r = await client.query(
              `UPDATE storage_targets SET channel_id = $1, scope = $2, tier = $3, is_default = $4,
                 enabled = $5, version = $6, data = $7 WHERE id = $8 AND version = $9`,
              [...params, ifVersion],
            );
            return r.rowCount === 1;
          },
          async insertOperation(op) {
            const r = await client.query(
              `INSERT INTO operations (channel_id, state, holder, lease_until, retry_at, created_at, data, id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
              opParams(op),
            );
            return r.rowCount === 1;
          },
          async putOperation(op, ifState, ifHolder) {
            const r = await client.query(
              `UPDATE operations SET channel_id = $1, state = $2, holder = $3, lease_until = $4,
                 retry_at = $5, created_at = $6, data = $7
               WHERE id = $8 AND state = $9 AND ($10::text IS NULL OR holder = $10)`,
              [...opParams(op), ifState, ifHolder ?? null],
            );
            return r.rowCount === 1;
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
        };
        return fn(tx);
      });
    },
    async file(id) {
      const { rows } = await pool.query<{ data: FileEntry }>(
        'SELECT data FROM files WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async liveFile(assetId, kind, variant) {
      const { rows } = await pool.query<{ data: FileEntry }>(
        `SELECT data FROM files WHERE asset_id = $1 AND kind = $2 AND variant = $3 AND deleted_at IS NULL`,
        [assetId, kind, variant ?? ''],
      );
      return rows[0]?.data;
    },
    async filesOf(channelId, assetId) {
      const { rows } = await pool.query<{ data: FileEntry }>(
        `SELECT data FROM files WHERE channel_id = $1 AND asset_id = $2 AND deleted_at IS NULL
         ORDER BY kind, variant`,
        [channelId, assetId],
      );
      return rows.map((r) => r.data);
    },
    async replicasOf(fileId) {
      const { rows } = await pool.query<{ data: Replica }>(
        'SELECT data FROM file_replicas WHERE file_id = $1 ORDER BY target_id',
        [fileId],
      );
      return rows.map((r) => r.data);
    },
    async target(id) {
      const { rows } = await pool.query<{ data: StorageTarget }>(
        'SELECT data FROM storage_targets WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async targets(channelId) {
      const { rows } = await pool.query<{ data: StorageTarget }>(
        `SELECT data FROM storage_targets WHERE scope = '' OR scope = $1`,
        [channelId ?? ''],
      );
      return rows.map((r) => r.data).sort((a, b) => a.name.localeCompare(b.name));
    },
    async defaultTarget(channelId, tier) {
      const { rows } = await pool.query<{ data: StorageTarget }>(
        `SELECT data FROM storage_targets
          WHERE tier = $1 AND is_default AND enabled AND (scope = $2 OR scope = '')
          ORDER BY (scope = '') LIMIT 1`,
        [tier, channelId],
      );
      return rows[0]?.data;
    },
    async operation(id) {
      const { rows } = await pool.query<{ data: Operation }>(
        'SELECT data FROM operations WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async operationsDue(now, limit) {
      const { rows } = await pool.query<{ data: Operation }>(
        `SELECT data FROM operations
          WHERE state = 'queued' OR (state = 'failed' AND retry_at <= $1)
          ORDER BY created_at, id LIMIT $2`,
        [now, limit],
      );
      return rows.map((r) => r.data);
    },
    async operationsLapsed(now) {
      const { rows } = await pool.query<{ data: Operation }>(
        `SELECT data FROM operations WHERE state = 'running' AND lease_until < $1`,
        [now],
      );
      return rows.map((r) => r.data);
    },
    async progress(id, holder, bytesDone, leaseUntil) {
      const r = await pool.query(
        `UPDATE operations
            SET lease_until = $1,
                data = jsonb_set(jsonb_set(data, '{bytesDone}', to_jsonb($2::bigint)), '{leaseUntil}', to_jsonb($5::text))
          WHERE id = $3 AND state = 'running' AND holder = $4`,
        // The lease twice: once as the column's timestamptz, once as the ISO string the document
        // keeps — one parameter would be inferred as timestamptz and cast back to a non-ISO text.
        [leaseUntil, bytesDone, id, holder, leaseUntil],
      );
      return r.rowCount === 1;
    },
    async close() {
      await pool.end();
    },
  };
}
