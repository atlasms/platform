// The review surfaces' decisions (EP-24.9; review plan WS-H), pure so they are tested without a DOM:
// what an asset's lifecycle badge says, when a verdict may be given, and what an approval sends.
import type { Asset } from '../core/generated/mam.types.ts';
import type { ApproveInput } from '../core/assets.service.ts';

/** A badge: a locale key, and the whole days it counts, when it counts any. */
export interface LifecycleBadge {
  key: string;
  days?: number;
  tone: 'ok' | 'warning' | 'danger' | 'info';
}

const DAY = 86_400_000;
const daysUntil = (iso: string, now: Date) =>
  Math.max(0, Math.ceil((Date.parse(iso) - now.getTime()) / DAY));

/**
 * `Approved · expires in 12d`, `Expired — re-review`, `Rejected — purges in 5d` (WS-H): where an
 * asset stands for air, at a glance. Null for a state with nothing to say about review.
 */
export function badgeOf(
  asset: Pick<Asset, 'state' | 'expiresAt' | 'retainUntil'>,
  now: Date,
): LifecycleBadge | null {
  switch (asset.state) {
    case 'ready':
      return { key: 'review.badge.awaiting', tone: 'info' };
    case 'approved':
      return asset.expiresAt
        ? { key: 'review.badge.approvedExpires', days: daysUntil(asset.expiresAt, now), tone: 'ok' }
        : { key: 'review.badge.approvedPermanent', tone: 'ok' };
    case 'expired':
      return { key: 'review.badge.expired', tone: 'warning' };
    case 'rejected':
      return asset.retainUntil
        ? {
            key: 'review.badge.rejectedPurges',
            days: daysUntil(asset.retainUntil, now),
            tone: 'danger',
          }
        : { key: 'review.badge.rejected', tone: 'danger' };
    default:
      return null;
  }
}

/** A verdict is given to a READY asset, or again to an EXPIRED one (re-review). MAM decides. */
export const awaitsVerdict = (state: string): boolean => state === 'ready' || state === 'expired';

/** How an approval sets the expiry: the category's default, a date, or never. */
export type ExpiryChoice = 'inherit' | 'date' | 'permanent';

/**
 * The approval's body. `inherit` sends NO `expiresAt` — MAM snapshots the category default — and
 * `permanent` sends `null`; a date is that day, from its start, in UTC. Null when a date was
 * chosen but none (or one in the past) given: the panel says so rather than sending it.
 */
export function approvalBody(choice: ExpiryChoice, date: string, now: Date): ApproveInput | null {
  if (choice === 'inherit') return {};
  if (choice === 'permanent') return { expiresAt: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = `${date}T00:00:00.000Z`;
  return Date.parse(at) > now.getTime() ? { expiresAt: at } : null;
}

/** A retention date for a rejection, the same way; blank is MAM's own policy (omitted). */
export function retentionOf(date: string): string | undefined | null {
  if (date.trim() === '') return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : null;
}
