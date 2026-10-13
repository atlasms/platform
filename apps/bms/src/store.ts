// The definition store: a port with a sqlite and a Postgres adapter, held to one conformance suite
// (store-conformance.ts) — the shape every Atlas service's persistence takes.
//
// Two tables, both channel-scoped: `workflows` (the header, compare-and-set on `revision`) and
// `workflow_versions` (one row per version; at most one draft per workflow, by a partial unique
// index; a published row is never updated — the adapters refuse it in the statement itself).

import type { OutboxRecord } from '@atlas/messaging';
import type { HistoryEntry, Instance } from './instance.ts';
import type { Workflow, WorkflowState, WorkflowVersion } from './workflow.ts';

export interface WorkflowStore {
  transaction<T>(fn: (tx: WorkflowTx) => Promise<T>): Promise<T>;
  get(id: string): Promise<Workflow | undefined>;
  /** One channel's workflows, keyset on id ascending; with `state`, only those in it. */
  list(
    channelId: string,
    options: { state?: WorkflowState; after?: string; limit: number },
  ): Promise<Workflow[]>;
  version(workflowId: string, version: number): Promise<WorkflowVersion | undefined>;
  /** The published versions, newest first. */
  published(workflowId: string): Promise<WorkflowVersion[]>;
  instance(id: string): Promise<Instance | undefined>;
  /** One channel's instances, newest first (keyset on id descending). */
  instances(
    channelId: string,
    options: { workflowId?: string; after?: string; limit: number },
  ): Promise<Instance[]>;
  /** An instance's step history, in order. */
  history(instanceId: string): Promise<HistoryEntry[]>;
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
  /**
   * The header, read THROUGH the transaction and locked: a state change and a start of an
   * instance both take it first, so "no instance is running" and "the workflow is active" are
   * each true at the moment of the write that depends on it (EP-22.11).
   */
  workflowForUpdate(id: string): Promise<Workflow | undefined>;
  /** Instances of a workflow not yet completed or failed. */
  liveInstances(workflowId: string): Promise<number>;
  /** Insert an instance; `false` if the id exists (a retried start is the same instance). */
  insertInstance(instance: Instance): Promise<boolean>;
  /** The instance, read THROUGH the transaction and locked for its update. */
  instanceForUpdate(id: string): Promise<Instance | undefined>;
  putInstance(instance: Instance): Promise<void>;
  /** Append a history entry; `false` if (instance, seq) is already there — a retried write. */
  appendHistory(entry: HistoryEntry): Promise<boolean>;
  /**
   * An activity's idempotency key, in the same transaction as its writes (EP-03.3's seen-mark):
   * `false` means a previous attempt already committed them, and the retry writes nothing.
   */
  markSeen(key: string): Promise<boolean>;
}
