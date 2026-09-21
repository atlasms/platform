// The Admin panel's Users view (EP-20.7): the keyset list and its "more", a user opening as a
// tab, and a new user created — with a taken username said in words.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateUser, User, UserPage } from '../../core/generated/iam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { UsersService } from '../../core/users.service.ts';
import { EditorStore } from '../../workbench/editor.store.ts';
import { UsersView } from './users-view.ts';

const user = (over: Partial<User> = {}): User => ({
  id: '01H0000000000000000000000A',
  channelId: 'ch12',
  username: 'ops',
  state: 'active',
  permVersion: 1,
  version: 1,
  createdAt: '2026-09-21T00:00:00.000Z',
  ...over,
});

class FakeUsers {
  readonly lists: { options: Record<string, unknown>; result: Subject<UserPage> }[] = [];
  readonly creates: { body: CreateUser; result: Subject<User> }[] = [];
  list(options: Record<string, unknown>) {
    const result = new Subject<UserPage>();
    this.lists.push({ options, result });
    return result;
  }
  create(body: CreateUser) {
    const result = new Subject<User>();
    this.creates.push({ body, result });
    return result;
  }
}

interface Internal {
  users: () => User[];
  error: () => string | null;
  createError: () => string | null;
  username: string;
  password: string;
  create(): void;
  load(after?: string): void;
}

function setup() {
  localStorage.clear();
  const fake = new FakeUsers();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: UsersService, useValue: fake },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  const fixture = TestBed.createComponent(UsersView);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    editors: TestBed.inject(EditorStore),
    root: fixture.nativeElement as HTMLElement,
  };
}

describe('UsersView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the users as IAM pages them, appends the next page after the last id, and opens one as a tab', () => {
    const t = setup();
    expect(t.fake.lists[0]?.options).toEqual({ limit: 50 });
    t.fake.lists[0]?.result.next({
      items: [user(), user({ id: '01H0000000000000000000000B', username: 'anchor' })],
      nextCursor: '01H0000000000000000000000B',
    });
    t.fixture.detectChanges();
    expect(t.component.users().map((u) => u.username)).toEqual(['ops', 'anchor']);

    t.component.load('01H0000000000000000000000B');
    expect(t.fake.lists[1]?.options).toEqual({ limit: 50, after: '01H0000000000000000000000B' });
    t.fake.lists[1]?.result.next({
      items: [user({ id: '01H0000000000000000000000C', username: 'third' })],
    });
    t.fixture.detectChanges();
    expect(t.component.users().map((u) => u.username)).toEqual(['ops', 'anchor', 'third']);
    expect(t.root.textContent).not.toContain('admin.more');

    (t.root.querySelector('.items button') as HTMLButtonElement).click();
    expect(t.editors.activeTab()?.type).toBe('user');
    expect(t.editors.activeTab()?.resourceId).toBe('01H0000000000000000000000A');
    expect(t.editors.activeTab()?.title).toBe('ops');
  });

  it('creates a user, leads the list with it, opens it — and says when the username is taken', () => {
    const t = setup();
    t.fake.lists[0]?.result.next({ items: [] });
    t.component.username = ' newbie ';
    t.component.password = 'secret-pass-1';
    t.component.create();
    expect(t.fake.creates[0]?.body).toEqual({ username: 'newbie', password: 'secret-pass-1' });
    t.fake.creates[0]?.result.next(user({ id: '01H0000000000000000000000N', username: 'newbie' }));
    t.fixture.detectChanges();
    expect(t.component.users().map((u) => u.username)).toEqual(['newbie']);
    expect(t.editors.activeTab()?.resourceId).toBe('01H0000000000000000000000N');
    expect(t.component.username).toBe('');

    t.component.username = 'newbie';
    t.component.create();
    t.fake.creates[1]?.result.error({ status: 409, error: { message: 'username taken' } });
    t.fixture.detectChanges();
    expect(t.component.createError()).toBe('admin.usernameTaken');
    expect(t.component.users()).toHaveLength(1);
  });

  it('a failed list reports rather than staying on "loading"', () => {
    const t = setup();
    t.fake.lists[0]?.result.error(new Error('403'));
    t.fixture.detectChanges();
    expect(t.component.error()).toBe('admin.loadError');
  });
});
