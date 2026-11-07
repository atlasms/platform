// EP-09.2 — who may see what. CORRECTNESS-CRITICAL.
//
// The fan-out boundary. Every frame a client receives passed through here, so an over-permissive
// answer leaks data across tenants or between users. Kept pure and separate from the socket
// transport precisely so it can be tested exhaustively without a network.

import { can, type EffectivePolicy } from '@atlas/policy';

/**
 * Broker subjects are `atlas.<channelId>.<domain>.<entity>.<action>` (messaging §1.1), and PROGRESS
 * is the same shape under `live.` (EP-16.4) — kept by nothing, but channel-scoped and permissioned
 * exactly like an event. The two roots differ in what the BROKER keeps, never in who may see them,
 * so they share every gate below.
 */
const ROOTS = new Set(['atlas', 'live']);

/**
 * The permission a domain's messages are read under, where it is not simply `<domain>:read`.
 *
 * `transcode` is MTS's: its jobs are read under `asset:read` on the `files` field group (the file
 * set is the Librarian's half — authorization-model.md §3.1), and there is no `transcode:read` in
 * the permission catalogue or in any starter role. Left to the default, every transcode message —
 * `transcode.completed` as much as progress — reached nobody, which is safe and useless. Mapped
 * here to the SAME grant MTS enforces, so the socket cannot disagree with the API.
 */
const DOMAIN_READ: Readonly<Record<string, { permission: string; fieldGroup?: string }>> = {
  transcode: { permission: 'asset:read', fieldGroup: 'files' },
  // HSM's `file.placed` / `file.moved` (ADR-0009): an asset's file set, read as MAM's
  // `GET /assets/{id}/files` and the audit log's `file` history are. Under the default it was
  // `file:read` — in no role, in no catalogue — so every file event reached nobody (#384).
  file: { permission: 'asset:read', fieldGroup: 'files' },
};

/**
 * Messages EVERY authenticated user of the channel receives, whatever their grants — checked after
 * tenant isolation, never instead of it. Each entry is a decision, not a convenience:
 *
 * - `workflow.changed` (EP-22.11, decided by the product owner 2026-10-13): an active workflow is
 *   visible to everyone in its channel, and every client keeps a copy of the catalog
 *   (`GET /workflows/catalog`) that this event tells it to refresh. It carries the workflow's id,
 *   state, version and name — what the catalog itself shows them. Every OTHER `workflow.*` event
 *   (a step requested, a task created, an instance completed) stays under `workflow:read`.
 */
const CHANNEL_WIDE: ReadonlySet<string> = new Set(['workflow.changed']);

/**
 * PERSONAL domains (EP-25.7, decided 2026-10-12; websocket.md §5): every message in one names ONE
 * recipient — `recipientUserId` in its envelope's payload — and reaches only connections
 * authenticated as that user, in that channel. An identity match, not a permission: no grant,
 * however wide, lets another user's socket receive it, and a message in one that names nobody
 * reaches nobody. Any user of the channel may SUBSCRIBE to one, since each message is then judged
 * by who it names.
 *
 * - `inbox` — `inbox.changed` (Notifications): this person's tasks, messages or notifications
 *   changed. It names what changed and nothing of its content; the client re-reads through the API.
 */
const PERSONAL: ReadonlySet<string> = new Set(['inbox']);

/** The recipient a personal message names — read from the ENVELOPE's payload, never its top level. */
function recipientOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const payload = (body as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const recipient = (payload as { recipientUserId?: unknown }).recipientUserId;
  return typeof recipient === 'string' && recipient !== '' ? recipient : undefined;
}

/** The channel an envelope says it belongs to, when it says. */
function envelopeChannel(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const channelId = (body as { channelId?: unknown }).channelId;
  return typeof channelId === 'string' ? channelId : undefined;
}

function readRuleFor(domain: string): { permission: string; fieldGroup?: string } {
  return DOMAIN_READ[domain] ?? { permission: `${domain}:read` };
}

export interface ParsedSubject {
  channelId: string;
  domain: string;
  rest: string[];
}

/** Private streams are `user.<userId>.<...>` and belong to exactly one subject. */
const PRIVATE_PREFIX = 'user.';

export function parseSubject(subject: string): ParsedSubject | undefined {
  const parts = subject.split('.');
  if (parts.length < 4 || !ROOTS.has(parts[0] ?? '')) return undefined;
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
 * 3. **A personal domain is an identity match** (EP-25.7): the message reaches the user its
 *    envelope names, and nobody else — whatever their grants. It needs the message's BODY, so a
 *    caller that cannot pass one gets a refusal for a personal subject, never a delivery.
 * 4. **The domain's read permission**, evaluated with the shared `can()` — the same function the
 *    owning service uses to enforce, so the socket cannot disagree with the API.
 */
export function mayReceive(sub: Subscriber, subject: string, body?: unknown): EligibilityDecision {
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

  if (CHANNEL_WIDE.has([parsed.domain, ...parsed.rest].join('.'))) return { allowed: true };

  if (PERSONAL.has(parsed.domain)) {
    // The envelope's own channel too, not only the subject's: a personal frame is the one kind a
    // grant does not filter, so it gets both tenant checks (EP-30.2's note on #456).
    const channel = envelopeChannel(body);
    if (channel !== undefined && channel !== sub.channelId)
      return { allowed: false, reason: 'message belongs to another channel' };
    const recipient = recipientOf(body);
    if (recipient === undefined)
      return { allowed: false, reason: 'a personal message names no recipient' };
    return recipient === sub.userId
      ? { allowed: true }
      : { allowed: false, reason: 'personal message for another user' };
  }

  const { permission, fieldGroup } = readRuleFor(parsed.domain);
  // STRICT: the full context is known here, so an unsatisfiable predicate must not pass
  // (authorization-model.md §5.1 — lenient mode would widen the grant).
  const decision = can(
    sub.policy,
    permission,
    { channelId: parsed.channelId, ...(fieldGroup !== undefined ? { fieldGroup } : {}) },
    { strict: true },
  );

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
  if (!ROOTS.has(parts[0] ?? '') || parts.length < 3) {
    return { allowed: false, reason: `unrecognised subscription pattern "${pattern}"` };
  }

  const channelToken = parts[1] ?? '';
  if (WILDCARD.has(channelToken)) {
    return { allowed: false, reason: 'a subscription may not wildcard the channel' };
  }
  if (channelToken !== sub.channelId) {
    return { allowed: false, reason: 'subject belongs to another channel' };
  }

  // A channel-wide subject, named exactly: anyone in the tenant may subscribe to it.
  if (CHANNEL_WIDE.has(parts.slice(2).join('.'))) return { allowed: true };

  const domainToken = parts[2] ?? '';
  // A personal domain (EP-25.7): anyone in the tenant may subscribe; each message reaches only the
  // user it names.
  if (PERSONAL.has(domainToken)) return { allowed: true };
  if (WILDCARD.has(domainToken)) {
    // Legitimate ("everything I may see in my tenant"); each message is still filtered.
    return { allowed: true };
  }

  const { permission, fieldGroup } = readRuleFor(domainToken);
  const decision = can(
    sub.policy,
    permission,
    { channelId: channelToken, ...(fieldGroup !== undefined ? { fieldGroup } : {}) },
    { strict: true },
  );
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason: decision.reason ?? `missing ${permission}` };
}
