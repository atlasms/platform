// The service's public surface — what a test imports, and what `main.ts` wires.
export {
  buildSchedulingApp,
  callerOf,
  INTERNAL_HEADERS,
  type Caller,
  type SchedulingAppOptions,
} from './app.ts';
export {
  checkItem,
  checkReel,
  endOf,
  inReelOrder,
  ITEM_TYPES,
  parseCreateSchedule,
  parseItemInput,
  parseUpdateSchedule,
  type CreateScheduleInput,
  type ItemType,
  type Schedule,
  type ScheduleItem,
  type ScheduleItemInput,
  type ScheduleState,
  type UpdateScheduleInput,
} from './schedule.ts';
export {
  SchedulingService,
  type ApprovalOutcome,
  type Caller as ServiceCaller,
  type SchedulingServiceOptions,
  type ValidationReport,
} from './service.ts';
export {
  APPROVAL_EVENTS,
  applyAssetEvent,
  type ApprovalState,
  type MediaApproval,
} from './approvals.ts';
export {
  clock,
  validateReel,
  type IssueKind,
  type ReelAvailability,
  type Severity,
  type ValidationIssue,
} from './validation.ts';
export {
  DEFAULT_RENDITION,
  fakeAvailability,
  hsmAvailability,
  renditionKey,
  type AvailabilitySource,
  type RenditionQuery,
  type RenditionState,
} from './availability.ts';
export { ASSET_EVENTS_PATTERN, startApprovalConsumer } from './consumer.ts';
export {
  parseCopyRequest,
  planCopy,
  type CopyMode,
  type CopyPlan,
  type CopyRequest,
} from './copy.ts';
export {
  covered,
  governingWindows,
  parseRightsWindowInput,
  type RightsWindow,
  type RightsWindowInput,
} from './rights.ts';
export type { ScheduleStore, ScheduleTx } from './store.ts';
export { sqliteScheduleStore, sqliteMigrations } from './store-sqlite.ts';
export { pgScheduleStore, pgMigrations } from './store-pg.ts';
export { scheduleStoreConformance, type ScheduleStoreHarness } from './store-conformance.ts';
