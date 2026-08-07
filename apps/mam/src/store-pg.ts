// The Postgres AssetStore — what actually gets deployed
// ([02-system-architecture.md §270](../../../docs/architecture/02-system-architecture.md)).
//
// Held to the same conformance suite as the sqlite adapter, because the properties MAM depends on
// (tenant isolation, outbox atomicity) are properties of the adapter, not of the service.

import type { Migration } from '@atlas/data';
import { outboxMigration, PgOutboxStore, withTransaction, type PgPool } from '@atlas/data-pg';
import type { Asset } from './asset.ts';
import type { FieldSchema } from './field-schema.ts';
import type { AssetStore, AssetTx } from './store.ts';
import type { Tag } from './tag.ts';

interface TagRow {
  id: string;
  channel_id: string;
  label: string;
  normalized: string;
}

const toTag = (r: TagRow): Tag => ({
  id: r.id,
  channelId: r.channel_id,
  label: r.label,
  normalized: r.normalized,
});

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

/**
 * The extensible document (EP-17.2), and the operator-defined schemas that govern it.
 *
 * `asset_extended` is its own table rather than a column on `assets`: it can grow without bound,
 * and most reads — a catalogue listing, a lifecycle check — do not want it.
 */
export const pgExtendedMigration: Migration = {
  id: 'mam_asset_extended',
  up: `CREATE TABLE IF NOT EXISTS asset_extended (
         asset_id   text PRIMARY KEY,
         channel_id text NOT NULL,
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE TABLE IF NOT EXISTS field_schemas (
         id            text PRIMARY KEY,
         channel_id    text NOT NULL,
         media_type    text NOT NULL,
         category_path text,
         fields        jsonb NOT NULL
       );
       CREATE INDEX IF NOT EXISTS field_schemas_channel_idx
         ON field_schemas (channel_id, media_type);`,
};

/**
 * Free-form tags and the asset join (EP-17.3).
 *
 * `(channel_id, normalized)` is UNIQUE and load-bearing: it is what makes "the same tag" a database
 * fact rather than a convention two adapters each implement. Without it, concurrent taggers mint
 * duplicate rows for one keyword and the tag cloud slowly fills with near-identical entries.
 *
 * `asset_tags` is indexed on `(tag_id, asset_id)` as well as its primary key — the reverse
 * direction, "which assets carry this tag", is what FR-TAX-6 asks for and what EP-17.4's query will
 * run. The index belongs with the table, not with the reader that arrives later.
 */
export const pgTagsMigration: Migration = {
  id: 'mam_tags',
  up: `CREATE TABLE IF NOT EXISTS tags (
         id         text PRIMARY KEY,
         channel_id text NOT NULL,
         label      text NOT NULL,
         normalized text NOT NULL
       );
       CREATE UNIQUE INDEX IF NOT EXISTS tags_identity_idx ON tags (channel_id, normalized);
       CREATE TABLE IF NOT EXISTS asset_tags (
         asset_id text NOT NULL,
         tag_id   text NOT NULL,
         PRIMARY KEY (asset_id, tag_id)
       );
       CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags (tag_id, asset_id);`,
};

/** Everything MAM's database needs, in order. Applied at startup under an advisory lock. */
export const mamMigrations: Migration[] = [
  outboxMigration,
  pgAssetsMigration,
  pgExtendedMigration,
  pgTagsMigration,
];

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

    async extended(assetId) {
      const { rows } = await pool.query<{ data: Record<string, unknown> }>(
        'SELECT data FROM asset_extended WHERE asset_id = $1',
        [assetId],
      );
      return rows[0]?.data;
    },

    async schemas(channelId) {
      const { rows } = await pool.query<{
        id: string;
        channel_id: string;
        media_type: string;
        category_path: string | null;
        fields: FieldSchema['fields'];
      }>(
        `SELECT id, channel_id, media_type, category_path, fields
           FROM field_schemas WHERE channel_id = $1 ORDER BY id`,
        [channelId],
      );
      return rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        mediaType: r.media_type,
        // Omit rather than set null: `categoryPath: null` is not the same value as absent, and
        // absent is what "applies channel-wide" means.
        ...(r.category_path !== null ? { categoryPath: r.category_path } : {}),
        fields: r.fields,
      }));
    },

    async tagsOf(assetId) {
      const { rows } = await pool.query<TagRow>(
        `SELECT t.id, t.channel_id, t.label, t.normalized
           FROM asset_tags a JOIN tags t ON t.id = a.tag_id
          WHERE a.asset_id = $1 ORDER BY t.normalized`,
        [assetId],
      );
      return rows.map(toTag);
    },

    async listTags(channelId) {
      const { rows } = await pool.query<TagRow>(
        'SELECT id, channel_id, label, normalized FROM tags WHERE channel_id = $1 ORDER BY normalized',
        [channelId],
      );
      return rows.map(toTag);
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
          async putExtended(assetId, channelId, values) {
            await client.query(
              `INSERT INTO asset_extended (asset_id, channel_id, data, updated_at)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (asset_id) DO UPDATE SET channel_id = excluded.channel_id,
                                                    data       = excluded.data,
                                                    updated_at = now()`,
              [assetId, channelId, JSON.stringify(values)],
            );
          },
          async putSchema(schema) {
            await client.query(
              `INSERT INTO field_schemas (id, channel_id, media_type, category_path, fields)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO UPDATE SET channel_id    = excluded.channel_id,
                                              media_type    = excluded.media_type,
                                              category_path = excluded.category_path,
                                              fields        = excluded.fields`,
              [
                schema.id,
                schema.channelId,
                schema.mediaType,
                schema.categoryPath ?? null,
                JSON.stringify(schema.fields),
              ],
            );
          },
          async setTags(assetId, channelId, candidates) {
            const resolved: Tag[] = [];
            for (const c of candidates) {
              // `DO UPDATE`, not `DO NOTHING`, and that is the whole trick: `DO NOTHING` returns
              // ZERO rows on conflict, so RETURNING would hand back nothing for every tag that
              // already existed. Writing the column back to itself makes the conflicting row an
              // updated row, which RETURNING then yields — and keeps the FIRST spelling, so a later
              // `football` does not silently rewrite everyone's `Football`.
              const { rows } = await client.query<{ id: string; label: string }>(
                `INSERT INTO tags (id, channel_id, label, normalized) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (channel_id, normalized) DO UPDATE SET label = tags.label
                 RETURNING id, label`,
                [c.id, channelId, c.label, c.normalized],
              );
              const row = rows[0];
              if (!row) throw new Error(`tag upsert returned no row for "${c.normalized}"`);
              resolved.push({ id: row.id, channelId, label: row.label, normalized: c.normalized });
            }

            // Replace, not merge. Delete-then-insert rather than a diff: the set is tiny, and a
            // diff is more code to get subtly wrong for no measurable gain.
            await client.query('DELETE FROM asset_tags WHERE asset_id = $1', [assetId]);
            for (const tag of resolved) {
              await client.query('INSERT INTO asset_tags (asset_id, tag_id) VALUES ($1, $2)', [
                assetId,
                tag.id,
              ]);
            }

            return resolved;
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
