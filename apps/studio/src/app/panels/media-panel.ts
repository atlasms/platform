import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset, Tag } from '../core/generated/mam.types.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';

/**
 * The Media panel (EP-20.1) — recent, search, and tag filters, against real MAM data.
 *
 * WHAT IS NOT HERE, and why. The story also names a **browse tree**, and it is not built because
 * there is nothing to build it from: MAM stores `categoryId` on an asset but categories do not
 * exist as entities — no hierarchy, no store, no endpoint (`/categories` is in mam.yaml and
 * unimplemented; the service's own comment reads "categoryId is one until categories exist").
 * A tree rendered from nothing would be a mock in production clothing, so the panel shows the
 * filters that do have a backend and the tree waits for the taxonomy story.
 *
 * "Recent" is a real newest-first read, not a client-side sort of whatever arrived: page one of an
 * ascending list is the OLDEST assets in the channel.
 */
@Component({
  selector: 'atlas-media-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="panel-title">{{ locale.t('workbench.panels.media') }}</h2>

    <label class="search">
      <span class="visually-hidden">{{ locale.t('mediaPanel.search') }}</span>
      <input
        type="search"
        [placeholder]="locale.t('mediaPanel.searchPlaceholder')"
        [value]="query()"
        (input)="onQuery($any($event.target).value)"
      />
    </label>

    @if (tags().length > 0) {
      <ul class="tags" [aria-label]="locale.t('mediaPanel.filterByTags')">
        @for (tag of tags(); track tag.id) {
          <li>
            <button
              type="button"
              class="chip"
              [class.on]="query() === tag.label"
              (click)="toggleTag(tag)"
            >
              {{ tag.label }}
            </button>
          </li>
        }
      </ul>
    }

    <p class="mode">{{ heading() }}</p>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('mediaPanel.loading') }}</p>
    } @else if (assets().length === 0) {
      <!-- The two empty states are different questions, and answering both with "No results" makes
           an empty channel look like a failed search. -->
      <p class="muted">
        {{ query() ? locale.t('mediaPanel.noResults') : locale.t('mediaPanel.emptyChannel') }}
      </p>
    } @else {
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

      @if (cursor()) {
        <button type="button" class="more" (click)="loadMore()">
          {{ locale.t('mediaPanel.loadMore') }}
        </button>
      }
    }
  `,
  styles: `
    .panel-title {
      margin: 0 0 var(--space-2);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .search input {
      inline-size: 100%;
      padding: var(--space-1) var(--space-2);
      margin-block-end: var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
    }
    .search input:focus-visible {
      border-color: var(--color-accent, currentColor);
      outline: none;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      list-style: none;
      margin: 0 0 var(--space-2);
      padding: 0;
    }
    .chip {
      padding: 0 var(--space-2);
      font-size: 0.75rem;
      line-height: 1.6;
      color: var(--color-fg-muted);
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: 999px;
      cursor: pointer;
    }
    .chip.on {
      color: var(--color-fg);
      border-color: currentColor;
    }
    .mode {
      margin: 0 0 var(--space-1);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .items {
      list-style: none;
      margin: 0 0 var(--space-2);
      padding: 0;
    }
    .items button {
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
      inline-size: 100%;
      padding: var(--space-1) var(--space-2);
      text-align: start;
      color: inherit;
      background: none;
      border: none;
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .items button:hover {
      background: var(--color-bg-hover);
    }
    .title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state {
      font-size: 0.6875rem;
      color: var(--color-fg-muted);
    }
    .more {
      inline-size: 100%;
      padding: var(--space-1);
      margin-block-end: var(--space-4);
      color: var(--color-fg-muted);
      background: none;
      border: 1px dashed var(--color-border, currentColor);
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .actions {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .muted,
    .error {
      color: var(--color-fg-muted);
      font-size: 0.8125rem;
    }
    .error {
      color: var(--color-danger, currentColor);
    }
    .visually-hidden {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class MediaPanel {
  private readonly assetsApi = inject(AssetsService);
  private readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly assets = signal<Asset[]>([]);
  protected readonly tags = signal<Tag[]>([]);
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Present only while browsing; a search returns one page and no cursor. */
  protected readonly cursor = signal<string | undefined>(undefined);

  protected readonly heading = computed(() =>
    this.query() ? this.locale.t('mediaPanel.results') : this.locale.t('mediaPanel.recent'),
  );

  /**
   * Guards against an out-of-order response overwriting a newer one.
   *
   * Typing "foo" fires three searches, and they can come back in any order — without this, the
   * results for "f" can land after the results for "foo" and the list shows the wrong thing while
   * the box says something else. Cheaper and more reliable than cancelling in-flight requests.
   */
  private requestId = 0;

  constructor() {
    this.loadRecent();
    // A tag list that fails is not worth an error banner: the filters simply do not appear, and
    // everything else on the panel still works.
    this.assetsApi.tags().subscribe({ next: (t) => this.tags.set(t), error: () => undefined });

    // Subscribe to live asset updates for this channel. The service queues the pattern if the
    // socket is not open yet, so mounting before the connection lands is not a silent loss.
    effect(() => {
      const channelId = this.session.channelId();
      if (channelId) {
        void this.ws.subscribe(`atlas.${channelId}.asset.>`);
      }
    });

    // Handle incoming WebSocket events for asset updates. takeUntilDestroyed: panels are created
    // and destroyed with the routed view, and a leaked subscription would keep refetching for a
    // panel that no longer exists.
    this.ws.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ subject, payload }) => {
      this.handleAssetEvent(subject, payload);
    });
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    const trimmed = value.trim();
    if (trimmed === '') {
      this.loadRecent();
      return;
    }
    this.run(this.requestId + 1, this.assetsApi.search(trimmed), { append: false });
  }

  protected toggleTag(tag: Tag): void {
    // A second click on the active chip clears it, which is what a filter chip is expected to do —
    // and searching for the tag's LABEL works because MAM indexes tag labels as search terms.
    this.onQuery(this.query() === tag.label ? '' : (tag.label ?? ''));
  }

  protected loadMore(): void {
    const after = this.cursor();
    if (after === undefined) return;
    this.run(this.requestId + 1, this.assetsApi.list({ order: 'desc', cursor: after }), {
      append: true,
    });
  }

  protected open(asset: Asset): void {
    this.editors.open({ type: 'asset', resourceId: asset.id, title: asset.title, icon: '▤' });
  }

  private loadRecent(): void {
    // `order: 'desc'` is the whole reason MAM grew the option — see assets.service.ts.
    this.run(this.requestId + 1, this.assetsApi.list({ order: 'desc' }), { append: false });
  }

  private run(
    id: number,
    request: ReturnType<AssetsService['list']>,
    options: { append: boolean },
  ): void {
    this.requestId = id;
    this.loading.set(true);
    this.error.set(null);

    request.subscribe({
      next: (page) => {
        if (id !== this.requestId) return; // a newer request has already been issued
        this.assets.set(options.append ? [...this.assets(), ...page.items] : page.items);
        this.cursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: () => {
        if (id !== this.requestId) return;
        // Deliberately not the server's message. A failed read here is either a network problem or
        // a refusal, and echoing an internal error into the sidebar tells the user nothing they can
        // act on while risking leaking detail.
        this.error.set('Could not load media.');
        this.loading.set(false);
      },
    });
  }

  private handleAssetEvent(subject: string, payload: unknown): void {
    // Subject format: atlas.<channelId>.asset.<action>
    // Actions: created, updated, approved, rejected, expired, deleted, replaced, ready
    const action = subject.split('.').pop();
    if (!action) return;

    const envelope = payload as {
      type: string;
      channelId: string;
      payload: {
        assetId: string;
        core?: Record<string, unknown>;
        changedFields?: string[];
      };
    };

    const assetId = envelope.payload?.assetId;
    if (!assetId) return;

    // Only process events for our current channel
    if (envelope.channelId !== this.session.channelId()) return;

    const exists = this.assets().some((a) => a.id === assetId);

    switch (action) {
      case 'created':
        // The created event carries only core fields, not a full record, so insert nothing
        // blind. In the unfiltered Recent view the honest move is to refetch page one; inside a
        // search result a new asset has no defined rank, so leave the list alone.
        if (!exists && !this.query()) {
          this.loadRecent();
        }
        break;

      case 'updated':
      case 'approved':
      case 'rejected':
      case 'expired':
      case 'ready':
        // The event carries changedFields, not new values — refetch the one record and splice it
        // in, so a live list never shows a stale row.
        if (exists) {
          this.assetsApi.get(assetId).subscribe({
            next: (asset) => {
              this.assets.update((list) => {
                const idx = list.findIndex((a) => a.id === assetId);
                if (idx < 0) return list;
                const copy = [...list];
                copy[idx] = asset;
                return copy;
              });
            },
          });
        }
        break;

      case 'deleted':
      case 'replaced':
        if (exists) {
          this.assets.update((list) => list.filter((a) => a.id !== assetId));
        }
        break;
    }
  }
}
