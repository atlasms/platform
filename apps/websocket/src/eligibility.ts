// EP-09.2 — who may see what. CORRECTNESS-CRITICAL.
//
// The fan-out boundary. Every frame a client receives passed through here, so an over-permissive
// answer leaks data across tenants or between users. Kept pure and separate from the socket
// transport precisely so it can be tested exhaustively without a network.

import { can, type EffectivePolicy } from '@atlas/policy';

/** Broker subjects are `atlas.<channelId>.<domain>.<entity>.<action>` (messaging §1.1). */
export interface ParsedSubject {
  channelId: string;
  domain: string;
  rest: string[];
}

/** Private streams are `user.<userId>.<...>` and belong to exactly one subject. */
const PRIVATE_PREFIX = 'user.';

export function parseSubject(subject: string): ParsedSubject | undefined {
  const parts = subject.split('.');
  if (parts.length < 4 || parts[0] !== 'atlas') return undefined;
  return { channelId: parts[1] ?? '', domain: parts[2] ?? '', rest: parts.slice(3) };
}

export function isPrivateSubject(subject: string): boolean {
  return subject.startsWith(PRIVATE_PREFIX);
}

export function privateSubjectOwner(subject: string): string | undefined {
  if (!isPrivateSubject(subject)) return undefined;
  const owner = subject.slice(PRIVATE_PREFIX.length).split('.')[0];
  return owner !== undefined && owner !== '' ? owner : undefined;
}

export interface Subscriber {
  userId: string;
  /** The tenant the connection authenticated into. */
  channelId: string;
  policy: EffectivePolicy;
}

export interface EligibilityDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * May this subscriber receive this subject?
 *
 * Three gates, in order of how cheaply they fail:
 *
 * 1. **Private streams belong to one user.** `user.<id>.…` reaches that id and nobody else — no
 *    permission can grant someone else's inbox.
 * 2. **Tenant isolation.** A connection authenticated into `ch12` never receives `ch99`, whatever
 *    its grants say. This is checked *before* permissions so a broad grant cannot cross tenants.
 * 3. **The domain's read permission**, evaluated with the shared `can()` — the same function the
 *    owning service uses to enforce, so the socket cannot disagree with the API.
 */
export function mayReceive(sub: Subscriber, subject: string): EligibilityDecision {
  if (isPrivateSubject(subject)) {
    const owner = privateSubjectOwner(subject);
    if (owner === undefined) return { allowed: false, reason: 'malformed private subject' };
    return owner === sub.userId
      ? { allowed: true }
      : { allowed: false, reason: 'private stream belongs to another user' };
  }

  const parsed = parseSubject(subject);
  if (!parsed) return { allowed: false, reason: `unrecognised subject "${subject}"` };

  // Tenant isolation first. A wildcard grant must never become a cross-tenant leak.
  if (parsed.channelId !== sub.channelId) {
    return { allowed: false, reason: 'subject belongs to another channel' };
  }

  const permission = `${parsed.domain}:read`;
  // STRICT: the full context is known here, so an unsatisfiable predicate must not pass
  // (authorization-model.md §5.1 — lenient mode would widen the grant).
  const decision = can(sub.policy, permission, { channelId: parsed.channelId }, { strict: true });

  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason: decision.reason ?? `missing ${permission}` };
}

const WILDCARD = new Set(['*', '>']);

/**
 * May this subscriber SUBSCRIBE to this pattern?
 *
 * A deliberately different question from {@link mayReceive}. A pattern may leave the domain
 * open (`atlas.ch12.>` = everything in my tenant), and there is no single permission to check
 * for that — so this verifies only what a pattern can actually assert:
 *
 *  - a **private** pattern must belong to the subscriber;
 *  - the **channel token must be literal and match** the connection's tenant. A wildcard there
 *    is refused outright, because tenant isolation cannot be verified against `*`;
 *  - a **literal domain** is checked against `<domain>:read`; a wildcard domain is admitted and
 *    left to the per-message re-check, which is the real boundary.
 */
export function maySubscribe(sub: Subscriber, pattern: string): EligibilityDecision {
  if (isPrivateSubject(pattern)) {
    const owner = privateSubjectOwner(pattern);
    if (owner === undefined || WILDCARD.has(owner)) {
      return { allowed: false, reason: 'a private subscription must name its owner' };
    }
    return owner === sub.userId
      ? { allowed: true }
      : { allowed: false, reason: 'private stream belongs to another user' };
  }

  const parts = pattern.split('.');
  if (parts[0] !== 'atlas' || parts.length < 3) {
    return { allowed: false, reason: `unrecognised subscription pattern "${pattern}"` };
  }

  const channelToken = parts[1] ?? '';
  if (WILDCARD.has(channelToken)) {
    return { allowed: false, reason: 'a subscription may not wildcard the channel' };
  }
  if (channelToken !== sub.channelId) {
    return { allowed: false, reason: 'subject belongs to another channel' };
  }

  const domainToken = parts[2] ?? '';
  if (WILDCARD.has(domainToken)) {
    // Legitimate ("everything I may see in my tenant"); each message is still filtered.
    return { allowed: true };
  }

  const permission = `${domainToken}:read`;
  const decision = can(sub.policy, permission, { channelId: channelToken }, { strict: true });
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason: decision.reason ?? `missing ${permission}` };
}
