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

export function sqliteAssetStore(path = ':memory:'): AssetStore & { db: Db } {
  const db = openDb(path);
  migrate(db, [outboxMigration, sqliteAssetsMigration]);
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
    async enqueue(record) {
      outbox.enqueue(record);
    },
  };

  return {
    db,
    async get(id) {
      return read(db.prepare('SELECT data FROM assets WHERE id = ?').get(id) as never);
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
