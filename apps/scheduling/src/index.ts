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
  type Caller as ServiceCaller,
  type SchedulingServiceOptions,
} from './service.ts';
export type { ScheduleStore, ScheduleTx } from './store.ts';
export { sqliteScheduleStore, sqliteMigrations } from './store-sqlite.ts';
export { pgScheduleStore, pgMigrations } from './store-pg.ts';
export { scheduleStoreConformance, type ScheduleStoreHarness } from './store-conformance.ts';
