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
import { CategoriesService } from '../core/categories.service.ts';
import { categoryLabel, moveTargets } from '../core/category-tree.ts';
import type { Category, UpdateCategoryInput } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

interface CategoryDraft {
  en: string;
  ar: string;
  kind: string;
  sortOrder: number;
  description: string;
  mediaAddable: boolean;
}

const draftOf = (c: Category): CategoryDraft => {
  const labels = c.labels as Record<string, string>;
  return {
    en: labels['en'] ?? '',
    ar: labels['ar'] ?? '',
    kind: c.kind ?? '',
    sortOrder: c.sortOrder,
    description: c.description ?? '',
    mediaAddable: c.mediaAddable,
  };
};

/** The PATCH body: only what changed, labels whole (MAM replaces the map). */
function patchOf(before: Category, d: CategoryDraft): UpdateCategoryInput {
  const was = draftOf(before);
  const patch: UpdateCategoryInput = {};
  if (d.en !== was.en || d.ar !== was.ar) {
    const labels: Record<string, string> = { ...(before.labels as Record<string, string>) };
    if (d.en.trim()) labels['en'] = d.en.trim();
    else delete labels['en'];
    if (d.ar.trim()) labels['ar'] = d.ar.trim();
    else delete labels['ar'];
    patch.labels = labels;
  }
  if (d.kind !== was.kind) patch.kind = d.kind.trim();
  if (d.sortOrder !== was.sortOrder) patch.sortOrder = d.sortOrder;
  if (d.description !== was.description) patch.description = d.description;
  if (d.mediaAddable !== was.mediaAddable) patch.mediaAddable = d.mediaAddable;
  return patch;
}

/** Open a category as an editor tab. */
export function openCategory(editors: EditorStore, category: Category, locale: string): void {
  editors.open({
    type: 'category',
    resourceId: category.id,
    title: categoryLabel(category, locale),
    icon: '▦',
  });
}

/**
 * A category, as an editor tab (#260; data-model.md §2.6). Its labels, kind, order, description
 * and whether media may go in it directly — saved over the version read, a 409 being a reload,
 * never a retry. Its KEY is shown and never editable: the path is built from keys. Deprecation and
 * the MOVE are separate actions, because each changes more than this row: deprecating takes the
 * branch out of pickers, and a move re-roots the whole subtree — so the move names its consequence
 * for grants before it is confirmed. MAM decides; this decides what to show.
 */
@Component({
  selector: 'atlas-category-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (loadError()) {
      <p class="error" role="alert">{{ loadError() }}</p>
    } @else if (!category()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else {
      <header class="head">
        <h2>{{ title() }}</h2>
        <code class="path">{{ category()!.path }}</code>
        <span class="state">v{{ category()!.version }}</span>
        @if (category()!.deprecatedAt) {
          <span class="state" data-state="disabled">{{ locale.t('categories.deprecated') }}</span>
        }
      </header>
      @if (conflict()) {
        <p class="error" role="alert">
          {{ locale.t('categories.conflict') }}
          <button type="button" class="link" (click)="reload()">
            {{ locale.t('categories.reload') }}
          </button>
        </p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <form (ngSubmit)="save()">
        <fieldset [disabled]="readOnly() || busy()">
          <div class="fields">
            <label>
              <span>{{ locale.t('categories.key') }}</span>
              <input name="key" [value]="category()!.key" disabled />
              <small class="muted">{{ locale.t('categories.keyFixed') }}</small>
            </label>
            <label>
              <span>{{ locale.t('categories.labelEn') }}</span>
              <input name="en" [ngModel]="d().en" (ngModelChange)="set('en', $event)" />
            </label>
            <label>
              <span>{{ locale.t('categories.labelAr') }}</span>
              <input name="ar" dir="rtl" [ngModel]="d().ar" (ngModelChange)="set('ar', $event)" />
            </label>
            <label>
              <span>{{ locale.t('categories.kind') }}</span>
              <input
                name="kind"
                placeholder="program"
                [ngModel]="d().kind"
                (ngModelChange)="set('kind', $event)"
              />
            </label>
            <label>
              <span>{{ locale.t('categories.sortOrder') }}</span>
              <input
                name="sortOrder"
                type="number"
                step="1"
                [ngModel]="d().sortOrder"
                (ngModelChange)="set('sortOrder', +$event)"
              />
            </label>
            <label>
              <span>{{ locale.t('categories.description') }}</span>
              <input
                name="description"
                [ngModel]="d().description"
                (ngModelChange)="set('description', $event)"
              />
            </label>
            <label class="check">
              <input
                type="checkbox"
                name="mediaAddable"
                [ngModel]="d().mediaAddable"
                (ngModelChange)="set('mediaAddable', $event)"
              />
              <span>{{ locale.t('categories.mediaAddable') }}</span>
            </label>
          </div>
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
          <h3>{{ locale.t('categories.move') }}</h3>
          <p class="muted">{{ locale.t('categories.moveWhy') }}</p>
          <div class="row">
            <select
              name="target"
              [disabled]="busy()"
              [ngModel]="target()"
              (ngModelChange)="target.set($event)"
            >
              <option value="">{{ locale.t('categories.chooseParent') }}</option>
              @if (category()!.parentId) {
                <option value="(root)">{{ locale.t('categories.root') }}</option>
              }
              @for (c of targets(); track c.id) {
                <option [value]="c.id">{{ c.path }}</option>
              }
            </select>
            <button type="button" [disabled]="busy() || !target()" (click)="move()">
              {{ locale.t('categories.moveConfirm') }}
            </button>
          </div>
          @if (target()) {
            <p class="warning" role="note">
              {{ locale.t('categories.moveGrants') }} {{ category()!.path }} →
              {{ destination() }}
            </p>
          }
        </section>

        <section>
          <h3>{{ locale.t('admin.danger') }}</h3>
          <div class="row">
            @if (category()!.deprecatedAt) {
              <button type="button" [disabled]="busy()" (click)="deprecate(false)">
                {{ locale.t('categories.restore') }}
              </button>
            } @else {
              <button type="button" class="danger" [disabled]="busy()" (click)="deprecate(true)">
                {{ locale.t('categories.deprecate') }}
              </button>
            }
            <span class="muted">{{ locale.t('categories.deprecateWhy') }}</span>
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
    .fields label.check {
      display: flex;
      gap: var(--space-1);
      align-items: center;
    }
    .path {
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    .warning {
      color: var(--color-warning);
      font-size: 0.8125rem;
    }
    .actions {
      margin-block-start: var(--space-3);
    }
  `,
})
export class CategoryEditor implements OnInit {
  readonly categoryId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(CategoriesService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly category = signal<Category | null>(null);
  private readonly all = signal<Category[]>([]);
  private readonly draft = signal<CategoryDraft | null>(null);
  protected readonly target = signal('');
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly conflict = signal(false);
  protected readonly busy = signal(false);

  protected readonly d = computed(() => this.draft()!);
  protected readonly title = computed(() => {
    const c = this.category();
    return c ? categoryLabel(c, this.locale.locale()) : '';
  });
  /** UX only — MAM enforces `taxonomy:admin` over the path, strictly. */
  protected readonly readOnly = computed(() => {
    const c = this.category();
    return !c || !this.permissions.can('taxonomy:admin', { categoryPath: c.path });
  });
  protected readonly dirty = computed(() => {
    const c = this.category();
    const d = this.draft();
    return !!c && !!d && Object.keys(patchOf(c, d)).length > 0;
  });
  protected readonly targets = computed(() => {
    const c = this.category();
    return c ? moveTargets(this.all(), c) : [];
  });
  protected readonly destination = computed(() => {
    const c = this.category();
    const t = this.target();
    if (!c || !t) return '';
    const parent = this.all().find((x) => x.id === t);
    return `${parent?.path ?? '/'}${c.key}/`;
  });

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.conflict.set(false);
    this.error.set(null);
    this.api.get(this.categoryId()).subscribe({
      next: (c) => this.adopt(c),
      error: () => this.loadError.set(this.locale.t('admin.loadError')),
    });
    this.api.list(true).subscribe({ next: (all) => this.all.set(all), error: () => undefined });
  }

  protected set<K extends keyof CategoryDraft>(key: K, value: CategoryDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
  }

  protected revert(): void {
    const c = this.category();
    if (c) this.adopt(c);
  }

  protected save(): void {
    const c = this.category();
    const d = this.draft();
    if (!c || !d || !this.dirty() || this.busy() || this.readOnly()) return;
    this.write(this.api.update(c.id, c.version, patchOf(c, d)));
  }

  protected deprecate(deprecated: boolean): void {
    const c = this.category();
    if (!c || this.busy() || this.readOnly()) return;
    this.write(this.api.update(c.id, c.version, { deprecated }));
  }

  protected move(): void {
    const c = this.category();
    const t = this.target();
    if (!c || !t || this.busy() || this.readOnly()) return;
    this.write(this.api.move(c.id, t === '(root)' ? null : t, c.version), () =>
      this.target.set(''),
    );
  }

  private write(request: ReturnType<CategoriesService['update']>, then?: () => void): void {
    this.busy.set(true);
    this.error.set(null);
    this.conflict.set(false);
    request.subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.adopt(saved);
        then?.();
        this.api.list(true).subscribe({ next: (all) => this.all.set(all), error: () => undefined });
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        if (err.status === 409 && /changed since version/.test(err.error?.message ?? '')) {
          this.conflict.set(true);
        } else this.error.set(err.error?.message ?? this.locale.t('admin.writeError'));
      },
    });
  }

  private adopt(c: Category): void {
    this.category.set(c);
    this.draft.set(draftOf(c));
    this.editors.setDirty(this.tabId(), false);
  }
}
