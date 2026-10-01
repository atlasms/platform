// File operations (EP-14.3, EP-14.5; ADR-0009 §5) — a TABLE, leased by compare-and-set, the MTS
// queue's shape.
//
//   copy     a verified replica of a file on another target; the file itself does not change
//   move     the file to another target (and tier): copy, verify, compare-and-set the ledger to the
//            new place, then release the old bytes
//   delete   the file leaves the ledger's live set (the row keeps `deletedAt`); its bytes and
//            replicas are released
//   release  remove bytes nothing references any more. INTERNAL: queued in the same transaction
//            that made the bytes unreferenced (a replacement, a move, a delete) — the only way
//            bytes are ever removed, so a crash can leak bytes but never lose referenced ones
//
// A retry is an idempotent restart: a copy's destination key is derived from the operation id, so a
// second attempt overwrites its own partial work and nothing else.

export const OPERATION_KINDS = ['copy', 'move', 'delete', 'release'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];
/** What a service may ask for; `release` is HSM's own. */
export const REQUESTABLE_KINDS = ['copy', 'move', 'delete'] as const;
export const OPERATION_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'dead-letter',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const MAX_ATTEMPTS = 3;

export interface Operation {
  id: string;
  channelId: string;
  kind: OperationKind;
  /** copy/move/delete: the file. */
  fileId?: string;
  assetId?: string;
  /** copy/move: where to. */
  toTargetId?: string;
  /** release: the bytes. */
  release?: { targetId: string; path: string };
  state: OperationState;
  attempts: number;
  /** The worker holding the lease, and until when. */
  holder?: string;
  leaseUntil?: string;
  /** failed: when the next attempt may start. */
  retryAt?: string;
  bytesDone: number;
  bytesTotal?: number;
  error?: string;
  requestedBy: string;
  correlationId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** The operation on the wire (hsm.yaml `Operation`): the lease is the workers' business. */
export function operationView(op: Operation): object {
  const { holder: _h, leaseUntil: _l, ...rest } = op;
  void _h;
  void _l;
  return {
    ...rest,
    progress: op.bytesTotal
      ? Math.min(1, op.bytesDone / op.bytesTotal)
      : op.state === 'completed'
        ? 1
        : 0,
  };
}

/** 30 s, doubling, capped at 10 minutes — MTS's schedule. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 600_000);
}

/** A failure that no retry can fix — dead-letter at once. */
export class OperationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationRefusal';
  }
}
