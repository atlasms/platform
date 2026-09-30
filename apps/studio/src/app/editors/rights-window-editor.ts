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
import type { RightsWindow } from '../core/generated/scheduling.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { NO_PROBLEMS, placeProblems, type Problems } from '../core/problems.ts';
import { RightsService } from '../core/rights.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { FIELD_CONTROL, draftOf, inputOf, type RightsDraft } from './rights-window.model.ts';

/**
 * A rights window, as an editor tab (EP-31). What the licence covers — one asset or one category —
 * and when, in the browser's zone. Scheduling decides: its 422 lands under the control it names,
 * and a 409 (someone changed or removed the window since it was read) is a reload, never a retry,
 * because a retry would overwrite terms this person never saw. `territory` is recorded and not
 * evaluated, and the form says so rather than let it look like a check.
 */
@Component({
  selector: 'atlas-rights-window-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!window()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ locale.t('rights.subject.' + d().subject) }} {{ d().subjectId }}</h2>
        <span class="state">v{{ window()!.version }}</span>
      </header>
      @if (conflict()) {
        <p class="error" role="alert">
          {{ locale.t('rights.conflict') }}
          <button type="button" class="link" (click)="reload()">
            {{ locale.t('rights.reload') }}
          </button>
        </p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (problems().general.length > 0) {
        <ul class="problems" role="alert">
          @for (rule of problems().general; track rule) {
            <li class="error">{{ rule }}</li>
          }
        </ul>
      }

      <form (ngSubmit)="save()">
        <fieldset [disabled]="readOnly() || busy()">
          <div class="fields">
            <label>
              <span>{{ locale.t('rights.licenses') }}</span>
              <select
                name="subject"
                [ngModel]="d().subject"
                (ngModelChange)="set('subject', $event)"
              >
                <option value="asset">{{ locale.t('rights.subject.asset') }}</option>
                <option value="category">{{ locale.t('rights.subject.category') }}</option>
              </select>
            </label>
            <label>
              <span>{{ locale.t('rights.subjectId.' + d().subject) }}</span>
              <input
                name="subjectId"
                autocomplete="off"
                [ngModel]="d().subjectId"
                (ngModelChange)="set('subjectId', $event)"
              />
              @for (m of problemsFor('subjectId'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('rights.from') }}</span>
              <input
                type="datetime-local"
                name="from"
                [ngModel]="d().from"
                (ngModelChange)="set('from', $event)"
              />
              @for (m of problemsFor('from'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('rights.to') }}</span>
              <input
                type="datetime-local"
                name="to"
                [ngModel]="d().to"
                (ngModelChange)="set('to', $event)"
              />
              @for (m of problemsFor('to'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('rights.territory') }}</span>
              <input
                name="territory"
                autocomplete="off"
                [ngModel]="d().territory"
                (ngModelChange)="set('territory', $event)"
              />
              <small class="muted">{{ locale.t('rights.territoryHint') }}</small>
            </label>
            <label>
              <span>{{ locale.t('rights.notes') }}</span>
              <input name="notes" [ngModel]="d().notes" (ngModelChange)="set('notes', $event)" />
            </label>
          </div>
          <p class="muted">
            {{ locale.t('rights.localTime') }} {{ zone }}. {{ locale.t('rights.rule') }}
          </p>

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

      @if (!readOnly()) {
        <section>
          <h3>{{ locale.t('admin.danger') }}</h3>
          <div class="row">
            <button type="button" class="danger" [disabled]="busy()" (click)="remove()">
              {{ locale.t('rights.delete') }}
            </button>
            <span class="muted">{{ locale.t('rights.deleteWhy') }}</span>
          </div>
        </section>
      }
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
      margin-block-end: var(--space-2);
    }
    .fields label {
      display: grid;
      gap: 2px;
      align-content: start;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    .fields small {
      font-size: 0.75rem;
    }
    .problems {
      margin: 0 0 var(--space-2);
      padding-inline-start: var(--space-4);
    }
    .actions {
      margin-block-start: var(--space-3);
    }
  `,
})
export class RightsWindowEditor implements OnInit {
  readonly windowId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(RightsService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly window = signal<RightsWindow | null>(null);
  private readonly draft = signal<RightsDraft | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly conflict = signal(false);
  protected readonly problems = signal<Problems>(NO_PROBLEMS);
  protected readonly busy = signal(false);
  protected readonly zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /** Only read once `window` is set, which is when the template reads it. */
  protected readonly d = computed(() => this.draft()!);
  /** UX only — Scheduling enforces `asset:write` on the rights group, strictly. */
  protected readonly readOnly = computed(
    () => !this.permissions.can('asset:write', { fieldGroup: 'rights' }),
  );
  /** Compared as the body Scheduling would be sent, so retyping a value is not an edit. */
  protected readonly dirty = computed(() => {
    const w = this.window();
    const d = this.draft();
    return !!w && !!d && JSON.stringify(inputOf(d)) !== JSON.stringify(inputOf(draftOf(w)));
  });

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.conflict.set(false);
    this.error.set(null);
    this.api.get(this.windowId()).subscribe({
      next: (w) => this.adopt(w),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
  }

  protected problemsFor(control: keyof RightsDraft): readonly string[] {
    return Object.entries(this.problems().fields)
      .filter(([field]) => FIELD_CONTROL[field] === control)
      .flatMap(([, rules]) => rules);
  }

  protected set<K extends keyof RightsDraft>(key: K, value: RightsDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected revert(): void {
    const w = this.window();
    if (w) this.adopt(w);
  }

  protected save(): void {
    const w = this.window();
    const d = this.draft();
    if (!w || !d || !this.dirty() || this.busy() || this.readOnly()) return;
    this.begin();
    this.api.replace(w.id, w.version, inputOf(d)).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.adopt(saved);
      },
      error: (err: { status?: number; error?: { message?: string } }) => this.fail(err),
    });
  }

  protected remove(): void {
    const w = this.window();
    if (!w || this.busy() || this.readOnly()) return;
    this.begin();
    this.api.remove(w.id, w.version).subscribe({
      next: () => {
        this.busy.set(false);
        this.editors.closeTab(this.tabId());
      },
      error: (err: { status?: number; error?: { message?: string } }) => this.fail(err),
    });
  }

  private begin(): void {
    this.busy.set(true);
    this.error.set(null);
    this.conflict.set(false);
    this.problems.set(NO_PROBLEMS);
  }

  private fail(err: { status?: number; error?: { message?: string } }): void {
    this.busy.set(false);
    const message = err.error?.message;
    if (err.status === 409) this.conflict.set(true);
    else if (err.status === 422 && message) {
      this.problems.set(placeProblems(message, (path) => path in FIELD_CONTROL));
    } else this.error.set(message ?? this.locale.t('admin.writeError'));
  }

  private adopt(w: RightsWindow): void {
    this.window.set(w);
    this.draft.set(draftOf(w));
    this.problems.set(NO_PROBLEMS);
    this.editors.setDirty(this.tabId(), false);
  }
}
