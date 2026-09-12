// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  withTransaction,
  type PgClient,
  type PgPool,
} from '@atlas/data-pg';
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
];

const toItem = (r: { data: ScheduleItem }): ScheduleItem => r.data;

export function pgScheduleStore(pool: PgPool): ScheduleStore {
  const outbox = new PgOutboxStore(pool);

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
          async put(s) {
            await client.query(
              `INSERT INTO schedules (id, channel_id, broadcast_date, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
              [s.id, s.channelId, s.broadcastDate, JSON.stringify(s)],
            );
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
