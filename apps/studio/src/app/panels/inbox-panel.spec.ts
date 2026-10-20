import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Inbox,
  InboxTask,
  Message,
  MessageRecipient,
  MessagePage,
  Notification,
  Preferences,
} from '../core/generated/notifications.types.ts';
import { InboxService } from '../core/inbox.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { InboxPanel, parseRecipients } from './inbox-panel.ts';

const task = (overrides: Partial<InboxTask> = {}): InboxTask => ({
  id: '01K0000000000000000000TASK',
  channelId: 'ch12',
  assignee: 'u1',
  assigneeKind: 'user',
  kind: 'review',
  state: 'open',
  createdAt: '2026-10-20T09:00:00.000Z',
  version: 1,
  participants: ['u1'],
  ...overrides,
});

const notification = (overrides: Partial<Notification> = {}): Notification => ({
  id: '01K0000000000000000000NOTE',
  channelId: 'ch12',
  userId: 'u1',
  type: 'asset.approved',
  severity: 'info',
  title: 'An asset you created was approved',
  titles: { en: 'An asset you created was approved', ar: 'تمت الموافقة' },
  subjectRef: { entityType: 'asset', entityId: '01K00000000000000000000AST' },
  read: false,
  createdAt: '2026-10-20T09:00:00.000Z',
  ...overrides,
});

class FakeInbox {
  readonly inboxes: Subject<Inbox>[] = [];
  readonly claims: Array<{ id: string; result: Subject<InboxTask> }> = [];
  readonly completes: Array<{ id: string; outcome?: string; result: Subject<InboxTask> }> = [];
  readonly reads: Array<{ id: string; read: boolean; result: Subject<void> }> = [];
  readonly messageLists: Subject<MessagePage>[] = [];
  readonly sends: Array<{ to: MessageRecipient[]; body: string; result: Subject<Message> }> = [];
  readonly prefLoads: Subject<Preferences>[] = [];
  readonly saves: Array<{
    version: number;
    types: Record<string, boolean>;
    result: Subject<Preferences>;
  }> = [];

  inbox() {
    const s = new Subject<Inbox>();
    this.inboxes.push(s);
    return s;
  }
  claim(id: string) {
    const result = new Subject<InboxTask>();
    this.claims.push({ id, result });
    return result;
  }
  complete(id: string, outcome?: string) {
    const result = new Subject<InboxTask>();
    this.completes.push({ id, ...(outcome !== undefined ? { outcome } : {}), result });
    return result;
  }
  markRead(id: string, read: boolean) {
    const result = new Subject<void>();
    this.reads.push({ id, read, result });
    return result;
  }
  messages() {
    const s = new Subject<MessagePage>();
    this.messageLists.push(s);
    return s;
  }
  send(to: MessageRecipient[], body: string) {
    const result = new Subject<Message>();
    this.sends.push({ to, body, result });
    return result;
  }
  preferences() {
    const s = new Subject<Preferences>();
    this.prefLoads.push(s);
    return s;
  }
  savePreferences(version: number, types: Record<string, boolean>) {
    const result = new Subject<Preferences>();
    this.saves.push({ version, types, result });
    return result;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
  setLocale(_locale: 'en' | 'ar'): Promise<void> {
    return Promise.resolve();
  }
}

interface Internal {
  show(view: string): void;
  claim(t: InboxTask): void;
  complete(t: InboxTask, outcome: string): void;
  openNotification(n: Notification): void;
  unread: () => number;
  error: () => string | null;
  to: { set(v: string): void };
  body: { set(v: string): void };
  send(event: Event): void;
  messages: () => Message[];
  toggle(key: string, on: boolean): void;
  savePreferences(): void;
}

function setup() {
  localStorage.clear();
  const fake = new FakeInbox();
  const ws = { resync$: new Subject<string>() };
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: InboxService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
      { provide: WebSocketService, useValue: ws },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    // No permission at all: the inbox is everyone's own.
    policy: { subjectId: 'u1', permVersion: 1, rules: [] },
  });
  const fixture = TestBed.createComponent(InboxPanel);
  fixture.detectChanges();
  const deliver = (inbox: Partial<Inbox>) => {
    fake.inboxes.at(-1)?.next({
      tasks: [],
      notifications: [],
      unreadCount: 0,
      partial: false,
      ...inbox,
    });
    fixture.detectChanges();
  };
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    ws,
    deliver,
    editors: TestBed.inject(EditorStore),
  };
}

const conflict = () => new HttpErrorResponse({ status: 409, error: { detail: 'taken' } });

describe('InboxPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads the inbox on opening and again when the socket resyncs', () => {
    const t = setup();
    expect(t.fake.inboxes.length).toBe(1);
    t.ws.resync$.next('reconnected');
    expect(t.fake.inboxes.length).toBe(2);
  });

  it('a task offered to a role is claimed first — and someone else’s claim is said so', () => {
    const t = setup();
    const offered = task({ assigneeKind: 'role', assignee: 'editor' });
    t.deliver({ tasks: [offered] });
    const buttons = [...t.root.querySelectorAll('.task button')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['inboxPanel.claim']);
    t.component.claim(offered);
    expect(t.fake.claims[0]?.id).toBe(offered.id);
    t.fake.claims[0]?.result.error(conflict());
    expect(t.component.error()).toBe('inboxPanel.claimTaken');
  });

  it('a task the caller holds is completed with an outcome; an approval offers approve and reject', () => {
    const t = setup();
    const approve = task({ kind: 'approve' });
    t.deliver({ tasks: [approve] });
    const buttons = [...t.root.querySelectorAll('.task button')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['inboxPanel.outcome.approved', 'inboxPanel.outcome.rejected']);
    t.component.complete(approve, 'rejected');
    expect(t.fake.completes[0]).toMatchObject({ id: approve.id, outcome: 'rejected' });
    t.fake.completes[0]?.result.next({ ...approve, state: 'done' });
    // Read again after the action.
    expect(t.fake.inboxes.length).toBe(2);
  });

  it('a review task is never completed here: it points at MAM and opens the asset', () => {
    const t = setup();
    const review = task({
      kind: 'approve',
      reviewPointId: 'pre-schedule',
      subjectRef: { entityType: 'asset', entityId: '01K00000000000000000000AST' },
    });
    t.deliver({ tasks: [review] });
    const buttons = [...t.root.querySelectorAll('.task button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['inboxPanel.openAsset']);
    expect(t.root.textContent).toContain('pre-schedule');
    (buttons[0] as HTMLButtonElement).click();
    expect(t.editors.activeTab()).toMatchObject({
      type: 'asset',
      resourceId: '01K00000000000000000000AST',
    });
  });

  it('opening an unread notification marks it read and opens its asset', () => {
    const t = setup();
    const n = notification();
    t.deliver({ notifications: [n], unreadCount: 1 });
    t.component.show('notifications');
    t.fixture.detectChanges();
    expect(t.root.querySelector('.views .badge')?.textContent?.trim()).toBe('1');
    t.component.openNotification(n);
    expect(t.fake.reads[0]).toMatchObject({ id: n.id, read: true });
    t.fake.reads[0]?.result.next();
    expect(t.component.unread()).toBe(0);
    expect(t.editors.activeTab()?.resourceId).toBe('01K00000000000000000000AST');
  });

  it('messages: listed when the view opens, sent to users and #groups', () => {
    const t = setup();
    t.component.show('messages');
    expect(t.fake.messageLists.length).toBe(1);
    t.component.to.set('u2, #g-desk');
    t.component.body.set('Rundown at 6');
    t.component.send(new Event('submit'));
    expect(t.fake.sends[0]).toMatchObject({
      to: [
        { kind: 'user', id: 'u2' },
        { kind: 'group', id: 'g-desk' },
      ],
      body: 'Rundown at 6',
    });
    t.fake.sends[0]?.result.next({
      id: '01K000000000000000000000MS',
      channelId: 'ch12',
      from: 'u1',
      to: [{ kind: 'user', id: 'u2' }],
      body: 'Rundown at 6',
      sentAt: '2026-10-20T09:00:00.000Z',
    });
    expect(t.component.messages().length).toBe(1);
  });

  it('preferences: a mandatory type cannot be switched; a save sends the whole set over the version read', () => {
    const t = setup();
    t.component.show('preferences');
    t.fake.prefLoads[0]?.next({
      version: 3,
      items: [
        { key: 'asset.approved', on: true, defaultOn: true, mandatory: false, chosen: false },
        { key: 'transcode.failed', on: false, defaultOn: true, mandatory: false, chosen: true },
        { key: 'asset.re-review-due', on: true, defaultOn: true, mandatory: true, chosen: false },
      ],
    });
    t.fixture.detectChanges();
    const boxes = [...t.root.querySelectorAll<HTMLInputElement>('.pref input')];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, false],
      [true, true],
    ]);
    t.component.toggle('asset.approved', false);
    t.component.savePreferences();
    expect(t.fake.saves[0]).toMatchObject({
      version: 3,
      types: { 'transcode.failed': false, 'asset.approved': false },
    });
    // Saved elsewhere meanwhile: read again, never retried.
    t.fake.saves[0]?.result.error(conflict());
    expect(t.component.error()).toBe('inboxPanel.preferencesMoved');
    expect(t.fake.prefLoads.length).toBe(2);
  });

  it('parses recipients — a bare id is a user, # a group — and nothing usable as none', () => {
    expect(parseRecipients('u1  #desk,u2')).toEqual([
      { kind: 'user', id: 'u1' },
      { kind: 'group', id: 'desk' },
      { kind: 'user', id: 'u2' },
    ]);
    expect(parseRecipients('  ')).toBeNull();
    expect(parseRecipients('#')).toBeNull();
  });
});
