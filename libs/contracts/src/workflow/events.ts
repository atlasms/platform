// The events a workflow may WAIT for (EP-22.6; bms.md §13f). A wait-event step names one, and BMS's
// router keeps a durable consumer per event type listed here — so the list is closed, like the
// commands (commands.ts): an author cannot make BMS consume, and copy into an instance's vars,
// whatever passes on the bus (`permissions.changed`, another service's internals), and a type that
// nobody here subscribes to would leave its step waiting forever. Widening it is a code change —
// the router subscribes from this list — so it is a Tier-0 list, not a registry.

export const WORKFLOW_EVENTS: readonly string[] = [
  'asset.ready',
  'asset.approved',
  'asset.rejected',
];

/**
 * The events that may START a workflow (EP-22.7, decided 2026-10-17) — a start step's
 * `trigger.event`. Closed for the same reasons: BMS keeps a durable consumer per type, and each one
 * starts every matching ACTIVE workflow of its channel, as BMS, on the publisher's authority — so
 * what can cause a start is a decision, not an author's. `asset.expired` opens a re-review
 * (EP-22.10, review plan WS-G2); `asset.approved` joins with EP-37's publishing commands.
 */
export const WORKFLOW_TRIGGERS: readonly string[] = ['ingest.accepted', 'asset.expired'];

/**
 * A review step's verdicts (EP-22.6, decided 2026-10-16): a human step with a `reviewPointId` is
 * resolved by MAM's verdict on the instance's asset, not by its task — and the event says which way.
 */
export const REVIEW_VERDICTS: Readonly<Record<string, { outcome: string; by: string }>> = {
  'asset.approved': { outcome: 'approved', by: 'approver' },
  'asset.rejected': { outcome: 'rejected', by: 'rejectedBy' },
};
