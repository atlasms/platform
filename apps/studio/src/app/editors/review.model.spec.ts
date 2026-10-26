import { describe, expect, it } from 'vitest';
import { approvalBody, awaitsVerdict, badgeOf, retentionOf } from './review.model.ts';

const NOW = new Date('2026-10-26T12:00:00.000Z');

describe('badgeOf — where an asset stands for air, at a glance (WS-H)', () => {
  it('counts the whole days left to an expiry or a purge, never below zero', () => {
    expect(badgeOf({ state: 'approved', expiresAt: '2026-11-07T12:00:00.000Z' }, NOW)).toEqual({
      key: 'review.badge.approvedExpires',
      days: 12,
      tone: 'ok',
    });
    expect(badgeOf({ state: 'rejected', retainUntil: '2026-10-31T00:00:00.000Z' }, NOW)).toEqual({
      key: 'review.badge.rejectedPurges',
      days: 5,
      tone: 'danger',
    });
    expect(badgeOf({ state: 'approved', expiresAt: '2026-10-01T00:00:00.000Z' }, NOW)?.days).toBe(
      0,
    );
  });

  it('names the states review is about, and stays silent on the rest', () => {
    expect(badgeOf({ state: 'approved' }, NOW)?.key).toBe('review.badge.approvedPermanent');
    expect(badgeOf({ state: 'expired' }, NOW)).toEqual({
      key: 'review.badge.expired',
      tone: 'warning',
    });
    expect(badgeOf({ state: 'ready' }, NOW)?.key).toBe('review.badge.awaiting');
    expect(badgeOf({ state: 'rejected' }, NOW)?.key).toBe('review.badge.rejected');
    expect(badgeOf({ state: 'processing' }, NOW)).toBeNull();
  });
});

describe('verdict inputs', () => {
  it('a verdict is given to a ready asset, or again to an expired one', () => {
    expect(
      ['created', 'processing', 'ready', 'approved', 'rejected', 'expired'].filter(awaitsVerdict),
    ).toEqual(['ready', 'expired']);
  });

  it('inherit sends no expiry, permanent sends null, a date its start in UTC — a past or missing one nothing', () => {
    expect(approvalBody('inherit', '', NOW)).toEqual({});
    expect(approvalBody('permanent', '2027-01-01', NOW)).toEqual({ expiresAt: null });
    expect(approvalBody('date', '2027-01-01', NOW)).toEqual({
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(approvalBody('date', '', NOW)).toBeNull();
    expect(approvalBody('date', '2026-10-01', NOW)).toBeNull();
  });

  it('a retention date is optional — blank is MAM’s own policy', () => {
    expect(retentionOf('')).toBeUndefined();
    expect(retentionOf('2026-12-01')).toBe('2026-12-01T00:00:00.000Z');
    expect(retentionOf('soon')).toBeNull();
  });
});
