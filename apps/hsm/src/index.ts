// The service's public surface — what a test imports, and what `main.ts` wires.
export { buildHsmApp, callerOf, INTERNAL_HEADERS, type Caller, type HsmAppOptions } from './app.ts';
export { checkKey, Hashing, StorageMissing, type StorageDriver, type Written } from './driver.ts';
export { fsDriver } from './driver-fs.ts';
export { s3Driver, type S3DriverOptions } from './driver-s3.ts';
export { storageDriverConformance, type DriverHarness } from './driver-conformance.ts';
export {
  FILE_KINDS,
  fileView,
  keyFor,
  parsePlacement,
  TIERS,
  type FileEntry,
  type FileKind,
  type FileStatus,
  type PlacementInput,
  type Replica,
  type Tier,
} from './file.ts';
export {
  backoffMs,
  MAX_ATTEMPTS,
  OPERATION_KINDS,
  OperationRefusal,
  operationView,
  type Operation,
  type OperationKind,
  type OperationState,
} from './operation.ts';
export {
  HsmService,
  type Caller as ServiceCaller,
  type HsmServiceOptions,
  type OperationRequest,
} from './service.ts';
export type { HsmStore, HsmTx } from './store.ts';
export { sqliteHsmStore, sqliteMigrations } from './store-sqlite.ts';
export { pgHsmStore, pgMigrations } from './store-pg.ts';
export {
  driverFactory,
  parseTargetInput,
  type DriverFactory,
  type StorageTarget,
  type StorageTargetInput,
} from './targets.ts';
