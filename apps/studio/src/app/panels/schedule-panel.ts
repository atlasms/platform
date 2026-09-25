import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';
import type { Schedule } from '../core/generated/scheduling.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SchedulesService } from '../core/schedules.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

/**
 * The Schedule panel (EP-20.5): pick a broadcast day, open its program table — or create it.
 *
 * One program table per channel per day (data-model §3.1), so the panel's question is "which
 * day?", and the answer is either an existing schedule to open or a day with none yet. The list
 * below the picker is the channel's recent tables, newest day first, for the common case of going
 * back to yesterday's.
 */
@Component({
  selector: 'atlas-schedule-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="panel-title">{{ locale.t('workbench.panels.schedule') }}</h2>

    <form class="day" (submit)="openDay($event)">
      <label>
        <span class="visually-hidden">{{ locale.t('schedulePanel.broadcastDay') }}</span>
        <input type="date" required [value]="day()" (input)="day.set($any($event.target).value)" />
      </label>
      <button type="submit" [disabled]="busy()">{{ locale.t('schedulePanel.open') }}</button>
    </form>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (missing(); as none) {
      <p class="muted">
        {{ locale.t('schedulePanel.noTableFor') }} {{ none }}.
        @if (mayCreate()) {
          <button type="button" class="link" [disabled]="busy()" (click)="create(none)">
            {{ locale.t('schedulePanel.createIt') }}
          </button>
        }
      </p>
    }

    <p class="mode">{{ locale.t('schedulePanel.recent') }}</p>
    @if (loading()) {
      <p class="muted">{{ locale.t('schedulePanel.loading') }}</p>
    } @else if (recent().length === 0) {
      <p class="muted">{{ locale.t('schedulePanel.none') }}</p>
    } @else {
      <ul class="items">
        @for (schedule of recent(); track schedule.id) {
          <li>
            <button type="button" (click)="open(schedule)">
              <span class="title">{{ schedule.broadcastDate }}</span>
              <span class="state">{{ schedule.state }}</span>
            </button>
          </li>
        }
      </ul>
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
    .day {
      display: flex;
      gap: var(--space-1);
      margin-block-end: var(--space-2);
    }
    .day label {
      flex: 1;
    }
    .day input {
      inline-size: 100%;
      padding: var(--space-1) var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
    }
    .day input:focus-visible {
      border-color: var(--color-accent);
      outline: none;
    }
    .mode {
      margin: var(--space-3) 0 var(--space-1);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .items {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .items button {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
      inline-size: 100%;
      padding: var(--space-1) var(--space-2);
      text-align: start;
      color: inherit;
      background: none;
      border: none;
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .items button:hover {
      background: var(--color-bg-hover);
    }
    .title {
      flex: 1;
    }
    .state {
      font-size: 0.6875rem;
      color: var(--color-fg-muted);
    }
    .link {
      padding: 0;
      color: var(--color-accent);
      background: none;
      border: none;
      cursor: pointer;
      font: inherit;
    }
    .muted,
    .error {
      color: var(--color-fg-muted);
      font-size: 0.8125rem;
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
export class SchedulePanel implements OnInit {
  private readonly schedulesApi = inject(SchedulesService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly day = signal(new Date().toISOString().slice(0, 10));
  protected readonly recent = signal<Schedule[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The day the user asked for that has no table yet. */
  protected readonly missing = signal<string | null>(null);
  protected readonly mayCreate = () => this.permissions.can('schedule:write');

  ngOnInit(): void {
    this.loadRecent();
  }

  protected loadRecent(): void {
    this.loading.set(true);
    this.schedulesApi.list({ limit: 30 }).subscribe({
      next: (page) => {
        this.recent.set(page.items);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('schedulePanel.loadError'));
        this.loading.set(false);
      },
    });
  }

  /** Open the day's table if there is one; otherwise offer to create it. */
  protected openDay(event: Event): void {
    event.preventDefault();
    const day = this.day();
    if (!day) return;
    this.busy.set(true);
    this.error.set(null);
    this.missing.set(null);
    this.schedulesApi.list({ broadcastDate: day, limit: 1 }).subscribe({
      next: (page) => {
        this.busy.set(false);
        const found = page.items[0];
        if (found) this.open(found);
        else this.missing.set(day);
      },
      error: () => {
        this.busy.set(false);
        this.error.set(this.locale.t('schedulePanel.loadError'));
      },
    });
  }

  protected create(day: string): void {
    this.busy.set(true);
    this.error.set(null);
    // The browser's zone as the broadcast day's zone: the operator is where the channel is, in
    // v0. A channel-configured zone is the reference-data story.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.schedulesApi.create({ broadcastDate: day, timezone }).subscribe({
      next: (schedule) => {
        this.busy.set(false);
        this.missing.set(null);
        this.recent.update((list) => [schedule, ...list]);
        this.open(schedule);
      },
      error: () => {
        this.busy.set(false);
        this.error.set(this.locale.t('schedulePanel.createError'));
      },
    });
  }

  protected open(schedule: Schedule): void {
    this.editors.open({
      type: 'schedule',
      resourceId: schedule.id,
      title: `${this.locale.t('schedulePanel.tabPrefix')} ${schedule.broadcastDate}`,
    });
  }
}
