// IAM's auth-specific counters (#205, EP-12.2a) — the signals that only an authentication service
// has, alongside the golden signals every service records.
//
// Spec: [iam.md §12](../../../docs/architecture/services/iam.md#12-observability).
//
// THE CARDINALITY AND DISCLOSURE RULE, which is the same rule here: **no identity is ever a label.**
// Not the username, not the user id, not the IP. `/metrics` is scraped unauthenticated, so a
// username label would publish the account list to anyone who can reach the port — and an attacker
// spraying logins would mint a time series per guess and take the metrics store down on the way.
// Who failed to log in is an audit question, answered by the LoginEvent trail. How many failed is
// the metrics question, and it is answered by a counter whose label set is CLOSED.

import type { MetricRegistry } from '@atlas/service-kit';
import type { UserState } from './store.ts';

/**
 * Why a login attempt ended the way it did.
 *
 * The non-active states are derived from {@link UserState} rather than listed, so adding a user
 * state that can refuse a login is a **compile error here** instead of a new unlabelled series
 * appearing in production. That is the drift this union exists to prevent.
 */
export type LoginOutcome =
  'success' | 'unknown_user' | 'bad_password' | 'no_credential' | Exclude<UserState, 'active'>;

/** Why a refresh ended the way it did. `reuse_detected` is the breach signal. */
export type RefreshOutcome =
  'success' | 'unknown_token' | 'reuse_detected' | 'expired' | 'inactive_account';

/** What produced a token pair: the credential exchange, or a rotation. */
export type Grant = 'password' | 'refresh';

/** Why a set of refresh tokens was revoked. */
export type RevocationReason = 'reuse' | 'logout';

export interface AuthSignals {
  /** One finished login attempt. */
  login(outcome: LoginOutcome): void;
  /** One finished refresh attempt. */
  refresh(outcome: RefreshOutcome): void;
  /** One token pair issued. */
  issued(grant: Grant): void;
  /** `sessions` refresh tokens moved from live to revoked — 0 is not recorded. */
  revoked(reason: RevocationReason, sessions: number): void;
  /** One account crossed the failure threshold and was locked. */
  lockedOut(): void;
  /** Seconds spent compiling one effective policy. */
  policyCompiled(seconds: number): void;
}

/**
 * Register IAM's auth counters on a registry.
 *
 * Every metric here is bounded by construction: the label values are unions in this file, so the
 * whole instrument set is at most a couple of dozen series no matter how much traffic arrives.
 */
export function authSignals(registry: MetricRegistry): AuthSignals {
  const logins = registry.counter({
    name: 'atlas_iam_login_attempts_total',
    help: 'Login attempts by outcome. Failures are the brute-force signal.',
    labelNames: ['outcome'],
  });

  const refreshes = registry.counter({
    name: 'atlas_iam_refresh_attempts_total',
    help: 'Refresh-token rotations by outcome. outcome="reuse_detected" is a breach signal.',
    labelNames: ['outcome'],
  });

  const issued = registry.counter({
    name: 'atlas_iam_tokens_issued_total',
    help: 'Token pairs issued, by what granted them.',
    labelNames: ['grant'],
  });

  const revoked = registry.counter({
    name: 'atlas_iam_sessions_revoked_total',
    help: 'Refresh tokens revoked, by reason. reason="reuse" revokes a whole family at once.',
    labelNames: ['reason'],
  });

  // The lockout EVENT, which is a different question from `login_attempts_total{outcome="locked"}`
  // — that counts attempts made against an account already locked, and stays high for as long as
  // an attacker keeps knocking. This one fires once, when the lock closes. Alert on this.
  const lockouts = registry.counter({
    name: 'atlas_iam_lockouts_total',
    help: 'Accounts locked by the failed-attempt policy.',
  });

  // Named in iam.md §12 as "permission-resolution latency". It is not an HTTP concern — the same
  // compile runs on every token issue — so the golden-signal route histogram does not cover it.
  // It grows with a subject's role and group count, which is what makes it worth watching.
  const policyCompile = registry.histogram({
    name: 'atlas_iam_policy_compile_duration_seconds',
    help: 'Time to compile one subject effective policy.',
    // Compiling is in-memory and sub-millisecond today; the HTTP defaults would put every
    // observation in the first bucket and show nothing. These resolve microseconds upward.
    buckets: [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.05, 0.1],
  });

  return {
    login: (outcome) => logins.inc({ outcome }),
    refresh: (outcome) => refreshes.inc({ outcome }),
    issued: (grant) => issued.inc({ grant }),
    revoked: (reason, sessions) => {
      // A logout that revoked nothing is idempotent, not an event. Recording a 0 would still
      // create the series, making an empty revocation indistinguishable from none at all.
      if (sessions > 0) revoked.inc({ reason }, sessions);
    },
    lockedOut: () => lockouts.inc(),
    policyCompiled: (seconds) => policyCompile.observe({}, seconds),
  };
}
