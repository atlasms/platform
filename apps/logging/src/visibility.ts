// Which log entries a caller may see (EP-19.3; FR-LOG-2: "some logs visible to some users, all
// retained").
//
// The rule is the websocket service's rule, on purpose: an event under `atlas.<ch>.<domain>.…`
// requires `<domain>:read` in that channel. What you may receive live and what you may read back
// from the log are the same question, and answering it two ways would let one of them drift wider.
//
// `audit.recorded` is the exception, and it is the same exception the history endpoint makes: its
// payload is an entity's before/after, so it takes the ENTITY's read permission — an asset's delta
// needs `asset:read`, not `audit:read` (which no role grants; that is what keeps it off sockets).
//
// IAM's domains are the other: `user`, `group`, `role` and `permissions` events (EP-10.6) take
// `user:admin`. The authorization model defines no `user:read` — administering identities is one
// permission — and the identity trail is exactly what an administrator reads the log for. The
// websocket service keeps `<domain>:read` for them, which nobody holds: the trail is read here,
// not streamed to browsers, and that asymmetry is deliberate.

import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import type { AuditEvent } from './store.ts';

/** What reading an entity type's entries takes: a permission, and sometimes a field group. */
export interface ReadRule {
  permission: string;
  fieldGroup?: string;
}

/** The rule an entry requires, beyond `logs:read`. */
export function requiredRule(event: AuditEvent): ReadRule {
  if (event.type === 'audit.recorded') {
    const entityType = (event.payload as { entityType?: unknown } | null)?.entityType;
    return entityRule(typeof entityType === 'string' ? entityType : 'audit');
  }
  return entityRule(event.type.split('.')[0] ?? event.type);
}

/** The permission an entry requires, beyond `logs:read` — {@link requiredRule} without its group. */
export function requiredPermission(event: AuditEvent): string {
  return requiredRule(event).permission;
}

/**
 * The read permission of an entity type — for its history and for its entries in the browse, one
 * answer. `<type>:read` by default; the exceptions are the domains whose administration is one
 * permission with no `:read` beside it: identities (`user:admin`), and the audit log's own
 * governance (`compliance:admin` — a retention policy's history is read by whoever may set it).
 */
export function entityPermission(entityType: string): string {
  return entityRule(entityType).permission;
}

/**
 * The full read rule of an entity type.
 *
 * The file set's entities — MTS's jobs and events (`transcode`, `transcode-job`) and MAM's file
 * rows (`file`) — read under `asset:read` on the `files` group, the grant MTS enforces for its
 * jobs and MAM for `GET /assets/{id}/files`, and the one the websocket service applies to the
 * same subjects. Under the `<type>:read` default they were readable by nobody: no role holds a
 * `transcode:read` or a `file:read`, and the catalogue defines neither.
 *
 * A transcode PROFILE's history is read by whoever may write the registry (`config:admin`), the
 * retention policy's rule: a Tier-1 entry's audience is its administrators.
 */
export function entityRule(entityType: string): ReadRule {
  if (IAM_DOMAINS.has(entityType)) return { permission: 'user:admin' };
  if (GOVERNANCE.has(entityType)) return { permission: 'compliance:admin' };
  if (CONFIG_REGISTRIES.has(entityType)) return { permission: 'config:admin' };
  if (FILE_SET.has(entityType)) return { permission: 'asset:read', fieldGroup: 'files' };
  return { permission: `${entityType}:read` };
}

const IAM_DOMAINS: ReadonlySet<string> = new Set(['user', 'group', 'role', 'permissions']);
const GOVERNANCE: ReadonlySet<string> = new Set(['retention-policy']);
const CONFIG_REGISTRIES: ReadonlySet<string> = new Set(['transcode-profile']);
const FILE_SET: ReadonlySet<string> = new Set(['transcode', 'transcode-job', 'file']);

/**
 * STRICT evaluation with the full context. The channel is known and the permission is derived
 * from the entry itself, so a predicate the caller's rules declare but this request cannot satisfy
 * is a refusal — lenient mode would widen the grant (authorization-model.md §5.1).
 */
export function visible(policy: EffectivePolicy, channelId: string, event: AuditEvent): boolean {
  const { permission, fieldGroup } = requiredRule(event);
  return canEnforce(policy, permission, {
    channelId,
    ...(fieldGroup !== undefined ? { fieldGroup } : {}),
  }).allowed;
}
