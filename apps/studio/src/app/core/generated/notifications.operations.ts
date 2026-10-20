// GENERATED FROM docs/architecture/openapi/notifications.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: Notifications's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in notifications.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const NotificationsOperations = {
  /** The caller's inbox — open tasks offered to them and their newest notifications */
  getInbox: { method: 'GET', path: '/api/v1/inbox', params: [] },
  /** The caller's messages, newest first — sent by them, to them, or to a group they are in NOW (EP-25.4) */
  listMessages: { method: 'GET', path: '/api/v1/messages', params: [] },
  /** Send a direct or group message — message:send; to any user or group of the caller's channel (decided 2026-10-18) */
  sendMessage: { method: 'POST', path: '/api/v1/messages', params: [] },
  /** Assign a task by hand — to a user, a group or a role of the channel (FR-APP-1; task:assign) */
  createTask: { method: 'POST', path: '/api/v1/tasks', params: [] },
  /** One task — to a participant, a holder of what it is offered to, or task:admin */
  getTask: { method: 'GET', path: '/api/v1/tasks/{id}', params: ['id'] },
  /** Take a task offered to a group or role you are in — first claim wins (decided 2026-10-16) */
  claimTask: { method: 'POST', path: '/api/v1/tasks/{id}/claim', params: ['id'] },
  /** Hand a task you hold to another user, group or role (or any task, with task:admin) */
  forwardTask: { method: 'POST', path: '/api/v1/tasks/{id}/forward', params: ['id'] },
  /** Complete a task you hold, with its outcome */
  completeTask: { method: 'POST', path: '/api/v1/tasks/{id}/complete', params: ['id'] },
  /** Cancel a task (task:admin) — a workflow's task is ended by its workflow, never here */
  cancelTask: { method: 'POST', path: '/api/v1/tasks/{id}/cancel', params: ['id'] },
  /** Mark one of the caller's notifications read or unread (EP-25.5) — theirs only */
  updateNotification: { method: 'PATCH', path: '/api/v1/notifications/{id}', params: ['id'] },
  /** Every notification type as it applies in the caller's channel (EP-25.5) — any authenticated caller */
  listNotificationTypes: { method: 'GET', path: '/api/v1/notification-types', params: [] },
  /** Change a type for the channel — config:admin; a compare-and-set on the override's version (0 for the first); audited */
  putNotificationType: { method: 'PUT', path: '/api/v1/notification-types/{key}', params: ['key'] },
  /** The caller's notification preferences — every type, on or off, and why (EP-25.6) */
  getPreferences: { method: 'GET', path: '/api/v1/preferences', params: [] },
  /** Replace the caller's choices — a compare-and-set on the version read (0 for the first); a mandatory type cannot be turned off */
  putPreferences: { method: 'PUT', path: '/api/v1/preferences', params: [] },
} as const;

export type NotificationsOperation = keyof typeof NotificationsOperations;
