// The `node:sqlite` AssetStore — tests and single-node dev.
//
// Same schema shape as the Postgres adapter (typed columns for what is queried, the record itself
// as a JSON document) so the two differ in driver, not in design.

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
import type { Asset, FileRef } from './asset.ts';
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

/**
 * MAM's reference-data version (EP-04.8).
 *
 * ONE row, pinned by a CHECK — a version table that can grow rows is a version table that will,
 * and then "the" config version is a question about which row you read.
 */
export const sqliteConfigMigration: Migration = {
  id: 'mam_config',
  up: `CREATE TABLE IF NOT EXISTS mam_config (
         id      INTEGER PRIMARY KEY CHECK (id = 1),
         version INTEGER NOT NULL
       );
       INSERT OR IGNORE INTO mam_config (id, version) VALUES (1, 1);`,
};

/**
 * FileRef — MAM's mirror of the HSM file ledger (EP-17.8).
 *
 * HSM is the source of truth for physical files. This table mirrors the logical file metadata
 * so the catalogue and Studio can display file rows without querying HSM directly.
 *
 * (asset_id, kind, variant) is UNIQUE: a file belongs to exactly one asset, and variants
 * distinguish multiple files of the same kind (e.g. subtitle languages, thumbnail indices).
 */
export const sqliteFileRefMigration: Migration = {
  id: 'mam_file_refs',
  up: `CREATE TABLE IF NOT EXISTS file_refs (
         id                TEXT PRIMARY KEY,
         channel_id        TEXT NOT NULL,
         asset_id          TEXT NOT NULL,
         kind              TEXT NOT NULL,
         variant           TEXT,
         storage_target_id TEXT NOT NULL,
         path              TEXT NOT NULL,
         tier              TEXT NOT NULL,
         status            TEXT NOT NULL,
         checksum          TEXT NOT NULL,
         last_verified_at  TEXT,
         size_bytes        INTEGER NOT NULL,
         technical         TEXT NOT NULL,
         provenance        TEXT NOT NULL,
         created_at        TEXT NOT NULL DEFAULT (datetime('now')),
         deleted_at        TEXT
       );
       CREATE UNIQUE INDEX IF NOT EXISTS file_refs_identity_idx
         ON file_refs (asset_id, kind, variant);
       CREATE INDEX IF NOT EXISTS file_refs_asset_idx
         ON file_refs (asset_id);
       CREATE INDEX IF NOT EXISTS file_refs_channel_idx
         ON file_refs (channel_id);`,
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
    // Appended, never inserted: migrations run in list order and a deployed database has already
    // recorded the ones above. Slotting these next to their tables would re-order history.
    outboxHeadersMigration,
    sqliteConfigMigration,
    sqliteFileRefMigration,
  ]);
  const outbox = new SqliteOutboxStore(db);

  const read = (row: { data: string } | undefined): Asset | undefined =>
    row ? (JSON.parse(row.data) as Asset) : undefined;

  /**
   * Advance the reference-data version (EP-04.8).
   *
   * `version + 1` read and written in one statement, and it runs inside the caller's transaction —
   * so the bump commits with the change that caused it. Bumping afterwards would leave a window
   * where the new tag is readable at the OLD version, and a client that revalidated in that window
   * would cache an incomplete vocabulary against a version that never changes again.
   */
  const bump = (): void => {
    db.prepare('UPDATE mam_config SET version = version + 1 WHERE id = 1').run();
  };

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
      bump();
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

      // Bumped on ANY tag write, not only when a label is genuinely new. Over-bumping costs a
      // client one wasted revalidation; under-bumping serves a vocabulary that is missing the tag
      // somebody just created. For a cache validator those are not comparable risks.
      bump();
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
    async putFileRef(fileRef) {
      db.prepare(
        `INSERT INTO file_refs (
           id, channel_id, asset_id, kind, variant, storage_target_id, path, tier, status,
           checksum, last_verified_at, size_bytes, technical, provenance, created_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           channel_id        = excluded.channel_id,
           asset_id          = excluded.asset_id,
           kind              = excluded.kind,
           variant           = excluded.variant,
           storage_target_id = excluded.storage_target_id,
           path              = excluded.path,
           tier              = excluded.tier,
           status            = excluded.status,
           checksum          = excluded.checksum,
           last_verified_at  = excluded.last_verified_at,
           size_bytes        = excluded.size_bytes,
           technical         = excluded.technical,
           provenance        = excluded.provenance,
           created_at        = excluded.created_at,
           deleted_at        = excluded.deleted_at`,
      ).run(
        fileRef.id,
        fileRef.channelId,
        fileRef.assetId,
        fileRef.kind,
        fileRef.variant ?? null,
        fileRef.storageTargetId,
        fileRef.path,
        fileRef.tier,
        fileRef.status,
        JSON.stringify(fileRef.checksum),
        fileRef.lastVerifiedAt ?? null,
        fileRef.sizeBytes,
        JSON.stringify(fileRef.technical),
        JSON.stringify(fileRef.provenance),
        fileRef.createdAt,
        fileRef.deletedAt ?? null,
      );
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

  const toFileRef = (r: {
    id: string;
    channel_id: string;
    asset_id: string;
    kind: string;
    variant: string | null;
    storage_target_id: string;
    path: string;
    tier: string;
    status: string;
    checksum: string;
    last_verified_at: string | null;
    size_bytes: number;
    technical: string;
    provenance: string;
    created_at: string;
    deleted_at: string | null;
  }): FileRef => ({
    id: r.id,
    channelId: r.channel_id,
    assetId: r.asset_id,
    kind: r.kind as FileRef['kind'],
    variant: r.variant ?? undefined,
    storageTargetId: r.storage_target_id,
    path: r.path,
    tier: r.tier as FileRef['tier'],
    status: r.status as FileRef['status'],
    checksum: JSON.parse(r.checksum),
    lastVerifiedAt: r.last_verified_at ?? undefined,
    sizeBytes: r.size_bytes,
    technical: JSON.parse(r.technical),
    provenance: JSON.parse(r.provenance),
    createdAt: r.created_at,
    deletedAt: r.deleted_at ?? undefined,
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
    async fileRefsOf(assetId) {
      const rows = db
        .prepare('SELECT * FROM file_refs WHERE asset_id = ? ORDER BY kind, variant')
        .all(assetId) as {
          id: string;
          channel_id: string;
          asset_id: string;
          kind: string;
          variant: string | null;
          storage_target_id: string;
          path: string;
          tier: string;
          status: string;
          checksum: string;
          last_verified_at: string | null;
          size_bytes: number;
          technical: string;
          provenance: string;
          created_at: string;
          deleted_at: string | null;
        }[];
      return rows.map(toFileRef);
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
    async listByChannel(channelId, options = {}) {
      // Ordered by id, which is a ULID and therefore chronological — a stable order without a
      // second column, and the one a catalogue listing wants anyway. It is also what makes the
      // keyset cursor work: `id > after` is meaningless without a total order on the same column.
      const desc = options.order === 'desc';
      const where = ['channel_id = ?'];
      const params: unknown[] = [channelId];
      if (options.after !== undefined) {
        // The comparison flips with the order: a keyset cursor only means "the next page"
        // relative to the direction it was produced in, so `id > after` under DESC would page
        // backwards into rows the caller has already seen.
        where.push(desc ? 'id < ?' : 'id > ?');
        params.push(options.after);
      }
      let sql =
        `SELECT data FROM assets WHERE ${where.join(' AND ')} ORDER BY id` + (desc ? ' DESC' : '');
      if (options.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }
      const rows = db.prepare(sql).all(...(params as never[])) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Asset);
    },
    async configVersion() {
      const row = db.prepare('SELECT version FROM mam_config WHERE id = 1').get() as
        { version: number } | undefined;
      return row?.version ?? 1;
    },
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async close() {
      db.close();
    },
  };
}
