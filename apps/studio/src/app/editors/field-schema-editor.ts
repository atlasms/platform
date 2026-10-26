import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { FieldSchemasService } from '../core/field-schemas.service.ts';
import type { FieldSchema } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { VOCABULARY_NAMES } from '../core/vocabularies.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import {
  FIELD_GROUPS,
  FIELD_TYPES,
  blankRow,
  draftOf,
  inputOf,
  moved,
  problemsByPath,
  renamed,
  type FieldRow,
  type SchemaDraft,
} from './field-schema.model.ts';

/**
 * A field schema as an editor tab (EP-27.4; Admin › Field schemas): where it applies, and its
 * fields — each a name, a label, a type and what that type takes (an enum's options, a
 * vocabulary, a text bound), whether it is required, its field group, its help. Rows are added,
 * reordered and removed; the whole schema is saved over the version read. MAM judges it — its 422
 * names every problem by path, and each is shown under the control it is about; a 409 is someone
 * else's save, read again, never overwritten. A RENAMED field is warned about before saving: the
 * values assets hold under the old name become orphaned (kept, but no longer governed).
 */
@Component({
  selector: 'atlas-field-schema-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (draft(); as d) {
      <header class="toolbar">
        <h2>{{ d.mediaType }} · {{ d.categoryPath || locale.t('admin.wholeChannel') }}</h2>
        <span class="muted">v{{ schema()?.version ?? 1 }}</span>
        @if (canEdit()) {
          <span class="actions">
            <button type="button" [disabled]="busy() || !dirty()" (click)="save()">
              {{ locale.t('schemaEditor.save') }}
            </button>
            <button type="button" class="link" [disabled]="busy() || !dirty()" (click)="load()">
              {{ locale.t('schemaEditor.revert') }}
            </button>
          </span>
        } @else {
          <span class="muted">{{ locale.t('schemaEditor.readOnly') }}</span>
        }
      </header>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="notice" role="status">{{ notice() }}</p>
      }
      @if (renames().length > 0) {
        <p class="warning" role="status">
          {{ locale.t('schemaEditor.renameWarning') }}
          @for (r of renames(); track r.readName) {
            <code>{{ r.readName }}</code>
          }
        </p>
      }
      @for (p of problemsAt(''); track p) {
        <p class="error">{{ p }}</p>
      }

      <div class="scope">
        <label>
          <span>{{ locale.t('admin.mediaType') }}</span>
          <input
            [value]="d.mediaType"
            [disabled]="!canEdit()"
            (input)="setScope('mediaType', $any($event.target).value)"
          />
          @for (p of problemsAt('mediaType'); track p) {
            <span class="problem">{{ p }}</span>
          }
        </label>
        <label>
          <span>{{ locale.t('admin.appliesTo') }}</span>
          <input
            [value]="d.categoryPath"
            [disabled]="!canEdit()"
            [placeholder]="locale.t('admin.wholeChannel')"
            (input)="setScope('categoryPath', $any($event.target).value)"
          />
          @for (p of problemsAt('categoryPath'); track p) {
            <span class="problem">{{ p }}</span>
          }
        </label>
      </div>

      <ol class="fields">
        @for (row of d.fields; track $index; let i = $index) {
          <li class="field" [attr.data-type]="row.type">
            <div class="row-head">
              <strong>{{ row.label || row.name || locale.t('schemaEditor.newField') }}</strong>
              @if (canEdit()) {
                <span class="row-actions">
                  <button
                    type="button"
                    class="link"
                    [disabled]="i === 0"
                    [attr.aria-label]="locale.t('schemaEditor.up')"
                    (click)="move(i, -1)"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="link"
                    [disabled]="i === d.fields.length - 1"
                    [attr.aria-label]="locale.t('schemaEditor.down')"
                    (click)="move(i, 1)"
                  >
                    ↓
                  </button>
                  <button type="button" class="link danger" (click)="remove(i)">
                    {{ locale.t('schemaEditor.remove') }}
                  </button>
                </span>
              }
            </div>
            <div class="grid">
              <label>
                <span>{{ locale.t('schemaEditor.name') }}</span>
                <input
                  [value]="row.name"
                  [disabled]="!canEdit()"
                  (input)="set(i, 'name', $any($event.target).value)"
                />
                @for (p of problemsAt('fields[' + i + '].name'); track p) {
                  <span class="problem">{{ p }}</span>
                }
              </label>
              <label>
                <span>{{ locale.t('schemaEditor.label') }}</span>
                <input
                  [value]="row.label"
                  [disabled]="!canEdit()"
                  (input)="set(i, 'label', $any($event.target).value)"
                />
                @for (p of problemsAt('fields[' + i + '].label'); track p) {
                  <span class="problem">{{ p }}</span>
                }
              </label>
              <label>
                <span>{{ locale.t('schemaEditor.type') }}</span>
                <select
                  [disabled]="!canEdit()"
                  (change)="set(i, 'type', $any($event.target).value)"
                >
                  @for (t of types; track t) {
                    <option [value]="t" [selected]="row.type === t">
                      {{ locale.t('schemaEditor.types.' + t) }}
                    </option>
                  }
                </select>
                @for (p of problemsAt('fields[' + i + '].type'); track p) {
                  <span class="problem">{{ p }}</span>
                }
              </label>
              <label>
                <span>{{ locale.t('schemaEditor.group') }}</span>
                <select
                  [disabled]="!canEdit()"
                  (change)="set(i, 'fieldGroup', $any($event.target).value)"
                >
                  <option value="" [selected]="row.fieldGroup === ''">core</option>
                  @for (g of groups; track g) {
                    @if (g !== 'core') {
                      <option [value]="g" [selected]="row.fieldGroup === g">{{ g }}</option>
                    }
                  }
                </select>
                @for (p of problemsAt('fields[' + i + '].fieldGroup'); track p) {
                  <span class="problem">{{ p }}</span>
                }
              </label>
              @if (row.type === 'enum') {
                <label class="wide">
                  <span>{{ locale.t('schemaEditor.options') }}</span>
                  <textarea
                    rows="3"
                    [value]="row.options"
                    [disabled]="!canEdit()"
                    (input)="set(i, 'options', $any($event.target).value)"
                  ></textarea>
                  @for (p of problemsAt('fields[' + i + '].options'); track p) {
                    <span class="problem">{{ p }}</span>
                  }
                </label>
              }
              @if (row.type === 'vocabulary') {
                <label>
                  <span>{{ locale.t('schemaEditor.vocabulary') }}</span>
                  <input
                    [value]="row.vocabulary"
                    [disabled]="!canEdit()"
                    list="schema-vocabularies"
                    (input)="set(i, 'vocabulary', $any($event.target).value)"
                  />
                  @for (p of problemsAt('fields[' + i + '].vocabulary'); track p) {
                    <span class="problem">{{ p }}</span>
                  }
                </label>
              }
              @if (row.type === 'string' || row.type === 'text') {
                <label>
                  <span>{{ locale.t('schemaEditor.maxLength') }}</span>
                  <input
                    type="number"
                    min="1"
                    [value]="row.maxLength"
                    [disabled]="!canEdit()"
                    (input)="set(i, 'maxLength', $any($event.target).value)"
                  />
                  @for (p of problemsAt('fields[' + i + '].maxLength'); track p) {
                    <span class="problem">{{ p }}</span>
                  }
                </label>
              }
              <label class="check">
                <input
                  type="checkbox"
                  [checked]="row.required"
                  [disabled]="!canEdit()"
                  (change)="set(i, 'required', $any($event.target).checked)"
                />
                {{ locale.t('schemaEditor.required') }}
              </label>
              <label class="wide">
                <span>{{ locale.t('schemaEditor.helpText') }}</span>
                <input
                  [value]="row.helpText"
                  [disabled]="!canEdit()"
                  (input)="set(i, 'helpText', $any($event.target).value)"
                />
              </label>
            </div>
            @for (p of problemsAt('fields[' + i + ']'); track p) {
              <span class="problem">{{ p }}</span>
            }
          </li>
        }
      </ol>
      <datalist id="schema-vocabularies">
        @for (v of vocabularies; track v) {
          <option [value]="v"></option>
        }
      </datalist>
      @if (canEdit()) {
        <button type="button" class="add" (click)="add()">
          {{ locale.t('schemaEditor.addField') }}
        </button>
      }
    } @else if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else {
      <p class="muted">{{ locale.t('editor.loading') }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: var(--space-2);
      overflow: auto;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: baseline;
      margin-block-end: var(--space-2);
    }
    .toolbar h2 {
      margin: 0;
      font-size: 1rem;
    }
    .actions {
      margin-inline-start: auto;
      display: flex;
      gap: var(--space-1);
    }
    .scope,
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: var(--space-2);
    }
    .fields {
      margin: var(--space-2) 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .field {
      padding: var(--space-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .row-head {
      display: flex;
      justify-content: space-between;
      margin-block-end: var(--space-1);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    label.check {
      flex-direction: row;
      align-items: center;
      gap: var(--space-1);
    }
    label.wide {
      grid-column: 1 / -1;
    }
    input,
    select,
    textarea {
      padding: var(--space-1);
      color: var(--color-fg);
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
    }
    button {
      padding: var(--space-1) var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
      cursor: pointer;
    }
    button.link {
      padding: 0 var(--space-1);
      background: none;
    }
    button.danger {
      color: var(--color-danger);
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .problem,
    .error {
      color: var(--color-danger);
    }
    .warning {
      color: var(--color-warning);
    }
    .notice {
      color: var(--color-success);
    }
    .muted {
      color: var(--color-fg-muted);
    }
    code {
      margin-inline-start: var(--space-1);
    }
  `,
})
export class FieldSchemaEditor implements OnInit {
  readonly schemaId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(FieldSchemasService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  private readonly session = inject(SessionStore);
  protected readonly locale = inject(LocaleService);

  protected readonly types = FIELD_TYPES;
  protected readonly groups = FIELD_GROUPS;
  protected readonly vocabularies = VOCABULARY_NAMES;

  protected readonly schema = signal<FieldSchema | null>(null);
  protected readonly draft = signal<SchemaDraft | null>(null);
  private readonly saved = signal<string | null>(null);
  protected readonly problems = signal<Record<string, string[]>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  /** UX only — MAM enforces `taxonomy:admin`. */
  protected readonly canEdit = computed(() => {
    this.session.policy(); // the dependency; the check reads it internally
    return this.permissions.can('taxonomy:admin');
  });
  protected readonly dirty = computed(() => {
    const d = this.draft();
    return !!d && this.saved() !== null && JSON.stringify(d) !== this.saved();
  });
  protected readonly renames = computed(() => {
    const d = this.draft();
    return d ? renamed(d) : [];
  });

  constructor() {
    // `setDirty` reads the layout it writes: untracked, or the effect never settles (AGENTS.md).
    effect(() => {
      const tabId = this.tabId();
      const dirty = this.dirty();
      untracked(() => this.editors.setDirty(tabId, dirty));
    });
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.error.set(null);
    this.problems.set({});
    this.api.list().subscribe({
      next: (all) => {
        const found = all.find((s) => s.id === this.schemaId());
        if (!found) {
          this.error.set(this.locale.t('schemaEditor.gone'));
          return;
        }
        this.show(found);
      },
      error: () => this.error.set(this.locale.t('admin.loadError')),
    });
  }

  private show(schema: FieldSchema): void {
    const d = draftOf(schema);
    this.schema.set(schema);
    this.draft.set(d);
    this.saved.set(JSON.stringify(d));
  }

  protected problemsAt(path: string): string[] {
    return this.problems()[path] ?? [];
  }

  protected setScope(key: 'mediaType' | 'categoryPath', value: string): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
  }

  protected set<K extends keyof FieldRow>(index: number, key: K, value: FieldRow[K]): void {
    this.draft.update((d) =>
      d
        ? { ...d, fields: d.fields.map((row, i) => (i === index ? { ...row, [key]: value } : row)) }
        : d,
    );
  }

  add(): void {
    this.draft.update((d) => (d ? { ...d, fields: [...d.fields, blankRow()] } : d));
  }

  remove(index: number): void {
    this.draft.update((d) => (d ? { ...d, fields: d.fields.filter((_, i) => i !== index) } : d));
  }

  move(index: number, by: -1 | 1): void {
    this.draft.update((d) => (d ? { ...d, fields: moved(d.fields, index, by) } : d));
  }

  /** The whole schema, over the version read. */
  save(): void {
    const s = this.schema();
    const d = this.draft();
    if (!s?.id || !d || !this.dirty() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.problems.set({});
    this.notice.set(null);
    this.api.put(inputOf(d, s.id), s.version ?? 1).subscribe({
      next: (stored) => {
        this.busy.set(false);
        this.show(stored);
        this.notice.set(this.locale.t('schemaEditor.saved'));
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (!(err instanceof HttpErrorResponse)) {
          this.error.set(this.locale.t('schemaEditor.saveError'));
          return;
        }
        const body = err.error as { detail?: unknown; details?: unknown } | null;
        if (err.status === 422) {
          this.problems.set(problemsByPath(body?.details));
          this.error.set(this.locale.t('schemaEditor.invalid'));
        } else if (err.status === 409) {
          // Someone saved in between: read theirs; never write over it.
          this.load();
          this.error.set(this.locale.t('schemaEditor.moved'));
        } else {
          this.error.set(
            typeof body?.detail === 'string'
              ? body.detail
              : this.locale.t('schemaEditor.saveError'),
          );
        }
      },
    });
  }
}
