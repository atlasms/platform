// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.
//
// Schedules are JSON documents (the header changes shape as v1 adds validation and export state);
// items are COLUMNS, because §3.6 is about indexing them: the reel is what the control room queries.

import {
  migrate,
  openDb,
  outboxHeadersMigration,
  outboxMigration,
  seenMigration,
  SqliteOutboxStore,
  SqliteSeenStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import type { MediaApproval } from './approvals.ts';
import type { Schedule, ScheduleItem } from './schedule.ts';
import type { ScheduleStore, ScheduleTx } from './store.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'scheduling_schedules',
    up: `CREATE TABLE IF NOT EXISTS schedules (
           id             TEXT PRIMARY KEY,
           channel_id     TEXT NOT NULL,
           broadcast_date TEXT NOT NULL,
           data           TEXT NOT NULL,
           UNIQUE (channel_id, broadcast_date)
         )`,
  },
  {
    id: 'scheduling_items',
    up: `CREATE TABLE IF NOT EXISTS schedule_items (
           id             TEXT PRIMARY KEY,
           schedule_id    TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
           channel_id     TEXT NOT NULL,
           broadcast_date TEXT NOT NULL,
           parent_item_id TEXT,
           seq            INTEGER NOT NULL,
           start          TEXT NOT NULL,
           duration_sec   REAL NOT NULL,
           "end"          TEXT NOT NULL,
           data           TEXT NOT NULL
         );
         -- §3.6: the two read patterns. "What is on this day" and "what is on air at T".
         CREATE INDEX IF NOT EXISTS schedule_items_day_idx ON schedule_items (channel_id, broadcast_date, start);
         CREATE INDEX IF NOT EXISTS schedule_items_range_idx ON schedule_items (channel_id, start, "end");`,
  },
  // EP-31: the first broker consumer here brings the seen-mark, and what it keeps — MAM's word on
  // each asset's approval, which validation reads.
  seenMigration,
  {
    id: 'scheduling_media_approvals',
    up: `CREATE TABLE IF NOT EXISTS media_approvals (
           asset_id   TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS media_approvals_channel_idx ON media_approvals (channel_id, asset_id);`,
  },
];

const toItem = (r: { data: string }): ScheduleItem => JSON.parse(r.data) as ScheduleItem;

export function sqliteScheduleStore(path = ':memory:'): ScheduleStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);
  const seen = new SqliteSeenStore(db);

  const putItem = (item: ScheduleItem, channelId: string, broadcastDate: string): void => {
    db.prepare(
      `INSERT INTO schedule_items
         (id, schedule_id, channel_id, broadcast_date, parent_item_id, seq, start, duration_sec, "end", data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         parent_item_id = excluded.parent_item_id, seq = excluded.seq, start = excluded.start,
         duration_sec = excluded.duration_sec, "end" = excluded."end", data = excluded.data`,
    ).run(
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
    );
  };
  const header = (scheduleId: string): { channel_id: string; broadcast_date: string } => {
    const row = db
      .prepare('SELECT channel_id, broadcast_date FROM schedules WHERE id = ?')
      .get(scheduleId) as { channel_id: string; broadcast_date: string } | undefined;
    if (!row) throw new Error(`schedule ${scheduleId} does not exist`);
    return row;
  };

  const tx: ScheduleTx = {
    async put(s, ifVersion) {
      if (ifVersion !== undefined) {
        const result = db
          .prepare(
            `UPDATE schedules SET data = ? WHERE id = ? AND json_extract(data, '$.version') = ?`,
          )
          .run(JSON.stringify(s), s.id, ifVersion);
        return Number(result.changes) === 1;
      }
      // An UPSERT, never INSERT OR REPLACE: REPLACE is DELETE + INSERT, and the items cascade on
      // delete — so every header write silently wiped the reel here while Postgres's ON CONFLICT
      // DO UPDATE kept it. The conformance suite is what caught the two adapters disagreeing.
      db.prepare(
        `INSERT INTO schedules (id, channel_id, broadcast_date, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      ).run(s.id, s.channelId, s.broadcastDate, JSON.stringify(s));
      return true;
    },
    async replaceItems(scheduleId, items) {
      const h = header(scheduleId);
      db.prepare('DELETE FROM schedule_items WHERE schedule_id = ?').run(scheduleId);
      for (const item of items) putItem(item, h.channel_id, h.broadcast_date);
    },
    async putItem(item) {
      const h = header(item.scheduleId);
      putItem(item, h.channel_id, h.broadcast_date);
    },
    async removeItem(scheduleId, itemId) {
      db.prepare(
        'DELETE FROM schedule_items WHERE schedule_id = ? AND (id = ? OR parent_item_id = ?)',
      ).run(scheduleId, itemId, itemId);
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
    async markSeen(messageId) {
      return seen.mark(db, messageId);
    },
    async approvalForUpdate(assetId) {
      // sqlite serializes writers; the transaction is the lock.
      const row = db.prepare('SELECT data FROM media_approvals WHERE asset_id = ?').get(assetId) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as MediaApproval) : undefined;
    },
    async putApproval(a, existed) {
      const result = db
        .prepare(
          existed
            ? 'UPDATE media_approvals SET channel_id = ?, data = ? WHERE asset_id = ?'
            : 'INSERT INTO media_approvals (channel_id, data, asset_id) VALUES (?, ?, ?) ON CONFLICT (asset_id) DO NOTHING',
        )
        .run(a.channelId, JSON.stringify(a), a.assetId);
      return Number(result.changes) === 1;
    },
  };

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async get(id) {
      const row = db.prepare('SELECT data FROM schedules WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Schedule) : undefined;
    },
    async list(channelId, options) {
      const params: (string | number)[] = [channelId];
      let where = 'channel_id = ?';
      if (options.broadcastDate !== undefined) {
        where += ' AND broadcast_date = ?';
        params.push(options.broadcastDate);
      }
      if (options.after !== undefined) {
        where += ' AND id < ?';
        params.push(options.after);
      }
      params.push(options.limit);
      const rows = db
        .prepare(
          `SELECT data FROM schedules WHERE ${where} ORDER BY broadcast_date DESC, id DESC LIMIT ?`,
        )
        .all(...params) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Schedule);
    },
    async byDay(channelId, broadcastDate) {
      const row = db
        .prepare('SELECT data FROM schedules WHERE channel_id = ? AND broadcast_date = ?')
        .get(channelId, broadcastDate) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as Schedule) : undefined;
    },
    async items(scheduleId) {
      const rows = db
        .prepare('SELECT data FROM schedule_items WHERE schedule_id = ? ORDER BY start, seq')
        .all(scheduleId) as { data: string }[];
      return rows.map(toItem);
    },
    async item(scheduleId, itemId) {
      const row = db
        .prepare('SELECT data FROM schedule_items WHERE schedule_id = ? AND id = ?')
        .get(scheduleId, itemId) as { data: string } | undefined;
      return row ? toItem(row) : undefined;
    },
    async onAir(channelId, from, to) {
      // Overlapping the window: started before it ends, ends after it starts. The range index.
      const rows = db
        .prepare(
          'SELECT data FROM schedule_items WHERE channel_id = ? AND start < ? AND "end" > ? ORDER BY start',
        )
        .all(channelId, to, from) as { data: string }[];
      return rows.map(toItem);
    },
    async approvals(channelId, assetIds) {
      if (assetIds.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT data FROM media_approvals WHERE channel_id = ? AND asset_id IN (${assetIds.map(() => '?').join(', ')})`,
        )
        .all(channelId, ...assetIds) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as MediaApproval);
    },
    async close() {
      db.close();
    },
  };
}
