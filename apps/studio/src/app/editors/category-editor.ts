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
import type {
  Category,
  CategoryInheritance,
  MediaDefaultField,
  UpdateCategoryInput,
  VocabularyTerm,
} from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import {
  TERM_FIELD_VOCABULARY,
  termLabel,
  VocabulariesService,
  type TermField,
} from '../core/vocabularies.service.ts';

/** The media defaults a category may set (EP-28.2) — the order the editor shows them in. */
const DEFAULT_FIELDS: readonly MediaDefaultField[] = [
  'structureId',
  'genre',
  'supplyType',
  'productionGroup',
  'productionDate',
];
type Policy = 'reviewNeeded' | 'keepDuration' | 'defaultExpiry';

export interface CategoryDraft {
  en: string;
  ar: string;
  kind: string;
  sortOrder: number;
  description: string;
  mediaAddable: boolean;
  /** '' = this node does not set it, so it inherits. */
  defaults: Record<MediaDefaultField, string>;
  /** '' inherits; 'true' / 'false' set it. */
  reviewNeeded: '' | 'true' | 'false';
  keepDuration: string;
  defaultExpiry: string;
}

export const draftOf = (c: Category): CategoryDraft => {
  const labels = c.labels as Record<string, string>;
  const own = (c.defaults ?? {}) as Partial<Record<MediaDefaultField, string>>;
  return {
    en: labels['en'] ?? '',
    ar: labels['ar'] ?? '',
    kind: c.kind ?? '',
    sortOrder: c.sortOrder,
    description: c.description ?? '',
    mediaAddable: c.mediaAddable,
    defaults: Object.fromEntries(DEFAULT_FIELDS.map((f) => [f, own[f] ?? ''])) as Record<
      MediaDefaultField,
      string
    >,
    reviewNeeded: c.reviewNeeded === undefined ? '' : c.reviewNeeded ? 'true' : 'false',
    keepDuration: c.keepDuration ?? '',
    defaultExpiry: c.defaultExpiry ?? '',
  };
};

/** The PATCH body: only what changed, labels whole (MAM replaces the map). */
export function patchOf(before: Category, d: CategoryDraft): UpdateCategoryInput {
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
  // A default or policy emptied is no longer set HERE: it inherits again (`inherit`).
  const inherit: NonNullable<UpdateCategoryInput['inherit']> = [];
  const defaults: Partial<Record<MediaDefaultField, string>> = {};
  for (const f of DEFAULT_FIELDS) {
    if (d.defaults[f] === was.defaults[f]) continue;
    if (d.defaults[f].trim() === '') inherit.push(f);
    else defaults[f] = d.defaults[f].trim();
  }
  if (Object.keys(defaults).length > 0) patch.defaults = defaults;
  if (d.reviewNeeded !== was.reviewNeeded) {
    if (d.reviewNeeded === '') inherit.push('reviewNeeded');
    else patch.reviewNeeded = d.reviewNeeded === 'true';
  }
  for (const f of ['keepDuration', 'defaultExpiry'] as const) {
    if (d[f] === was[f]) continue;
    if (d[f].trim() === '') inherit.push(f);
    else patch[f] = d[f].trim();
  }
  if (inherit.length > 0) patch.inherit = inherit;
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

          <h3>{{ locale.t('categories.defaults') }}</h3>
          <p class="muted">{{ locale.t('categories.defaultsWhy') }}</p>
          <fieldset class="fields" [disabled]="!mayGroup('defaults')">
            <label>
              <span>{{ locale.t('categories.default.structureId') }}</span>
              <!-- EP-28.3: a term of the vocabulary; empty inherits from above. -->
              <select
                name="default-structureId"
                [ngModel]="d().defaults.structureId"
                (ngModelChange)="setDefault('structureId', $event)"
              >
                <option value="">{{ inheritOption('structureId') }}</option>
                @if (d().defaults.structureId && !isLive('structureId', d().defaults.structureId)) {
                  <option [value]="d().defaults.structureId">
                    {{ termName('structureId', d().defaults.structureId) }}
                  </option>
                }
                @for (t of liveTerms('structureId'); track t.id) {
                  <option [value]="t.id">{{ termName('structureId', t.id) }}</option>
                }
              </select>
              @if (origin('structureId'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('categories.default.genre') }}</span>
              <!-- EP-28.3: a term of the vocabulary; empty inherits from above. -->
              <select
                name="default-genre"
                [ngModel]="d().defaults.genre"
                (ngModelChange)="setDefault('genre', $event)"
              >
                <option value="">{{ inheritOption('genre') }}</option>
                @if (d().defaults.genre && !isLive('genre', d().defaults.genre)) {
                  <option [value]="d().defaults.genre">
                    {{ termName('genre', d().defaults.genre) }}
                  </option>
                }
                @for (t of liveTerms('genre'); track t.id) {
                  <option [value]="t.id">{{ termName('genre', t.id) }}</option>
                }
              </select>
              @if (origin('genre'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('categories.default.supplyType') }}</span>
              <!-- EP-28.3: a term of the vocabulary; empty inherits from above. -->
              <select
                name="default-supplyType"
                [ngModel]="d().defaults.supplyType"
                (ngModelChange)="setDefault('supplyType', $event)"
              >
                <option value="">{{ inheritOption('supplyType') }}</option>
                @if (d().defaults.supplyType && !isLive('supplyType', d().defaults.supplyType)) {
                  <option [value]="d().defaults.supplyType">
                    {{ termName('supplyType', d().defaults.supplyType) }}
                  </option>
                }
                @for (t of liveTerms('supplyType'); track t.id) {
                  <option [value]="t.id">{{ termName('supplyType', t.id) }}</option>
                }
              </select>
              @if (origin('supplyType'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('categories.default.productionGroup') }}</span>
              <!-- EP-28.3: a term of the vocabulary; empty inherits from above. -->
              <select
                name="default-productionGroup"
                [ngModel]="d().defaults.productionGroup"
                (ngModelChange)="setDefault('productionGroup', $event)"
              >
                <option value="">{{ inheritOption('productionGroup') }}</option>
                @if (
                  d().defaults.productionGroup &&
                  !isLive('productionGroup', d().defaults.productionGroup)
                ) {
                  <option [value]="d().defaults.productionGroup">
                    {{ termName('productionGroup', d().defaults.productionGroup) }}
                  </option>
                }
                @for (t of liveTerms('productionGroup'); track t.id) {
                  <option [value]="t.id">{{ termName('productionGroup', t.id) }}</option>
                }
              </select>
              @if (origin('productionGroup'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('categories.default.productionDate') }}</span>
              <input
                name="default-productionDate"
                type="date"
                [placeholder]="inherited('productionDate')"
                [ngModel]="d().defaults.productionDate"
                (ngModelChange)="setDefault('productionDate', $event)"
              />
              @if (origin('productionDate'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
            </label>
          </fieldset>

          <h3>{{ locale.t('categories.policies') }}</h3>
          <fieldset class="fields" [disabled]="!mayGroup('policies')">
            <label>
              <span>{{ locale.t('categories.reviewNeeded') }}</span>
              <select
                name="reviewNeeded"
                [ngModel]="d().reviewNeeded"
                (ngModelChange)="set('reviewNeeded', $event)"
              >
                <option value="">
                  {{ locale.t('categories.inherit') }}{{ inheritedReview() }}
                </option>
                <option value="true">{{ locale.t('categories.yes') }}</option>
                <option value="false">{{ locale.t('categories.no') }}</option>
              </select>
            </label>
            <label>
              <span>{{ locale.t('categories.keepDuration') }}</span>
              <input
                name="keepDuration"
                [placeholder]="inherited('keepDuration') || 'P30D'"
                [ngModel]="d().keepDuration"
                (ngModelChange)="set('keepDuration', $event)"
              />
              @if (origin('keepDuration'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
            </label>
            <label>
              <span>{{ locale.t('categories.defaultExpiry') }}</span>
              <input
                name="defaultExpiry"
                [placeholder]="inherited('defaultExpiry') || 'P1Y'"
                [ngModel]="d().defaultExpiry"
                (ngModelChange)="set('defaultExpiry', $event)"
              />
              @if (origin('defaultExpiry'); as from) {
                <small class="muted">{{ locale.t('categories.inheritedFrom') }} {{ from }}</small>
              }
              <small class="muted">{{ locale.t('categories.defaultExpiryWhy') }}</small>
            </label>
          </fieldset>
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
  /** What this node inherits from its ancestors (EP-28.2) — the placeholders and their origin. */
  private readonly inheritance = signal<CategoryInheritance | null>(null);
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
  /** Defaults and policies are their own field groups (UX only — MAM enforces them). */
  protected mayGroup(group: 'defaults' | 'policies'): boolean {
    const c = this.category();
    return (
      !!c && this.permissions.can('taxonomy:admin', { categoryPath: c.path, fieldGroup: group })
    );
  }
  protected readonly inheritedReview = computed(() => {
    const r = this.inheritance()?.policies.reviewNeeded;
    return r
      ? ` — ${this.locale.t(r.value ? 'categories.yes' : 'categories.no')} (${r.from.path})`
      : '';
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
    for (const [field, vocabulary] of Object.entries(TERM_FIELD_VOCABULARY) as [
      TermField,
      (typeof TERM_FIELD_VOCABULARY)[TermField],
    ][]) {
      this.vocabularies.list(vocabulary, true).subscribe({
        next: (list) => this.terms.update((t) => ({ ...t, [field]: list })),
        error: () => undefined,
      });
    }
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

  /** The terms each term default offers (EP-28.3) — deprecated too, to name an old value. */
  private readonly vocabularies = inject(VocabulariesService);
  private readonly terms = signal<Partial<Record<TermField, VocabularyTerm[]>>>({});

  protected liveTerms(field: TermField): VocabularyTerm[] {
    return (this.terms()[field] ?? []).filter((t) => !t.deprecatedAt);
  }

  protected isLive(field: TermField, id: string): boolean {
    return this.liveTerms(field).some((t) => t.id === id);
  }

  protected termName(field: TermField, id: string): string {
    const term = (this.terms()[field] ?? []).find((t) => t.id === id);
    if (!term) return id;
    const name = termLabel(term, this.locale.locale());
    return term.deprecatedAt ? `${name} (${this.locale.t('categories.deprecated')})` : name;
  }

  /** The empty choice: what this node would inherit for the field, or that nothing is set. */
  protected inheritOption(field: TermField): string {
    const value = this.inherited(field);
    return value
      ? `${this.locale.t('categories.inherit')} — ${this.termName(field, value)}`
      : this.locale.t('categories.inherit');
  }

  /** The value this node would inherit for a field, or ''. */
  protected inherited(field: MediaDefaultField | Policy): string {
    const i = this.inheritance();
    const hit =
      field === 'reviewNeeded' || field === 'keepDuration' || field === 'defaultExpiry'
        ? i?.policies[field]
        : i?.defaults[field];
    return hit === undefined ? '' : String(hit.value);
  }

  /** Where an inherited value is set — shown only while this node does not set its own. */
  protected origin(field: MediaDefaultField | Policy): string | null {
    const d = this.draft();
    if (!d) return null;
    const own =
      field === 'reviewNeeded' || field === 'keepDuration' || field === 'defaultExpiry'
        ? d[field]
        : d.defaults[field];
    if (own !== '') return null;
    const i = this.inheritance();
    const hit =
      field === 'reviewNeeded' || field === 'keepDuration' || field === 'defaultExpiry'
        ? i?.policies[field]
        : i?.defaults[field];
    return hit?.from.path ?? null;
  }

  protected setDefault(field: MediaDefaultField, value: string): void {
    this.draft.update((d) => (d ? { ...d, defaults: { ...d.defaults, [field]: value } } : d));
    this.editors.setDirty(this.tabId(), this.dirty());
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
    // What it inherits depends on where it is, so it is read again after every write (a move).
    this.api.inherited(c.id).subscribe({
      next: (i) => this.inheritance.set(i),
      error: () => this.inheritance.set(null),
    });
  }
}
