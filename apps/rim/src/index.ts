// The service's public surface — what a test imports, and what `main.ts` wires.
export { buildRimApp, callerOf, INTERNAL_HEADERS, type Caller, type RimAppOptions } from './app.ts';
export {
  DEFAULT_PART_BYTES,
  DEFAULT_UPLOAD_TTL_MS,
  RimService,
  type Caller as ServiceCaller,
  type RimServiceOptions,
} from './service.ts';
export { fsStaging, type Staging } from './staging.ts';
export type { RimStore, RimTx } from './store.ts';
export { pgMigrations, pgRimStore } from './store-pg.ts';
export { sqliteMigrations, sqliteRimStore } from './store-sqlite.ts';
export {
  checkFilename,
  expectedPartSize,
  missingParts,
  newUpload,
  parseStartUpload,
  partCountOf,
  UPLOAD_SOURCE,
  type IngestJob,
  type IngestState,
  type StartUploadInput,
  type Upload,
  type UploadPart,
  type UploadState,
  type UploadStatus,
} from './upload.ts';
