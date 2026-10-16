// The service's public surface — what a test imports, and what `main.ts` wires.
export {
  buildNotificationsApp,
  callerOf,
  INTERNAL_HEADERS,
  type Caller,
  type NotificationsAppOptions,
} from './app.ts';
export { NotificationsService, type NotificationsOptions } from './service.ts';
export type { InboxStore, InboxTx } from './store.ts';
export { sqliteInboxStore, sqliteMigrations } from './store-sqlite.ts';
export { pgInboxStore, pgMigrations } from './store-pg.ts';
export {
  startConsumers,
  startPrincipalInvalidation,
  TASK_CREATED_PATTERN,
  ASSET_EXPIRED_PATTERN,
  PERMISSIONS_CHANGED_PATTERN,
  MEMBERSHIP_CHANGED_PATTERN,
} from './consumers.ts';
export {
  iamPrincipals,
  fakePrincipals,
  type Principal,
  type PrincipalSource,
} from './principals.ts';
export type { Inbox, Notification, Task, TaskState } from './inbox.ts';
export {
  TaskActions,
  parseAssignee,
  type ActingCaller,
  type NewTask,
  type TaskActionsOptions,
} from './task-actions.ts';
