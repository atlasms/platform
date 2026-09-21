// The group and role editor tabs: each write is its own request against IAM; the profile is the
// dirty pair; grants and members change through PATCHes and member calls; a platform-wide role
// is shown and not offered for editing; deleting closes the tab, and a held role says why not.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Group,
  GroupInput,
  GroupWithMembers,
  Role,
  RoleInput,
  UserPage,
} from '../core/generated/iam.types.ts';
import { GroupsService } from '../core/groups.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RolesService } from '../core/roles.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { ULID_RE } from '../core/ulid.ts';
import { UsersService } from '../core/users.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { GroupEditor } from './group-editor.ts';
import { RoleEditor } from './role-editor.ts';

const GID = '01H0000000000000000000000G';

class FakeGroups {
  readonly gets: Subject<GroupWithMembers>[] = [];
  readonly updates: { id: string; patch: GroupInput; result: Subject<Group> }[] = [];
  readonly adds: { id: string; userId: string; result: Subject<void> }[] = [];
  readonly removes: { id: string; userId: string; result: Subject<void> }[] = [];
  readonly deletes: { id: string; result: Subject<void> }[] = [];
  get() {
    const s = new Subject<GroupWithMembers>();
    this.gets.push(s);
    return s;
  }
  update(id: string, patch: GroupInput) {
    const result = new Subject<Group>();
    this.updates.push({ id, patch, result });
    return result;
  }
  addMember(id: string, userId: string) {
    const result = new Subject<void>();
    this.adds.push({ id, userId, result });
    return result;
  }
  removeMember(id: string, userId: string) {
    const result = new Subject<void>();
    this.removes.push({ id, userId, result });
    return result;
  }
  delete(id: string) {
    const result = new Subject<void>();
    this.deletes.push({ id, result });
    return result;
  }
}

class FakeRoles {
  readonly lists: Subject<Role[]>[] = [];
  readonly gets: Subject<Role>[] = [];
  readonly updates: { id: string; patch: RoleInput; result: Subject<Role> }[] = [];
  readonly deletes: { id: string; result: Subject<void> }[] = [];
  list() {
    const s = new Subject<Role[]>();
    this.lists.push(s);
    return s;
  }
  get() {
    const s = new Subject<Role>();
    this.gets.push(s);
    return s;
  }
  update(id: string, patch: RoleInput) {
    const result = new Subject<Role>();
    this.updates.push({ id, patch, result });
    return result;
  }
  delete(id: string) {
    const result = new Subject<void>();
    this.deletes.push({ id, result });
    return result;
  }
}

class FakeUsers {
  readonly lists: Subject<UserPage>[] = [];
  list() {
    const s = new Subject<UserPage>();
    this.lists.push(s);
    return s;
  }
}

function configure() {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: GroupsService, useValue: new FakeGroups() },
      { provide: RolesService, useValue: new FakeRoles() },
      { provide: UsersService, useValue: new FakeUsers() },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'admin',
    channelId: 'ch12',
    policy: {
      subjectId: 'admin',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['user:admin'] }],
    },
  });
  return {
    groups: TestBed.inject(GroupsService) as unknown as FakeGroups,
    roles: TestBed.inject(RolesService) as unknown as FakeRoles,
    users: TestBed.inject(UsersService) as unknown as FakeUsers,
    editors: TestBed.inject(EditorStore),
  };
}

const group = (over: Partial<GroupWithMembers> = {}): GroupWithMembers => ({
  id: GID,
  channelId: 'ch12',
  name: 'Newsroom',
  members: ['01H0000000000000000000000U'],
  roleIds: ['editor'],
  rules: [],
  version: 1,
  ...over,
});

interface GroupInternal {
  dirty: () => boolean;
  members: () => string[];
  roleIds: () => string[];
  error: () => string | null;
  memberId: string;
  roleId: string;
  permissions: string;
  setName(v: string): void;
  saveProfile(): void;
  addMember(): void;
  removeMember(id: string): void;
  addRole(): void;
  removeRole(id: string): void;
  addRule(): void;
  remove(): void;
}

describe('GroupEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function open() {
    const t = configure();
    t.editors.open({ type: 'group', resourceId: GID, title: 'Newsroom' });
    const fixture = TestBed.createComponent(GroupEditor);
    fixture.componentRef.setInput('groupId', GID);
    fixture.componentRef.setInput('tabId', `group:${GID}`);
    fixture.detectChanges();
    t.groups.gets[0]?.next(group());
    t.roles.lists[0]?.next([
      { id: 'editor', name: 'Editor', rules: [], version: 1 },
      { id: 'viewer', name: 'Viewer', rules: [], version: 1 },
    ]);
    t.users.lists[0]?.next({
      items: [
        {
          id: '01H0000000000000000000000U',
          username: 'ops',
          state: 'active',
          permVersion: 1,
          version: 1,
          createdAt: '',
        },
        {
          id: '01H0000000000000000000000V',
          username: 'newbie',
          state: 'active',
          permVersion: 1,
          version: 1,
          createdAt: '',
        },
      ],
    });
    fixture.detectChanges();
    return {
      ...t,
      fixture,
      component: fixture.componentInstance as unknown as GroupInternal,
      root: fixture.nativeElement as HTMLElement,
    };
  }

  it('shows members by username and roles by name; the profile is the dirty pair, saved as one PATCH', () => {
    const t = open();
    expect(t.root.textContent).toContain('ops');
    expect(t.root.textContent).toContain('Editor');
    t.component.setName('News desk');
    expect(t.component.dirty()).toBe(true);
    expect(t.editors.activeTab()?.dirty).toBe(true);
    t.component.saveProfile();
    expect(t.groups.updates[0]).toMatchObject({
      id: GID,
      patch: { name: 'News desk', description: '' },
    });
    t.groups.updates[0]?.result.next({ ...group({ name: 'News desk', version: 2 }) });
    expect(t.component.dirty()).toBe(false);
    // a PATCH answer carries no members; ours are kept
    expect(t.component.members()).toEqual(['01H0000000000000000000000U']);
  });

  it('members come and go by their own calls; only users not yet members are offered', () => {
    const t = open();
    expect(t.root.querySelectorAll('select[name=member] option')).toHaveLength(2); // — and newbie
    t.component.memberId = '01H0000000000000000000000V';
    t.component.addMember();
    expect(t.groups.adds[0]).toMatchObject({ id: GID, userId: '01H0000000000000000000000V' });
    t.groups.adds[0]?.result.next();
    expect(t.component.members()).toEqual([
      '01H0000000000000000000000U',
      '01H0000000000000000000000V',
    ]);
    t.component.removeMember('01H0000000000000000000000U');
    t.groups.removes[0]?.result.next();
    expect(t.component.members()).toEqual(['01H0000000000000000000000V']);
  });

  it('grants are PATCHes of the whole set: a role added or revoked, a rule with a ULID scoped to the channel', () => {
    const t = open();
    t.component.roleId = 'viewer';
    t.component.addRole();
    expect(t.groups.updates[0]?.patch).toEqual({ roleIds: ['editor', 'viewer'] });
    t.groups.updates[0]?.result.next(group({ roleIds: ['editor', 'viewer'], version: 2 }));
    expect(t.component.roleIds()).toEqual(['editor', 'viewer']);
    t.component.removeRole('editor');
    expect(t.groups.updates[1]?.patch).toEqual({ roleIds: ['viewer'] });
    t.groups.updates[1]?.result.next(group({ roleIds: ['viewer'], version: 3 }));

    t.component.permissions = 'schedule:read';
    t.component.addRule();
    const rule = t.groups.updates[2]?.patch.rules?.[0];
    expect(rule?.id).toMatch(ULID_RE);
    expect(rule?.effect).toBe('allow');
    expect(rule?.permissions).toEqual(['schedule:read']);
    expect(rule?.scope).toEqual({ channelIds: ['ch12'] });
    t.groups.updates[2]?.result.error({ error: { message: 'no' } });
    expect(t.component.error()).toBe('no');
  });

  it('deleting the group closes its tab', () => {
    const t = open();
    expect(t.editors.activeTab()?.id).toBe(`group:${GID}`);
    t.component.remove();
    expect(t.groups.deletes[0]?.id).toBe(GID);
    t.groups.deletes[0]?.result.next();
    expect(t.editors.activeTab()?.id).not.toBe(`group:${GID}`);
  });
});

interface RoleInternal {
  readOnly: () => boolean;
  dirty: () => boolean;
  error: () => string | null;
  permissions: string;
  setName(v: string): void;
  saveProfile(): void;
  addRule(): void;
  removeRule(id: string): void;
  remove(): void;
}

describe('RoleEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function open(role: Role) {
    const t = configure();
    t.editors.open({ type: 'role', resourceId: role.id, title: role.name ?? role.id });
    const fixture = TestBed.createComponent(RoleEditor);
    fixture.componentRef.setInput('roleId', role.id);
    fixture.componentRef.setInput('tabId', `role:${role.id}`);
    fixture.detectChanges();
    t.roles.gets[0]?.next(role);
    fixture.detectChanges();
    return {
      ...t,
      fixture,
      component: fixture.componentInstance as unknown as RoleInternal,
      root: fixture.nativeElement as HTMLElement,
    };
  }

  const editor: Role = {
    id: 'editor',
    channelId: 'ch12',
    name: 'Editor',
    rules: [
      {
        id: '01H0000000000000000000000R',
        permissions: ['asset:write'],
        scope: { channelIds: ['ch12'] },
      },
    ],
    version: 1,
  };

  it('a channel role: profile saved as a PATCH, a rule added and removed as PATCHes of the whole list', () => {
    const t = open(editor);
    expect(t.component.readOnly()).toBe(false);
    expect(t.root.textContent).toContain('asset:write @ ch12');
    t.component.setName('Senior editor');
    t.component.saveProfile();
    expect(t.roles.updates[0]?.patch).toEqual({ name: 'Senior editor', description: '' });
    t.roles.updates[0]?.result.next({ ...editor, name: 'Senior editor', version: 2 });
    expect(t.component.dirty()).toBe(false);

    t.component.permissions = 'schedule:write, schedule:read';
    t.component.addRule();
    const rules = t.roles.updates[1]?.patch.rules ?? [];
    expect(rules).toHaveLength(2);
    expect(rules[1]?.permissions).toEqual(['schedule:write', 'schedule:read']);
    expect(rules[1]?.id).toMatch(ULID_RE);
    t.roles.updates[1]?.result.next({ ...editor, rules, version: 3 });
    t.component.removeRule('01H0000000000000000000000R');
    expect(t.roles.updates[2]?.patch.rules?.map((r) => r.permissions)).toEqual([
      ['schedule:write', 'schedule:read'],
    ]);
  });

  it('a platform-wide role is shown, not offered for editing', () => {
    const t = open({ id: 'viewer', name: 'Viewer', rules: [], version: 1 });
    expect(t.component.readOnly()).toBe(true);
    expect(t.root.textContent).toContain('admin.platformWideRole');
    expect(t.root.querySelector('form')).toBeNull();
    expect(t.root.querySelector('.danger')).toBeNull();
  });

  it('deleting: a held role says so (409) and the tab stays; a free one closes the tab', () => {
    const t = open(editor);
    t.component.remove();
    t.roles.deletes[0]?.result.error({ status: 409, error: { message: 'held' } });
    expect(t.component.error()).toBe('admin.roleHeld');
    expect(t.editors.activeTab()?.id).toBe('role:editor');
    t.component.remove();
    t.roles.deletes[1]?.result.next();
    expect(t.editors.activeTab()?.id).not.toBe('role:editor');
  });
});
