// The side-effect boundary for the interpreter. The pure interpreter (interpreter.ts) never
// touches the broker, DB, clock, or Temporal directly — it goes through this interface. In
// production a Temporal adapter implements it (proxyActivities / condition / sleep / setHandler /
// executeChild — see design §10); in tests a simulated driver (sim.ts) implements it. This is what
// makes the workflow logic deterministic and unit-testable without a Temporal server.

export interface CommandRequest {
  event: string;
  payload: Record<string, unknown>;
  correlationId: string; // `${instanceId}::${stepId}:${attempt}`
  idempotencyKey: string;
}

export interface TaskSpec {
  instanceId: string;
  stepId: string;
  taskType: string;
  assignee: { userId?: string; role?: string; expression?: string };
  reviewPointId?: string;
  dueAt?: number; // epoch ms (fx.now()-based)
}

export type HistoryEvent = 'entered' | 'awaiting' | 'completed' | 'failed' | 'compensated' | 'escalated';

export interface Effects {
  now(): number;
  sleep(ms: number): Promise<void>;

  /** Emit a command event to the broker (an activity). */
  emitCommand(req: CommandRequest): Promise<void>;
  /** Block until the correlated completion for a step arrives, or reject on timeout. */
  waitForCompletion(stepId: string, timeoutMs?: number): Promise<Record<string, unknown>>;

  /** Create a human task (emits workflow.task.created), then wait for its completion. */
  createTask(spec: TaskSpec): Promise<void>;
  waitForTask(stepId: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  escalate(stepId: string, to: { userId?: string; role?: string } | undefined, action: string): Promise<void>;

  /** Wait for an external (non-command) event, correlated by the step. */
  waitForEvent(stepId: string, timeoutMs?: number): Promise<Record<string, unknown>>;

  /** Run a published workflow as a child; returns its output vars. */
  runChild(workflowId: string, version: number | 'latest', input: Record<string, unknown>): Promise<Record<string, unknown>>;

  appendHistory(stepId: string, event: HistoryEvent, result?: unknown): void;
}

export interface StartContext {
  instanceId: string;
  incoming?: Record<string, unknown>; // the trigger event payload
  vars?: Record<string, unknown>;     // trigger->vars binding done by the caller/start step
}

export interface RunResult {
  state: 'completed' | 'failed';
  endStepId?: string;
  status?: string;
  vars: Record<string, unknown>;
  error?: string;
}

export class StepTimeout extends Error {
  constructor(public stepId: string) { super(`step "${stepId}" timed out`); }
}
