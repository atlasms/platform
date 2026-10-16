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
import { normalizeTask, type Notification, type Task } from './inbox.ts';
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
