// The `node:sqlite` AssetStore — tests and single-node dev.
//
// Same schema shape as the Postgres adapter (typed columns for what is queried, the record itself
// as a JSON document) so the two differ in driver, not in design.

import {
  migrate,
  openDb,
  outboxMigration,
  SqliteOutboxStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import type { Asset } from './asset.ts';
import type { FieldSchema } from './field-schema.ts';
import type { AssetStore, AssetTx } from './store.ts';

export const sqliteAssetsMigration: Migration = {
  id: 'mam_assets',
  up: `CREATE TABLE IF NOT EXISTS assets (
         id         TEXT PRIMARY KEY,
         channel_id TEXT NOT NULL,
         state      TEXT NOT NULL,
         data       TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS assets_channel_idx ON assets (channel_id, state);`,
};

export const sqliteExtendedMigration: Migration = {
  id: 'mam_asset_extended',
  up: `CREATE TABLE IF NOT EXISTS asset_extended (
         asset_id   TEXT PRIMARY KEY,
         channel_id TEXT NOT NULL,
         data       TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS field_schemas (
         id            TEXT PRIMARY KEY,
         channel_id    TEXT NOT NULL,
         media_type    TEXT NOT NULL,
         category_path TEXT,
         fields        TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS field_schemas_channel_idx
         ON field_schemas (channel_id, media_type);`,
};

export function sqliteAssetStore(path = ':memory:'): AssetStore & { db: Db } {
  const db = openDb(path);
  migrate(db, [outboxMigration, sqliteAssetsMigration, sqliteExtendedMigration]);
  const outbox = new SqliteOutboxStore(db);

  const read = (row: { data: string } | undefined): Asset | undefined =>
    row ? (JSON.parse(row.data) as Asset) : undefined;

  const tx: AssetTx = {
    async put(asset) {
      db.prepare(
        `INSERT INTO assets (id, channel_id, state, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id,
                                       state      = excluded.state,
                                       data       = excluded.data`,
      ).run(asset.id, asset.channelId, asset.state, JSON.stringify(asset));
    },
    async putExtended(assetId, channelId, values) {
      db.prepare(
        `INSERT INTO asset_extended (asset_id, channel_id, data) VALUES (?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET channel_id = excluded.channel_id,
                                             data       = excluded.data`,
      ).run(assetId, channelId, JSON.stringify(values));
    },
    async putSchema(schema) {
      db.prepare(
        `INSERT INTO field_schemas (id, channel_id, media_type, category_path, fields)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET channel_id    = excluded.channel_id,
                                       media_type    = excluded.media_type,
                                       category_path = excluded.category_path,
                                       fields        = excluded.fields`,
      ).run(
        schema.id,
        schema.channelId,
        schema.mediaType,
        schema.categoryPath ?? null,
        JSON.stringify(schema.fields),
      );
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
  };

  return {
    db,
    async get(id) {
      return read(db.prepare('SELECT data FROM assets WHERE id = ?').get(id) as never);
    },
    async extended(assetId) {
      const row = db.prepare('SELECT data FROM asset_extended WHERE asset_id = ?').get(assetId) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined;
    },
    async schemas(channelId) {
      const rows = db
        .prepare(
          `SELECT id, channel_id, media_type, category_path, fields
             FROM field_schemas WHERE channel_id = ? ORDER BY id`,
        )
        .all(channelId) as {
        id: string;
        channel_id: string;
        media_type: string;
        category_path: string | null;
        fields: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        mediaType: r.media_type,
        // Omit rather than set null: `categoryPath: null` is not the same value as absent, and
        // absent is what "applies channel-wide" means.
        ...(r.category_path !== null ? { categoryPath: r.category_path } : {}),
        fields: JSON.parse(r.fields) as FieldSchema['fields'],
      }));
    },
    async listByChannel(channelId) {
      // Ordered by id, which is a ULID and therefore chronological — a stable order without a
      // second column, and the one a catalogue listing wants anyway.
      const rows = db
        .prepare('SELECT data FROM assets WHERE channel_id = ? ORDER BY id')
        .all(channelId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Asset);
    },
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async close() {
      db.close();
    },
  };
}
