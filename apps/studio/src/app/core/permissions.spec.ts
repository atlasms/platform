import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PermissionService } from './permission.service.ts';
import { SessionStore } from './session.store.ts';

function signedIn(rules: { id: string; permissions: string[]; scope?: unknown }[]): {
  session: SessionStore;
  permissions: PermissionService;
} {
  TestBed.resetTestingModule();
  const session = TestBed.inject(SessionStore);
  const permissions = TestBed.inject(PermissionService);
  session.signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: rules as never },
  });
  return { session, permissions };
}

describe('PermissionService', () => {
  it('denies everything without a session', () => {
    TestBed.resetTestingModule();
    const permissions = TestBed.inject(PermissionService);
    const decision = permissions.decide('asset:read');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no session');
  });

  it('allows a granted permission and refuses an ungranted one', () => {
    const { permissions } = signedIn([
      { id: 'r1', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } },
    ]);
    expect(permissions.can('asset:read')).toBe(true);
    expect(permissions.can('asset:write')).toBe(false);
  });

  it('flattens group-derived grants through compile()', () => {
    TestBed.resetTestingModule();
    const session = TestBed.inject(SessionStore);
    const permissions = TestBed.inject(PermissionService);
    session.signIn({
      userId: 'u1',
      channelId: 'ch12',
      policy: {
        subjectId: 'u1',
        permVersion: 1,
        rules: [],
        groups: [{ id: 'g', rules: [{ id: 'gr', permissions: ['asset:approve'] }] }],
      },
    });
    // A grant reached only through a group must survive: dropping it looks exactly like
    // "the user has no permission", which is the hardest kind of bug to notice.
    expect(permissions.can('asset:approve')).toBe(true);
  });

  it('SECURITY: scopes every check to the signed-in channel', () => {
    // The rule is scoped to ch12. Under lenient evaluation an omitted channelId means "any
    // channel", so without defaulting it the control would light up for tenants the user cannot
    // reach. The service supplies the session's channel so the question is asked correctly.
    const { permissions } = signedIn([
      { id: 'r1', permissions: ['asset:read'], scope: { channelIds: ['ch99'] } },
    ]);
    expect(permissions.can('asset:read')).toBe(false);
  });

  it('an explicit resource channel overrides the session default', () => {
    const { permissions } = signedIn([
      { id: 'r1', permissions: ['asset:read'], scope: { channelIds: ['ch99'] } },
    ]);
    expect(permissions.can('asset:read', { channelId: 'ch99' })).toBe(true);
  });

  it('lenient by default: a broad question is answered broadly', () => {
    // "Could this user edit ANY asset?" — the right question for showing a nav item, and it must
    // not be narrowed by the absence of a category that has not been loaded yet.
    const { permissions } = signedIn([
      {
        id: 'r1',
        permissions: ['asset:write'],
        scope: { channelIds: ['ch12'], categoryPaths: ['/sports/'] },
      },
    ]);
    expect(permissions.can('asset:write')).toBe(true);
  });

  it('strict mode refuses the same check when the context is incomplete', () => {
    const { permissions } = signedIn([
      {
        id: 'r1',
        permissions: ['asset:delete'],
        scope: { channelIds: ['ch12'], categoryPaths: ['/sports/'] },
      },
    ]);
    // Same grant, same user — only the strictness differs. This is the distinction that makes
    // lenient-for-UI safe: it is a deliberate choice, not an accident of the default.
    expect(permissions.can('asset:delete')).toBe(true);
    expect(permissions.canStrict('asset:delete', {})).toBe(false);
    expect(permissions.canStrict('asset:delete', { categoryPath: '/sports/football/' })).toBe(true);
    expect(permissions.canStrict('asset:delete', { categoryPath: '/news/' })).toBe(false);
  });

  it('signing out revokes everything immediately', () => {
    const { session, permissions } = signedIn([
      { id: 'r1', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } },
    ]);
    expect(permissions.can('asset:read')).toBe(true);
    session.signOut();
    expect(permissions.can('asset:read')).toBe(false);
    expect(session.isAuthenticated()).toBe(false);
  });
});
