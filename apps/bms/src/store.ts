// The definition store: a port with a sqlite and a Postgres adapter, held to one conformance suite
// (store-conformance.ts) — the shape every Atlas service's persistence takes.
//
// Two tables, both channel-scoped: `workflows` (the header, compare-and-set on `revision`) and
// `workflow_versions` (one row per version; at most one draft per workflow, by a partial unique
// index; a published row is never updated — the adapters refuse it in the statement itself).

import type { OutboxRecord } from '@atlas/messaging';
import type { Workflow, WorkflowVersion } from './workflow.ts';

export interface WorkflowStore {
  transaction<T>(fn: (tx: WorkflowTx) => Promise<T>): Promise<T>;
  get(id: string): Promise<Workflow | undefined>;
  /** One channel's workflows, keyset on id ascending. */
  list(channelId: string, options: { after?: string; limit: number }): Promise<Workflow[]>;
  version(workflowId: string, version: number): Promise<WorkflowVersion | undefined>;
  /** The published versions, newest first. */
  published(workflowId: string): Promise<WorkflowVersion[]>;
  close(): Promise<void>;
}

export interface WorkflowTx {
  /**
   * Write the header. Without `ifRevision` it is an INSERT and `false` means the id exists; with
   * it, an update only over that revision — `false` means someone wrote in between and nothing
   * was written.
   */
  put(workflow: Workflow, ifRevision?: number): Promise<boolean>;
  /**
   * Write a version. A draft row is inserted or replaced; a row that is already PUBLISHED is never
   * touched — `false` back, nothing written. Publishing is this call with `status: 'published'`
   * over the draft row.
   */
  putVersion(version: WorkflowVersion): Promise<boolean>;
  enqueue(record: OutboxRecord): Promise<void>;
}
