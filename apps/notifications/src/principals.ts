// Who a caller is as an ADDRESSEE (EP-25.3): their groups and roles, asked of IAM when an inbox is
// read — a task offered to a group or a role reaches whoever is in it NOW (decided 2026-10-16).
//
// Over a signed internal call (ADR-0008): `GET /internal/v1/users/{id}/principals`, signed with
// the first of `iam-read-keys`, a READ key that opens that route and nothing else in IAM — a leaked
// Notifications key learns who holds which role, and changes nothing.
//
// Cached per user for a short TTL, and FORGOTTEN on `permissions.changed` / `group.membership.changed`
// for that user (every replica hears them — a broadcast subscription), so a grant or a membership
// reaches the inbox at once, and the TTL only bounds what a broker outage delays. Concurrent reads of
// one user share one request.

import { signInternal, INTERNAL_SIGNATURE_HEADER } from '@atlas/service-kit';
import type { PrincipalKind } from './inbox.ts';

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

export interface PrincipalSource {
  /** The user's groups and roles — NOT the user themself. Throws when IAM cannot say. */
  principalsOf(userId: string): Promise<Principal[]>;
  /** Drop what is cached for a user — their grants or memberships changed. */
  forget(userId: string): void;
}

export interface IamPrincipalsOptions {
  origin: string;
  /** The first of `iam-read-keys`. */
  key: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function iamPrincipals(options: IamPrincipalsOptions): PrincipalSource {
  const doFetch = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { principals: Principal[]; at: number }>();
  const inFlight = new Map<string, Promise<Principal[]>>();
  // Bumped by forget(): an answer that left IAM before the change is not cached after it.
  const generation = new Map<string, number>();

  const fetchFor = async (userId: string): Promise<Principal[]> => {
    const path = `/internal/v1/users/${encodeURIComponent(userId)}/principals`;
    const res = await doFetch(new URL(path, options.origin), {
      headers: {
        [INTERNAL_SIGNATURE_HEADER]: signInternal(options.key, { method: 'GET', path, body: '' }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Unknown or disabled: addressed as nobody beyond their own name.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`IAM principals: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { groups?: unknown; roles?: unknown };
    const ids = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return [
      ...ids(body.groups).map((id) => ({ kind: 'group' as const, id })),
      ...ids(body.roles).map((id) => ({ kind: 'role' as const, id })),
    ];
  };

  return {
    async principalsOf(userId) {
      const hit = cache.get(userId);
      if (hit && now() - hit.at < ttlMs) return hit.principals;
      const pending = inFlight.get(userId);
      if (pending) return pending;
      const asked = generation.get(userId) ?? 0;
      const request = fetchFor(userId)
        .then((principals) => {
          if ((generation.get(userId) ?? 0) === asked) cache.set(userId, { principals, at: now() });
          return principals;
        })
        .finally(() => inFlight.delete(userId));
      inFlight.set(userId, request);
      return request;
    },
    forget(userId) {
      cache.delete(userId);
      inFlight.delete(userId);
      generation.set(userId, (generation.get(userId) ?? 0) + 1);
    },
  };
}

/** For the suites: a fixed table, and a switch that makes IAM "away". */
export function fakePrincipals(table: Record<string, Principal[]> = {}): PrincipalSource & {
  table: Record<string, Principal[]>;
  down: boolean;
  forgotten: string[];
} {
  const fake = {
    table,
    down: false,
    forgotten: [] as string[],
    async principalsOf(userId: string): Promise<Principal[]> {
      if (fake.down) throw new Error('IAM is away');
      return fake.table[userId] ?? [];
    },
    forget(userId: string): void {
      fake.forgotten.push(userId);
    },
  };
  return fake;
}
