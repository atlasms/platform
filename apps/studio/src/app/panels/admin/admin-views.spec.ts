// The Admin panel's view switch, and its Groups and Roles views: each lists what IAM gives,
// creates, and opens an item as the right kind of editor tab.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Group, GroupInput, Role, RoleInput } from '../../core/generated/iam.types.ts';
import { GroupsService } from '../../core/groups.service.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { ProfilesService } from '../../core/profiles.service.ts';
import { RolesService } from '../../core/roles.service.ts';
import { SessionStore } from '../../core/session.store.ts';
import { UsersService } from '../../core/users.service.ts';
import { EditorStore } from '../../workbench/editor.store.ts';
import { AdminPanel } from '../admin-panel.ts';
import { GroupsView } from './groups-view.ts';
import { RolesView } from './roles-view.ts';

class FakeGroups {
  readonly lists: Subject<Group[]>[] = [];
  readonly creates: { body: GroupInput; result: Subject<Group> }[] = [];
  list() {
    const s = new Subject<Group[]>();
    this.lists.push(s);
    return s;
  }
  create(body: GroupInput) {
    const result = new Subject<Group>();
    this.creates.push({ body, result });
    return result;
  }
}

class FakeRoles {
  readonly lists: Subject<Role[]>[] = [];
  readonly creates: { body: RoleInput; result: Subject<Role> }[] = [];
  list() {
    const s = new Subject<Role[]>();
    this.lists.push(s);
    return s;
  }
  create(body: RoleInput) {
    const result = new Subject<Role>();
    this.creates.push({ body, result });
    return result;
  }
}

class FakeUsers {
  list() {
    return new Subject();
  }
}

function providers() {
  return [
    EditorStore,
    { provide: GroupsService, useValue: new FakeGroups() },
    { provide: RolesService, useValue: new FakeRoles() },
    { provide: UsersService, useValue: new FakeUsers() },
    { provide: ProfilesService, useValue: { list: () => new Subject() } },
    { provide: LocaleService, useValue: { t: (k: string) => k } },
  ];
}

function signIn(permissions: string[], scope?: { channelIds: string[] }) {
  TestBed.inject(SessionStore).signIn({
    userId: 'admin',
    channelId: 'ch12',
    policy: {
      subjectId: 'admin',
      permVersion: 1,
      rules: [{ id: 'r', permissions, ...(scope ? { scope } : {}) }],
    },
  });
}

const tabNames = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('[role=tab]')).map((t) => t.textContent?.trim());

describe('AdminPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('switches between the views; Users is the first', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: providers() });
    signIn(['user:admin']);
    const fixture = TestBed.createComponent(AdminPanel);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tabs = Array.from(root.querySelectorAll('[role=tab]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      'admin.users',
      'admin.groups',
      'admin.roles',
    ]);
    expect(root.querySelector('atlas-users-view')).not.toBeNull();
    (tabs[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('atlas-users-view')).toBeNull();
    expect(root.querySelector('atlas-groups-view')).not.toBeNull();
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    (tabs[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('atlas-roles-view')).not.toBeNull();
  });

  it('shows each view by its own permission: config alone shows Transcode profiles, and opens on it', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: providers() });
    signIn(['config:read'], { channelIds: ['ch12'] });
    const fixture = TestBed.createComponent(AdminPanel);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    // No user:admin: the people views are not offered, and the panel lands on what IS.
    expect(tabNames(root)).toEqual(['admin.profiles']);
    expect(root.querySelector('atlas-profiles-view')).not.toBeNull();
    expect(root.querySelector('atlas-users-view')).toBeNull();
  });

  it('shows all four to someone holding both, and drops a view when its grant goes mid-session', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: providers() });
    signIn(['user:admin', 'config:admin']);
    const fixture = TestBed.createComponent(AdminPanel);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(tabNames(root)).toEqual([
      'admin.users',
      'admin.groups',
      'admin.roles',
      'admin.profiles',
    ]);
    (root.querySelectorAll('[role=tab]')[3] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('atlas-profiles-view')).not.toBeNull();

    // A policy that no longer carries config:*: the chosen view is gone, the first one shows.
    signIn(['user:admin']);
    fixture.detectChanges();
    expect(tabNames(root)).toEqual(['admin.users', 'admin.groups', 'admin.roles']);
    expect(root.querySelector('atlas-users-view')).not.toBeNull();
  });
});

describe('GroupsView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the groups, marks the platform-wide ones, creates one and opens it as a group tab', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: providers() });
    const fake = TestBed.inject(GroupsService) as unknown as FakeGroups;
    const editors = TestBed.inject(EditorStore);
    const fixture = TestBed.createComponent(GroupsView);
    fixture.detectChanges();
    fake.lists[0]?.next([
      { id: '01H0000000000000000000000A', channelId: 'ch12', name: 'Newsroom', version: 1 },
      { id: '01H0000000000000000000000B', name: 'Everyone', version: 1 },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const items = Array.from(root.querySelectorAll('.items button'));
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ''))).toEqual([
      'Newsroom',
      'Everyoneadmin.platformWide',
    ]);

    const component = fixture.componentInstance as unknown as {
      name: string;
      description: string;
      create(): void;
    };
    component.name = ' Sport ';
    component.description = 'the desk';
    component.create();
    expect(fake.creates[0]?.body).toEqual({ name: 'Sport', description: 'the desk' });
    fake.creates[0]?.result.next({
      id: '01H0000000000000000000000C',
      channelId: 'ch12',
      name: 'Sport',
      version: 1,
    });
    fixture.detectChanges();
    expect(editors.activeTab()?.type).toBe('group');
    expect(editors.activeTab()?.resourceId).toBe('01H0000000000000000000000C');
    expect(root.querySelectorAll('.items button')).toHaveLength(3);
  });
});

describe('RolesView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the roles with their rule counts, refuses a bad id, creates with a kebab id, opens a role tab', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: providers() });
    const fake = TestBed.inject(RolesService) as unknown as FakeRoles;
    const editors = TestBed.inject(EditorStore);
    const fixture = TestBed.createComponent(RolesView);
    fixture.detectChanges();
    fake.lists[0]?.next([
      {
        id: 'editor',
        channelId: 'ch12',
        name: 'Editor',
        rules: [{ id: 'r', permissions: ['asset:write'] }],
        version: 1,
      },
      { id: 'viewer', name: 'Viewer', rules: [], version: 1 },
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('1 admin.rulesCount');
    expect(root.textContent).toContain('admin.platformWide');

    const component = fixture.componentInstance as unknown as {
      id: string;
      name: string;
      idOk(): boolean;
      create(): void;
    };
    component.id = 'Bad Id';
    component.name = 'Bad';
    expect(component.idOk()).toBe(false);
    component.create();
    expect(fake.creates).toHaveLength(0);

    component.id = 'news-editor';
    component.name = 'News editor';
    component.create();
    expect(fake.creates[0]?.body).toEqual({ id: 'news-editor', name: 'News editor', rules: [] });
    fake.creates[0]?.result.next({
      id: 'news-editor',
      channelId: 'ch12',
      name: 'News editor',
      rules: [],
      version: 1,
    });
    fixture.detectChanges();
    expect(editors.activeTab()?.type).toBe('role');
    expect(editors.activeTab()?.resourceId).toBe('news-editor');

    component.id = 'taken';
    component.name = 'Taken';
    component.create();
    fake.creates[1]?.result.error({ status: 409, error: { message: 'role taken' } });
    fixture.detectChanges();
    expect(root.textContent).toContain('admin.roleIdTaken');
  });
});
