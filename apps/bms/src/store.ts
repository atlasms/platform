// The definition store: a port with a sqlite and a Postgres adapter, held to one conformance suite
// (store-conformance.ts) — the shape every Atlas service's persistence takes.
//
// Two tables, both channel-scoped: `workflows` (the header, compare-and-set on `revision`) and
// `workflow_versions` (one row per version; at most one draft per workflow, by a partial unique
// index; a published row is never updated — the adapters refuse it in the statement itself).

import type { OutboxRecord } from '@atlas/messaging';
import type {
  BufferedEvent,
  CommandAwait,
  EventAwait,
  HistoryEntry,
  Instance,
  InstanceState,
} from './instance.ts';
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
    options: { workflowId?: string; state?: InstanceState; after?: string; limit: number },
  ): Promise<Instance[]>;
  /** An instance's step history, in order. */
  history(instanceId: string): Promise<HistoryEntry[]>;
  /** The command issued under this correlation id, answered or not (EP-22.4). */
  commandAwait(correlationId: string): Promise<CommandAwait | undefined>;
  /**
   * The OPEN event awaits of one type in one channel (EP-22.6). With `assetId`, only those keyed on
   * that asset or on no asset at all — the narrowing every asset event gets; the caller matches the
   * rest of the keys.
   */
  openEventAwaits(channelId: string, eventType: string, assetId?: string): Promise<EventAwait[]>;
  /**
   * Buffered events of one type in one channel that occurred at or after `since`, oldest first
   * (EP-22.7). With `assetId`, only that asset's — and those that name no asset.
   */
  bufferedEvents(
    channelId: string,
    eventType: string,
    since: string,
    assetId?: string,
  ): Promise<BufferedEvent[]>;
  /** One buffered event, by its message id. */
  bufferedEvent(messageId: string): Promise<BufferedEvent | undefined>;
  /** Every event await under one correlation id, answered or not — a review's are two. */
  eventAwaitsFor(correlationId: string): Promise<EventAwait[]>;
  /** The message ids that already answered one of this instance's event awaits. */
  eventsUsedBy(instanceId: string): Promise<string[]>;
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
  /** Record a command BMS issued and will hear back about; `false` if the id exists. */
  insertAwait(entry: CommandAwait): Promise<boolean>;
  /**
   * Mark it answered — only if it is not already: `false` means an earlier delivery of the answer
   * (or another answer) got there first, and nothing is written.
   */
  answerAwait(correlationId: string, answeredAt: string, answeredBy: string): Promise<boolean>;
  /** Record a step waiting for an event; `false` if (correlation id, event type) exists — a retry. */
  insertEventAwait(entry: EventAwait): Promise<boolean>;
  /**
   * Mark every open event await under this correlation id answered — a review's two verdict rows
   * together. `false` means none was open: another event, or a delivery of this one, got there first.
   */
  answerEventAwaits(
    correlationId: string,
    answeredAt: string,
    answeredBy: string,
  ): Promise<boolean>;
  /** Keep a waitable event (EP-22.7); `false` if it is already kept — a redelivery. */
  bufferEvent(event: BufferedEvent): Promise<boolean>;
  /** Forget events received before `before`; how many went. */
  pruneEventBuffer(before: string): Promise<number>;
}
