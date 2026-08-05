// The asset lifecycle (EP-17.1) — MAM's core correctness rule.
//
// `created → processing → ready → approved`, with time-bounded validity
// ([mam.md §3.1](../../../docs/architecture/services/mam.md#31-asset-lifecycle)).
//
// Pure functions over plain data, deliberately separate from storage and HTTP: what makes an asset
// schedulable is a safety question — a rejected or expired asset reaching air is the failure this
// service exists to prevent — and that deserves to be tested without a database.
//
// RECONCILIATION: the state diagram also shows `Replaced` and `Purged`, but the `state` enum in
// [data-model.md §1.1](../../../docs/architecture/data-model.md) has six values and does not
// include them. The enum is the field, so those are modelled as what they actually are — leaving
// the aggregate. Replacement mints a NEW asset id (`replacesId` chain, §1.7) and purging deletes
// the record; neither is a state an asset sits in.

export type AssetState = 'created' | 'processing' | 'ready' | 'approved' | 'rejected' | 'expired';

export const ASSET_STATES: readonly AssetState[] = [
  'created',
  'processing',
  'ready',
  'approved',
  'rejected',
  'expired',
];

/** What a transition is asked to do. `expire` is fired by the scheduler, never by a user. */
export type LifecycleAction =
  'startProcessing' | 'markReady' | 'approve' | 'reject' | 'expire' | 'purge';

/** The subset of an asset the lifecycle actually reasons about. */
export interface LifecycleContext {
  state: AssetState;
  /** Renditions attached by MTS. `markReady` is refused without them. */
  hasRenditions: boolean;
  /** Field names the asset's category/media type requires before it may go ready. */
  mandatoryFields: readonly string[];
  /** Field names actually populated. */
  presentFields: readonly string[];
  /** Enforced usable-until. Absent ⇒ permanent. */
  expiresAt?: string | undefined;
  /** Purge time for rejected media. */
  retainUntil?: string | undefined;
}

export interface TransitionResult {
  allowed: boolean;
  /** The state the asset lands in. Only meaningful when `allowed`. */
  next?: AssetState;
  reason?: string;
  /** Mandatory fields still missing — populated when `markReady` is refused for that reason. */
  missing?: readonly string[];
}

/**
 * The legal edges. Everything not listed here is refused, so a new state or action cannot quietly
 * become reachable by omission.
 */
const EDGES: Readonly<Record<LifecycleAction, Readonly<Record<string, AssetState>>>> = {
  startProcessing: { created: 'processing' },
  markReady: { processing: 'ready' },
  // Re-review: an expired asset can be approved again with a fresh expiry, or finally rejected.
  approve: { ready: 'approved', expired: 'approved' },
  reject: { ready: 'rejected', expired: 'rejected' },
  // Only the scheduler fires this, and only against a currently-approved asset.
  expire: { approved: 'expired' },
  // Purge is deletion, not a state; the edge exists so the guard below can refuse it.
  purge: { rejected: 'rejected' },
};

/**
 * May this asset take this action?
 *
 * Refusals carry a reason, because "no" reaches an operator through the API and "cannot approve:
 * asset is still processing" is actionable where a bare 409 is not.
 */
export function canTransition(
  context: LifecycleContext,
  action: LifecycleAction,
): TransitionResult {
  const next = EDGES[action][context.state];
  if (next === undefined) {
    return {
      allowed: false,
      reason: `cannot ${action} an asset in state "${context.state}"`,
    };
  }

  if (action === 'markReady') {
    // Two independent gates, reported separately: an operator who is only missing metadata should
    // not be told to wait for renditions.
    if (!context.hasRenditions) {
      return { allowed: false, reason: 'cannot mark ready before renditions are attached' };
    }
    const missing = missingMandatory(context);
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `mandatory metadata missing: ${missing.join(', ')}`,
        missing,
      };
    }
  }

  return { allowed: true, next };
}

/**
 * EP-17.5 — the mandatory-metadata gate.
 *
 * An asset reaching `ready` is a promise that it can be scheduled and aired, so the fields the
 * category requires must be present before that promise is made, not after.
 */
export function missingMandatory(context: LifecycleContext): readonly string[] {
  const present = new Set(context.presentFields);
  return context.mandatoryFields.filter((field) => !present.has(field));
}

/**
 * Is this asset schedulable RIGHT NOW?
 *
 * `approved` alone is not enough: an approved asset whose `expiresAt` has passed is unusable even
 * if the scheduler has not run yet ([FR-SCH-3](../../../docs/requirements/05-functional-requirements.md#scheduling)).
 * Reading the stored state on its own would let a lapsed asset reach air in the window between
 * expiry and the sweep, which is exactly the failure this check exists to prevent.
 */
export function isSchedulable(context: LifecycleContext, now: Date = new Date()): boolean {
  if (context.state !== 'approved') return false;
  if (context.expiresAt === undefined) return true; // no expiry ⇒ permanent
  return new Date(context.expiresAt).getTime() > now.getTime();
}

/** Has an approved asset lapsed? Drives the scheduler's `approved → expired` sweep. */
export function hasLapsed(context: LifecycleContext, now: Date = new Date()): boolean {
  return (
    context.state === 'approved' &&
    context.expiresAt !== undefined &&
    new Date(context.expiresAt).getTime() <= now.getTime()
  );
}

/** Is a rejected asset due for purging? Drives the `retainUntil` sweep. */
export function isPurgeable(context: LifecycleContext, now: Date = new Date()): boolean {
  return (
    context.state === 'rejected' &&
    context.retainUntil !== undefined &&
    new Date(context.retainUntil).getTime() <= now.getTime()
  );
}

/** The event a successful transition emits, or undefined where the platform defines none. */
export function eventFor(action: LifecycleAction): string | undefined {
  switch (action) {
    case 'markReady':
      return 'asset.ready';
    case 'approve':
      return 'asset.approved';
    case 'reject':
      return 'asset.rejected';
    case 'expire':
      return 'asset.expired';
    case 'purge':
      return 'asset.deleted';
    // `startProcessing` is an internal step with no contract event: nothing outside MAM acts on
    // "renditions are being made", and inventing an event would be a contract nobody consumes.
    case 'startProcessing':
      return undefined;
  }
}
