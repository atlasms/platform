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
  dueAt?: string;
  createdBy: string;
  createdAt: string;
}

/** Something a person should know, addressed to them. */
export interface Notification {
  id: string;
  channelId: string;
  userId: string;
  /** Notification-type key — `asset.re-review-due`. The registry is EP-25.5. */
  type: string;
  severity: Severity;
  subjectRef?: EntityRef;
  title?: string;
  read: boolean;
  createdAt: string;
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
