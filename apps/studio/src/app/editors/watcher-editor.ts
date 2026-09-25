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
import type { Watcher, WatcherInput } from '../core/generated/rim.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { NO_PROBLEMS, placeProblems, type Problems } from '../core/problems.ts';
import { WatchersService } from '../core/watchers.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

/** The form's state: flat, one control per field; extensions as the text the operator types. */
interface WatcherDraft {
  name: string;
  path: string;
  settleSeconds: number | null;
  /** `mxf, mov` — split, lowercased, dots dropped on save. */
  extensions: string;
  afterPickup: 'delete' | 'keep';
  enabled: boolean;
}

const FIELDS = new Set(['name', 'path', 'settleSeconds', 'extensions', 'afterPickup', 'enabled']);

export function draftOf(w: Watcher): WatcherDraft {
  return {
    name: w.name,
    path: w.path,
    settleSeconds: w.settleSeconds,
    extensions: (w.extensions ?? []).join(', '),
    afterPickup: w.afterPickup,
    enabled: w.enabled,
  };
}

/**
 * The body RIM is sent: the whole watcher, as the form says it. An empty extensions box is "every
 * file" and is sent as an empty list; an emptied settle box is left to RIM's default.
 */
export function inputOf(d: WatcherDraft): WatcherInput {
  const extensions = d.extensions
    .split(/[\s,]+/)
    .map((e) => e.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  return {
    name: d.name.trim(),
    path: d.path.trim(),
    ...(d.settleSeconds !== null ? { settleSeconds: d.settleSeconds } : {}),
    extensions,
    afterPickup: d.afterPickup,
    enabled: d.enabled,
  };
}

/**
 * A folder watcher, as an editor tab (EP-15.2). What RIM decides stays RIM's: a path out of the
 * channel's directory, or a symlink that leads out, is its 422, shown under the field it names; two
 * enabled watchers on one folder is its 409, shown above the form. The page says what the settings
 * MEAN — when a file counts as settled, what happens to it after — because the consequences of
 * `delete` land on another team's folder.
 */
@Component({
  selector: 'atlas-watcher-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!watcher()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ watcher()!.name }}</h2>
        <span class="state">v{{ watcher()!.version }}</span>
        @if (!watcher()!.enabled) {
          <span class="state" data-state="disabled">{{ locale.t('watchers.disabled') }}</span>
        }
      </header>
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
              <span>{{ locale.t('watchers.name') }}</span>
              <input name="name" [ngModel]="d().name" (ngModelChange)="set('name', $event)" />
              @for (m of problemsFor('name'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('watchers.path') }}</span>
              <input name="path" [ngModel]="d().path" (ngModelChange)="set('path', $event)" />
              <small class="muted">{{ locale.t('watchers.pathHint') }}</small>
              @for (m of problemsFor('path'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('watchers.settleSeconds') }}</span>
              <input
                type="number"
                name="settleSeconds"
                min="1"
                max="3600"
                [ngModel]="d().settleSeconds"
                (ngModelChange)="set('settleSeconds', $event)"
              />
              <small class="muted">{{ locale.t('watchers.settleHint') }}</small>
              @for (m of problemsFor('settleSeconds'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('watchers.extensions') }}</span>
              <input
                name="extensions"
                placeholder="mxf, mov, wav"
                [ngModel]="d().extensions"
                (ngModelChange)="set('extensions', $event)"
              />
              <small class="muted">{{ locale.t('watchers.extensionsHint') }}</small>
              @for (m of problemsFor('extensions'); track m) {
                <small class="error">{{ m }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('watchers.afterPickup') }}</span>
              <select
                name="afterPickup"
                [ngModel]="d().afterPickup"
                (ngModelChange)="set('afterPickup', $event)"
              >
                <option value="delete">{{ locale.t('watchers.after.delete') }}</option>
                <option value="keep">{{ locale.t('watchers.after.keep') }}</option>
              </select>
              <small class="muted">{{ locale.t('watchers.afterHint.' + d().afterPickup) }}</small>
            </label>
            <label class="check">
              <input
                type="checkbox"
                name="enabled"
                [ngModel]="d().enabled"
                (ngModelChange)="set('enabled', $event)"
              />
              <span>{{ locale.t('watchers.enabled') }}</span>
            </label>
          </div>
          <p class="muted">{{ locale.t('watchers.enabledWhy') }}</p>

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
    label.check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
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
export class WatcherEditor implements OnInit {
  readonly watcherId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(WatchersService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly watcher = signal<Watcher | null>(null);
  private readonly draft = signal<WatcherDraft | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<Problems>(NO_PROBLEMS);
  protected readonly busy = signal(false);

  /** Only read once `watcher` is set, which is when the template reads it. */
  protected readonly d = computed(() => this.draft()!);
  /** UX only — RIM enforces `ingest:admin` in the channel. */
  protected readonly readOnly = computed(() => !this.permissions.can('ingest:admin'));
  /** Compared as the body RIM would be sent, so retyping a value is not an edit. */
  protected readonly dirty = computed(() => {
    const w = this.watcher();
    const d = this.draft();
    return !!w && !!d && JSON.stringify(inputOf(d)) !== JSON.stringify(inputOf(draftOf(w)));
  });

  ngOnInit(): void {
    this.api.get(this.watcherId()).subscribe({
      next: (w) => this.adopt(w),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
  }

  protected problemsFor(field: string): readonly string[] {
    return this.problems().fields[field] ?? [];
  }

  protected set<K extends keyof WatcherDraft>(key: K, value: WatcherDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected revert(): void {
    const w = this.watcher();
    if (w) this.adopt(w);
  }

  protected save(): void {
    const w = this.watcher();
    const d = this.draft();
    if (!w || !d || !this.dirty() || this.busy() || this.readOnly()) return;
    this.busy.set(true);
    this.error.set(null);
    this.problems.set(NO_PROBLEMS);
    this.api.replace(w.id, inputOf(d)).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.adopt(saved);
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

  private adopt(w: Watcher): void {
    this.watcher.set(w);
    this.draft.set(draftOf(w));
    this.problems.set(NO_PROBLEMS);
    this.editors.setDirty(this.tabId(), false);
  }
}

/**
 * Open a watcher's tab. Here, not in the list view: the editor area defers each editor kind, and
 * an eager import of an editor module would pull it back into the initial bundle.
 */
export function openWatcher(editors: EditorStore, watcher: Pick<Watcher, 'id' | 'name'>): void {
  editors.open({ type: 'watcher', resourceId: watcher.id, title: watcher.name, icon: '⌖' });
}
