import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { AssetsService } from '../core/assets.service.ts';
import { CategoriesService } from '../core/categories.service.ts';
import { categoryLabel } from '../core/category-tree.ts';
import type { Asset, VocabularyName } from '../core/generated/mam.types.ts';
import { termLabel, VocabulariesService } from '../core/vocabularies.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { LocaleService } from '../core/locale.service.ts';

/** The facets the panel offers chips for, in order (MAM's FACETS, less the bookkeeping ones). */
const SHOWN_FACETS = [
  'category',
  'genre',
  'subject',
  'classification',
  'structure',
  'supply-type',
  'production-group',
  'tag',
  'state',
] as const;
const FACET_VOCABULARIES: readonly VocabularyName[] = [
  'genre',
  'subject',
  'classification',
  'structure',
  'supply-type',
  'production-group',
];

@Component({
  selector: 'atlas-search-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="panel-title">{{ locale.t('search.title') }}</h2>

    <label class="search">
      <span class="visually-hidden">{{ locale.t('search.placeholder') }}</span>
      <input
        type="search"
        [placeholder]="locale.t('search.placeholder')"
        [value]="query()"
        (input)="onQuery($any($event.target).value)"
        (keydown.enter)="onEnter()"
        #queryField
      />
    </label>

    <!-- EP-28.6: the facets of the current page — a chip filters by it (AND across, OR within). -->
    @if (facetGroups().length > 0) {
      <div class="facets">
        @for (g of facetGroups(); track g.facet) {
          <div class="facet">
            <span class="facet-name">{{ locale.t('search.facet.' + g.facet) }}</span>
            @for (v of g.values; track v.value) {
              <button
                type="button"
                class="chip"
                [class.on]="v.selected"
                [attr.aria-pressed]="v.selected"
                (click)="toggle(g.facet, v.value)"
              >
                {{ label(g.facet, v.value) }} <span class="count">{{ v.count }}</span>
              </button>
            }
          </div>
        }
      </div>
    }

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('search.loading') }}</p>
    } @else if (assets().length === 0 && (query().trim() !== '' || filtering())) {
      <p class="muted">{{ locale.t('search.noResults') }}</p>
    } @else if (assets().length > 0) {
      <ul class="items">
        @for (asset of assets(); track asset.id) {
          <li>
            <button type="button" (click)="open(asset)">
              <span class="title">{{ asset.title }}</span>
              @if (asset.state) {
                <span class="state">{{ asset.state }}</span>
              }
            </button>
          </li>
        }
      </ul>
    } @else {
      <p class="muted">{{ locale.t('search.emptyHint') }}</p>
    }
  `,
  styles: `
    .facets {
      display: grid;
      gap: var(--space-1);
    }
    .facet {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
      font-size: 0.75rem;
    }
    .facet-name {
      color: var(--color-fg-muted);
    }
    .chip {
      border: 1px solid var(--color-border);
      border-radius: 999px;
      padding: 0 var(--space-2);
      background: none;
      color: inherit;
      font: inherit;
    }
    .chip.on {
      border-color: var(--color-accent);
      color: var(--color-accent);
    }
    .count {
      color: var(--color-fg-muted);
    }
    :host {
      display: grid;
      gap: 0.75rem;
      height: 100%;
      padding: 1rem;
      overflow-y: auto;
    }
    .panel-title {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
    }
    .search {
      position: relative;
    }
    .search input {
      width: 100%;
      box-sizing: border-box;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .muted {
      color: var(--color-fg-muted);
      font-size: 0.875rem;
      margin: 0;
    }
    .error {
      color: var(--color-danger);
      font-size: 0.875rem;
      margin: 0;
    }
    .items {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 0.25rem;
    }
    .items li button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      text-align: left;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: 4px;
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      transition:
        background 0.1s,
        border-color 0.1s;
    }
    .items li button:hover {
      background: var(--color-bg-hover);
      border-color: var(--color-border-hover);
    }
    .items li button:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
    .title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .state {
      font-size: 0.75rem;
      padding: 0.125rem 0.375rem;
      border-radius: 9999px;
      background: var(--color-bg-raised);
      color: var(--color-fg-muted);
      white-space: nowrap;
    }
    .actions {
      margin-top: 0.5rem;
      display: flex;
      gap: 0.5rem;
    }
    .actions button {
      flex: 1;
    }
  `,
})
export class SearchPanel {
  private readonly assetsApi = inject(AssetsService);
  private readonly categoriesApi = inject(CategoriesService);
  private readonly vocabularies = inject(VocabulariesService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);
  private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryField');

  constructor() {
    // Opening the Search panel is asking to type a query, so the field takes focus — as VS Code's
    // does. Not `autofocus`: a browser honours that once per document load, so it only ever worked
    // when Studio happened to load straight onto /search, never when the panel was opened.
    afterNextRender(() => this.queryInput()?.nativeElement.focus());
    // The names a facet chip shows: categories and the terms of every vocabulary that is a facet.
    // A failed read leaves the id on the chip, which still filters correctly.
    this.categoriesApi.list(true).subscribe({
      next: (all) =>
        this.names.update((n) => ({
          ...n,
          ...Object.fromEntries(all.map((c) => [c.id, categoryLabel(c, this.locale.locale())])),
        })),
      error: () => undefined,
    });
    for (const vocabulary of FACET_VOCABULARIES) {
      this.vocabularies.list(vocabulary, true).subscribe({
        next: (terms) =>
          this.names.update((n) => ({
            ...n,
            ...Object.fromEntries(terms.map((t) => [t.id, termLabel(t, this.locale.locale())])),
          })),
        error: () => undefined,
      });
    }
  }

  protected readonly assets = signal<Asset[]>([]);
  protected readonly query = signal('');
  /** The chosen facet values (EP-28.6). */
  protected readonly filters = signal<Record<string, string[]>>({});
  /** The counts the last page came back with. */
  private readonly counts = signal<Record<string, Record<string, number>>>({});
  /** Display names for term ids and category ids, read once. */
  private readonly names = signal<Record<string, string>>({});
  protected readonly filtering = computed(() =>
    Object.values(this.filters()).some((v) => v.length > 0),
  );
  /** Each facet with its values: those on the page with their counts, and any chosen ones. */
  protected readonly facetGroups = computed(() => {
    const counts = this.counts();
    const chosen = this.filters();
    return SHOWN_FACETS.map((facet) => {
      const values = new Map(Object.entries(counts[facet] ?? {}));
      for (const v of chosen[facet] ?? []) if (!values.has(v)) values.set(v, 0);
      return {
        facet,
        values: [...values].map(([value, count]) => ({
          value,
          count,
          selected: (chosen[facet] ?? []).includes(value),
        })),
      };
    }).filter((g) => g.values.length > 0);
  });
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * Guards against an out-of-order response overwriting a newer one — the same shape the media
   * panel uses, and for the same reason: typing "foo" fires three searches and they can return in
   * any order.
   */
  private requestId = 0;

  protected onQuery(value: string): void {
    this.query.set(value);
    this.run(++this.requestId, value);
  }

  protected toggle(facet: string, value: string): void {
    this.filters.update((f) => {
      const current = f[facet] ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...f, [facet]: next };
    });
    this.run(++this.requestId, this.query());
  }

  protected label(facet: string, value: string): string {
    return facet === 'tag' || facet === 'state' || facet === 'mediaType'
      ? value
      : (this.names()[value] ?? value);
  }

  protected onEnter(): void {
    // Re-runs the search rather than waiting for the debounce a future story will add. It MUST
    // take a new id: reusing the current one leaves two in-flight requests that both pass the
    // staleness check, and then the slower one wins — which is the exact race the id prevents.
    this.run(++this.requestId, this.query());
  }

  protected open(asset: Asset): void {
    this.editors.open({ type: 'asset', resourceId: asset.id, title: asset.title, icon: '▤' });
  }

  private run(id: number, q: string): void {
    const trimmed = q.trim();
    const facets = Object.fromEntries(
      Object.entries(this.filters()).filter(([, v]) => v.length > 0),
    );
    if (trimmed === '' && Object.keys(facets).length === 0) {
      this.assets.set([]);
      this.counts.set({});
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.assetsApi
      .advancedSearch({ ...(trimmed ? { q: trimmed } : {}), facets, limit: 100 })
      .subscribe({
        next: (page) => {
          if (id !== this.requestId) return;
          this.assets.set(page.items);
          this.counts.set(page.facets ?? {});
          this.loading.set(false);
        },
        error: () => {
          if (id !== this.requestId) return;
          this.error.set('Could not search.');
          this.loading.set(false);
        },
      });
  }
}
