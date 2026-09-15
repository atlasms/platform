// The service's public surface — what a test imports, and what `main.ts` wires.
export { buildRimApp, callerOf, INTERNAL_HEADERS, type Caller, type RimAppOptions } from './app.ts';
export {
  DEFAULT_PART_BYTES,
  DEFAULT_UPLOAD_TTL_MS,
  DEFAULT_VALIDATE_AFTER_MS,
  RimService,
  type Caller as ServiceCaller,
  type IngestQueuePage,
  type RimServiceOptions,
} from './service.ts';
export {
  applies,
  evaluate,
  newRuleSet,
  ON_FAIL,
  parseRuleSetInput,
  RULE_KINDS,
  type AcceptanceRule,
  type AcceptanceRuleSet,
  type AcceptanceRuleSetInput,
  type Facts,
  type OnFail,
  type Outcome,
  type RuleKind,
  type RuleScope,
  type Verdict,
} from './acceptance.ts';
export { fsStaging, type Staging } from './staging.ts';
export type { JobQuery, RimStore, RimTx } from './store.ts';
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
  INGEST_STATES,
  type IngestJob,
  type IngestState,
  type SourceKind,
  type StartUploadInput,
  type Upload,
  type UploadPart,
  type UploadState,
  type UploadStatus,
} from './upload.ts';
