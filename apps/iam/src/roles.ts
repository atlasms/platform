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
    // EP-28.5: reading the people register is part of reading the catalogue — a cast entry is a
    // person's name.
    rules: [r('viewer-read', ['asset:read', 'schedule:read', 'taxonomy:read', 'people:read'])],
  },
  {
    id: 'editor',
    name: 'Journalist / Editor',
    rules: [
      r('editor-read', ['asset:read', 'schedule:read', 'taxonomy:read', 'people:read']),
      {
        ...r('editor-write', ['asset:write']),
        fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
      },
      // EP-25.2 (decided 2026-10-16): an editor hands work to a person, a group or a role.
      r('editor-flow', ['workflow:act', 'task:assign']),
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
      // EP-28.5: the people register is kept by whoever keeps the taxonomy.
      r('lib-restore', ['asset:restore', 'taxonomy:admin', 'people:read', 'people:admin']),
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
      // EVERY permission (decided by the product owner 2026-10-15): `*:*` — every action on every
      // resource, today's and any a later catalogue adds. Like every starter role it ships
      // unscoped for an operator to narrow; the assignment's scope (a channel) still bounds it, and
      // tenant isolation is never a permission.
      r('admin', ['*:*']),
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
