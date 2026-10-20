import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval, merge } from 'rxjs';
import type {
  InboxTask,
  Message,
  MessageRecipient,
  Notification,
  Preferences,
} from '../core/generated/notifications.types.ts';
import { InboxService } from '../core/inbox.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

type InboxView = 'tasks' | 'notifications' | 'messages' | 'preferences';

/** How often the panel re-reads while it is open — live delivery is EP-25.7's (held). */
export const INBOX_REFRESH_MS = 30_000;

/**
 * The Inbox panel (EP-25.9; notifications.md §13a–§13f): the caller's OWN tasks, notifications,
 * messages and notification preferences — every signed-in user has one, so no permission reveals
 * it. Every action is the caller's request to Notifications, which authorizes it; the panel only
 * offers what the task's shape allows:
 *
 * - a task offered to a group or a role is CLAIMED first (first claim wins — a 409 is "someone
 *   took it"); one the caller holds is completed with an outcome;
 * - a REVIEW task (a `reviewPointId`) is never completed here — its verdict is given in MAM at that
 *   point, and closes it — so the panel opens the asset instead;
 * - a notification is marked read when opened; one about an asset opens it;
 * - a mandatory notification type's switch cannot be turned off.
 *
 * Live delivery to a person is EP-25.7 (held for a security review), so the panel re-reads every
 * {@link INBOX_REFRESH_MS} while open and whenever the socket resyncs.
 */
@Component({
  selector: 'atlas-inbox-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="panel-title">{{ locale.t('workbench.panels.inbox') }}</h2>
    <nav class="views" role="tablist" [attr.aria-label]="locale.t('workbench.panels.inbox')">
      @for (v of views; track v) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="view() === v"
          [class.active]="view() === v"
          (click)="show(v)"
        >
          {{ locale.t('inboxPanel.view.' + v) }}
          @if (v === 'notifications' && unread() > 0) {
            <span class="badge" [attr.aria-label]="locale.t('inboxPanel.unread')">{{
              unread()
            }}</span>
          }
          @if (v === 'tasks' && tasks().length > 0) {
            <span class="badge">{{ tasks().length }}</span>
          }
        </button>
      }
    </nav>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (partial()) {
      <p class="muted">{{ locale.t('inboxPanel.partial') }}</p>
    }

    @switch (view()) {
      @case ('tasks') {
        @if (tasks().length === 0) {
          <p class="muted">{{ locale.t('inboxPanel.noTasks') }}</p>
        }
        <ul class="items">
          @for (task of tasks(); track task.id) {
            <li class="task">
              <span class="title">{{
                task.title ?? locale.t('inboxPanel.kind.' + task.kind)
              }}</span>
              <span class="meta">
                @if (task.assigneeKind !== 'user') {
                  {{ locale.t('inboxPanel.offeredTo.' + task.assigneeKind) }} {{ task.assignee }}
                }
                @if (task.dueAt) {
                  · {{ locale.t('inboxPanel.due') }} {{ task.dueAt.slice(0, 16).replace('T', ' ') }}
                }
              </span>
              <span class="actions">
                @if (task.assigneeKind !== 'user') {
                  <button type="button" [disabled]="busy()" (click)="claim(task)">
                    {{ locale.t('inboxPanel.claim') }}
                  </button>
                } @else if (task.reviewPointId) {
                  <span class="muted">
                    {{ locale.t('inboxPanel.reviewInMam') }} “{{ task.reviewPointId }}”
                  </span>
                  @if (task.subjectRef?.entityType === 'asset') {
                    <button type="button" (click)="openSubject(task.subjectRef!.entityId)">
                      {{ locale.t('inboxPanel.openAsset') }}
                    </button>
                  }
                } @else {
                  @for (outcome of outcomesOf(task); track outcome) {
                    <button type="button" [disabled]="busy()" (click)="complete(task, outcome)">
                      {{ locale.t('inboxPanel.outcome.' + outcome) }}
                    </button>
                  }
                }
              </span>
            </li>
          }
        </ul>
      }
      @case ('notifications') {
        @if (notifications().length === 0) {
          <p class="muted">{{ locale.t('inboxPanel.noNotifications') }}</p>
        }
        <ul class="items">
          @for (n of notifications(); track n.id) {
            <li [class.unread]="!n.read">
              <button type="button" class="row" (click)="openNotification(n)">
                <span class="severity" [attr.data-severity]="n.severity">●</span>
                <span class="title">{{ titleOf(n) }}</span>
                <span class="meta">{{ n.createdAt.slice(0, 16).replace('T', ' ') }}</span>
              </button>
            </li>
          }
        </ul>
      }
      @case ('messages') {
        <form class="compose" (submit)="send($event)">
          <label>
            <span>{{ locale.t('inboxPanel.to') }}</span>
            <input
              type="text"
              [placeholder]="locale.t('inboxPanel.toHint')"
              [value]="to()"
              (input)="to.set($any($event.target).value)"
            />
          </label>
          <label>
            <span class="visually-hidden">{{ locale.t('inboxPanel.message') }}</span>
            <textarea
              rows="3"
              maxlength="4000"
              [placeholder]="locale.t('inboxPanel.message')"
              [value]="body()"
              (input)="body.set($any($event.target).value)"
            ></textarea>
          </label>
          <button type="submit" [disabled]="busy() || !canSend()">
            {{ locale.t('inboxPanel.send') }}
          </button>
        </form>
        @if (messages().length === 0) {
          <p class="muted">{{ locale.t('inboxPanel.noMessages') }}</p>
        }
        <ul class="items">
          @for (m of messages(); track m.id) {
            <li class="message">
              <span class="meta">
                {{ m.from === me() ? locale.t('inboxPanel.you') : m.from }} →
                {{ recipientsOf(m) }} · {{ m.sentAt.slice(0, 16).replace('T', ' ') }}
              </span>
              <span class="body">{{ m.body }}</span>
            </li>
          }
        </ul>
      }
      @case ('preferences') {
        @if (preferences(); as prefs) {
          <ul class="items">
            @for (p of prefs.items; track p.key) {
              <li class="pref">
                <label>
                  <input
                    type="checkbox"
                    [checked]="isOn(p.key, p.on)"
                    [disabled]="p.mandatory || busy()"
                    (change)="toggle(p.key, $any($event.target).checked)"
                  />
                  {{ locale.t('inboxPanel.type.' + p.key) }}
                  @if (p.mandatory) {
                    <span class="muted">({{ locale.t('inboxPanel.mandatory') }})</span>
                  }
                </label>
              </li>
            }
          </ul>
          <button type="button" [disabled]="busy() || !dirty()" (click)="savePreferences()">
            {{ locale.t('inboxPanel.save') }}
          </button>
        }
      }
    }
  `,
  styles: `
    .panel-title {
      margin: 0 0 var(--space-2);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .views {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin-block-end: var(--space-2);
      border-block-end: 1px solid var(--color-border);
    }
    .views button {
      padding: var(--space-1) var(--space-2);
      color: var(--color-fg-muted);
      background: none;
      border: none;
      border-block-end: 2px solid transparent;
      cursor: pointer;
      font: inherit;
      font-size: 0.8125rem;
    }
    .views button.active {
      color: var(--color-fg);
      border-block-end-color: var(--color-accent);
    }
    .views button:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
    .badge {
      margin-inline-start: var(--space-1);
      padding: 0 var(--space-1);
      font-size: 0.6875rem;
      color: var(--color-accent);
      background: var(--color-accent-bg);
      border-radius: var(--radius-md);
    }
    .items {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .items li {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-1) 0;
      border-block-end: 1px solid var(--color-border);
      font-size: 0.8125rem;
    }
    .items li.unread .title {
      font-weight: 600;
    }
    .row {
      display: flex;
      align-items: baseline;
      gap: var(--space-1);
      inline-size: 100%;
      padding: 0;
      color: inherit;
      text-align: start;
      background: none;
      border: none;
      cursor: pointer;
      font: inherit;
    }
    .row .title {
      flex: 1;
    }
    .severity[data-severity='warning'] {
      color: var(--color-warning);
    }
    .severity[data-severity='critical'] {
      color: var(--color-danger);
    }
    .severity[data-severity='info'] {
      color: var(--color-fg-muted);
    }
    .meta,
    .muted {
      color: var(--color-fg-muted);
      font-size: 0.75rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
    }
    .compose {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin-block-end: var(--space-2);
    }
    .compose input,
    .compose textarea {
      inline-size: 100%;
      padding: var(--space-1) var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
    }
    .body {
      white-space: pre-wrap;
    }
    .error {
      color: var(--color-danger);
    }
    .visually-hidden {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class InboxPanel implements OnInit {
  private readonly api = inject(InboxService);
  private readonly editors = inject(EditorStore);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly locale = inject(LocaleService);

  protected readonly views: readonly InboxView[] = [
    'tasks',
    'notifications',
    'messages',
    'preferences',
  ];
  protected readonly view = signal<InboxView>('tasks');
  protected readonly tasks = signal<InboxTask[]>([]);
  protected readonly notifications = signal<Notification[]>([]);
  protected readonly unread = signal(0);
  protected readonly partial = signal(false);
  protected readonly messages = signal<Message[]>([]);
  protected readonly preferences = signal<Preferences | null>(null);
  /** The caller's unsaved switches, by type key. */
  protected readonly chosen = signal<Record<string, boolean>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly to = signal('');
  protected readonly body = signal('');
  protected readonly me = computed(() => this.session.userId() ?? '');
  protected readonly canSend = computed(
    () => this.body().trim() !== '' && parseRecipients(this.to()) !== null,
  );
  protected readonly dirty = computed(() => Object.keys(this.chosen()).length > 0);

  ngOnInit(): void {
    this.refresh();
    // No live delivery to a person yet (EP-25.7): read again on a timer, and when the socket
    // says the client may have missed something.
    merge(interval(INBOX_REFRESH_MS), this.ws.resync$)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden')
          this.refresh();
      });
  }

  protected show(view: InboxView): void {
    this.view.set(view);
    this.error.set(null);
    if (view === 'messages') this.loadMessages();
    if (view === 'preferences') this.loadPreferences();
  }

  /** The inbox, and whatever the open view also shows. */
  protected refresh(): void {
    this.api.inbox().subscribe({
      next: (inbox) => {
        this.tasks.set(inbox.tasks);
        this.notifications.set(inbox.notifications);
        this.unread.set(inbox.unreadCount);
        this.partial.set(inbox.partial);
      },
      error: () => this.error.set(this.locale.t('inboxPanel.loadError')),
    });
    if (this.view() === 'messages') this.loadMessages();
  }

  protected outcomesOf(task: InboxTask): readonly string[] {
    return task.kind === 'approve' ? ['approved', 'rejected'] : ['done'];
  }

  protected claim(task: InboxTask): void {
    this.act(this.api.claim(task.id), 'inboxPanel.claimTaken');
  }

  protected complete(task: InboxTask, outcome: string): void {
    this.act(this.api.complete(task.id, outcome), 'inboxPanel.completeRefused');
  }

  protected openSubject(assetId: string): void {
    this.editors.open({ type: 'asset', resourceId: assetId, title: assetId, icon: '▤' });
  }

  protected titleOf(n: Notification): string {
    const locale = this.locale.locale() as 'en' | 'ar';
    return n.titles?.[locale] ?? n.title ?? this.locale.t('inboxPanel.type.' + n.type);
  }

  protected openNotification(n: Notification): void {
    if (!n.read) {
      this.api.markRead(n.id, true).subscribe({
        next: () => {
          this.notifications.update((all) =>
            all.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
          );
          this.unread.update((u) => Math.max(0, u - 1));
        },
        error: () => this.error.set(this.locale.t('inboxPanel.loadError')),
      });
    }
    if (n.subjectRef?.entityType === 'asset') this.openSubject(n.subjectRef.entityId);
  }

  protected loadMessages(): void {
    this.api.messages({ limit: 50 }).subscribe({
      next: (page) => {
        this.messages.set(page.items);
        if (page.partial) this.partial.set(true);
      },
      error: () => this.error.set(this.locale.t('inboxPanel.loadError')),
    });
  }

  protected recipientsOf(m: Message): string {
    return m.to.map((r) => (r.kind === 'group' ? `#${r.id}` : r.id)).join(', ');
  }

  protected send(event: Event): void {
    event.preventDefault();
    const to = parseRecipients(this.to());
    if (!to || this.body().trim() === '') return;
    this.busy.set(true);
    this.error.set(null);
    this.api.send(to, this.body()).subscribe({
      next: (message) => {
        this.busy.set(false);
        this.body.set('');
        this.messages.update((all) => [message, ...all]);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(reasonOf(err) ?? this.locale.t('inboxPanel.sendError'));
      },
    });
  }

  protected loadPreferences(): void {
    this.api.preferences().subscribe({
      next: (prefs) => {
        this.preferences.set(prefs);
        this.chosen.set({});
      },
      error: () => this.error.set(this.locale.t('inboxPanel.loadError')),
    });
  }

  protected isOn(key: string, saved: boolean): boolean {
    return this.chosen()[key] ?? saved;
  }

  protected toggle(key: string, on: boolean): void {
    this.chosen.update((c) => ({ ...c, [key]: on }));
  }

  /** The whole set — what they chose before and what they changed now — over the version read. */
  protected savePreferences(): void {
    const prefs = this.preferences();
    if (!prefs) return;
    const types: Record<string, boolean> = {};
    for (const p of prefs.items) if (!p.mandatory && p.chosen) types[p.key] = p.on;
    Object.assign(types, this.chosen());
    this.busy.set(true);
    this.error.set(null);
    this.api.savePreferences(prefs.version, types).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.preferences.set(saved);
        this.chosen.set({});
      },
      error: (err: unknown) => {
        this.busy.set(false);
        // A 409 is someone else's save in between (another tab): read them again, never retry.
        if (err instanceof HttpErrorResponse && err.status === 409) {
          this.error.set(this.locale.t('inboxPanel.preferencesMoved'));
          this.loadPreferences();
        } else this.error.set(reasonOf(err) ?? this.locale.t('inboxPanel.saveError'));
      },
    });
  }

  /** A task action, then the inbox again; a 409 is the server's word on why not. */
  private act(request: ReturnType<InboxService['claim']>, conflictKey: string): void {
    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.refresh();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(
          err instanceof HttpErrorResponse && err.status === 409
            ? this.locale.t(conflictKey)
            : (reasonOf(err) ?? this.locale.t('inboxPanel.actionError')),
        );
        this.refresh();
      },
    });
  }
}

/**
 * `user-1, #g-desk` → recipients: a bare id is a user, `#` names a group. Null when nothing or
 * something unreadable is given — the server is the authority on whether they exist.
 */
export function parseRecipients(text: string): MessageRecipient[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: MessageRecipient[] = [];
  for (const p of parts) {
    const group = p.startsWith('#');
    const id = group ? p.slice(1) : p;
    if (id === '') return null;
    out.push({ kind: group ? 'group' : 'user', id });
  }
  return out;
}

/** The service's own words for a refusal, when it gave any. */
function reasonOf(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const body = err.error as { detail?: unknown; message?: unknown } | null;
  const text = body?.detail ?? body?.message;
  return typeof text === 'string' ? text : null;
}
