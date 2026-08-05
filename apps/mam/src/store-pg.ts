// The Postgres AssetStore — what actually gets deployed
// ([02-system-architecture.md §270](../../../docs/architecture/02-system-architecture.md)).
//
// Held to the same conformance suite as the sqlite adapter, because the properties MAM depends on
// (tenant isolation, outbox atomicity) are properties of the adapter, not of the service.

import type { Migration } from '@atlas/data';
import { outboxMigration, PgOutboxStore, withTransaction, type PgPool } from '@atlas/data-pg';
import type { Asset } from './asset.ts';
import type { AssetStore, AssetTx } from './store.ts';

/**
 * `channel_id` and `state` are real columns; everything else is the document.
 *
 * They are the two things every query filters on, and the two things that must never disagree with
 * the record — so they are written from the asset on every upsert rather than maintained
 * separately. Extensible per-media-type metadata (EP-17.2) will be its own document beside this.
 */
export const pgAssetsMigration: Migration = {
  id: 'mam_assets',
  up: `CREATE TABLE IF NOT EXISTS assets (
         id         text PRIMARY KEY,
         channel_id text NOT NULL,
         state      text NOT NULL,
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS assets_channel_idx ON assets (channel_id, state);`,
};

/** Everything MAM's database needs, in order. Applied at startup under an advisory lock. */
export const mamMigrations: Migration[] = [outboxMigration, pgAssetsMigration];

export function pgAssetStore(pool: PgPool): AssetStore {
  const outbox = new PgOutboxStore(pool);

  return {
    async get(id) {
      const { rows } = await pool.query<{ data: Asset }>('SELECT data FROM assets WHERE id = $1', [
        id,
      ]);
      return rows[0]?.data;
    },

    async listByChannel(channelId) {
      const { rows } = await pool.query<{ data: Asset }>(
        'SELECT data FROM assets WHERE channel_id = $1 ORDER BY id',
        [channelId],
      );
      return rows.map((r) => r.data);
    },

    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        // The tx handle is built per transaction and closes over THIS client. That is the point:
        // a write that reached for the pool instead would land in a different transaction, and the
        // atomicity the outbox exists for would be gone without a single error.
        const tx: AssetTx = {
          async put(asset) {
            await client.query(
              `INSERT INTO assets (id, channel_id, state, data, updated_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id,
                                              state      = excluded.state,
                                              data       = excluded.data,
                                              updated_at = now()`,
              [asset.id, asset.channelId, asset.state, JSON.stringify(asset)],
            );
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
        };
        return fn(tx);
      });
    },

    async close() {
      await pool.end();
    },
  };
}
