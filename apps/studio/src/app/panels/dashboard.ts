import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';

interface StateCount {
  state: Asset['state'];
  count: number;
  label: string;
}

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
        <h2 id="system-state-heading">{{ locale.t('dashboard.systemState') }}</h2>

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
      background: var(--color-surface);
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
      color: var(--color-primary);
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
      background: var(--color-surface-hover);
      border-color: var(--color-border-hover);
    }

    .recent-list li button:focus-visible {
      outline: 2px solid var(--color-primary);
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
      background: var(--color-primary-bg);
      color: var(--color-primary);
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
      background: var(--color-surface);
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

  protected readonly loading = signal(true);
  protected readonly assets = signal<Asset[]>([]);

  protected readonly stateCounts = computed<StateCount[]>(() => {
    const items = this.assets();
    const counts = new Map<Asset['state'], number>();

    // Initialize all states
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
    for (const state of allStates) {
      counts.set(state, 0);
    }

    for (const asset of items) {
      counts.set(asset.state, (counts.get(asset.state) ?? 0) + 1);
    }

    const labelMap: Record<Asset['state'], string> = {
      created: 'Created',
      processing: 'Processing',
      ready: 'Ready',
      approved: 'Approved',
      rejected: 'Rejected',
      expired: 'Expired',
      replaced: 'Replaced',
      purged: 'Purged',
    };

    return Array.from(counts.entries()).map(([state, count]) => ({
      state,
      count,
      label: labelMap[state],
    }));
  });

  protected readonly recentAssets = computed(() =>
    this.assets()
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 10),
  );

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    // Load recent 50 assets for dashboard (state counts + recent list)
    this.assetsApi.list({ limit: 50, order: 'desc' }).subscribe({
      next: (page) => {
        this.assets.set(page.items);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  protected openAsset(asset: Asset): void {
    // Navigate to media panel and open asset editor
    // For now, we'll use the editor store
    // This would need to be wired up properly
    console.log('Open asset:', asset.id);
  }
}
