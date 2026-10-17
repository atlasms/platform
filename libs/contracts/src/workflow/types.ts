// The workflow DSL as TypeScript, mirroring docs/architecture/schemas/workflow-definition.schema.json
// (lifted from reference/bms-workflow). Hand-written: the generator projects EVENT payloads, and
// this is a domain contract — the validator (validate.ts) checks every definition against the
// schema itself, so a drift here shows up as a definition the types accept and the schema refuses.
import type { TaskKind } from '../generated/events.ts';

export type StepKind =
  | 'start'
  | 'end'
  | 'command'
  | 'human-task'
  | 'wait-event'
  | 'timer'
  | 'branch'
  | 'parallel'
  | 'sub-flow';

/** FEEL expression, '=' prefixed by convention — the restricted subset (feel.ts). */
export type Feel = string;
/** ISO-8601 duration, e.g. "PT30M". */
export type Duration = string;
/** target dotted-path -> FEEL expression. */
export type DataMapping = Record<string, Feel>;

export interface VarDecl {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  initial?: unknown;
  description?: string;
}

export interface Retry {
  maxAttempts: number;
  backoff?: {
    type?: 'fixed' | 'exponential';
    initial?: Duration;
    max?: Duration;
    factor?: number;
  };
}

export type OnError = 'fail' | 'compensate' | { transitionTo: string };

export interface Transition {
  id: string;
  from: string;
  to: string;
  name?: string;
  when?: Feel;
  isDefault?: boolean;
}

export interface StartConfig {
  trigger?: { event?: string; filter?: Feel; output?: DataMapping };
}
export interface EndConfig {
  terminate?: boolean;
  status?: string;
}
export interface CommandConfig {
  action: string;
  request: { event: string; input?: DataMapping };
  await?: { event?: string; correlate?: Feel; output?: DataMapping };
}
export interface HumanTaskConfig {
  taskType: TaskKind;
  assignee: { userId?: string; role?: string; expression?: Feel };
  reviewPointId?: string;
  form?: Record<string, unknown>;
  dueIn?: Duration;
  output?: DataMapping;
  escalation?: {
    after: Duration;
    action: 'reassign' | 'notify';
    to?: { userId?: string; role?: string };
  };
}
export interface WaitEventConfig {
  event: string;
  correlate: Feel;
  output?: DataMapping;
}
export interface TimerConfig {
  mode: 'duration' | 'date' | 'cron';
  value: string;
}
export interface BranchConfig {
  default?: string;
}
export interface ParallelConfig {
  mode: 'split' | 'join';
}
export interface SubFlowConfig {
  workflowId: string;
  version?: number | 'latest';
  input?: DataMapping;
  output?: DataMapping;
}

export type StepConfig =
  | StartConfig
  | EndConfig
  | CommandConfig
  | HumanTaskConfig
  | WaitEventConfig
  | TimerConfig
  | BranchConfig
  | ParallelConfig
  | SubFlowConfig;

export interface Step {
  id: string;
  kind: StepKind;
  name?: string;
  position?: { x: number; y: number };
  retry?: Retry;
  timeout?: Duration;
  onError?: OnError;
  compensation?: string;
  config?: StepConfig;
}

export interface WorkflowDefinition {
  id: string;
  channelId: string;
  name: string;
  description?: string;
  scope?: { categoryId?: string; mediaType?: string; usage?: string };
  version: number;
  status: 'draft' | 'published';
  vars?: VarDecl[];
  steps: Step[];
  transitions: Transition[];
  metadata?: {
    createdBy?: string;
    createdAt?: string;
    publishedBy?: string;
    publishedAt?: string;
  };
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Stable machine code — `UNREACHABLE_STEP`, `FEEL_PARSE`, `FEEL_SUBSET`, `BRANCH_NO_DEFAULT`… */
  code: string;
  message: string;
  stepId?: string;
  transitionId?: string;
  /** JSON pointer into the definition, e.g. `/steps/3/config/await/correlate`. */
  path?: string;
}

export interface ValidationResult {
  /** False when any issue is an error. */
  valid: boolean;
  issues: ValidationIssue[];
}
