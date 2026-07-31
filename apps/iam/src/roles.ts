// EP-10.7 — the starter roles from authorization-model.md §9.
// Operators clone and adjust these; they are a starting point, not a fixed set.

import type { Role, Rule } from '@atlas/policy';

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
export function seedStarterRoles(roles: Map<string, Role>): number {
  let added = 0;
  for (const role of STARTER_ROLES) {
    if (!roles.has(role.id)) {
      roles.set(role.id, role);
      added++;
    }
  }
  return added;
}
