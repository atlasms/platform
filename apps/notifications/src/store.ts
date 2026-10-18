// The inbox store: a port with a sqlite and a Postgres adapter, held to one conformance suite
// (store-conformance.ts) — the shape every Atlas service's persistence takes.
//
// Two tables, both channel-scoped: `tasks` (one row per task, whoever it is offered to) and
// `notifications` (one row per recipient). The seen-mark commits inside each consumer's transaction
// with what it wrote (EP-03.3), so a redelivered event writes nothing twice.

import type { OutboxRecord } from '@atlas/messaging';
import type { Message, Notification, PrincipalKind, SharedNotification, Task } from './inbox.ts';
import type { TypeOverride } from './notification-types.ts';
import type { Preferences } from './preferences.ts';

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
  /**
   * A person's messages in a channel, newest first (EP-25.4): what they sent, what was sent to them
   * by name, and what was sent to any of `groups` — the groups they are in NOW (resolved by the
   * caller at read time). Keyset on the message id, descending.
   */
  messagesFor(
    channelId: string,
    reader: { userId: string; groups: string[] },
    options: { after?: string; limit: number },
  ): Promise<Message[]>;
  /**
   * The shared notifications of a channel addressed to any of these permissions, newest first, as
   * this reader sees them — `userId` the reader, `read` their own read state (EP-25.5).
   */
  sharedFor(
    channelId: string,
    permissions: string[],
    userId: string,
    limit: number,
  ): Promise<Notification[]>;
  /** How many of those this reader has not read. */
  sharedUnread(channelId: string, permissions: string[], userId: string): Promise<number>;
  /** A person's notification preferences in a channel (EP-25.6), if they have chosen any. */
  preferences(channelId: string, userId: string): Promise<Preferences | undefined>;
  /** A channel's notification-type overrides (EP-25.5). */
  typeOverrides(channelId: string): Promise<TypeOverride[]>;
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
  /**
   * Write a type's override: an insert when `ifVersion` is 0, otherwise only over that version —
   * `false` means someone wrote it in between, and nothing was written.
   */
  putTypeOverride(override: TypeOverride, ifVersion: number): Promise<boolean>;
  /** Replace a person's preferences: an insert when `ifVersion` is 0, else only over that version. */
  putPreferences(preferences: Preferences, ifVersion: number): Promise<boolean>;
  /** A notification for everyone holding a permission. */
  insertShared(notification: SharedNotification): Promise<void>;
  /**
   * A reader's read state of a shared notification — `false` if there is none addressed to one of
   * `permissions` (theirs to hold) in the channel.
   */
  markSharedRead(
    channelId: string,
    userId: string,
    id: string,
    read: boolean,
    permissions: string[],
  ): Promise<boolean>;
  /** Mark one of a person's notifications read; `false` if it is not theirs (or not there). */
  markRead(channelId: string, userId: string, id: string, read: boolean): Promise<boolean>;
  /** A sent message and one row per recipient — the index a reader is found by. */
  insertMessage(message: Message): Promise<void>;
  enqueue(record: OutboxRecord): Promise<void>;
  /** The consumer's dedup mark, in the transaction of its writes (EP-03.3). */
  markSeen(messageId: string): Promise<boolean>;
}
