// What lands in a person's inbox (notifications.md §3) — lifted from reference/notifications-service
// and made channel-scoped, durable and addressable.

import type { EntityRef, PrincipalKind, Severity, TaskKind } from '@atlas/contracts';

export type { EntityRef, PrincipalKind, Severity, TaskKind };
export type TaskState = 'open' | 'forwarded' | 'done' | 'cancelled';

/**
 * A task offered to a user, a group or a role. One row whoever it reaches: a group or a role is
 * resolved to its people when an inbox is READ (decided 2026-10-16), so a new holder sees an open
 * task and someone who left stops seeing it.
 */
export interface Task {
  id: string;
  channelId: string;
  assignee: string;
  assigneeKind: PrincipalKind;
  kind: TaskKind;
  state: TaskState;
  subjectRef?: EntityRef;
  /** Set when a workflow's human step made it (BMS). */
  workflowInstanceId?: string;
  /**
   * A workflow REVIEW step's task (EP-22.6): the point the verdict is given at. Such a task is
   * closed by the verdict in MAM (BMS's `workflow.task.resolved`), never completed here.
   */
  reviewPointId?: string;
  dueAt?: string;
  /** What a person wrote when assigning it by hand. */
  title?: string;
  createdBy: string;
  createdAt: string;
  /** Compare-and-set on every action: two claims, one wins (EP-25.2). */
  version: number;
  /**
   * Every user it was ever assigned to BY NAME, who made it, claimed it or acted on it — who may
   * read its history without `task:audit` (decided 2026-10-16). Grows; never shrinks.
   */
  participants: string[];
  /** For a completed decision task: the verdict. */
  outcome?: string;
  closedBy?: string;
  closedAt?: string;
}

/** A task as stored before EP-25.2 carried no version or participants: read it as its first revision. */
export function normalizeTask(t: Task): Task {
  return {
    ...t,
    version: t.version ?? 1,
    participants: t.participants ?? (t.assigneeKind === 'user' ? [t.assignee] : []),
  };
}

/** An action may move an open task; a done or cancelled one is closed for good. */
export const isClosed = (t: Task): boolean => t.state === 'done' || t.state === 'cancelled';

/** Something a person should know, addressed to them. */
export interface Notification {
  id: string;
  channelId: string;
  userId: string;
  /** Notification-type key — `asset.re-review-due`. The registry is EP-25.5. */
  type: string;
  severity: Severity;
  subjectRef?: EntityRef;
  /** The title in the channel's first locale (`en`); `titles` has every locale (EP-25.5). */
  title?: string;
  titles?: Record<string, string>;
  read: boolean;
  createdAt: string;
}

/**
 * A notification for everyone holding a PERMISSION in the channel (EP-25.5: an alert to the holders
 * of `ops:read`) — one row, resolved to its readers when an inbox is read, as a role's task is; each
 * reader's read state is their own.
 */
export interface SharedNotification extends Omit<Notification, 'userId' | 'read'> {
  audience: { permission: string };
}

export interface Inbox {
  tasks: Task[];
  notifications: Notification[];
  unreadCount: number;
  /**
   * True when the caller's groups and roles could not be resolved (IAM away, or not configured):
   * the tasks are those offered to them BY NAME only, and the rest will appear on a later read.
   */
  partial: boolean;
}

/** Who a chat message is addressed to (EP-25.4): a user, or a group — never a role. */
export interface MessageRecipient {
  kind: 'user' | 'group';
  id: string;
}

/**
 * A direct or group chat message (EP-25.4, decided 2026-10-18). Addressed to users and groups of
 * the sender's channel; a GROUP's message is read by whoever is in the group WHEN IT IS READ — a
 * chat room: a member who joins reads its history, one who leaves no longer does.
 */
export interface Message {
  id: string;
  channelId: string;
  from: string;
  to: MessageRecipient[];
  body: string;
  threadId?: string;
  sentAt: string;
}
