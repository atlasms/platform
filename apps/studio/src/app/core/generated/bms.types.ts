// GENERATED FROM docs/architecture/openapi/bms.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: BMS's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

import type { WorkflowDefinition as WorkflowDefinitionContract } from '@atlas/contracts/workflow-types';

export type Ulid = string;

/** The domain contract docs/architecture/schemas/workflow-definition.schema.json — steps, transitions, vars. Referenced, not copied, so the two cannot drift. */
export type WorkflowDefinition = WorkflowDefinitionContract;

/** A definition as the designer sends it. `id`, `channelId`, `version`, `status` and `metadata` are the server's and are ignored if sent; the rest is stored as given. */
export interface DraftInput {
  name: string;
  description?: string;
  scope?: { categoryId?: string; mediaType?: string; usage?: string };
  vars?: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  transitions: Record<string, unknown>[];
}

/** draft — never published; active — in the catalog, starts instances (a first publish makes it so); inactive — out of the catalog, no new instances, can be reactivated; archived — final, kept for its history. Deactivating and archiving are refused while instances run. */
export type WorkflowState = 'draft' | 'active' | 'inactive' | 'archived';

export interface CatalogEntry {
  id: Ulid;
  name: string;
  description?: string;
  scope?: { categoryId?: string; mediaType?: string; usage?: string };
  revision: number;
  /** The published version a new instance runs. */
  version: number;
  definition: WorkflowDefinition;
}

export interface Catalog {
  /** The same value as the ETag header. */
  etag: string;
  items: CatalogEntry[];
}

export interface VersionSummary {
  version: number;
  publishedAt: string;
  publishedBy: string;
}

export interface Workflow {
  id: Ulid;
  channelId: string;
  state: WorkflowState;
  /** The draft's name while one is open, else the latest published version's. */
  name: string;
  description?: string;
  scope?: { categoryId?: string; mediaType?: string; usage?: string };
  /** Every write bumps it; `?revision=` on a write is compare-and-set. */
  revision: number;
  /** The newest PUBLISHED version; 0 before the first publish. */
  latestVersion: number;
  /** The open draft's version — always latestVersion + 1. Absent when there is none. */
  draftVersion?: number;
  draft?: WorkflowDefinition;
  /** Published versions, newest first. */
  versions: VersionSummary[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummary {
  id: Ulid;
  channelId: string;
  name: string;
  state: WorkflowState;
  description?: string;
  revision: number;
  latestVersion: number;
  draftVersion?: number;
  updatedAt?: string;
}

export interface WorkflowPage {
  items: WorkflowSummary[];
  nextCursor?: Ulid;
}

export interface StartInstance {
  workflowId: Ulid;
  /** A published version; omitted: the latest published. */
  version?: number;
  /** Initial values of the definition's declared vars, over their `initial`s. */
  vars?: Record<string, unknown>;
  assetId?: Ulid;
}

export interface Signal {
  /** The waiting step this completes — its id in the definition. */
  stepId: string;
  /** What the step receives as `incoming`; its output mappings read it. */
  payload?: Record<string, unknown>;
}

export interface HistoryEntry {
  seq: number;
  stepId: string;
  event: 'entered' | 'awaiting' | 'completed' | 'failed' | 'compensated' | 'escalated';
  at: string;
  result?: unknown;
}

export interface WorkflowInstance {
  id: Ulid;
  channelId: string;
  workflowId: Ulid;
  /** The published version it is pinned to. */
  version: number;
  assetId?: Ulid;
  parentId?: Ulid;
  /** As the mirror last recorded it; Temporal holds the instance (ADR-0010). */
  state: 'running' | 'waiting' | 'completed' | 'failed';
  /** The steps it is waiting in. */
  currentSteps: string[];
  startedAt: string;
  /** Who started it — a user, or `bms` when its trigger did. */
  startedBy: string;
  /** Set when its start step's trigger started it (EP-22.7): the event and the message. */
  triggeredBy?: { event: string; messageId: Ulid };
  endedAt?: string;
  endStepId?: string;
  error?: string;
  /** The vars when it ended. */
  vars?: Record<string, unknown>;
  /** Every step event in order — on a single read only. */
  history?: HistoryEntry[];
}

export interface InstancePage {
  items: WorkflowInstance[];
  nextCursor?: Ulid;
}

/** One draggable step kind for the designer palette (see workflows/palette.json). */
export interface PaletteEntry {
  kind:
    | 'start'
    | 'end'
    | 'command'
    | 'human-task'
    | 'wait-event'
    | 'timer'
    | 'branch'
    | 'parallel'
    | 'sub-flow';
  label: string;
  icon?: string;
  category?: 'events' | 'activities' | 'gateways';
  /** the BPMN element this maps to */
  bpmn?: string;
  waits?: 'no' | 'yes' | 'if-await' | 'at-join' | 'on-trigger';
  /** inlined JSON Schema for this kind config (a $def of workflow-definition.schema.json) */
  configSchema?: Record<string, unknown>;
  /** alternative to configSchema: a JSON-pointer/URI to the $def */
  configSchemaRef?: string;
  hint?: string;
}

/** One diagnostic. Anchored to a step or a transition (never both). */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** stable machine code, e.g. UNREACHABLE_STEP, FEEL_PARSE, FEEL_SUBSET, BRANCH_NO_DEFAULT, UNBOUND_VAR, SUBFLOW_UNPUBLISHED */
  code: string;
  message: string;
  stepId?: string;
  transitionId?: string;
  /** JSON pointer into the definition, e.g. /steps/3/config/await/correlate */
  path?: string;
}

export interface ValidationResult {
  /** false if any issue has severity=error */
  valid: boolean;
  issues: ValidationIssue[];
}

export interface PublishResult {
  workflowId: Ulid;
  /** A first publish makes the workflow active; a later one leaves its state as it was. */
  state: WorkflowState;
  version: number;
  publishedAt: string;
  /** The workflow's revision after publishing. */
  revision: number;
  /** Warnings the published graph still carries. */
  warnings?: ValidationIssue[];
}

/** BPMN import rejected: constructs outside the Atlas subset are reported, never silently dropped. */
export interface ImportError {
  code: 'UNSUPPORTED_BPMN' | 'MALFORMED_XML';
  message: string;
  unsupported?: { elementId?: string; elementType?: string; reason?: string }[];
}

/** RFC 9457 Problem Details, served as application/problem+json, with the platform's keys kept: `code` is the machine key (a closed enum), `message` the text. `type` is https://atlas.example/problems/<code>, `title` constant per code, `detail` equals `message`, `instance` is urn:atlas:correlation:<correlationId>. */
export interface Error {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code:
    | 'VALIDATION'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PAYLOAD_TOO_LARGE'
    | 'RATE_LIMITED'
    | 'UNAVAILABLE'
    | 'INTERNAL';
  message: string;
  details?: unknown;
  correlationId?: string;
}
