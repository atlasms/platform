// HSM's store: a port with two adapters (sqlite for the suites, Postgres in production), held to one
// conformance suite driven through the service — the MAM/MTS shape.
//
// Every write that must be exactly-once is a compare-and-set here, because two HSM replicas (or two
// workers) can race for the same row: a placement inserts a file only if no live one exists for its
// (asset, kind, variant), or replaces it only at the version it read; a worker leases an operation
// only in the state it saw. Nothing reads back inside a transaction (AGENTS.md §6).

import type { OutboxRecord } from '@atlas/messaging';
import type { FileEntry, FileKind, Replica, Tier } from './file.ts';
import type { Operation, OperationState } from './operation.ts';
import type { StorageTarget } from './targets.ts';

export interface HsmStore {
  transaction<T>(fn: (tx: HsmTx) => Promise<T>): Promise<T>;
  file(id: string): Promise<FileEntry | undefined>;
  /** The LIVE file of (asset, kind, variant), if any. */
  liveFile(assetId: string, kind: FileKind, variant?: string): Promise<FileEntry | undefined>;
  /** An asset's live files in a channel, by kind then variant. */
  filesOf(channelId: string, assetId: string): Promise<FileEntry[]>;
  replicasOf(fileId: string): Promise<Replica[]>;
  target(id: string): Promise<StorageTarget | undefined>;
  /** The targets a channel can see: its own and the platform-wide, by name. */
  targets(channelId: string | undefined): Promise<StorageTarget[]>;
  /** Where a channel's new files of a tier go: its own enabled default, else the platform's. */
  defaultTarget(channelId: string, tier: Tier): Promise<StorageTarget | undefined>;
  operation(id: string): Promise<Operation | undefined>;
  /** Operations a worker may take now: queued, or failed with `retryAt` passed. Oldest first. */
  operationsDue(now: string, limit: number): Promise<Operation[]>;
  /** Running operations whose lease has lapsed — a worker died holding them. */
  operationsLapsed(now: string): Promise<Operation[]>;
  /**
   * A running operation's progress, and its lease extended — by its holder only. `false`: the lease
   * is no longer this holder's, and the worker must stop.
   */
  progress(id: string, holder: string, bytesDone: number, leaseUntil: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface HsmTx {
  /**
   * Insert a file (no `ifVersion`): `false` if a live file of its (asset, kind, variant) exists.
   * Replace one (`ifVersion`): `false` if it is not at that version.
   */
  putFile(file: FileEntry, ifVersion?: number): Promise<boolean>;
  putReplica(replica: Replica): Promise<void>;
  deleteReplicas(fileId: string): Promise<void>;
  /** Insert (no `ifVersion`; `false` if the id exists) or replace at a version. */
  putTarget(target: StorageTarget, ifVersion?: number): Promise<boolean>;
  /** `false` if an operation with this id exists — the caller's retry, which is fine. */
  insertOperation(op: Operation): Promise<boolean>;
  /** Write an operation only if it is in `ifState` (and, when given, held by `ifHolder`). */
  putOperation(op: Operation, ifState: OperationState, ifHolder?: string): Promise<boolean>;
  enqueue(record: OutboxRecord): Promise<void>;
}
