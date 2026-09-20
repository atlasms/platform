// The service's public surface — what a test imports, and what `main.ts` wires.
export {
  buildLoggingApp,
  callerOf,
  INTERNAL_HEADERS,
  type Caller,
  type LoggingAppOptions,
} from './app.ts';
export {
  canonical,
  chainHash,
  GENESIS,
  historyOf,
  verifyChain,
  type AuditEvent,
  type AuditStore,
  type AuditTx,
  type ChainHead,
  type HistoryEntry,
  type LogBrowser,
  type LogFilter,
  type RetentionPolicy,
} from './store.ts';
export { requiredPermission, visible } from './visibility.ts';
export { sqliteAuditStore, sqliteMigrations } from './store-sqlite.ts';
export { pgAuditStore, pgMigrations } from './store-pg.ts';
export {
  appendEnvelope,
  ingest,
  startSink,
  DEFAULT_SINK_PATTERNS,
  type Outcome,
  type SinkOptions,
} from './sink.ts';
export {
  auditStoreConformance,
  browseConformance,
  type AuditStoreHarness,
  type BrowseHarness,
} from './store-conformance.ts';
export {
  openSearchAuditIndex,
  AUDIT_INDEX_MAPPINGS,
  DEFAULT_AUDIT_INDEX,
  type AuditIndex,
} from './index-opensearch.ts';
export { startProjector, type Projector, type ProjectorOptions } from './projector.ts';
export { memoryAuditIndex } from './index-memory.ts';
export {
  DEFAULT_COLD_DAYS,
  DEFAULT_HOT_DAYS,
  effectivePolicy,
  hotCutoff,
  parseRetentionPolicyInput,
  retentionTick,
  startRetention,
  tieredBrowser,
  type Retention,
  type RetentionDefaults,
  type RetentionPolicyInput,
  type RetentionTickOptions,
  type TrimReport,
} from './retention.ts';
