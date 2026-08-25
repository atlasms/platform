// The Postgres AssetStore — what actually gets deployed
// ([02-system-architecture.md §270](../../../docs/architecture/02-system-architecture.md)).
//
// Held to the same conformance suite as the sqlite adapter, because the properties MAM depends on
// (tenant isolation, outbox atomicity) are properties of the adapter, not of the service.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  withTransaction,
  type PgPool,
} from '@atlas/data-pg';
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

/**
 * Neutralise LIKE's own wildcards in a user-supplied prefix.
 *
 * A query of `50%` must look for terms starting with "50%", not "terms starting with 50 followed by
 * anything" — and `_` is a single-character wildcard that is even easier to type by accident. The
 * tokenizer strips punctuation, so neither can reach here today; escaping anyway costs one line
 * and removes the dependency of one module's correctness on another module's character class.
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/([\\%_])/g, '\\$1');
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

/**
 * The simple-search term index (EP-17.4).
 *
 * `(asset_id, term)` as PRIMARY KEY is load-bearing, not tidiness: the query counts matches per
 * asset to decide whether every term was found, and a duplicated row would let one term satisfy
 * that count twice.
 *
 * TWO indexes on `(channel_id, term)` deliberately. The first serves equality; the second carries
 * `text_pattern_ops`, which is what lets a prefix `LIKE 'foo%'` use a btree in a database whose
 * collation is not C. Without it Postgres falls back to a sequential scan on exactly the query an
 * editor types most — the half-finished word — and the failure shows up as latency at library
 * scale rather than as a wrong answer.
 */
/**
 * MAM's reference-data version (EP-04.8).
 *
 * ONE row, pinned by a CHECK — a version table that can grow rows is a version table that will,
 * and then "the" config version is a question about which row you read.
 */
export const pgConfigMigration: Migration = {
  id: 'mam_config',
  up: `CREATE TABLE IF NOT EXISTS mam_config (
         id      integer PRIMARY KEY CHECK (id = 1),
         version bigint NOT NULL
       );
       INSERT INTO mam_config (id, version) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;`,
};

export const pgSearchMigration: Migration = {
  id: 'mam_search',
  up: `CREATE TABLE IF NOT EXISTS asset_search (
         asset_id   text NOT NULL,
         channel_id text NOT NULL,
         term       text NOT NULL,
         PRIMARY KEY (asset_id, term)
       );
       CREATE INDEX IF NOT EXISTS asset_search_term_idx
         ON asset_search (channel_id, term, asset_id);
       CREATE INDEX IF NOT EXISTS asset_search_prefix_idx
         ON asset_search (channel_id, term text_pattern_ops);`,
};

/** Everything MAM's database needs, in order. Applied at startup under an advisory lock. */
export const mamMigrations: Migration[] = [
  outboxMigration,
  pgAssetsMigration,
  pgExtendedMigration,
  pgTagsMigration,
  pgSearchMigration,
  // Appended, never inserted: migrations run in list order and a deployed database has already
  // recorded the ones above. Slotting this next to its table would re-order history.
  outboxHeadersMigration,
  pgConfigMigration,
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

    async listByChannel(channelId, options = {}) {
      // Ordered by id (a ULID, so chronological). That total order is what makes the keyset cursor
      // work at all: `id > after` means nothing without it.
      const desc = options.order === 'desc';
      const params: unknown[] = [channelId];
      const p = (v: unknown): string => `$${params.push(v)}`;
      let sql = 'SELECT data FROM assets WHERE channel_id = $1';
      // The cursor comparison flips with the order: a keyset cursor only means "the next page"
      // relative to the direction it was produced in.
      if (options.after !== undefined) sql += ` AND id ${desc ? '<' : '>'} ${p(options.after)}`;
      sql += desc ? ' ORDER BY id DESC' : ' ORDER BY id';
      if (options.limit !== undefined) sql += ` LIMIT ${p(options.limit)}`;

      const { rows } = await pool.query<{ data: Asset }>(sql, params);
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

    async search(channelId, query, limit) {
      const params: unknown[] = [channelId];
      const p = (v: unknown): string => `$${params.push(v)}`;

      const clauses: string[] = [];
      const having: string[] = [];

      if (query.exact.length > 0) {
        const list = query.exact.map((t) => p(t)).join(', ');
        clauses.push(`term IN (${list})`);
        // Same placeholders reused — the values are already bound, so this costs no extra params.
        having.push(`count(*) FILTER (WHERE term IN (${list})) >= ${p(query.exact.length)}`);
      }
      if (query.prefix !== undefined) {
        // `LIKE prefix || '%'` rather than the sqlite adapter's range, because the
        // `text_pattern_ops` index above is built precisely for this and the planner recognises
        // the pattern. Same semantics, different route to the index — which is exactly the kind of
        // divergence the conformance suite exists to hold to one behaviour.
        const like = p(escapeLikePrefix(query.prefix) + '%');
        clauses.push(`term LIKE ${like}`);
        having.push(`count(*) FILTER (WHERE term LIKE ${like}) >= 1`);
      }
      if (clauses.length === 0) return [];

      const { rows } = await pool.query<{ asset_id: string; score: string }>(
        `SELECT asset_id, count(*) AS score
           FROM asset_search
          WHERE channel_id = $1 AND (${clauses.join(' OR ')})
          GROUP BY asset_id
         HAVING ${having.join(' AND ')}
          ORDER BY score DESC, asset_id DESC
          LIMIT ${p(limit)}`,
        params,
      );
      // `count(*)` comes back as a STRING from pg — bigint does not fit a JS number, so the driver
      // refuses to guess. Scoring on a string sorts "10" before "9".
      return rows.map((r) => ({ assetId: r.asset_id, score: Number(r.score) }));
    },

    async configVersion() {
      const { rows } = await pool.query<{ version: string }>(
        'SELECT version FROM mam_config WHERE id = 1',
      );
      // bigint arrives as a STRING from node-postgres — it does not fit a JS number in general, so
      // the driver refuses to guess. Number() is safe here because a version counter will not pass
      // 2^53 before the heat death of the newsroom.
      return Number(rows[0]?.version ?? 1);
    },
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        // The tx handle is built per transaction and closes over THIS client. That is the point:
        // a write that reached for the pool instead would land in a different transaction, and the
        // atomicity the outbox exists for would be gone without a single error.

        /**
         * Advance the reference-data version (EP-04.8), on THIS client so it commits with the
         * change that caused it.
         *
         * A closure rather than a method on `AssetTx`: the service never bumps by hand — the store
         * bumps on the writes that change reference data — and putting it on the port would invite
         * a caller to bump without changing anything, or to change something without bumping.
         */
        const bumpConfig = async (): Promise<void> => {
          await client.query('UPDATE mam_config SET version = version + 1 WHERE id = 1');
        };

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
            await bumpConfig();
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

            // Bumped on ANY tag write, not only when a label is genuinely new. Over-bumping costs
            // a client one wasted revalidation; under-bumping serves a vocabulary missing the tag
            // somebody just created. For a cache validator those are not comparable risks.
            await bumpConfig();
            return resolved;
          },
          async indexTerms(assetId, channelId, terms) {
            await client.query('DELETE FROM asset_search WHERE asset_id = $1', [assetId]);
            if (terms.length === 0) return;
            // One statement with an unnested array rather than a loop: an asset can carry a few
            // hundred terms, and that many round trips inside a transaction holds the connection
            // far longer than the write deserves.
            await client.query(
              `INSERT INTO asset_search (asset_id, channel_id, term)
               SELECT $1, $2, unnest($3::text[])`,
              [assetId, channelId, terms],
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
