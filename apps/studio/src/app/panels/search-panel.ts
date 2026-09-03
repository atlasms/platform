import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset } from '../core/generated/mam.types.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { LocaleService } from '../core/locale.service.ts';

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
        autofocus
      />
    </label>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('search.loading') }}</p>
    } @else if (assets().length === 0 && query().trim() !== '') {
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
      color: var(--color-text-muted);
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
      background: var(--color-surface-hover);
      border-color: var(--color-border-hover);
    }
    .items li button:focus-visible {
      outline: 2px solid var(--color-primary);
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
      background: var(--color-surface);
      color: var(--color-text-muted);
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
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);

  protected readonly assets = signal<Asset[]>([]);
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  private requestId = 0;

  protected onQuery(value: string): void {
    this.query.set(value);
    this.requestId++;
    this.run(this.requestId, value);
  }

  protected onEnter(): void {
    // Just trigger search again in case they typed without the input event firing
    this.run(this.requestId, this.query());
  }

  protected open(asset: Asset): void {
    this.editors.open({ type: 'asset', resourceId: asset.id, title: asset.title, icon: '▤' });
  }

  private run(id: number, q: string): void {
    const trimmed = q.trim();
    if (trimmed === '') {
      this.assets.set([]);
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.assetsApi.search(trimmed, 100).subscribe({
      next: (page) => {
        if (id !== this.requestId) return;
        this.assets.set(page.items);
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
