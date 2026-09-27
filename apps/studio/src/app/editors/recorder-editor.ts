import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Capture, Recorder } from '../core/generated/rim.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { NO_PROBLEMS, placeProblems, type Problems } from '../core/problems.ts';
import { RecordersService } from '../core/recorders.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import {
  DAYS,
  FILE_MINUTES,
  allDay,
  draftOf,
  inputOf,
  isHole,
  localTime,
  type RecorderDraft,
  type WindowDraft,
} from './recorder.model.ts';

const FIELDS = new Set([
  'name',
  'input.url',
  'input.passphraseSecret',
  'timezone',
  'windows',
  'fileMinutes',
  'padSeconds',
]);

/**
 * A recorder, as an editor tab (EP-39; ADR-0007): its feed, zone, recording windows, file length
 * and pad — and, under them, its CAPTURES: what is planned, what is recording and on which worker,
 * what finished, what was cut short (partial, with why) and what was missed. The second half is
 * what an operator actually watches; a `missed` capture is a hole in the recording and is marked.
 *
 * Saved whole, as RIM replaces it; RIM then plans again what has not started. Its 422 lands under
 * the field each reason names.
 */
@Component({
  selector: 'atlas-recorder-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!recorder()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ recorder()!.name }}</h2>
        <span class="state">v{{ recorder()!.version }}</span>
        @if (!recorder()!.enabled) {
          <span class="state" data-state="disabled">{{ locale.t('recorders.disabled') }}</span>
        }
      </header>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @for (m of problems().general; track m) {
        <p class="error" role="alert">{{ m }}</p>
      }

      <form (ngSubmit)="save()">
        <fieldset [disabled]="readOnly() || busy()">
          <div class="fields">
            <label>
              <span>{{ locale.t('recorders.name') }}</span>
              <input name="name" [ngModel]="d().name" (ngModelChange)="set('name', $event)" />
              @for (m of problemsFor('name'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label class="wide">
              <span>{{ locale.t('recorders.url') }}</span>
              <input
                name="url"
                placeholder="udp://239.1.1.1:5000"
                [ngModel]="d().url"
                (ngModelChange)="set('url', $event)"
              />
              <small class="muted">{{ locale.t('recorders.urlHint') }}</small>
              @for (m of problemsFor('input.url'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('recorders.passphraseSecret') }}</span>
              <input
                name="passphraseSecret"
                placeholder="srt-passphrases/channel-1"
                [ngModel]="d().passphraseSecret"
                (ngModelChange)="set('passphraseSecret', $event)"
              />
              @for (m of problemsFor('input.passphraseSecret'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('recorders.timezone') }}</span>
              <input
                name="timezone"
                list="recorder-zones"
                [ngModel]="d().timezone"
                (ngModelChange)="set('timezone', $event)"
              />
              <datalist id="recorder-zones">
                @for (z of zones; track z) {
                  <option [value]="z"></option>
                }
              </datalist>
              @for (m of problemsFor('timezone'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('recorders.fileMinutes') }}</span>
              <select
                name="fileMinutes"
                [ngModel]="d().fileMinutes"
                (ngModelChange)="set('fileMinutes', +$event)"
              >
                @for (m of fileMinutesOptions(); track m) {
                  <option [ngValue]="m">{{ m }} {{ locale.t('recorders.minutes') }}</option>
                }
              </select>
              @for (m of problemsFor('fileMinutes'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('recorders.padSeconds') }}</span>
              <input
                type="number"
                name="padSeconds"
                min="0"
                max="60"
                [ngModel]="d().padSeconds"
                (ngModelChange)="set('padSeconds', $event)"
              />
              @for (m of problemsFor('padSeconds'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label class="check">
              <input
                type="checkbox"
                name="enabled"
                [ngModel]="d().enabled"
                (ngModelChange)="set('enabled', $event)"
              />
              <span>{{ locale.t('recorders.enabled') }}</span>
            </label>
          </div>
          <p class="muted">{{ locale.t('recorders.padHint') }}</p>

          <section>
            <h3>{{ locale.t('recorders.windows') }}</h3>
            @for (m of problemsFor('windows'); track m) {
              <p class="error">{{ m }}</p>
            }
            <ol class="windows">
              @for (w of d().windows; track $index; let i = $index) {
                <li>
                  <span class="days" role="group" [attr.aria-label]="locale.t('recorders.days')">
                    @for (day of days; track day) {
                      <label class="day">
                        <input
                          type="checkbox"
                          [name]="'day' + i + day"
                          [ngModel]="w.days.includes(day)"
                          (ngModelChange)="toggleDay(i, day, $event)"
                        />
                        <span>{{ locale.t('recorders.day.' + day) }}</span>
                      </label>
                    }
                  </span>
                  <input
                    class="time"
                    [name]="'from' + i"
                    [attr.aria-label]="locale.t('recorders.from')"
                    placeholder="06:00"
                    [ngModel]="w.from"
                    (ngModelChange)="setWindow(i, 'from', $event)"
                  />
                  <span aria-hidden="true">–</span>
                  <input
                    class="time"
                    [name]="'to' + i"
                    [attr.aria-label]="locale.t('recorders.to')"
                    placeholder="24:00"
                    [ngModel]="w.to"
                    (ngModelChange)="setWindow(i, 'to', $event)"
                  />
                  @if (!readOnly() && d().windows.length > 1) {
                    <button type="button" class="link" (click)="removeWindow(i)">
                      {{ locale.t('admin.remove') }}
                    </button>
                  }
                </li>
              }
            </ol>
            @if (!readOnly()) {
              <button type="button" class="link" (click)="addWindow()">
                {{ locale.t('recorders.addWindow') }}
              </button>
            }
            <p class="muted">{{ locale.t('recorders.windowsHint') }}</p>
          </section>

          @if (!readOnly()) {
            <div class="row actions">
              <button type="submit" [disabled]="busy() || !dirty()">
                {{ locale.t('admin.save') }}
              </button>
              <button type="button" class="link" [disabled]="busy() || !dirty()" (click)="revert()">
                {{ locale.t('admin.revert') }}
              </button>
            </div>
          }
        </fieldset>
      </form>

      <section>
        <h3>
          {{ locale.t('recorders.captures') }}
          <button type="button" class="link" (click)="loadCaptures()">
            {{ locale.t('recorders.refresh') }}
          </button>
        </h3>
        <p class="muted">{{ locale.t('recorders.capturesHint') }}</p>
        @if (capturesError()) {
          <p class="error">{{ capturesError() }}</p>
        } @else if (captures().length === 0) {
          <p class="muted">{{ locale.t('recorders.noCaptures') }}</p>
        } @else {
          <table class="captures">
            <thead>
              <tr>
                <th>{{ locale.t('recorders.file') }}</th>
                <th>{{ locale.t('recorders.part') }}</th>
                <th>{{ locale.t('recorders.state') }}</th>
                <th>{{ locale.t('recorders.worker') }}</th>
                <th>{{ locale.t('recorders.reason') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (c of captures(); track c.id) {
                <tr [class.hole]="hole(c)">
                  <td>{{ time(c.fileStart) }}–{{ time(c.fileEnd) }}</td>
                  <td>{{ c.part }}</td>
                  <td>
                    <span class="state" [attr.data-state]="c.state">{{
                      locale.t('recorders.captureState.' + c.state)
                    }}</span>
                  </td>
                  <td>{{ c.holder ?? '—' }}</td>
                  <td>{{ c.reason ?? '' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    }
  `,
  styleUrls: ['./admin-editor.scss'],
  styles: `
    fieldset {
      margin: 0;
      padding: 0;
      border: none;
      min-inline-size: 0;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
      gap: var(--space-2);
      align-items: start;
    }
    .fields label {
      display: grid;
      gap: 2px;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    .fields .wide {
      grid-column: span 2;
    }
    label.check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
    }
    small {
      font-size: 0.75rem;
    }
    .windows {
      margin: 0 0 var(--space-2);
      padding-inline-start: var(--space-4);
      display: grid;
      gap: var(--space-2);
    }
    .windows li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
    }
    .days {
      display: flex;
      gap: 2px;
    }
    .day {
      display: flex;
      gap: 2px;
      align-items: center;
      font-size: 0.75rem;
    }
    .time {
      inline-size: 5rem;
    }
    .captures {
      inline-size: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }
    .captures th,
    .captures td {
      padding: var(--space-1);
      text-align: start;
      border-block-end: 1px solid var(--color-border);
    }
    .captures tr.hole td {
      color: var(--color-danger);
    }
    .actions {
      margin-block-start: var(--space-3);
    }
  `,
})
export class RecorderEditor implements OnInit {
  readonly recorderId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(RecordersService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly days = DAYS;
  /** The zones the browser knows, for the field's suggestions; RIM is the judge of the value. */
  protected readonly zones: readonly string[] =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  protected readonly recorder = signal<Recorder | null>(null);
  private readonly draft = signal<RecorderDraft | null>(null);
  protected readonly captures = signal<Capture[]>([]);
  protected readonly capturesError = signal<string | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<Problems>(NO_PROBLEMS);
  protected readonly busy = signal(false);

  protected readonly d = computed(() => this.draft()!);
  /** UX only — RIM enforces `ingest:admin`. */
  protected readonly readOnly = computed(() => !this.permissions.can('ingest:admin'));
  protected readonly dirty = computed(() => {
    const r = this.recorder();
    const d = this.draft();
    return !!r && !!d && JSON.stringify(inputOf(d)) !== JSON.stringify(inputOf(draftOf(r)));
  });
  /** The offered lengths, and the recorder's own if it is none of them. */
  protected readonly fileMinutesOptions = computed(() => {
    const current = this.draft()?.fileMinutes;
    const list: number[] = [...FILE_MINUTES];
    return current !== undefined && !list.includes(current)
      ? [...list, current].sort((a, b) => a - b)
      : list;
  });

  ngOnInit(): void {
    this.api.get(this.recorderId()).subscribe({
      next: (r) => this.adopt(r),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
    this.loadCaptures();
  }

  protected loadCaptures(): void {
    this.api.captures(this.recorderId()).subscribe({
      next: (list) => {
        this.captures.set(list);
        this.capturesError.set(null);
      },
      error: () => this.capturesError.set(this.locale.t('admin.loadError')),
    });
  }

  protected time(iso: string): string {
    return localTime(iso, this.recorder()?.timezone ?? 'UTC');
  }

  protected hole(c: Capture): boolean {
    return isHole(c);
  }

  protected problemsFor(field: string): readonly string[] {
    return this.problems().fields[field] ?? [];
  }

  protected set<K extends keyof RecorderDraft>(key: K, value: RecorderDraft[K]): void {
    this.update((d) => ({ ...d, [key]: value }));
  }

  protected setWindow(i: number, key: 'from' | 'to', value: string): void {
    this.update((d) => ({
      ...d,
      windows: d.windows.map((w, j) => (j === i ? { ...w, [key]: value } : w)),
    }));
  }

  protected toggleDay(i: number, day: WindowDraft['days'][number], on: boolean): void {
    this.update((d) => ({
      ...d,
      windows: d.windows.map((w, j) =>
        j === i ? { ...w, days: on ? [...w.days, day] : w.days.filter((x) => x !== day) } : w,
      ),
    }));
  }

  protected addWindow(): void {
    this.update((d) => ({ ...d, windows: [...d.windows, allDay()] }));
  }

  protected removeWindow(i: number): void {
    this.update((d) => ({ ...d, windows: d.windows.filter((_, j) => j !== i) }));
  }

  protected revert(): void {
    const r = this.recorder();
    if (r) this.adopt(r);
  }

  protected save(): void {
    const r = this.recorder();
    const d = this.draft();
    if (!r || !d || !this.dirty() || this.busy() || this.readOnly()) return;
    this.busy.set(true);
    this.error.set(null);
    this.problems.set(NO_PROBLEMS);
    this.api.replace(r.id, inputOf(d)).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.adopt(saved);
        this.loadCaptures(); // RIM planned again
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        const message = err.error?.message;
        if (err.status === 422 && message) {
          this.problems.set(placeProblems(message, (path) => FIELDS.has(path)));
        } else {
          this.error.set(message ?? this.locale.t('admin.writeError'));
        }
      },
    });
  }

  private update(fn: (d: RecorderDraft) => RecorderDraft): void {
    this.draft.update((d) => (d ? fn(d) : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  private adopt(r: Recorder): void {
    this.recorder.set(r);
    this.draft.set(draftOf(r));
    this.problems.set(NO_PROBLEMS);
    this.editors.setDirty(this.tabId(), false);
  }
}

/** Open a recorder's tab — here, not in the list view, so the deferred editor stays deferred. */
export function openRecorder(editors: EditorStore, r: Pick<Recorder, 'id' | 'name'>): void {
  editors.open({ type: 'recorder', resourceId: r.id, title: r.name, icon: '●' });
}
