// The Postgres adapter — production. Same port, same conformance suite.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  PgSeenStore,
  seenMigration,
  withTransaction,
  type PgPool,
} from '@atlas/data-pg';
import {
  normalizeTask,
  type Message,
  type Notification,
  type SharedNotification,
  type Task,
} from './inbox.ts';
import type { TypeOverride } from './notification-types.ts';
import type { Preferences } from './preferences.ts';
import type { InboxStore, InboxTx } from './store.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  seenMigration,
  {
    id: 'notifications_inbox',
    up: `CREATE TABLE IF NOT EXISTS tasks (
           id            text PRIMARY KEY,
           channel_id    text NOT NULL,
           assignee_kind text NOT NULL,
           assignee      text NOT NULL,
           state         text NOT NULL,
           due_at        timestamptz,
           data          jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS tasks_assignee_idx
           ON tasks (channel_id, assignee_kind, assignee, state);
         CREATE TABLE IF NOT EXISTS notifications (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           user_id    text NOT NULL,
           read       boolean NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS notifications_user_idx
           ON notifications (channel_id, user_id, id);`,
  },
  // EP-25.2: a task is acted on — claimed, forwarded, completed — each a compare-and-set.
  {
    id: 'notifications_task_version',
    up: `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;`,
  },
  // EP-25.4: chat messages, and the recipients a reader is found by (a group resolved when read).
  {
    id: 'notifications_messages',
    up: `CREATE TABLE IF NOT EXISTS messages (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           sender     text NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (channel_id, sender, id);
         CREATE TABLE IF NOT EXISTS message_recipients (
           message_id   text NOT NULL REFERENCES messages(id),
           channel_id   text NOT NULL,
           kind         text NOT NULL,
           recipient_id text NOT NULL,
           PRIMARY KEY (message_id, kind, recipient_id)
         );
         CREATE INDEX IF NOT EXISTS message_recipients_reader_idx
           ON message_recipients (channel_id, kind, recipient_id, message_id);`,
  },
  // EP-25.5: a channel's overrides of the notification-type registry (the built-ins are code).
  {
    id: 'notifications_type_overrides',
    up: `CREATE TABLE IF NOT EXISTS notification_type_overrides (
           channel_id text NOT NULL,
           type_key   text NOT NULL,
           version    integer NOT NULL,
           data       jsonb NOT NULL,
           PRIMARY KEY (channel_id, type_key)
         );`,
  },
  // EP-25.5: notifications for everyone holding a permission (an alert to ops:read), and each
  // reader's read state of them.
  {
    id: 'notifications_shared',
    up: `CREATE TABLE IF NOT EXISTS shared_notifications (
           id         text PRIMARY KEY,
           channel_id text NOT NULL,
           permission text NOT NULL,
           data       jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS shared_notifications_audience_idx
           ON shared_notifications (channel_id, permission, id);
         CREATE TABLE IF NOT EXISTS shared_notification_reads (
           notification_id text NOT NULL REFERENCES shared_notifications(id),
           channel_id      text NOT NULL,
           user_id         text NOT NULL,
           read            boolean NOT NULL,
           PRIMARY KEY (notification_id, user_id)
         );`,
  },
  // EP-25.6: a person's notification preferences — one row per person per channel.
  {
    id: 'notifications_preferences',
    up: `CREATE TABLE IF NOT EXISTS preferences (
           channel_id text NOT NULL,
           user_id    text NOT NULL,
           version    integer NOT NULL,
           data       jsonb NOT NULL,
           PRIMARY KEY (channel_id, user_id)
         );`,
  },
];

export function pgInboxStore(pool: PgPool): InboxStore {
  const outbox = new PgOutboxStore(pool);
  const seen = new PgSeenStore(pool);

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        const tx: InboxTx = {
          async insertTask(t) {
            const result = await client.query(
              `INSERT INTO tasks (id, channel_id, assignee_kind, assignee, state, due_at, version, data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
              [
                t.id,
                t.channelId,
                t.assigneeKind,
                t.assignee,
                t.state,
                t.dueAt ?? null,
                t.version,
                JSON.stringify(t),
              ],
            );
            return result.rowCount === 1;
          },
          async updateTask(t, ifVersion) {
            const result = await client.query(
              `UPDATE tasks SET assignee_kind = $1, assignee = $2, state = $3, due_at = $4,
                      version = $5, data = $6
                WHERE id = $7 AND version = $8`,
              [
                t.assigneeKind,
                t.assignee,
                t.state,
                t.dueAt ?? null,
                t.version,
                JSON.stringify(t),
                t.id,
                ifVersion,
              ],
            );
            return result.rowCount === 1;
          },
          async insertNotification(n) {
            await client.query(
              'INSERT INTO notifications (id, channel_id, user_id, read, data) VALUES ($1, $2, $3, $4, $5)',
              [n.id, n.channelId, n.userId, n.read, JSON.stringify(n)],
            );
          },
          async putPreferences(p, ifVersion) {
            const result =
              ifVersion === 0
                ? await client.query(
                    `INSERT INTO preferences (channel_id, user_id, version, data) VALUES ($1, $2, $3, $4)
                     ON CONFLICT DO NOTHING`,
                    [p.channelId, p.userId, p.version, JSON.stringify(p)],
                  )
                : await client.query(
                    `UPDATE preferences SET version = $1, data = $2
                      WHERE channel_id = $3 AND user_id = $4 AND version = $5`,
                    [p.version, JSON.stringify(p), p.channelId, p.userId, ifVersion],
                  );
            return result.rowCount === 1;
          },
          async insertShared(n) {
            await client.query(
              'INSERT INTO shared_notifications (id, channel_id, permission, data) VALUES ($1, $2, $3, $4)',
              [n.id, n.channelId, n.audience.permission, JSON.stringify(n)],
            );
          },
          async markSharedRead(channelId, userId, id, read, permissions) {
            if (permissions.length === 0) return false;
            const there = await client.query(
              `SELECT 1 FROM shared_notifications
                WHERE id = $1 AND channel_id = $2 AND permission = ANY($3::text[])`,
              [id, channelId, permissions],
            );
            if (there.rowCount === 0) return false;
            await client.query(
              `INSERT INTO shared_notification_reads (notification_id, channel_id, user_id, read)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (notification_id, user_id) DO UPDATE SET read = excluded.read`,
              [id, channelId, userId, read],
            );
            return true;
          },
          async putTypeOverride(o, ifVersion) {
            const result =
              ifVersion === 0
                ? await client.query(
                    `INSERT INTO notification_type_overrides (channel_id, type_key, version, data)
                     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                    [o.channelId, o.key, o.version, JSON.stringify(o)],
                  )
                : await client.query(
                    `UPDATE notification_type_overrides SET version = $1, data = $2
                      WHERE channel_id = $3 AND type_key = $4 AND version = $5`,
                    [o.version, JSON.stringify(o), o.channelId, o.key, ifVersion],
                  );
            return result.rowCount === 1;
          },
          async markRead(channelId, userId, id, read) {
            const result = await client.query(
              `UPDATE notifications SET read = $1, data = data || jsonb_build_object('read', $1::boolean)
                WHERE id = $2 AND channel_id = $3 AND user_id = $4`,
              [read, id, channelId, userId],
            );
            return result.rowCount === 1;
          },
          async insertMessage(m) {
            await client.query(
              'INSERT INTO messages (id, channel_id, sender, data) VALUES ($1, $2, $3, $4)',
              [m.id, m.channelId, m.from, JSON.stringify(m)],
            );
            for (const r of m.to)
              await client.query(
                `INSERT INTO message_recipients (message_id, channel_id, kind, recipient_id)
                 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                [m.id, m.channelId, r.kind, r.id],
              );
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
          async markSeen(messageId) {
            return seen.mark(client, messageId);
          },
        };
        return fn(tx);
      });
    },
    async task(id) {
      const { rows } = await pool.query<{ data: Task }>('SELECT data FROM tasks WHERE id = $1', [
        id,
      ]);
      return rows[0] !== undefined ? normalizeTask(rows[0].data) : undefined;
    },
    async openTasks(channelId, principals, limit) {
      if (principals.length === 0) return [];
      const params: unknown[] = [channelId];
      const match = principals
        .map((p) => {
          params.push(p.kind, p.id);
          return `(assignee_kind = $${params.length - 1} AND assignee = $${params.length})`;
        })
        .join(' OR ');
      params.push(limit);
      const { rows } = await pool.query<{ data: Task }>(
        `SELECT data FROM tasks
          WHERE channel_id = $1 AND state IN ('open', 'forwarded') AND (${match})
          ORDER BY due_at ASC NULLS LAST, id LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => normalizeTask(r.data));
    },
    async notifications(channelId, userId, limit) {
      const { rows } = await pool.query<{ data: Notification }>(
        `SELECT data FROM notifications WHERE channel_id = $1 AND user_id = $2
          ORDER BY id DESC LIMIT $3`,
        [channelId, userId, limit],
      );
      return rows.map((r) => r.data);
    },
    async preferences(channelId, userId) {
      const { rows } = await pool.query<{ data: Preferences }>(
        'SELECT data FROM preferences WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId],
      );
      return rows[0]?.data;
    },
    async sharedFor(channelId, permissions, userId, limit) {
      if (permissions.length === 0) return [];
      const { rows } = await pool.query<{ data: SharedNotification; read: boolean }>(
        `SELECT s.data, COALESCE(r.read, false) AS read FROM shared_notifications s
           LEFT JOIN shared_notification_reads r ON r.notification_id = s.id AND r.user_id = $1
          WHERE s.channel_id = $2 AND s.permission = ANY($3::text[])
          ORDER BY s.id DESC LIMIT $4`,
        [userId, channelId, permissions, limit],
      );
      return rows.map((r) => {
        const { audience: _audience, ...n } = r.data;
        return { ...n, userId, read: r.read };
      });
    },
    async sharedUnread(channelId, permissions, userId) {
      if (permissions.length === 0) return 0;
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM shared_notifications s
           LEFT JOIN shared_notification_reads r ON r.notification_id = s.id AND r.user_id = $1
          WHERE s.channel_id = $2 AND s.permission = ANY($3::text[]) AND NOT COALESCE(r.read, false)`,
        [userId, channelId, permissions],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async typeOverrides(channelId) {
      const { rows } = await pool.query<{ data: TypeOverride }>(
        'SELECT data FROM notification_type_overrides WHERE channel_id = $1',
        [channelId],
      );
      return rows.map((r) => r.data);
    },
    async messagesFor(channelId, reader, { after, limit }) {
      const params: unknown[] = [channelId, reader.userId, reader.groups];
      let keyset = '';
      if (after !== undefined) {
        params.push(after);
        keyset = `AND m.id < $${params.length}`;
      }
      params.push(limit);
      const { rows } = await pool.query<{ data: Message }>(
        `SELECT m.data FROM messages m
          WHERE m.channel_id = $1
            AND (m.sender = $2
                 OR m.id IN (SELECT message_id FROM message_recipients
                              WHERE channel_id = $1
                                AND ((kind = 'user' AND recipient_id = $2)
                                     OR (kind = 'group' AND recipient_id = ANY($3::text[])))))
            ${keyset}
          ORDER BY m.id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => r.data);
    },
    async unreadCount(channelId, userId) {
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM notifications WHERE channel_id = $1 AND user_id = $2 AND NOT read',
        [channelId, userId],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async close() {
      // The pool is main.ts's to end.
    },
  };
}
