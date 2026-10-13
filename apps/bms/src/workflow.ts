// A workflow, as BMS keeps it (bms-workflow-dsl-and-designer.md §7): a HEADER — the row a list
// shows, compare-and-set on `revision` — and its VERSIONS, each a whole definition. Version n is
// either the one open draft (n = latestVersion + 1) or published, and a published version is
// never written again: an instance pinned to it (EP-22.3) must replay against the graph it started
// on.

import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import { ValidationError } from '@atlas/service-kit';

/**
 * A workflow's lifecycle (EP-22.11, decided 2026-10-13). `draft` — never published; `active` — in
 * every user's catalog, starts instances (a first publish makes it so); `inactive` — out of the
 * catalog, no new instances, can be reactivated; `archived` — final, kept for its history.
 * Deactivating and archiving are refused while an instance of the workflow is still running.
 */
export type WorkflowState = 'draft' | 'active' | 'inactive' | 'archived';

export interface Workflow {
  id: string;
  channelId: string;
  state: WorkflowState;
  /** The open draft's name while there is one, else the latest published version's. */
  name: string;
  description?: string;
  scope?: NonNullable<WorkflowDefinition['scope']>;
  /** Every write bumps it; a write names the revision it was made on (compare-and-set). */
  revision: number;
  /** The newest PUBLISHED version; 0 before the first publish. */
  latestVersion: number;
  /** The open draft's version — always latestVersion + 1 — or absent. */
  draftVersion?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersion {
  workflowId: string;
  channelId: string;
  version: number;
  status: 'draft' | 'published';
  definition: WorkflowDefinition;
  createdBy: string;
  createdAt: string;
  publishedBy?: string;
  publishedAt?: string;
}

/** What the designer sends — the definition minus what the server owns. */
export interface DraftInput {
  name: string;
  description?: string;
  scope?: NonNullable<WorkflowDefinition['scope']>;
  vars?: NonNullable<WorkflowDefinition['vars']>;
  steps: WorkflowDefinition['steps'];
  transitions: WorkflowDefinition['transitions'];
}

// Bounds on what a draft may hold — a designer's graph is tens of steps; these stop a request from
// storing a document nobody could open, long before the body cap does.
const MAX_STEPS = 500;
const MAX_TRANSITIONS = 1000;
const MAX_VARS = 100;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The SHAPE of a draft, not its correctness. A draft is work in progress: an unreachable step or
 * an expression half typed is saved, and only publish refuses it (validateDefinition). What is
 * refused here is what could not be a graph at all — no steps array, a step that is not an object.
 */
export function parseDraftInput(body: unknown): DraftInput {
  if (!isObject(body)) throw new ValidationError('body must be a workflow definition object');
  const { name, description, scope, vars, steps, transitions } = body;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 200)
    throw new ValidationError('name is required (1–200 characters)');
  if (description !== undefined && (typeof description !== 'string' || description.length > 2000))
    throw new ValidationError('description must be a string of at most 2000 characters');
  if (scope !== undefined && !isObject(scope)) throw new ValidationError('scope must be an object');
  const list = (
    v: unknown,
    field: string,
    max: number,
    required: boolean,
  ): unknown[] | undefined => {
    if (v === undefined && !required) return undefined;
    if (!Array.isArray(v)) throw new ValidationError(`${field} must be an array`);
    if (v.length > max) throw new ValidationError(`${field} holds at most ${max} entries`);
    if (!v.every(isObject)) throw new ValidationError(`every entry of ${field} must be an object`);
    return v;
  };
  const parsedVars = list(vars, 'vars', MAX_VARS, false);
  return {
    name: name.trim(),
    ...(description !== undefined ? { description } : {}),
    ...(scope !== undefined ? { scope: scope as NonNullable<DraftInput['scope']> } : {}),
    ...(parsedVars !== undefined ? { vars: parsedVars as NonNullable<DraftInput['vars']> } : {}),
    steps: list(steps, 'steps', MAX_STEPS, true) as DraftInput['steps'],
    transitions: list(
      transitions,
      'transitions',
      MAX_TRANSITIONS,
      true,
    ) as DraftInput['transitions'],
  };
}

/** The definition the server stores for a draft: the input, under the server's own header fields. */
export function definitionOf(w: Workflow, version: number, input: DraftInput): WorkflowDefinition {
  return {
    id: w.id,
    channelId: w.channelId,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    version,
    status: 'draft',
    ...(input.vars !== undefined ? { vars: input.vars } : {}),
    steps: input.steps,
    transitions: input.transitions,
  };
}

/** A required `?revision=` — the compare-and-set every write makes. */
export function parseRevision(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new ValidationError(
      '?revision= is required: the workflow revision this edit was made on',
    );
  return n;
}

/**
 * A header as written before EP-22.11 carries no `state`: one that was ever published was, in
 * effect, active (instances started from it), and one that never was is a draft.
 */
export function withState(w: Workflow): Workflow {
  if (w.state !== undefined) return w;
  return { ...w, state: w.latestVersion > 0 ? 'active' : 'draft' };
}
