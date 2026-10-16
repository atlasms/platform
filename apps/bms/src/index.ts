// The service's public surface — what a test imports, and what `main.ts` wires.
export { buildBmsApp, callerOf, INTERNAL_HEADERS, type Caller, type BmsAppOptions } from './app.ts';
export { BmsService, type PublishResult, type WorkflowView } from './service.ts';
export type { WorkflowStore, WorkflowTx } from './store.ts';
export { sqliteWorkflowStore, sqliteMigrations } from './store-sqlite.ts';
export { pgWorkflowStore, pgMigrations } from './store-pg.ts';
export {
  parseDraftInput,
  type DraftInput,
  type Workflow,
  type WorkflowVersion,
} from './workflow.ts';
export { BmsRuntime } from './runtime.ts';
export { inProcessRunner, type InProcessRunner } from './runner-inprocess.ts';
export { InstanceNotRunning, type InstanceRunner } from './runner.ts';
export type { Instance, HistoryEntry, CommandAwait } from './instance.ts';
export {
  CompletionRouter,
  startCompletionRouter,
  answerPatterns,
  TASK_UPDATED_PATTERN,
  type RouteOutcome,
} from './router.ts';
export { StepInbox, CommandFailed, type StepSignal } from './engine/inbox.ts';
