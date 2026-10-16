// The side-effect boundary of the workflow interpreter (bms-workflow-dsl-and-designer.md §10.0).
// The interpreter never touches the broker, the database, the clock or Temporal directly — it goes
// through this interface. Production implements it on Temporal (temporal/workflows.ts: activities,
// signals, durable timers, child workflows); the tests implement it in memory (test/sim.ts). That
// is what keeps the control flow deterministic and testable without a server — and what keeps the
// broker-backed saga a fallback behind the same logic (ADR-0010).
//
// Lifted from reference/bms-workflow, with one change: `appendHistory` is ASYNC. In Temporal it is
// an activity (a row in step_history), and an activity is awaited, never fired and forgotten.

export interface CommandRequest {
  stepId: string;
  event: string;
  payload: Record<string, unknown>;
  /** `${instanceId}::${stepId}:${attempt}` — the completion carries it back. */
  correlationId: string;
  /** `${instanceId}:${stepId}:${attempt}` — the target dedupes on it. */
  idempotencyKey: string;
}

export interface TaskSpec {
  instanceId: string;
  stepId: string;
  taskType: string;
  /** Resolved: a user id, or a role — the expression form is evaluated before it gets here. */
  assignee: { userId?: string; role?: string };
  reviewPointId?: string;
  /** Epoch ms, from `now()`. */
  dueAt?: number;
}

/**
 * A wait-event step's wait (EP-22.6): the event, and the values its `correlate` keys evaluated to
 * when the step started waiting — what the router matches an event of that type against.
 */
export interface EventWait {
  stepId: string;
  event: string;
  /** Payload path (dotted) → the value it must equal. */
  match: Record<string, unknown>;
}

export type HistoryEvent =
  'entered' | 'awaiting' | 'completed' | 'failed' | 'compensated' | 'escalated';

export interface Effects {
  now(): number;
  sleep(ms: number): Promise<void>;

  /** Request a step of another service (an activity). */
  emitCommand(req: CommandRequest): Promise<void>;
  /** Wait for the step's correlated completion; rejects with StepTimeout after `timeoutMs`. */
  waitForCompletion(stepId: string, timeoutMs?: number): Promise<Record<string, unknown>>;

  createTask(spec: TaskSpec): Promise<void>;
  waitForTask(stepId: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  escalate(
    stepId: string,
    to: { userId?: string; role?: string } | undefined,
    action: string,
  ): Promise<void>;

  /** Wait for an event, not one this instance asked for, that matches the step's keys. */
  waitForEvent(wait: EventWait, timeoutMs?: number): Promise<Record<string, unknown>>;

  /** Run a published workflow as a child; resolves with its output vars. */
  runChild(
    stepId: string,
    workflowId: string,
    version: number | 'latest',
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  appendHistory(stepId: string, event: HistoryEvent, result?: unknown): Promise<void>;
}

export interface StartContext {
  instanceId: string;
  /** The trigger's payload, when an event started the instance. */
  incoming?: Record<string, unknown>;
  /** Initial vars, over the definition's declared `initial`s. */
  vars?: Record<string, unknown>;
}

export interface RunResult {
  state: 'completed' | 'failed';
  endStepId?: string;
  status?: string;
  vars: Record<string, unknown>;
  error?: string;
}

export class StepTimeout extends Error {
  readonly stepId: string;
  constructor(stepId: string) {
    super(`step "${stepId}" timed out`);
    this.name = 'StepTimeout';
    this.stepId = stepId;
  }
}
