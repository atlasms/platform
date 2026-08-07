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
import { prefixUpperBound } from './search.ts';
import type { Tag } from './tag.ts';

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

export const sqliteTagsMigration: Migration = {
  id: 'mam_tags',
  up: `CREATE TABLE IF NOT EXISTS tags (
         id         TEXT PRIMARY KEY,
         channel_id TEXT NOT NULL,
         label      TEXT NOT NULL,
         normalized TEXT NOT NULL
       );
       CREATE UNIQUE INDEX IF NOT EXISTS tags_identity_idx ON tags (channel_id, normalized);
       CREATE TABLE IF NOT EXISTS asset_tags (
         asset_id TEXT NOT NULL,
         tag_id   TEXT NOT NULL,
         PRIMARY KEY (asset_id, tag_id)
       );
       CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags (tag_id, asset_id);`,
};

export const sqliteSearchMigration: Migration = {
  id: 'mam_search',
  up: `CREATE TABLE IF NOT EXISTS asset_search (
         asset_id   TEXT NOT NULL,
         channel_id TEXT NOT NULL,
         term       TEXT NOT NULL,
         PRIMARY KEY (asset_id, term)
       );
       CREATE INDEX IF NOT EXISTS asset_search_term_idx
         ON asset_search (channel_id, term, asset_id);`,
};

export function sqliteAssetStore(path = ':memory:'): AssetStore & { db: Db } {
  const db = openDb(path);
  migrate(db, [
    outboxMigration,
    sqliteAssetsMigration,
    sqliteExtendedMigration,
    sqliteTagsMigration,
    sqliteSearchMigration,
  ]);
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
    async setTags(assetId, channelId, candidates) {
      const resolved = candidates.map((c) => {
        // `DO UPDATE`, not `DO NOTHING`, and that is the whole trick: `DO NOTHING` returns ZERO
        // rows on conflict, so RETURNING would hand back nothing for every tag that already
        // existed. Writing the column back to itself makes the conflicting row an updated row,
        // which RETURNING then yields — and keeps the FIRST spelling, so a later `football` does
        // not silently rewrite everyone's `Football`.
        const row = db
          .prepare(
            `INSERT INTO tags (id, channel_id, label, normalized) VALUES (?, ?, ?, ?)
             ON CONFLICT (channel_id, normalized) DO UPDATE SET label = tags.label
             RETURNING id, label`,
          )
          .get(c.id, channelId, c.label, c.normalized) as { id: string; label: string };
        return { id: row.id, channelId, label: row.label, normalized: c.normalized };
      });

      // Replace, not merge. Delete-then-insert rather than a diff: the set is tiny, and a diff is
      // more code to get subtly wrong for no measurable gain.
      db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(assetId);
      const link = db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)');
      for (const tag of resolved) link.run(assetId, tag.id);

      return resolved;
    },
    async indexTerms(assetId, channelId, terms) {
      db.prepare('DELETE FROM asset_search WHERE asset_id = ?').run(assetId);
      const add = db.prepare(
        'INSERT INTO asset_search (asset_id, channel_id, term) VALUES (?, ?, ?)',
      );
      for (const term of terms) add.run(assetId, channelId, term);
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
  };

  const toTag = (r: {
    id: string;
    channel_id: string;
    label: string;
    normalized: string;
  }): Tag => ({
    id: r.id,
    channelId: r.channel_id,
    label: r.label,
    normalized: r.normalized,
  });

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
    async tagsOf(assetId) {
      const rows = db
        .prepare(
          `SELECT t.id, t.channel_id, t.label, t.normalized
             FROM asset_tags a JOIN tags t ON t.id = a.tag_id
            WHERE a.asset_id = ? ORDER BY t.normalized`,
        )
        .all(assetId) as { id: string; channel_id: string; label: string; normalized: string }[];
      return rows.map(toTag);
    },
    async listTags(channelId) {
      const rows = db
        .prepare(
          'SELECT id, channel_id, label, normalized FROM tags WHERE channel_id = ? ORDER BY normalized',
        )
        .all(channelId) as { id: string; channel_id: string; label: string; normalized: string }[];
      return rows.map(toTag);
    },
    async search(channelId, query, limit) {
      const clauses: string[] = [];
      const params: unknown[] = [channelId];

      if (query.exact.length > 0) {
        clauses.push(`term IN (${query.exact.map(() => '?').join(', ')})`);
        params.push(...query.exact);
      }
      if (query.prefix !== undefined) {
        // A RANGE, not `LIKE 'p%'`. SQLite only uses an index for LIKE when case-sensitivity is
        // enabled globally, which is a pragma this store has no business setting for the whole
        // connection. `>= p AND < bound` is an index scan unconditionally.
        clauses.push('(term >= ? AND term < ?)');
        params.push(query.prefix, prefixUpperBound(query.prefix));
      }
      if (clauses.length === 0) return [];

      // AND semantics, and the arithmetic is only sound because `(asset_id, term)` is the PRIMARY
      // KEY: each term appears at most once per asset, so summing the matches of the exact set
      // counts DISTINCT terms without a DISTINCT. A duplicate row would silently satisfy the
      // HAVING with one term matched twice.
      const having: string[] = [];
      if (query.exact.length > 0) {
        having.push(
          `SUM(CASE WHEN term IN (${query.exact.map(() => '?').join(', ')}) THEN 1 ELSE 0 END) >= ?`,
        );
        params.push(...query.exact, query.exact.length);
      }
      if (query.prefix !== undefined) {
        having.push('SUM(CASE WHEN term >= ? AND term < ? THEN 1 ELSE 0 END) >= 1');
        params.push(query.prefix, prefixUpperBound(query.prefix));
      }

      params.push(limit);
      const rows = db
        .prepare(
          `SELECT asset_id, COUNT(*) AS score
             FROM asset_search
            WHERE channel_id = ? AND (${clauses.join(' OR ')})
            GROUP BY asset_id
           HAVING ${having.join(' AND ')}
            ORDER BY score DESC, asset_id DESC
            LIMIT ?`,
        )
        .all(...(params as never[])) as { asset_id: string; score: number }[];
      return rows.map((r) => ({ assetId: r.asset_id, score: Number(r.score) }));
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
