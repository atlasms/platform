import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ItemType, Schedule } from '../core/generated/scheduling.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SchedulesService } from '../core/schedules.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import {
  append,
  childrenOf,
  endOf,
  fromItems,
  move,
  newRow,
  patch,
  problems,
  remove,
  span,
  toInputs,
  topLevel,
  type ReelRow,
} from './reel.model.ts';

/**
 * Every item type, with its label key. A `Record<ItemType, …>` rather than a list: add a type to
 * the contract, regenerate, and this stops compiling until the label exists.
 */
const ITEM_TYPE_LABEL: Readonly<Record<ItemType, string>> = {
  media: 'scheduleEditor.type.media',
  live: 'scheduleEditor.type.live',
  title: 'scheduleEditor.type.title',
  filler: 'scheduleEditor.type.filler',
  break: 'scheduleEditor.type.break',
};

interface NewItemForm {
  itemType: ItemType;
  /** `HH:mm` in the broadcast day — used only when `fixed`. */
  time: string;
  /** Minutes, as typed; parsed on add. */
  minutes: string;
  mediaId: string;
  title: string;
  fixed: boolean;
}

const EMPTY_FORM: NewItemForm = {
  itemType: 'media',
  time: '',
  minutes: '30',
  mediaId: '',
  title: '',
  fixed: false,
};

/**
 * The schedule editor v0 (EP-20.5): the reel, with add, move, resize and remove.
 *
 * The rules — reflow, overlaps refused at save, gaps flagged — are `reel.model.ts`; this component
 * holds the rows and renders what the model says. The save is ONE request, `PUT …/items` with the
 * whole reel: the service stores it as given, so what this component sends is exactly what the
 * next reader gets, ids kept for rows that had them and minted for rows that did not.
 *
 * Sub-schedules are rendered under their live item and travel with it; editing inside one is v1.
 */
@Component({
  selector: 'atlas-schedule-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <div class="state">
        <p>{{ locale.t('scheduleEditor.loading') }}</p>
      </div>
    } @else if (loadError()) {
      <div class="state" role="alert">
        <p>{{ loadError() }}</p>
        <button type="button" (click)="reload()">{{ locale.t('common.retry') }}</button>
      </div>
    } @else if (schedule(); as current) {
      <header class="editor-header">
        <div>
          <p class="eyebrow">{{ current.timezone }} · {{ current.state }}</p>
          <h2>{{ current.broadcastDate }}</h2>
        </div>
        <span class="version">v{{ current.version }} · {{ runtime() }}</span>
      </header>

      @if (overlapCount() > 0) {
        <p class="message error" role="alert">
          {{ overlapCount() }} {{ locale.t('scheduleEditor.overlapsBlockSave') }}
        </p>
      } @else if (saveError()) {
        <p class="message error" role="alert">{{ saveError() }}</p>
      } @else if (saved()) {
        <p class="message" role="status">{{ locale.t('scheduleEditor.saved') }}</p>
      }

      <table class="reel" [attr.aria-label]="locale.t('scheduleEditor.reel')">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{{ locale.t('scheduleEditor.start') }}</th>
            <th scope="col">{{ locale.t('scheduleEditor.end') }}</th>
            <th scope="col">{{ locale.t('scheduleEditor.duration') }}</th>
            <th scope="col">{{ locale.t('scheduleEditor.typeHeading') }}</th>
            <th scope="col">{{ locale.t('scheduleEditor.title') }}</th>
            <th scope="col">{{ locale.t('scheduleEditor.fixed') }}</th>
            <th scope="col">
              <span class="visually-hidden">{{ locale.t('scheduleEditor.actions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          @for (row of top(); track row.key; let i = $index; let first = $first; let last = $last) {
            @if (gapBefore(row.key); as gap) {
              <tr class="gap" role="note">
                <td colspan="8">{{ locale.t('scheduleEditor.gap') }} {{ minutes(gap) }}</td>
              </tr>
            }
            <tr [class.overlap]="isOverlap(row.key)" [class.unsaved]="!row.id">
              <td class="seq">{{ i + 1 }}</td>
              <td class="time">{{ clock(row.start) }}</td>
              <td class="time">{{ clock(endOf(row.start, row.durationSec)) }}</td>
              <td class="dur">
                @if (mayEdit()) {
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    class="minutes"
                    [attr.aria-label]="locale.t('scheduleEditor.minutes')"
                    [value]="row.durationSec / 60"
                    (change)="setDuration(row.key, $any($event.target).value)"
                  />
                } @else {
                  {{ minutes(row.durationSec) }}
                }
              </td>
              <td>{{ locale.t(typeLabel(row.itemType)) }}</td>
              <td class="title">
                {{ row.mediaTitle || row.description || row.mediaId || '—' }}
                @if (isOverlap(row.key)) {
                  <span class="flag">{{ locale.t('scheduleEditor.overlap') }}</span>
                }
              </td>
              <td>
                <input
                  type="checkbox"
                  [attr.aria-label]="locale.t('scheduleEditor.fixed')"
                  [checked]="row.fixed"
                  [disabled]="!mayEdit()"
                  (change)="toggleFixed(row.key, $any($event.target).checked)"
                />
              </td>
              <td class="row-actions">
                @if (mayEdit()) {
                  <button
                    type="button"
                    [disabled]="first"
                    [title]="locale.t('scheduleEditor.moveUp')"
                    (click)="moveRow(row.key, 'up')"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    [disabled]="last"
                    [title]="locale.t('scheduleEditor.moveDown')"
                    (click)="moveRow(row.key, 'down')"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="danger"
                    [title]="locale.t('scheduleEditor.remove')"
                    (click)="removeRow(row.key)"
                  >
                    ✕
                  </button>
                }
              </td>
            </tr>
            @for (child of childrenOf(row.key); track child.key; let j = $index) {
              <tr class="child">
                <td class="seq">{{ i + 1 }}.{{ j + 1 }}</td>
                <td class="time">{{ clock(child.start) }}</td>
                <td class="time">{{ clock(endOf(child.start, child.durationSec)) }}</td>
                <td class="dur">{{ minutes(child.durationSec) }}</td>
                <td>{{ locale.t(typeLabel(child.itemType)) }}</td>
                <td class="title">
                  {{ child.mediaTitle || child.description || child.mediaId || '—' }}
                </td>
                <td></td>
                <td></td>
              </tr>
            }
          } @empty {
            <tr>
              <td colspan="8" class="muted">{{ locale.t('scheduleEditor.emptyReel') }}</td>
            </tr>
          }
        </tbody>
      </table>

      @if (mayEdit()) {
        <form
          class="add"
          (submit)="add($event)"
          [attr.aria-label]="locale.t('scheduleEditor.addItem')"
        >
          <label>
            {{ locale.t('scheduleEditor.typeHeading') }}
            <select
              name="itemType"
              [value]="form().itemType"
              (change)="setForm('itemType', $any($event.target).value)"
            >
              @for (type of itemTypes; track type) {
                <option [value]="type">{{ locale.t(typeLabel(type)) }}</option>
              }
            </select>
          </label>
          <label>
            {{ locale.t('scheduleEditor.minutes') }}
            <input
              name="minutes"
              type="number"
              min="0"
              step="0.5"
              [value]="form().minutes"
              (input)="setForm('minutes', $any($event.target).value)"
            />
          </label>
          @if (form().itemType === 'media') {
            <label>
              {{ locale.t('scheduleEditor.mediaId') }}
              <input
                name="mediaId"
                [value]="form().mediaId"
                (input)="setForm('mediaId', $any($event.target).value)"
              />
            </label>
          }
          <label>
            {{ locale.t('scheduleEditor.title') }}
            <input
              name="title"
              [value]="form().title"
              (input)="setForm('title', $any($event.target).value)"
            />
          </label>
          <label class="check">
            <input
              name="fixed"
              type="checkbox"
              [checked]="form().fixed"
              (change)="setForm('fixed', $any($event.target).checked)"
            />
            {{ locale.t('scheduleEditor.fixedAt') }}
          </label>
          @if (form().fixed) {
            <label>
              {{ locale.t('scheduleEditor.time') }}
              <input
                name="time"
                type="time"
                step="1"
                [value]="form().time"
                (input)="setForm('time', $any($event.target).value)"
              />
            </label>
          }
          <button type="submit">{{ locale.t('scheduleEditor.addItem') }}</button>
          @if (formError()) {
            <span class="error" role="alert">{{ formError() }}</span>
          }
        </form>

        <div class="actions">
          <button
            type="button"
            (click)="save()"
            [disabled]="saving() || !dirty() || overlapCount() > 0"
          >
            {{ saving() ? locale.t('scheduleEditor.saving') : locale.t('scheduleEditor.saveReel') }}
          </button>
          @if (dirty()) {
            <button type="button" class="secondary" (click)="reload()">
              {{ locale.t('scheduleEditor.discard') }}
            </button>
          }
          <span>{{ top().length }} {{ locale.t('scheduleEditor.items') }}</span>
        </div>
      }
    }
  `,
  styleUrl: './schedule-editor.scss',
})
export class ScheduleEditor {
  readonly scheduleId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly schedulesApi = inject(SchedulesService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly schedule = signal<Schedule | null>(null);
  protected readonly rows = signal<readonly ReelRow[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly dirty = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly form = signal<NewItemForm>(EMPTY_FORM);
  protected readonly formError = signal<string | null>(null);

  protected readonly itemTypes = Object.keys(ITEM_TYPE_LABEL) as ItemType[];
  protected readonly top = computed(() => topLevel(this.rows()));
  protected readonly problems = computed(() => problems(this.rows()));
  protected readonly overlapCount = computed(() => this.problems().overlaps.size);
  protected readonly runtime = computed(() => this.minutes(span(this.rows())));
  /** UX only: the service re-checks with `canEnforce` and the full resource context. */
  protected readonly mayEdit = computed(() => this.permissions.can('schedule:write'));

  protected readonly endOf = endOf;

  // Scheduling publishes atlas.<channel>.schedule.<action>; the payload's scheduleId filters.
  private readonly wsSubscription = effect(() => {
    const channelId = this.session.channelId();
    if (channelId) void this.ws.subscribe(`atlas.${channelId}.schedule.>`);
  });

  private readonly wsEvents = this.ws.events$
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(({ subject, payload }) => this.handleScheduleEvent(subject, payload));

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.schedulesApi.get(this.scheduleId()).subscribe({
      next: ({ items, ...header }) => {
        this.schedule.set(header);
        this.rows.set(fromItems(items));
        this.setDirty(false);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set(this.locale.t('scheduleEditor.loadError'));
        this.loading.set(false);
      },
    });
  }

  // --- the edits ------------------------------------------------------------------------------------

  protected setForm<K extends keyof NewItemForm>(field: K, value: NewItemForm[K]): void {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.formError.set(null);
  }

  protected add(event: Event): void {
    event.preventDefault();
    const f = this.form();
    const durationSec = Math.round(Number(f.minutes) * 60);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      this.formError.set(this.locale.t('scheduleEditor.invalidDuration'));
      return;
    }
    if (f.itemType === 'media' && f.mediaId.trim() === '') {
      this.formError.set(this.locale.t('scheduleEditor.mediaRequired'));
      return;
    }
    const start = f.fixed ? this.startFromTime(f.time) : this.reelEnd();
    if (start === null) {
      this.formError.set(this.locale.t('scheduleEditor.invalidTime'));
      return;
    }
    const row = newRow({
      start,
      durationSec,
      fixed: f.fixed,
      itemType: f.itemType,
      ...(f.itemType === 'media' ? { mediaId: f.mediaId.trim() } : {}),
      ...(f.title.trim() !== '' ? { mediaTitle: f.title.trim() } : {}),
    });
    this.rows.set(append(this.rows(), row));
    this.form.set({ ...EMPTY_FORM, itemType: f.itemType, minutes: f.minutes });
    this.setDirty(true);
  }

  protected moveRow(key: string, direction: 'up' | 'down'): void {
    this.rows.set(move(this.rows(), key, direction));
    this.setDirty(true);
  }

  protected removeRow(key: string): void {
    this.rows.set(remove(this.rows(), key));
    this.setDirty(true);
  }

  /** Resize: everything after the row re-times (rule 1), and an anchor inside it is an overlap. */
  protected setDuration(key: string, minutesText: string): void {
    const durationSec = Math.round(Number(minutesText) * 60);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return;
    this.rows.set(patch(this.rows(), key, { durationSec }));
    this.setDirty(true);
  }

  protected toggleFixed(key: string, fixed: boolean): void {
    this.rows.set(patch(this.rows(), key, { fixed }));
    this.setDirty(true);
  }

  protected save(): void {
    if (this.saving() || !this.dirty() || this.overlapCount() > 0) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.schedulesApi.replaceItems(this.scheduleId(), toInputs(this.rows())).subscribe({
      next: (items) => {
        // The stored reel, ids and all — the version moved, so the header is refetched too.
        this.rows.set(fromItems(items));
        this.setDirty(false);
        this.saving.set(false);
        this.saved.set(true);
        this.schedulesApi.get(this.scheduleId()).subscribe({
          next: ({ items: _items, ...header }) => {
            void _items;
            this.schedule.set(header);
          },
        });
      },
      error: () => {
        // The edits stay; nothing was stored.
        this.saveError.set(this.locale.t('scheduleEditor.saveError'));
        this.saving.set(false);
      },
    });
  }

  // --- rendering helpers -------------------------------------------------------------------------------

  protected childrenOf(key: string): ReelRow[] {
    return childrenOf(this.rows(), key);
  }

  protected isOverlap(key: string): boolean {
    return this.problems().overlaps.has(key);
  }

  protected gapBefore(key: string): number | undefined {
    return this.problems().gaps.get(key);
  }

  protected typeLabel(type: ItemType): string {
    return ITEM_TYPE_LABEL[type];
  }

  /** `HH:mm:ss` in the schedule's own zone — the control room reads wall-clock time. */
  protected clock(iso: string): string {
    const zone = this.schedule()?.timezone;
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        ...(zone ? { timeZone: zone } : {}),
      }).format(new Date(iso));
    } catch {
      return iso.slice(11, 19);
    }
  }

  protected minutes(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s === 0 ? `${m}′` : `${m}′${String(s).padStart(2, '0')}″`;
  }

  private setDirty(dirty: boolean): void {
    this.dirty.set(dirty);
    if (dirty) this.saved.set(false);
    this.editors.setDirty(this.tabId(), dirty);
  }

  /** Where the reel currently ends; the broadcast day's 06:00 in its zone when it is empty. */
  private reelEnd(): string {
    const last = this.top()[this.top().length - 1];
    if (last) return endOf(last.start, last.durationSec);
    return this.startFromTime('06:00') ?? new Date().toISOString();
  }

  /**
   * A wall-clock time on the broadcast day, in the schedule's zone, as an instant.
   *
   * The browser has no zone arithmetic without a library, so the offset is MEASURED: take the
   * wall clock as if it were UTC, read the zone's offset at that instant, subtract, and read the
   * offset once more at the result — the second read is what gets a DST boundary right. Wrong
   * only for the one wall-clock hour a year that does not exist, which is not a scheduling hour.
   */
  private startFromTime(time: string): string | null {
    const schedule = this.schedule();
    if (!schedule || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
    const wall = Date.parse(
      `${schedule.broadcastDate}T${time.length === 5 ? `${time}:00` : time}Z`,
    );
    if (!Number.isFinite(wall)) return null;
    const first = wall - zoneOffsetMs(schedule.timezone, wall);
    return new Date(wall - zoneOffsetMs(schedule.timezone, first)).toISOString();
  }

  private handleScheduleEvent(subject: string, payload: unknown): void {
    if (!subject.startsWith('atlas.')) return;
    const envelope = payload as { channelId?: string; payload?: { scheduleId?: string } };
    if (envelope.channelId !== this.session.channelId()) return;
    if (envelope.payload?.scheduleId !== this.scheduleId()) return;
    // A reload replaces the rows; with unsaved edits that would discard the user's work.
    if (this.dirty()) return;
    this.reload();
  }
}

/** The zone's UTC offset at `atMs`, in milliseconds (positive east of UTC). */
function zoneOffsetMs(zone: string, atMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: zone,
    }).formatToParts(new Date(atMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return asUtc - Math.floor(atMs / 1000) * 1000;
  } catch {
    return 0;
  }
}
