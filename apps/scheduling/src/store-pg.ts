// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  PgSeenStore,
  seenMigration,
  withTransaction,
  type PgClient,
  type PgPool,
} from '@atlas/data-pg';
import type { MediaApproval } from './approvals.ts';
import type { RightsWindow } from './rights.ts';
import type { Schedule, ScheduleItem } from './schedule.ts';
import type { ScheduleStore, ScheduleTx } from './store.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'scheduling_schedules',
    up: `CREATE TABLE IF NOT EXISTS schedules (
           id             text PRIMARY KEY,
           channel_id     text NOT NULL,
           broadcast_date date NOT NULL,
           data           jsonb NOT NULL,
           UNIQUE (channel_id, broadcast_date)
         )`,
  },
  {
    id: 'scheduling_items',
    up: `CREATE TABLE IF NOT EXISTS schedule_items (
           id             text PRIMARY KEY,
           schedule_id    text NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
           channel_id     text NOT NULL,
           broadcast_date date NOT NULL,
           parent_item_id text,
           seq            integer NOT NULL,
           start          timestamptz NOT NULL,
           duration_sec   double precision NOT NULL,
           "end"          timestamptz NOT NULL,
           data           jsonb NOT NULL
         );
         -- §3.6: "what is on this day" and "what is on air at T" are index hits, not derivations.
         CREATE INDEX IF NOT EXISTS schedule_items_day_idx ON schedule_items (channel_id, broadcast_date, start);
         CREATE INDEX IF NOT EXISTS schedule_items_range_idx ON schedule_items (channel_id, start, "end");`,
  },
  // EP-31: the first broker consumer here brings the seen-mark, and MAM's word on each approval.
  seenMigration,
  {
    id: 'scheduling_media_approvals',
    up: `CREATE TABLE IF NOT EXISTS media_approvals (
           asset_id   text PRIMARY KEY,
           channel_id text NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS media_approvals_channel_idx ON media_approvals (channel_id, asset_id);`,
  },
  {
    id: 'scheduling_rights_windows',
    up: `CREATE TABLE IF NOT EXISTS rights_windows (
           id          text PRIMARY KEY,
           channel_id  text NOT NULL,
           asset_id    text,
           category_id text,
           valid_from  timestamptz NOT NULL,
           valid_to    timestamptz NOT NULL,
           version     integer NOT NULL,
           data        jsonb NOT NULL,
           CHECK ((asset_id IS NULL) <> (category_id IS NULL))
         );
         CREATE INDEX IF NOT EXISTS rights_windows_asset_idx ON rights_windows (channel_id, asset_id);
         CREATE INDEX IF NOT EXISTS rights_windows_category_idx ON rights_windows (channel_id, category_id);`,
  },
];

const toItem = (r: { data: ScheduleItem }): ScheduleItem => r.data;

export function pgScheduleStore(pool: PgPool): ScheduleStore {
  const outbox = new PgOutboxStore(pool);
  const seen = new PgSeenStore(pool);

  const putItem = async (
    client: PgClient,
    item: ScheduleItem,
    channelId: string,
    broadcastDate: string,
  ): Promise<void> => {
    await client.query(
      `INSERT INTO schedule_items
         (id, schedule_id, channel_id, broadcast_date, parent_item_id, seq, start, duration_sec, "end", data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         parent_item_id = EXCLUDED.parent_item_id, seq = EXCLUDED.seq, start = EXCLUDED.start,
         duration_sec = EXCLUDED.duration_sec, "end" = EXCLUDED."end", data = EXCLUDED.data`,
      [
        item.id,
        item.scheduleId,
        channelId,
        broadcastDate,
        item.parentItemId ?? null,
        item.seq,
        item.start,
        item.durationSec,
        item.end,
        JSON.stringify(item),
      ],
    );
  };
  const header = async (
    client: PgClient,
    scheduleId: string,
  ): Promise<{ channel_id: string; broadcast_date: string }> => {
    const { rows } = await client.query<{ channel_id: string; broadcast_date: Date }>(
      'SELECT channel_id, broadcast_date FROM schedules WHERE id = $1',
      [scheduleId],
    );
    const row = rows[0];
    if (!row) throw new Error(`schedule ${scheduleId} does not exist`);
    return { channel_id: row.channel_id, broadcast_date: dateOnly(row.broadcast_date) };
  };

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        const tx: ScheduleTx = {
          async put(s, ifVersion) {
            if (ifVersion !== undefined) {
              const result = await client.query(
                `UPDATE schedules SET data = $1 WHERE id = $2 AND (data->>'version')::int = $3`,
                [JSON.stringify(s), s.id, ifVersion],
              );
              return result.rowCount === 1;
            }
            await client.query(
              `INSERT INTO schedules (id, channel_id, broadcast_date, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
              [s.id, s.channelId, s.broadcastDate, JSON.stringify(s)],
            );
            return true;
          },
          async replaceItems(scheduleId, items) {
            const h = await header(client, scheduleId);
            await client.query('DELETE FROM schedule_items WHERE schedule_id = $1', [scheduleId]);
            for (const item of items) await putItem(client, item, h.channel_id, h.broadcast_date);
          },
          async putItem(item) {
            const h = await header(client, item.scheduleId);
            await putItem(client, item, h.channel_id, h.broadcast_date);
          },
          async removeItem(scheduleId, itemId) {
            await client.query(
              'DELETE FROM schedule_items WHERE schedule_id = $1 AND (id = $2 OR parent_item_id = $2)',
              [scheduleId, itemId],
            );
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
          async markSeen(messageId) {
            return seen.mark(client, messageId);
          },
          async approvalForUpdate(assetId) {
            const { rows } = await client.query<{ data: MediaApproval }>(
              'SELECT data FROM media_approvals WHERE asset_id = $1 FOR UPDATE',
              [assetId],
            );
            return rows[0]?.data;
          },
          async putApproval(a, existed) {
            const result = await client.query(
              existed
                ? 'UPDATE media_approvals SET channel_id = $1, data = $2 WHERE asset_id = $3'
                : 'INSERT INTO media_approvals (channel_id, data, asset_id) VALUES ($1, $2, $3) ON CONFLICT (asset_id) DO NOTHING',
              [a.channelId, JSON.stringify(a), a.assetId],
            );
            return result.rowCount === 1;
          },
          async putRightsWindow(w, ifVersion) {
            const params = [
              w.channelId,
              w.assetId ?? null,
              w.categoryId ?? null,
              w.validFrom,
              w.validTo,
              w.version,
              JSON.stringify(w),
              w.id,
            ];
            const result =
              ifVersion !== undefined
                ? await client.query(
                    `UPDATE rights_windows SET channel_id = $1, asset_id = $2, category_id = $3,
                       valid_from = $4, valid_to = $5, version = $6, data = $7
                     WHERE id = $8 AND version = $9`,
                    [...params, ifVersion],
                  )
                : await client.query(
                    `INSERT INTO rights_windows (channel_id, asset_id, category_id, valid_from, valid_to, version, data, id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
                    params,
                  );
            return result.rowCount === 1;
          },
          async deleteRightsWindow(id, ifVersion) {
            const result = await client.query(
              'DELETE FROM rights_windows WHERE id = $1 AND version = $2',
              [id, ifVersion],
            );
            return result.rowCount === 1;
          },
        };
        return fn(tx);
      });
    },
    async get(id) {
      const { rows } = await pool.query<{ data: Schedule }>(
        'SELECT data FROM schedules WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async list(channelId, options) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = $1';
      if (options.broadcastDate !== undefined) {
        params.push(options.broadcastDate);
        where += ` AND broadcast_date = $${params.length}`;
      }
      if (options.after !== undefined) {
        params.push(options.after);
        where += ` AND id < $${params.length}`;
      }
      params.push(options.limit);
      const { rows } = await pool.query<{ data: Schedule }>(
        `SELECT data FROM schedules WHERE ${where} ORDER BY broadcast_date DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => r.data);
    },
    async byDay(channelId, broadcastDate) {
      const { rows } = await pool.query<{ data: Schedule }>(
        'SELECT data FROM schedules WHERE channel_id = $1 AND broadcast_date = $2',
        [channelId, broadcastDate],
      );
      return rows[0]?.data;
    },
    async items(scheduleId) {
      const { rows } = await pool.query<{ data: ScheduleItem }>(
        'SELECT data FROM schedule_items WHERE schedule_id = $1 ORDER BY start, seq',
        [scheduleId],
      );
      return rows.map(toItem);
    },
    async item(scheduleId, itemId) {
      const { rows } = await pool.query<{ data: ScheduleItem }>(
        'SELECT data FROM schedule_items WHERE schedule_id = $1 AND id = $2',
        [scheduleId, itemId],
      );
      return rows[0] ? toItem(rows[0]) : undefined;
    },
    async onAir(channelId, from, to) {
      const { rows } = await pool.query<{ data: ScheduleItem }>(
        'SELECT data FROM schedule_items WHERE channel_id = $1 AND start < $2 AND "end" > $3 ORDER BY start',
        [channelId, to, from],
      );
      return rows.map(toItem);
    },
    async approvals(channelId, assetIds) {
      if (assetIds.length === 0) return [];
      const { rows } = await pool.query<{ data: MediaApproval }>(
        'SELECT data FROM media_approvals WHERE channel_id = $1 AND asset_id = ANY($2::text[])',
        [channelId, [...assetIds]],
      );
      return rows.map((r) => r.data);
    },
    async rightsWindow(id) {
      const { rows } = await pool.query<{ data: RightsWindow }>(
        'SELECT data FROM rights_windows WHERE id = $1',
        [id],
      );
      return rows[0]?.data;
    },
    async rightsWindows(channelId, subjects) {
      if (subjects === undefined) {
        const { rows } = await pool.query<{ data: RightsWindow }>(
          'SELECT data FROM rights_windows WHERE channel_id = $1 ORDER BY valid_from, id',
          [channelId],
        );
        return rows.map((r) => r.data);
      }
      const assets = [...(subjects.assetIds ?? [])];
      const categories = [...(subjects.categoryIds ?? [])];
      if (assets.length === 0 && categories.length === 0) return [];
      const { rows } = await pool.query<{ data: RightsWindow }>(
        `SELECT data FROM rights_windows
          WHERE channel_id = $1 AND (asset_id = ANY($2::text[]) OR category_id = ANY($3::text[]))
          ORDER BY valid_from, id`,
        [channelId, assets, categories],
      );
      return rows.map((r) => r.data);
    },
    async close() {
      await pool.end();
    },
  };
}

/** `date` columns come back as a JS Date at local midnight; the model wants YYYY-MM-DD. */
function dateOnly(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
