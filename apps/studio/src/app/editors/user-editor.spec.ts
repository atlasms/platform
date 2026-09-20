// The user editor (EP-20.7): each write is its own request against IAM, the name is the one
// dirty field, disabling yourself is refused before IAM refuses it, and a granted rule is a
// well-formed policy rule scoped to the user's channel.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Assignment,
  AssignmentInput,
  Role,
  UpdateUser,
  User,
} from '../core/generated/iam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { ULID_RE } from '../core/ulid.ts';
import { UsersService } from '../core/users.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { parsePermissions, UserEditor } from './user-editor.ts';

const UID = '01H0000000000000000000000A';
const user = (over: Partial<User> = {}): User => ({
  id: UID,
  channelId: 'ch12',
  username: 'ops',
  name: 'Ops Desk',
  state: 'active',
  permVersion: 1,
  version: 1,
  createdAt: '2026-09-21T00:00:00.000Z',
  ...over,
});

class FakeUsers {
  readonly gets: Subject<User>[] = [];
  readonly assignmentLists: Subject<Assignment[]>[] = [];
  readonly roleLists: Subject<Role[]>[] = [];
  readonly updates: { id: string; patch: UpdateUser; result: Subject<User> }[] = [];
  readonly grants: { id: string; input: AssignmentInput; result: Subject<Assignment> }[] = [];
  readonly revokes: { id: string; assignmentId: string; result: Subject<void> }[] = [];
  get() {
    const s = new Subject<User>();
    this.gets.push(s);
    return s;
  }
  assignments() {
    const s = new Subject<Assignment[]>();
    this.assignmentLists.push(s);
    return s;
  }
  roles() {
    const s = new Subject<Role[]>();
    this.roleLists.push(s);
    return s;
  }
  update(id: string, patch: UpdateUser) {
    const result = new Subject<User>();
    this.updates.push({ id, patch, result });
    return result;
  }
  grant(id: string, input: AssignmentInput) {
    const result = new Subject<Assignment>();
    this.grants.push({ id, input, result });
    return result;
  }
  revoke(id: string, assignmentId: string) {
    const result = new Subject<void>();
    this.revokes.push({ id, assignmentId, result });
    return result;
  }
}

interface Internal {
  user: () => User | null;
  assignments: () => Assignment[];
  dirty: () => boolean;
  busy: () => boolean;
  error: () => string | null;
  isSelf: () => boolean;
  grantableRoles: () => Role[];
  password: string;
  roleId: string;
  permissions: string;
  setName(value: string): void;
  saveName(): void;
  setState(state: 'active' | 'disabled'): void;
  setPassword(): void;
  grantRole(): void;
  grantRule(): void;
  revoke(a: Assignment): void;
}

function setup(sessionUserId = 'u-admin') {
  localStorage.clear();
  const fake = new FakeUsers();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: UsersService, useValue: fake },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: sessionUserId,
    channelId: 'ch12',
    policy: {
      subjectId: sessionUserId,
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['user:admin'] }],
    },
  });
  const editors = TestBed.inject(EditorStore);
  editors.open({ type: 'user', resourceId: UID, title: 'ops' });
  const fixture = TestBed.createComponent(UserEditor);
  fixture.componentRef.setInput('userId', UID);
  fixture.componentRef.setInput('tabId', `user:${UID}`);
  fixture.detectChanges();
  fake.gets[0]?.next(user());
  fake.assignmentLists[0]?.next([
    { id: 'a-role', userId: UID, roleId: 'editor' },
    {
      id: 'a-rule',
      userId: UID,
      rule: {
        id: '01H0000000000000000000000R',
        permissions: ['asset:read'],
        scope: { channelIds: ['ch12'] },
      },
    },
  ]);
  fake.roleLists[0]?.next([
    { id: 'editor', name: 'Editor', rules: [], version: 1 },
    { id: 'viewer', name: 'Viewer', rules: [], version: 1 },
  ]);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    editors,
    root: fixture.nativeElement as HTMLElement,
  };
}

describe('UserEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the user, the grants by name, and only the roles not yet held as grantable', () => {
    const t = setup();
    expect(t.root.textContent).toContain('ops');
    expect(t.root.textContent).toContain('Editor');
    expect(t.root.textContent).toContain('asset:read @ ch12');
    expect(t.component.grantableRoles().map((r) => r.id)).toEqual(['viewer']);
  });

  it('the name is the one dirty field: marked on the tab, saved as its own PATCH, clean after', () => {
    const t = setup();
    t.component.setName('Ops Desk');
    expect(t.component.dirty()).toBe(false);
    t.component.setName('Operations');
    expect(t.component.dirty()).toBe(true);
    expect(t.editors.activeTab()?.dirty).toBe(true);
    t.component.saveName();
    expect(t.fake.updates[0]).toMatchObject({ id: UID, patch: { name: 'Operations' } });
    t.fake.updates[0]?.result.next(user({ name: 'Operations', version: 2 }));
    expect(t.component.dirty()).toBe(false);
    expect(t.editors.activeTab()?.dirty).toBe(false);
    expect(t.component.user()?.version).toBe(2);
  });

  it('disable and a new password are their own PATCHes', () => {
    const t = setup();
    t.component.setState('disabled');
    expect(t.fake.updates[0]?.patch).toEqual({ state: 'disabled' });
    t.fake.updates[0]?.result.next(user({ state: 'disabled' }));
    expect(t.component.user()?.state).toBe('disabled');

    t.component.password = 'short';
    t.component.setPassword();
    expect(t.fake.updates).toHaveLength(1);
    t.component.password = 'long-enough-1';
    t.component.setPassword();
    expect(t.fake.updates[1]?.patch).toEqual({ password: 'long-enough-1' });
    t.fake.updates[1]?.result.next(user({ state: 'disabled' }));
    expect(t.component.password).toBe('');
  });

  it('disabling yourself is refused here, before IAM refuses it', () => {
    const self = setup(UID);
    expect(self.component.isSelf()).toBe(true);
    self.component.setState('disabled');
    expect(self.fake.updates).toHaveLength(0);
  });

  it('grants a role or a rule — a rule with a ULID, allow, and the user’s channel as scope — and revokes', () => {
    const t = setup();
    t.component.roleId = 'viewer';
    t.component.grantRole();
    expect(t.fake.grants[0]).toMatchObject({ id: UID, input: { roleId: 'viewer' } });
    t.fake.grants[0]?.result.next({ id: 'a-viewer', userId: UID, roleId: 'viewer' });
    expect(t.component.assignments().map((a) => a.id)).toEqual(['a-role', 'a-rule', 'a-viewer']);
    expect(t.component.grantableRoles()).toEqual([]);

    t.component.permissions = 'schedule:read, schedule:write bad:: ';
    t.component.grantRule();
    const rule = t.fake.grants[1]?.input.rule;
    expect(rule?.id).toMatch(ULID_RE);
    expect(rule?.effect).toBe('allow');
    expect(rule?.permissions).toEqual(['schedule:read', 'schedule:write']);
    expect(rule?.scope).toEqual({ channelIds: ['ch12'] });
    t.fake.grants[1]?.result.error({
      error: { message: 'a rule for channel ch12 needs user:admin there' },
    });
    expect(t.component.error()).toBe('a rule for channel ch12 needs user:admin there');
    expect(t.component.busy()).toBe(false);

    t.component.revoke({ id: 'a-role', userId: UID, roleId: 'editor' });
    expect(t.fake.revokes[0]).toMatchObject({ id: UID, assignmentId: 'a-role' });
    t.fake.revokes[0]?.result.next();
    expect(t.component.assignments().map((a) => a.id)).toEqual(['a-rule', 'a-viewer']);
  });
});

describe('parsePermissions', () => {
  it('splits on commas and spaces, keeps noun:verb only, de-duplicates', () => {
    expect(
      parsePermissions(' asset:read,schedule:write  asset:read\nbad, :x, y:, Asset:Read '),
    ).toEqual(['asset:read', 'schedule:write']);
    expect(parsePermissions('')).toEqual([]);
  });
});
