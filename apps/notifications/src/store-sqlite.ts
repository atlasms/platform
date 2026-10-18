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
import { normalizeTask, type Message, type Notification, type Task } from './inbox.ts';
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
