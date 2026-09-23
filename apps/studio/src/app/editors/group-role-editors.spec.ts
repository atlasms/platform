// The group and role editor tabs: each write is its own request against IAM; the profile is the
// dirty pair; grants and members change through PATCHes and member calls; a platform-wide role
// is shown and not offered for editing; deleting closes the tab, and a held role says why not.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Assignment,
  AssignmentInput,
  Group,
  GroupInput,
  GroupWithMembers,
  Role,
  RoleHolders,
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
  readonly lists: Subject<Group[]>[] = [];
  readonly gets: Subject<GroupWithMembers>[] = [];
  list() {
    const s = new Subject<Group[]>();
    this.lists.push(s);
    return s;
  }
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
  readonly holderReads: Subject<RoleHolders>[] = [];
  readonly updates: { id: string; patch: RoleInput; result: Subject<Role> }[] = [];
  readonly deletes: { id: string; result: Subject<void> }[] = [];
  holders() {
    const s = new Subject<RoleHolders>();
    this.holderReads.push(s);
    return s;
  }
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
  readonly grants: { id: string; input: AssignmentInput; result: Subject<Assignment> }[] = [];
  readonly revocations: { id: string; assignmentId: string; result: Subject<void> }[] = [];
  list() {
    const s = new Subject<UserPage>();
    this.lists.push(s);
    return s;
  }
  grant(id: string, input: AssignmentInput) {
    const result = new Subject<Assignment>();
    this.grants.push({ id, input, result });
    return result;
  }
  revoke(id: string, assignmentId: string) {
    const result = new Subject<void>();
    this.revocations.push({ id, assignmentId, result });
    return result;
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
  holdersError: () => string | null;
  grantableUsers: () => { id: string; username: string }[];
  grantableGroups: () => { id: string; name: string }[];
  permissions: string;
  holderRef: string;
  grant(): void;
  revokeUser(userId: string, assignmentId: string): void;
  revokeGroup(groupId: string): void;
  setName(v: string): void;
  saveProfile(): void;
  addRule(): void;
  removeRule(id: string): void;
  remove(): void;
}

describe('RoleEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const HOLDERS: RoleHolders = {
    users: [
      // Sorted by username, each person once, carrying every path the role reaches them by.
      {
        id: '01H0000000000000000000000A',
        username: 'ana',
        viaGroupIds: ['01H000000000000000000000G1'],
      },
      {
        id: '01H0000000000000000000000B',
        username: 'bo',
        assignmentId: 'asg-bo',
        viaGroupIds: ['01H000000000000000000000G1'],
      },
      {
        id: '01H0000000000000000000000Z',
        username: 'zoe',
        assignmentId: 'asg-zoe',
        viaGroupIds: [],
      },
    ],
    groups: [{ id: '01H000000000000000000000G1', name: 'Desk' }],
  };

  function open(role: Role, holders: RoleHolders | 'refuse' = HOLDERS) {
    const t = configure();
    t.editors.open({ type: 'role', resourceId: role.id, title: role.name ?? role.id });
    const fixture = TestBed.createComponent(RoleEditor);
    fixture.componentRef.setInput('roleId', role.id);
    fixture.componentRef.setInput('tabId', `role:${role.id}`);
    fixture.detectChanges();
    t.roles.gets[0]?.next(role);
    if (holders === 'refuse') t.roles.holderReads[0]?.error({ status: 404 });
    else t.roles.holderReads[0]?.next(holders);
    t.groups.lists[0]?.next([
      {
        id: '01H000000000000000000000G1',
        channelId: 'ch12',
        name: 'Desk',
        roleIds: [role.id],
        version: 1,
      },
      {
        id: '01H000000000000000000000G2',
        channelId: 'ch12',
        name: 'Sport',
        roleIds: [],
        version: 1,
      },
    ]);
    t.users.lists[0]?.next({
      items: [
        {
          id: '01H0000000000000000000000A',
          username: 'ana',
          state: 'active',
          permVersion: 1,
          version: 1,
          createdAt: '',
        },
        {
          id: '01H0000000000000000000000Z',
          username: 'zoe',
          state: 'active',
          permVersion: 1,
          version: 1,
          createdAt: '',
        },
        {
          id: '01H0000000000000000000000N',
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

  it('holders: every path shown once per person, and what can be revoked from here', () => {
    const t = open(editor);
    const rows = Array.from(t.root.querySelectorAll('.grants li')).map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    // The rule row, then the group that carries the role, then each person it reaches.
    expect(rows).toEqual([
      'admin.ruleasset:write @ ch12 admin.remove',
      'admin.groupDesk admin.remove',
      'admin.userana — admin.viaGroup Desk',
      'admin.userbo — admin.viaGroup Desk admin.remove',
      'admin.userzoe admin.remove',
    ]);

    // Only a DIRECT grant is revocable here: ana holds it through the group, so the group row is
    // where that ends, and her row offers nothing to click.
    t.component.revokeUser('01H0000000000000000000000B', 'asg-bo');
    expect(t.users.revocations[0]).toMatchObject({
      id: '01H0000000000000000000000B',
      assignmentId: 'asg-bo',
    });
    t.users.revocations[0]?.result.next();
    // The answer is IAM's join, so it is re-read rather than patched in the browser.
    expect(t.roles.holderReads).toHaveLength(2);
  });

  it('granting: one select for two kinds of holder; a group is a PATCH of its roles, a user a grant', () => {
    const t = open(editor);
    // Offered: the groups that do not already carry it, and the users without a DIRECT grant —
    // ana is offered although the group already reaches her, because a direct grant outlives the
    // group membership.
    expect(t.component.grantableGroups().map((g) => g.name)).toEqual(['Sport']);
    expect(t.component.grantableUsers().map((u) => u.username)).toEqual(['ana', 'newbie']);

    t.component.holderRef = 'user:01H0000000000000000000000N';
    t.component.grant();
    expect(t.users.grants[0]).toMatchObject({
      id: '01H0000000000000000000000N',
      input: { roleId: 'editor' },
    });
    t.users.grants[0]?.result.next({ id: 'asg-new', userId: '01H0000000000000000000000N' });
    expect(t.component.holderRef).toBe('');

    t.component.holderRef = 'group:01H000000000000000000000G2';
    t.component.grant();
    expect(t.groups.updates[0]).toMatchObject({
      id: '01H000000000000000000000G2',
      patch: { roleIds: ['editor'] },
    });

    // Revoking a group is the same PATCH with the role taken out.
    t.groups.updates[0]?.result.next({
      id: '01H000000000000000000000G2',
      name: 'Sport',
      version: 2,
    });
    t.component.revokeGroup('01H000000000000000000000G1');
    expect(t.groups.updates[1]?.patch).toEqual({ roleIds: [] });
  });

  it('a platform-wide role: IAM refuses its holders, and the page says why rather than erroring', () => {
    const t = open({ id: 'viewer', name: 'Viewer', rules: [], version: 1 }, 'refuse');
    expect(t.component.holdersError()).toBe('admin.holdersPlatformWide');
    expect(t.root.textContent).toContain('admin.holdersPlatformWide');
    expect(t.root.textContent).not.toContain('admin.loadError');
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
