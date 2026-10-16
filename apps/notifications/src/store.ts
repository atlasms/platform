// The inbox store: a port with a sqlite and a Postgres adapter, held to one conformance suite
// (store-conformance.ts) — the shape every Atlas service's persistence takes.
//
// Two tables, both channel-scoped: `tasks` (one row per task, whoever it is offered to) and
// `notifications` (one row per recipient). The seen-mark commits inside each consumer's transaction
// with what it wrote (EP-03.3), so a redelivered event writes nothing twice.

import type { OutboxRecord } from '@atlas/messaging';
import type { Notification, PrincipalKind, Task } from './inbox.ts';

export interface InboxStore {
  transaction<T>(fn: (tx: InboxTx) => Promise<T>): Promise<T>;
  task(id: string): Promise<Task | undefined>;
  /** A channel's OPEN tasks offered to any of these principals, oldest due first. */
  openTasks(
    channelId: string,
    principals: { kind: PrincipalKind; id: string }[],
    limit: number,
  ): Promise<Task[]>;
  /** A person's notifications in a channel, newest first. */
  notifications(channelId: string, userId: string, limit: number): Promise<Notification[]>;
  unreadCount(channelId: string, userId: string): Promise<number>;
  close(): Promise<void>;
}

export interface InboxTx {
  /** Insert a task; `false` if the id exists — the same task, delivered again. */
  insertTask(task: Task): Promise<boolean>;
  /**
   * Replace a task only over the version the action read (EP-25.2): `false` means someone acted in
   * between — the second of two claims — and nothing was written.
   */
  updateTask(task: Task, ifVersion: number): Promise<boolean>;
  insertNotification(notification: Notification): Promise<void>;
  enqueue(record: OutboxRecord): Promise<void>;
  /** The consumer's dedup mark, in the transaction of its writes (EP-03.3). */
  markSeen(messageId: string): Promise<boolean>;
}
