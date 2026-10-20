// GENERATED FROM docs/architecture/openapi/notifications.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: Notifications's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

export interface MessageRecipient {
  /** A user, or a group — read by its members at READ time. Never a role. */
  kind: 'user' | 'group';
  id: string;
}

export interface Message {
  id: Ulid;
  channelId: string;
  from: string;
  to: MessageRecipient[];
  body: string;
  threadId?: Ulid;
  sentAt: string;
}

export interface MessagePage {
  items: Message[];
  nextCursor?: Ulid;
  /** True when the caller's groups could not be resolved: messages to their groups are left out. */
  partial: boolean;
}

export interface Inbox {
  /** True when the caller's groups and roles could not be resolved: only the tasks offered to them by name are here. */
  partial: boolean;
  /** Open tasks, oldest due first. */
  tasks: InboxTask[];
  /** Newest first, at most 50. */
  notifications: Notification[];
  /** Unread notifications, all of them. */
  unreadCount: number;
}

export interface InboxTask {
  id: Ulid;
  channelId: string;
  assignee: string;
  assigneeKind: 'user' | 'group' | 'role';
  kind: 'approve' | 'edit' | 'review' | 'generic';
  state: 'open' | 'forwarded' | 'done' | 'cancelled';
  subjectRef?: EntityRef;
  workflowInstanceId?: Ulid;
  /** A workflow review step's task (EP-22.6): the point to name when giving the verdict in MAM (POST /assets/{id}/approve or /reject). The verdict closes it; it is never completed here. */
  reviewPointId?: string;
  dueAt?: string;
  title?: string;
  createdBy?: string;
  createdAt: string;
  version: number;
  /** Every user it was ever assigned to by name, who claimed it, made it or acted on it — who may read its history. */
  participants: string[];
  outcome?: string;
  closedBy?: string;
  closedAt?: string;
}

export interface Notification {
  id: Ulid;
  channelId: string;
  userId: string;
  /** Notification-type key, e.g. asset.re-review-due. */
  type: string;
  severity: 'info' | 'warning' | 'critical';
  subjectRef?: EntityRef;
  /** In the channel's first locale (en). */
  title?: string;
  titles?: Titles;
  read: boolean;
  createdAt: string;
}

export interface Preferences {
  version: number;
  items: { key: string; on: boolean; defaultOn: boolean; mandatory: boolean; chosen: boolean }[];
}

/** A title per locale; a template may use the type's {{slots}}. */
export interface Titles {
  en?: string;
  ar?: string;
}

export interface NotificationType {
  key: string;
  /** The event that raises it. */
  event: string;
  /** Who it goes to — the routing in code. */
  recipients: string;
  /** The {{slots}} its titles may use. */
  vars: string[];
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
  defaultOn: boolean;
  mandatory: boolean;
  title: Titles;
  origin: 'built-in' | 'channel';
  /** The channel override's version — 0 when there is none. */
  version: number;
}

export interface EntityRef {
  entityType: string;
  entityId: string;
}

export interface Error {
  code: string;
  message: string;
  correlationId?: string;
}
