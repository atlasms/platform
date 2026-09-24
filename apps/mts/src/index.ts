// The service's public surface — what a test imports, and what `main.ts` wires.
export { buildMtsApp, callerOf, INTERNAL_HEADERS, type Caller, type MtsAppOptions } from './app.ts';
export {
  JOB_STATES,
  canTransition,
  renditionsFor,
  type JobState,
  type RenditionResult,
  type TranscodeJob,
} from './job.ts';
export {
  BUILT_IN_PRESETS,
  presetById,
  unknownPresets,
  type Preset,
  type PresetRequires,
} from './preset.ts';
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  MtsService,
  type Caller as ServiceCaller,
  type EnqueueInput,
  type MtsOptions,
  type RunOutcome,
} from './service.ts';
export {
  JOB_CREATE_PATTERN,
  runWorker,
  startJobConsumer,
  type JobConsumerOptions,
  type WorkerOptions,
} from './jobs.ts';
export { type JobQuery, type JobStore, type JobTx } from './store.ts';
export { sqliteJobStore, sqliteMigrations } from './store-sqlite.ts';
export { pgJobStore, pgMigrations } from './store-pg.ts';
export {
  DEFAULT_GRACE_MS,
  DEFAULT_TRANSCODE_TIMEOUT_MS,
  TranscodeRefusal,
  ffmpegTranscoder,
  type FfmpegOptions,
  type Transcoder,
  type TranscodeOutput,
  type TranscodeSpec,
} from './transcoder.ts';
export { fakeTranscoder, type FakeTranscoder } from './transcoder-fake.ts';
