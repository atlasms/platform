import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CategoriesService } from '../../core/categories.service.ts';
import { FieldSchemasService } from '../../core/field-schemas.service.ts';
import type { Category, FieldSchema } from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { ulid } from '../../core/ulid.ts';
import { EditorStore } from '../../workbench/editor.store.ts';

/** What the media-type box suggests; MAM takes any media type slug. */
export const MEDIA_TYPE_SUGGESTIONS = ['video', 'audio', 'image', 'document'];

/**
 * The Admin panel's **Field schemas** view (EP-27.4; studio-frontend.md §1): the channel's custom
 * field schemas — where each applies (a media type, narrowed to a category branch) and how many
 * fields it defines — and a new one, which opens as an EDITOR TAB (field-schema-editor.ts) where
 * the fields are. `taxonomy:admin` reveals it; MAM enforces it.
 */
@Component({
  selector: 'atlas-schemas-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <details class="new" [open]="creating()">
      <summary (click)="creating.set(!creating()); $event.preventDefault()">
        {{ locale.t('admin.newSchema') }}
      </summary>
      <form (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('admin.mediaType') }}</span>
          <input name="mediaType" [(ngModel)]="mediaType" list="schema-media-types" required />
          <datalist id="schema-media-types">
            @for (m of mediaTypes; track m) {
              <option [value]="m"></option>
            }
          </datalist>
        </label>
        <label>
          <span>{{ locale.t('admin.appliesTo') }}</span>
          <select name="categoryPath" [(ngModel)]="categoryPath">
            <option value="">{{ locale.t('admin.wholeChannel') }}</option>
            @for (c of categories(); track c.id) {
              <option [value]="c.path">{{ c.path }}</option>
            }
          </select>
        </label>
        @if (createError()) {
          <p class="error" role="alert">{{ createError() }}</p>
        }
        <button type="submit" [disabled]="busy() || !mediaType.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    </details>

    <p class="mode">{{ locale.t('admin.schemas') }}</p>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (schemas().length === 0) {
      <p class="muted">{{ locale.t('admin.noSchemas') }}</p>
    } @else {
      <ul class="items">
        @for (s of schemas(); track s.id) {
          <li>
            <button type="button" (click)="open(s)">
              <span class="title">{{ titleOf(s) }}</span>
              <span class="state">{{ s.fields.length }} {{ locale.t('admin.fieldsCount') }}</span>
            </button>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
})
export class SchemasView {
  private readonly api = inject(FieldSchemasService);
  private readonly categoriesApi = inject(CategoriesService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly mediaTypes = MEDIA_TYPE_SUGGESTIONS;
  protected readonly schemas = signal<FieldSchema[]>([]);
  protected readonly categories = signal<Category[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected mediaType = 'video';
  protected categoryPath = '';

  constructor() {
    this.load();
    this.categoriesApi.list().subscribe({
      next: (all) => this.categories.set(all),
      error: () => undefined, // no tree: a schema can still apply to the whole channel
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (schemas) => {
        this.schemas.set(schemas);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  /** "video · /sports/" — or "video · whole channel". */
  protected titleOf(s: FieldSchema): string {
    return `${s.mediaType} · ${s.categoryPath ?? this.locale.t('admin.wholeChannel')}`;
  }

  /** A new schema with no fields yet: its fields are edited in its tab. */
  protected create(): void {
    const mediaType = this.mediaType.trim();
    if (!mediaType || this.busy()) return;
    this.busy.set(true);
    this.createError.set(null);
    this.api
      .put({
        id: ulid(),
        mediaType,
        ...(this.categoryPath ? { categoryPath: this.categoryPath } : {}),
        fields: [],
      })
      .subscribe({
        next: (schema) => {
          this.schemas.update((list) => [...list, schema]);
          this.busy.set(false);
          this.creating.set(false);
          this.open(schema);
        },
        error: (err: { error?: { detail?: string; message?: string } }) => {
          this.createError.set(
            err.error?.detail ?? err.error?.message ?? this.locale.t('admin.createError'),
          );
          this.busy.set(false);
        },
      });
  }

  protected open(schema: FieldSchema): void {
    if (!schema.id) return;
    this.editors.open({
      type: 'field-schema',
      resourceId: schema.id,
      title: this.titleOf(schema),
      icon: '☷',
    });
  }
}
