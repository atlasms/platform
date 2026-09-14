// EP-10.7 — the starter roles from authorization-model.md §9.
// Operators clone and adjust these; they are a starting point, not a fixed set.

import type { Role, Rule } from '@atlas/policy';
import type { IamStore } from './store.ts';

const r = (id: string, permissions: string[]): Rule => ({ id, permissions });

/**
 * Ship these as defaults ([FR-IAM-1](../../../docs/requirements/05-functional-requirements.md#iam)).
 *
 * Note what is deliberately NOT bundled: `schedule:send` is its own role, not part of Scheduler.
 * Putting media to air is the most consequential action in the platform and deserves a separate,
 * audited grant rather than arriving as a side effect of being able to edit a schedule.
 */
export const STARTER_ROLES: Role[] = [
  {
    id: 'viewer',
    name: 'Viewer',
    rules: [r('viewer-read', ['asset:read', 'schedule:read', 'taxonomy:read'])],
  },
  {
    id: 'editor',
    name: 'Journalist / Editor',
    rules: [
      r('editor-read', ['asset:read', 'schedule:read', 'taxonomy:read']),
      {
        ...r('editor-write', ['asset:write']),
        fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
      },
      r('editor-flow', ['workflow:act']),
    ],
  },
  {
    id: 'approver',
    name: 'Approver',
    rules: [r('approver-approve', ['asset:approve'])],
  },
  {
    id: 'scheduler',
    name: 'Scheduler',
    rules: [
      r('scheduler-read', ['asset:read', 'schedule:read', 'taxonomy:read']),
      r('scheduler-write', ['schedule:write']),
    ],
  },
  {
    id: 'send-to-air',
    name: 'Send to air',
    rules: [r('sta', ['schedule:send'])],
  },
  {
    id: 'librarian',
    name: 'Librarian',
    rules: [
      { ...r('lib-write', ['asset:write']), fieldGroups: ['files', 'rights'] },
      r('lib-restore', ['asset:restore', 'taxonomy:admin']),
    ],
  },
  {
    id: 'ops',
    name: 'Ops',
    rules: [r('ops', ['ops:read', 'logs:read', 'storage:admin'])],
  },
  {
    id: 'administrator',
    name: 'Administrator',
    rules: [
      r('admin', [
        'user:admin',
        'metadata:admin',
        'workflow:admin',
        'feed:admin',
        'compliance:admin',
        'config:admin',
      ]),
    ],
  },
];

/** Idempotent: re-seeding an existing deployment must not duplicate or overwrite edits. */
/**
 * Register the starter roles that are not there yet. Idempotent — it runs on every start, and a
 * store that persists (EP-10.4) already has them after the first — and it never overwrites: an
 * operator who narrowed `editor` keeps their version.
 */
export async function seedStarterRoles(store: IamStore): Promise<number> {
  const present = new Set((await store.roles()).map((r) => r.id));
  const missing = STARTER_ROLES.filter((r) => !present.has(r.id));
  if (missing.length === 0) return 0;
  await store.transaction(async (tx) => {
    for (const role of missing) await tx.putRole({ ...role, version: 1 });
  });
  return missing.length;
}
