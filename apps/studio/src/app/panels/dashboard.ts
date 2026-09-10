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
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

interface StateCount {
  state: Asset['state'];
  count: number;
  label: string;
}

/**
 * Counting more than this would mean paging on and on for a number that is a glance, not a
 * report. Past the cap the widget still counts — a channel that large needs a real counts
 * endpoint (mam.yaml has none yet), which is a deliberate follow-up rather than a silent lie.
 */
const COUNT_PAGE_LIMIT = 200;
const COUNT_MAX_PAGES = 5;

@Component({
  selector: 'atlas-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dashboard">
      <header>
        <h1>{{ locale.t('dashboard.title') }}</h1>
      </header>

      <!-- System State Widget -->
      <section class="widget" aria-labelledby="system-state-heading">
        <h2 id="system-state-heading">
          {{ locale.t('dashboard.systemState') }}
          <!-- Said out loud rather than left to be assumed. When the aggregate refuses (a reader
               scoped to a category cannot be given a channel total), these numbers come from a
               capped page walk — correct for what they may see, but not necessarily complete. A
               number that might be partial and does not say so is the bug this widget started
               with. -->
          @if (approximate()) {
            <span class="qualifier" [title]="locale.t('dashboard.approximateHint')">
              {{ locale.t('dashboard.approximate') }}
            </span>
          }
        </h2>

        @if (loading()) {
          <p class="muted">{{ locale.t('dashboard.loading') }}</p>
        } @else {
          <div class="state-grid">
            @for (sc of stateCounts(); track sc.state) {
              <article class="state-card" [class]="'state-' + sc.state">
                <span class="state-label">{{ sc.label }}</span>
                <span class="state-count">{{ sc.count }}</span>
              </article>
            }
          </div>
        }
      </section>

      <!-- What's New Widget -->
      <section class="widget" aria-labelledby="whats-new-heading">
        <h2 id="whats-new-heading">{{ locale.t('dashboard.whatsNew') }}</h2>

        @if (recentAssets().length === 0 && !loading()) {
          <p class="muted">{{ locale.t('dashboard.noRecent') }}</p>
        } @else {
          <ul class="recent-list">
            @for (asset of recentAssets(); track asset.id) {
              <li>
                <button type="button" (click)="openAsset(asset)">
                  <span class="recent-title">{{ asset.title }}</span>
                  <span class="recent-state" [attr.data-state]="asset.state">{{
                    asset.state
                  }}</span>
                  <span class="recent-type">{{ asset.mediaType }}</span>
                </button>
              </li>
            }
          </ul>
        }
      </section>

      <!-- Inbox & Notifications Widgets (placeholders) -->
      <div class="widget-row">
        <section class="widget" aria-labelledby="inbox-heading">
          <h2 id="inbox-heading">{{ locale.t('dashboard.inbox') }}</h2>
          <p class="muted">{{ locale.t('dashboard.inboxPlaceholder') }}</p>
        </section>

        <section class="widget" aria-labelledby="notifications-heading">
          <h2 id="notifications-heading">{{ locale.t('dashboard.notifications') }}</h2>
          <p class="muted">{{ locale.t('dashboard.notificationsPlaceholder') }}</p>
        </section>
      </div>
    </div>
  `,
  styles: `
    .dashboard {
      display: grid;
      gap: 1rem;
      padding: 1rem;
      overflow-y: auto;
    }

    header {
      margin-bottom: 0.5rem;
    }

    header h1 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
    }

    .widget {
      background: var(--color-bg-raised);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 1rem;
    }

    .widget h2 {
      margin: 0 0 0.75rem;
      font-size: 0.875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-fg-muted);
    }

    .muted {
      color: var(--color-fg-muted);
      font-size: 0.875rem;
      margin: 0;
    }

    .qualifier {
      margin-inline-start: 0.5rem;
      padding: 0.0625rem 0.375rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
      background: var(--color-warning-bg);
      color: var(--color-warning);
    }

    /* State Grid */
    .state-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 0.75rem;
    }

    .state-card {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .state-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-fg-muted);
    }

    .state-count {
      font-size: 1.5rem;
      font-weight: 600;
    }

    .state-card.state-created .state-count {
      color: var(--color-info);
    }
    .state-card.state-processing .state-count {
      color: var(--color-warning);
    }
    .state-card.state-ready .state-count {
      color: var(--color-success);
    }
    .state-card.state-approved .state-count {
      color: var(--color-accent);
    }
    .state-card.state-rejected .state-count {
      color: var(--color-danger);
    }
    .state-card.state-expired .state-count {
      color: var(--color-danger);
    }
    .state-card.state-replaced .state-count {
      color: var(--color-fg-muted);
    }
    .state-card.state-purged .state-count {
      color: var(--color-fg-muted);
    }

    /* Recent List */
    .recent-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 0.5rem;
    }

    .recent-list li button {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 0.75rem;
      align-items: center;
      width: 100%;
      text-align: left;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      transition:
        background 0.1s,
        border-color 0.1s;
    }

    .recent-list li button:hover {
      background: var(--color-bg-hover);
      border-color: var(--color-border-hover);
    }

    .recent-list li button:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }

    .recent-title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }

    .recent-state {
      font-size: 0.75rem;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-weight: 500;
      white-space: nowrap;
    }

    .recent-state[data-state='created'] {
      background: var(--color-info-bg);
      color: var(--color-info);
    }
    .recent-state[data-state='processing'] {
      background: var(--color-warning-bg);
      color: var(--color-warning);
    }
    .recent-state[data-state='ready'] {
      background: var(--color-success-bg);
      color: var(--color-success);
    }
    .recent-state[data-state='approved'] {
      background: var(--color-accent-bg);
      color: var(--color-accent);
    }
    .recent-state[data-state='rejected'] {
      background: var(--color-danger-bg);
      color: var(--color-danger);
    }
    .recent-state[data-state='expired'] {
      background: var(--color-danger-bg);
      color: var(--color-danger);
    }
    .recent-state[data-state='replaced'],
    .recent-state[data-state='purged'] {
      background: var(--color-bg-raised);
      color: var(--color-fg-muted);
    }

    .recent-type {
      font-size: 0.75rem;
      color: var(--color-fg-muted);
      white-space: nowrap;
    }

    /* Widget Row */
    .widget-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    @media (max-width: 768px) {
      .widget-row {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class Dashboard {
  private readonly assetsApi = inject(AssetsService);
  protected readonly locale = inject(LocaleService);
  private readonly editors = inject(EditorStore);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  /** The newest page, for "what's new". Not the source of the counts any more. */
  protected readonly assets = signal<Asset[]>([]);
  /**
   * Counts from MAM's aggregate, when it will answer.
   *
   * `null` means it would not — a reader whose grant is narrowed by category, state or ownership
   * gets a 403, because the aggregate cannot apply the per-asset check that listing does and would
   * therefore be counting assets they may not see. Those callers fall back to tallying the pages
   * below, which IS filtered for them, and the widget goes back to being capped rather than wrong.
   */
  private readonly exactCounts = signal<Record<string, number> | null>(null);
  /** True while the numbers come from the capped page walk rather than the aggregate. */
  protected readonly approximate = computed(() => this.exactCounts() === null);

  protected readonly stateCounts = computed<StateCount[]>(() => {
    const allStates: Asset['state'][] = [
      'created',
      'processing',
      'ready',
      'approved',
      'rejected',
      'expired',
      'replaced',
      'purged',
    ];
    // Zero-filled HERE rather than by the store: the set of states a dashboard renders is the
    // client's business, and a store inventing rows for empty states would be asserting something
    // about the lifecycle it has no business knowing.
    const exact = this.exactCounts();
    const counts = new Map<Asset['state'], number>(allStates.map((s) => [s, 0]));
    if (exact) {
      for (const state of allStates) counts.set(state, exact[state] ?? 0);
    } else {
      for (const asset of this.assets()) {
        counts.set(asset.state, (counts.get(asset.state) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).map(([state, count]) => ({
      state,
      count,
      label: this.locale.t(`dashboard.state.${state}`),
    }));
  });

  // Already newest-first from the store (`order: 'desc'`) — re-sorting by updatedAt would claim
  // an ordering "recently touched" the query never asked for.
  protected readonly recentAssets = computed(() => this.assets().slice(0, 10));

  constructor() {
    this.load();
    this.loadCounts();

    // Widgets are live (studio-frontend.md §3): any asset event in this channel changes the
    // numbers, so refetch. The service queues the subscription until the socket is open.
    effect(() => {
      const channelId = this.session.channelId();
      if (channelId) {
        void this.ws.subscribe(`atlas.${channelId}.asset.>`);
      }
    });
    this.ws.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ subject }) => {
      if (subject.startsWith(`atlas.${this.session.channelId()}.asset.`)) {
        this.load();
        this.loadCounts();
      }
    });
  }

  /**
   * The exact tally, when this caller is allowed one.
   *
   * A failure is not an error state on the widget: a 403 is the expected answer for a scoped
   * reader, and the page walk below already produces a correct — if capped — number for them. So
   * this quietly leaves `exactCounts` null and the widget marks itself approximate.
   */
  private loadCounts(): void {
    this.assetsApi.counts().subscribe({
      next: (counts) => this.exactCounts.set(counts),
      error: () => this.exactCounts.set(null),
    });
  }

  /** Newest-first, following the keyset cursor so the counts cover the catalogue, not page one. */
  private load(cursor?: string, pages = 0, acc: Asset[] = []): void {
    this.loading.set(true);
    this.assetsApi
      .list({ limit: COUNT_PAGE_LIMIT, order: 'desc', ...(cursor ? { cursor } : {}) })
      .subscribe({
        next: (page) => {
          const items = [...acc, ...page.items];
          if (page.nextCursor && pages + 1 < COUNT_MAX_PAGES) {
            this.load(page.nextCursor, pages + 1, items);
            return;
          }
          this.assets.set(items);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  protected openAsset(asset: Asset): void {
    this.editors.open({ type: 'asset', resourceId: asset.id, title: asset.title, icon: '▤' });
  }
}
