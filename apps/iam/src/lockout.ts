// Account lockout (#240) — the policy behind the `locked` state that nothing used to set.
//
// Scope, decided by where the platform already puts each concern:
//
//   PER-SOURCE rate limiting is the GATEWAY's job. api-gateway.md lists "rate limiting and quotas"
//   among its responsibilities (EP-08.3), and it is the only component that sees the source address
//   before any identity exists. Building it here would put it in the wrong layer and duplicate it.
//
//   PER-CREDENTIAL policy is IAM's job, and that is this file: how many consecutive failures a
//   single account tolerates before it stops accepting passwords at all.
//
// The two are complementary — source limiting bounds a spray across many accounts, this bounds a
// grind against one — and neither substitutes for the other.
//
// THE DENIAL-OF-SERVICE TRADE. A lock keyed on the account is a weapon an attacker can point at a
// real user: guess badly ten times and the person cannot log in. That is why the automatic lock is
// TIME-BOUNDED — it converts an attack from "lock the CEO out until someone notices" into "cost the
// CEO fifteen minutes", while still cutting an online guessing attack down to a few attempts per
// window. A permanent lock would have been the more secure-sounding choice and the worse one.

import type { User } from './store.ts';

export interface LockoutPolicy {
  /** Consecutive failures that trip the lock. */
  threshold: number;
  /** A run of failures older than this is stale, and counting starts again. */
  windowMs: number;
  /** How long an automatic lock lasts before a login attempt clears it. */
  durationMs: number;
}

/**
 * Ten attempts in fifteen minutes, locked for fifteen.
 *
 * Deliberately not three. A real user fat-fingering a password twice and being locked out trains
 * them to write passwords down, which costs more than it saves; NIST SP 800-63B makes the same
 * point and argues for throttling over aggressive lockout. Ten leaves an online attacker roughly
 * 40 guesses a day against one account, which no password worth having falls to.
 */
export const DEFAULT_LOCKOUT: LockoutPolicy = {
  threshold: 10,
  windowMs: 15 * 60_000,
  durationMs: 15 * 60_000,
};

/** The failure-tracking fields, which live on the user record so they survive with it. */
export interface FailureState {
  failedAttempts: number;
  /** ISO timestamp of the first failure in the current run. */
  firstFailedAt: string;
}

/**
 * Has an automatic lock served its time?
 *
 * An **administrative** lock has no `lockedUntil` and never expires here — only {@link clearLock}
 * lifts it. Distinguishing the two matters: an operator who disables an account for cause must not
 * have that undone by the clock.
 */
export function lockExpired(user: User, now: number): boolean {
  if (user.state !== 'locked') return false;
  if (user.lockedUntil === undefined) return false;
  return Date.parse(user.lockedUntil) <= now;
}

/**
 * Fold one more failure into the user's run, and say whether it trips the lock.
 *
 * Counts CONSECUTIVE failures rather than keeping a list of timestamps: a list is unbounded memory
 * an attacker chooses the size of, and the extra precision buys nothing a threshold cannot express.
 */
export function nextFailure(
  user: User,
  now: number,
  policy: LockoutPolicy,
): FailureState & { locked: boolean } {
  const runStartedAt = user.firstFailedAt;

  // No run, or one that has aged out: this failure starts a fresh one. A threshold of 1 must still
  // lock here, so the comparison is made rather than assumed not to trip.
  if (runStartedAt === undefined || Date.parse(runStartedAt) + policy.windowMs <= now) {
    return {
      failedAttempts: 1,
      firstFailedAt: new Date(now).toISOString(),
      locked: 1 >= policy.threshold,
    };
  }

  const failedAttempts = (user.failedAttempts ?? 0) + 1;
  return {
    failedAttempts,
    firstFailedAt: runStartedAt,
    locked: failedAttempts >= policy.threshold,
  };
}

/** Wipe the failure run. Called on every success — a correct password ends the run, whatever its length. */
export function clearFailures(user: User): void {
  delete user.failedAttempts;
  delete user.firstFailedAt;
}

/** Lift a lock, automatic or administrative, and start the user clean. */
export function clearLock(user: User): void {
  user.state = 'active';
  delete user.lockedUntil;
  clearFailures(user);
}
