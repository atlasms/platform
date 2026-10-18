// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.

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
import {
  normalizeTask,
  type Message,
  type Notification,
  type SharedNotification,
  type Task,
} from './inbox.ts';
import type { TypeOverride } from './notification-types.ts';
import type { InboxStore, InboxTx } from './store.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  seenMigration,
  {
    id: 'notifications_inbox',
    up: `CREATE TABLE IF NOT EXISTS tasks (
           id            TEXT PRIMARY KEY,
           channel_id    TEXT NOT NULL,
           assignee_kind TEXT NOT NULL,
           assignee      TEXT NOT NULL,
           state         TEXT NOT NULL,
           due_at        TEXT,
           data          TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS tasks_assignee_idx
           ON tasks (channel_id, assignee_kind, assignee, state);
         CREATE TABLE IF NOT EXISTS notifications (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           user_id    TEXT NOT NULL,
           read       INTEGER NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS notifications_user_idx
           ON notifications (channel_id, user_id, id);`,
  },
  // EP-25.2: a task is acted on — claimed, forwarded, completed — each a compare-and-set.
  {
    id: 'notifications_task_version',
    up: `ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`,
  },
  // EP-25.4: chat messages, and the recipients a reader is found by (a group resolved when read).
  {
    id: 'notifications_messages',
    up: `CREATE TABLE IF NOT EXISTS messages (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           sender     TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (channel_id, sender, id);
         CREATE TABLE IF NOT EXISTS message_recipients (
           message_id   TEXT NOT NULL REFERENCES messages(id),
           channel_id   TEXT NOT NULL,
           kind         TEXT NOT NULL,
           recipient_id TEXT NOT NULL,
           PRIMARY KEY (message_id, kind, recipient_id)
         );
         CREATE INDEX IF NOT EXISTS message_recipients_reader_idx
           ON message_recipients (channel_id, kind, recipient_id, message_id);`,
  },
  // EP-25.5: a channel's overrides of the notification-type registry (the built-ins are code).
  {
    id: 'notifications_type_overrides',
    up: `CREATE TABLE IF NOT EXISTS notification_type_overrides (
           channel_id TEXT NOT NULL,
           type_key   TEXT NOT NULL,
           version    INTEGER NOT NULL,
           data       TEXT NOT NULL,
           PRIMARY KEY (channel_id, type_key)
         );`,
  },
  // EP-25.5: notifications for everyone holding a permission (an alert to ops:read), and each
  // reader's read state of them.
  {
    id: 'notifications_shared',
    up: `CREATE TABLE IF NOT EXISTS shared_notifications (
           id         TEXT PRIMARY KEY,
           channel_id TEXT NOT NULL,
           permission TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS shared_notifications_audience_idx
           ON shared_notifications (channel_id, permission, id);
         CREATE TABLE IF NOT EXISTS shared_notification_reads (
           notification_id TEXT NOT NULL REFERENCES shared_notifications(id),
           channel_id      TEXT NOT NULL,
           user_id         TEXT NOT NULL,
           read            INTEGER NOT NULL,
           PRIMARY KEY (notification_id, user_id)
         );`,
  },
];

export function sqliteInboxStore(path = ':memory:'): InboxStore & { db: Db } {
  const db = openDb(path);
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);
  const seen = new SqliteSeenStore(db);

  const tx: InboxTx = {
    async insertTask(t) {
      const result = db
        .prepare(
          `INSERT INTO tasks (id, channel_id, assignee_kind, assignee, state, due_at, version, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .run(
          t.id,
          t.channelId,
          t.assigneeKind,
          t.assignee,
          t.state,
          t.dueAt ?? null,
          t.version,
          JSON.stringify(t),
        );
      return Number(result.changes) === 1;
    },
    async updateTask(t, ifVersion) {
      const result = db
        .prepare(
          `UPDATE tasks SET assignee_kind = ?, assignee = ?, state = ?, due_at = ?, version = ?, data = ?
            WHERE id = ? AND version = ?`,
        )
        .run(
          t.assigneeKind,
          t.assignee,
          t.state,
          t.dueAt ?? null,
          t.version,
          JSON.stringify(t),
          t.id,
          ifVersion,
        );
      return Number(result.changes) === 1;
    },
    async insertNotification(n) {
      db.prepare(
        'INSERT INTO notifications (id, channel_id, user_id, read, data) VALUES (?, ?, ?, ?, ?)',
      ).run(n.id, n.channelId, n.userId, n.read ? 1 : 0, JSON.stringify(n));
    },
    async insertShared(n) {
      db.prepare(
        'INSERT INTO shared_notifications (id, channel_id, permission, data) VALUES (?, ?, ?, ?)',
      ).run(n.id, n.channelId, n.audience.permission, JSON.stringify(n));
    },
    async markSharedRead(channelId, userId, id, read, permissions) {
      if (permissions.length === 0) return false;
      const there = db
        .prepare(
          `SELECT 1 FROM shared_notifications WHERE id = ? AND channel_id = ?
             AND permission IN (${permissions.map(() => '?').join(', ')})`,
        )
        .get(id, channelId, ...permissions);
      if (!there) return false;
      db.prepare(
        `INSERT INTO shared_notification_reads (notification_id, channel_id, user_id, read)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (notification_id, user_id) DO UPDATE SET read = excluded.read`,
      ).run(id, channelId, userId, read ? 1 : 0);
      return true;
    },
    async putTypeOverride(o, ifVersion) {
      const result =
        ifVersion === 0
          ? db
              .prepare(
                `INSERT INTO notification_type_overrides (channel_id, type_key, version, data)
                 VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              )
              .run(o.channelId, o.key, o.version, JSON.stringify(o))
          : db
              .prepare(
                `UPDATE notification_type_overrides SET version = ?, data = ?
                  WHERE channel_id = ? AND type_key = ? AND version = ?`,
              )
              .run(o.version, JSON.stringify(o), o.channelId, o.key, ifVersion);
      return Number(result.changes) === 1;
    },
    async markRead(channelId, userId, id, read) {
      const result = db
        .prepare(
          `UPDATE notifications SET read = ?, data = json_set(data, '$.read', json(?))
            WHERE id = ? AND channel_id = ? AND user_id = ?`,
        )
        .run(read ? 1 : 0, read ? 'true' : 'false', id, channelId, userId);
      return Number(result.changes) === 1;
    },
    async insertMessage(m) {
      db.prepare('INSERT INTO messages (id, channel_id, sender, data) VALUES (?, ?, ?, ?)').run(
        m.id,
        m.channelId,
        m.from,
        JSON.stringify(m),
      );
      const add = db.prepare(
        `INSERT INTO message_recipients (message_id, channel_id, kind, recipient_id)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      for (const r of m.to) add.run(m.id, m.channelId, r.kind, r.id);
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
    async markSeen(messageId) {
      return seen.mark(db, messageId);
    },
  };

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async task(id) {
      const row = db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as
        { data: string } | undefined;
      return row ? normalizeTask(JSON.parse(row.data) as Task) : undefined;
    },
    async openTasks(channelId, principals, limit) {
      if (principals.length === 0) return [];
      const match = principals.map(() => '(assignee_kind = ? AND assignee = ?)').join(' OR ');
      const rows = db
        .prepare(
          `SELECT data FROM tasks
            WHERE channel_id = ? AND state IN ('open', 'forwarded') AND (${match})
            ORDER BY due_at IS NULL, due_at, id LIMIT ?`,
        )
        .all(channelId, ...principals.flatMap((p) => [p.kind, p.id]), limit) as {
        data: string;
      }[];
      return rows.map((r) => normalizeTask(JSON.parse(r.data) as Task));
    },
    async notifications(channelId, userId, limit) {
      const rows = db
        .prepare(
          `SELECT data FROM notifications WHERE channel_id = ? AND user_id = ?
            ORDER BY id DESC LIMIT ?`,
        )
        .all(channelId, userId, limit) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Notification);
    },
    async sharedFor(channelId, permissions, userId, limit) {
      if (permissions.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT s.data, COALESCE(r.read, 0) AS read FROM shared_notifications s
             LEFT JOIN shared_notification_reads r ON r.notification_id = s.id AND r.user_id = ?
            WHERE s.channel_id = ? AND s.permission IN (${permissions.map(() => '?').join(', ')})
            ORDER BY s.id DESC LIMIT ?`,
        )
        .all(userId, channelId, ...permissions, limit) as { data: string; read: number }[];
      return rows.map((r) => {
        const { audience: _audience, ...n } = JSON.parse(r.data) as SharedNotification;
        return { ...n, userId, read: r.read === 1 };
      });
    },
    async sharedUnread(channelId, permissions, userId) {
      if (permissions.length === 0) return 0;
      const row = db
        .prepare(
          `SELECT count(*) AS n FROM shared_notifications s
             LEFT JOIN shared_notification_reads r ON r.notification_id = s.id AND r.user_id = ?
            WHERE s.channel_id = ? AND s.permission IN (${permissions.map(() => '?').join(', ')})
              AND COALESCE(r.read, 0) = 0`,
        )
        .get(userId, channelId, ...permissions) as { n: number };
      return Number(row.n);
    },
    async typeOverrides(channelId) {
      const rows = db
        .prepare('SELECT data FROM notification_type_overrides WHERE channel_id = ?')
        .all(channelId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as TypeOverride);
    },
    async messagesFor(channelId, reader, { after, limit }) {
      const params: (string | number)[] = [channelId, reader.userId, channelId, reader.userId];
      const groups = reader.groups.map(() => '?').join(', ');
      params.push(...reader.groups);
      let keyset = '';
      if (after !== undefined) {
        keyset = 'AND m.id < ?';
        params.push(after);
      }
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT m.data FROM messages m
            WHERE m.channel_id = ?
              AND (m.sender = ?
                   OR m.id IN (SELECT message_id FROM message_recipients
                                WHERE channel_id = ?
                                  AND ((kind = 'user' AND recipient_id = ?)
                                       ${groups ? `OR (kind = 'group' AND recipient_id IN (${groups}))` : ''})))
              ${keyset}
            ORDER BY m.id DESC LIMIT ?`,
        )
        .all(...params) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as Message);
    },
    async unreadCount(channelId, userId) {
      const row = db
        .prepare(
          'SELECT count(*) AS n FROM notifications WHERE channel_id = ? AND user_id = ? AND read = 0',
        )
        .get(channelId, userId) as { n: number };
      return Number(row.n);
    },
    async close() {
      db.close();
    },
  };
}
