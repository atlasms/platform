// What MAM has said about each asset's approval — Scheduling's own record of it (EP-31).
//
// scheduling.md §5: Scheduling CONSUMES MAM's lifecycle rather than asking MAM at validation time,
// so a validation (and, later, the send-to-air guard) answers from data this service holds, with
// MAM down or not. One durable over `atlas.*.asset.*` keeps the stream's order; the rest is here.
//
// Two facts, each with the time MAM stated it: the approval STATE (approved / rejected / expired /
// deleted) and the EXPIRY (from `asset.approved`, or a later `asset.updated` that names it). They
// are timed separately because they arrive on different events: a redelivered `asset.approved`
// that is older than an `asset.updated` must still set the state and must not undo the newer
// expiry. A fact older than the one held is ignored, so the record converges on MAM's latest word
// whatever order the broker delivers in.

import type { Envelope, EventPayloads } from '@atlas/contracts';

/** `unknown`: MAM has named an expiry for the asset but no verdict has arrived yet. */
export type ApprovalState = 'approved' | 'rejected' | 'expired' | 'deleted' | 'unknown';

export interface MediaApproval {
  assetId: string;
  channelId: string;
  state: ApprovalState;
  /** `occurredAt` of the event that set `state`; absent while `unknown`. */
  stateAsOf?: string;
  /** When the approval lapses; absent = permanent (or never stated). */
  expiresAt?: string;
  /** `occurredAt` of the event that set `expiresAt` (or cleared it). */
  expiryAsOf?: string;
}

/** The asset events this record is built from; every other `asset.*` is acked and ignored. */
export const APPROVAL_EVENTS = [
  'asset.approved',
  'asset.rejected',
  'asset.expired',
  'asset.deleted',
  'asset.updated',
] as const;

const VERDICTS: Record<string, ApprovalState> = {
  'asset.approved': 'approved',
  'asset.rejected': 'rejected',
  'asset.expired': 'expired',
  'asset.deleted': 'deleted',
};

/** Is `at` at least as new as `asOf`? Ties go to the later delivery — the stream's order. */
const newer = (at: string, asOf: string | undefined): boolean =>
  asOf === undefined || Date.parse(at) >= Date.parse(asOf);

/**
 * The record after one event, or `undefined` when the event changes nothing (an `asset.updated`
 * that does not touch the expiry, or a fact older than the one held).
 */
export function applyAssetEvent(
  current: MediaApproval | undefined,
  envelope: Envelope,
): MediaApproval | undefined {
  const at = envelope.occurredAt;
  const payload = envelope.payload as { assetId: string };
  const base: MediaApproval = current ?? {
    assetId: payload.assetId,
    channelId: envelope.channelId,
    state: 'unknown',
  };
  let next = base;
  let changed = false;

  const verdict = VERDICTS[envelope.type];
  if (verdict !== undefined && newer(at, base.stateAsOf)) {
    next = { ...next, state: verdict, stateAsOf: at };
    changed = true;
  }

  // The expiry: stated by an approval (absent there = permanent), or by an edit that names it.
  let expiry: { value: string | undefined } | undefined;
  if (envelope.type === 'asset.approved') {
    expiry = { value: (envelope.payload as unknown as EventPayloads['asset.approved']).expiresAt };
  } else if (envelope.type === 'asset.updated') {
    const p = envelope.payload as unknown as EventPayloads['asset.updated'];
    if (p.changedFields.includes('expiresAt') && p.expiresAt !== undefined) {
      expiry = { value: p.expiresAt ?? undefined };
    }
  }
  if (expiry !== undefined && newer(at, base.expiryAsOf)) {
    const { expiresAt: _old, ...rest } = next;
    void _old;
    next = {
      ...rest,
      ...(expiry.value !== undefined ? { expiresAt: expiry.value } : {}),
      expiryAsOf: at,
    };
    changed = true;
  }

  return changed ? next : undefined;
}
