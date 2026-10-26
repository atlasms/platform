// A review verdict, RETAINED (EP-24.4; review-lifecycle plan WS-A2/WS-C, FR-APP-5): one row per
// approval or rejection, written in the transaction that moved the asset, never updated or
// deleted — by the database, not only by this code. The asset holds only its CURRENT state and
// approver; this is what it was decided, by whom, when, at which review point, and why.

export type VerdictKind = 'approved' | 'rejected';

export interface Verdict {
  /** A ULID, minted when the verdict was given. */
  id: string;
  assetId: string;
  channelId: string;
  verdict: VerdictKind;
  /** The user who gave it — or MAM itself for an automatic approval (EP-28.7). */
  decidedBy: string;
  decidedAt: string;
  /** A rejection's reason (required there, by the transition). */
  reason?: string;
  /** The workflow review step the verdict was given at (EP-22.6), when one was named. */
  reviewPointId?: string;
  /** What the approval set, as it set it: the expiry snapshotted at that moment. */
  expiresAt?: string;
  expirySource?: 'asset' | 'category';
  /** What the rejection set: until when the rejected media is kept. */
  retainUntil?: string;
  /** True when no person gave it: the category chain needs no review (EP-28.7). */
  automatic?: boolean;
}
