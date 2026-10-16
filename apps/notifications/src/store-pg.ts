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
import type { Notification, Task } from './inbox.ts';
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
              `INSERT INTO tasks (id, channel_id, assignee_kind, assignee, state, due_at, data)
               VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
              [
                t.id,
                t.channelId,
                t.assigneeKind,
                t.assignee,
                t.state,
                t.dueAt ?? null,
                JSON.stringify(t),
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
      return rows[0]?.data;
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
      return rows.map((r) => r.data);
    },
    async notifications(channelId, userId, limit) {
      const { rows } = await pool.query<{ data: Notification }>(
        `SELECT data FROM notifications WHERE channel_id = $1 AND user_id = $2
          ORDER BY id DESC LIMIT $3`,
        [channelId, userId, limit],
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
