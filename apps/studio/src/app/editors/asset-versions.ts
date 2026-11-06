import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { AssetsService } from '../core/assets.service.ts';
import type { Asset } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';

/** States an asset can be made a new version from: it has had no verdict (mam.md §13t). */
const UNJUDGED = 'created,processing,ready';

/**
 * Could `candidate` become the next version of `asset`? MAM judges it (409/422); this only keeps
 * the picker to the assets it would accept — same media type, not in a chain, no verdict yet.
 */
export function canBecomeVersionOf(asset: Asset, candidate: Asset): boolean {
  return (
    candidate.id !== asset.id &&
    candidate.mediaType === asset.mediaType &&
    candidate.replacesId === undefined &&
    candidate.replacedById === undefined &&
    !['approved', 'rejected', 'expired'].includes(candidate.state)
  );
}

/**
 * The asset editor's Versions section (EP-27.6; data-model §1.7, studio-frontend.md): the asset's
 * media-file versions — the chain MAM links by `replacesId` / `replacedById`, oldest first — and,
 * on the newest, making another asset (an upload of the new media) its next version.
 *
 * - Metadata edits are not versions; they are the History. A version is a new FILE, a new asset.
 * - Offered to a holder of `asset:write` on `core` — UX only, MAM enforces it (and the groups the
 *   copy writes on the new asset). MAM copies the metadata; the new version opens in its own tab.
 * - Read on entering the section and again whenever the asset's version moves.
 */
@Component({
  selector: 'atlas-asset-versions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="versions">
      @if (asset().replacedById; as next) {
        <p class="superseded" role="status">
          {{ locale.t('versions.superseded') }}
          <button type="button" class="link" (click)="openId(next)">
            {{ locale.t('versions.openNewest') }}
          </button>
        </p>
      }
      @if (chain() === null) {
        <p class="muted">{{ locale.t('editor.loading') }}</p>
      } @else if (chain()!.length <= 1) {
        <p class="muted">{{ locale.t('versions.only') }}</p>
      } @else {
        <ol class="chain">
          @for (v of chain(); track v.id; let i = $index) {
            <li [class.current]="v.id === asset().id">
              <span class="n">v{{ i + 1 }}</span>
              @if (v.id === asset().id) {
                <strong>{{ v.title }}</strong>
                <span class="muted">· {{ locale.t('versions.this') }}</span>
              } @else {
                <button type="button" class="link" (click)="open(v)">{{ v.title }}</button>
              }
              <span class="muted">· {{ v.state }} · {{ v.createdAt.slice(0, 10) }}</span>
            </li>
          }
        </ol>
      }

      @if (offered()) {
        <div class="make">
          <h3>{{ locale.t('versions.make') }}</h3>
          <p class="muted">{{ locale.t('versions.makeHint') }}</p>
          @if (candidates() === null) {
            <button type="button" class="find" (click)="find()">
              {{ locale.t('versions.find') }}
            </button>
          } @else if (candidates()!.length === 0) {
            <p class="muted">{{ locale.t('versions.none') }}</p>
          } @else {
            <label>
              {{ locale.t('versions.from') }}
              <select
                [value]="chosen()"
                (change)="chosen.set($any($event.target).value)"
                [attr.aria-label]="locale.t('versions.from')"
              >
                <option value="">—</option>
                @for (c of candidates(); track c.id) {
                  <option [value]="c.id">
                    {{ c.title }} · {{ c.createdAt.slice(0, 16).replace('T', ' ') }}
                  </option>
                }
              </select>
            </label>
            <button
              type="button"
              class="create"
              [disabled]="busy() || chosen() === ''"
              (click)="make()"
            >
              {{ locale.t('versions.create') }}
            </button>
          }
        </div>
      }

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: `
    .versions {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-2) 0;
    }
    h3 {
      margin: 0;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--color-fg-muted);
    }
    .chain {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .chain li.current {
      background: var(--color-info-bg);
      border-radius: var(--radius-md);
      padding-inline: var(--space-1);
    }
    .n {
      display: inline-block;
      min-width: 2.5em;
      color: var(--color-fg-muted);
    }
    .superseded {
      margin: 0;
      padding: var(--space-1) var(--space-2);
      color: var(--color-warning);
      background: var(--color-warning-bg);
      border-radius: var(--radius-md);
    }
    .link {
      background: none;
      border: none;
      padding: 0;
      color: var(--color-accent);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
    }
    .make {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      align-items: flex-start;
    }
    .muted {
      color: var(--color-fg-muted);
      margin: 0;
    }
    .error {
      color: var(--color-danger);
      margin: 0;
    }
  `,
})
export class AssetVersions {
  protected readonly locale = inject(LocaleService);
  private readonly api = inject(AssetsService);
  private readonly editors = inject(EditorStore);

  readonly asset = input.required<Asset>();
  /** `asset:write` on `core` — UX only. */
  readonly canEdit = input(false);
  /** The asset changed here (it is now superseded); the editor reloads it. */
  readonly changed = output<void>();

  protected readonly chain = signal<Asset[] | null>(null);
  protected readonly candidates = signal<Asset[] | null>(null);
  protected readonly chosen = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Only the newest version is made a version again — MAM refuses the rest (409). */
  protected readonly offered = computed(
    () => this.canEdit() && this.asset().replacedById === undefined,
  );

  private readonly load = effect(() => {
    const { id, version } = this.asset();
    void version;
    this.api.versions(id).subscribe({
      next: (page) => this.chain.set(page.items),
      error: () => this.chain.set([]),
    });
  });

  find(): void {
    const asset = this.asset();
    this.api.list({ order: 'desc', state: UNJUDGED, limit: 50 }).subscribe({
      next: (page) => this.candidates.set(page.items.filter((c) => canBecomeVersionOf(asset, c))),
      error: () => this.candidates.set([]),
    });
  }

  make(): void {
    const assetId = this.chosen();
    if (assetId === '') return;
    this.busy.set(true);
    this.error.set(null);
    this.api.createVersion(this.asset().id, assetId).subscribe({
      next: (made) => {
        this.busy.set(false);
        this.chosen.set('');
        this.candidates.set(null);
        this.open(made);
        this.changed.emit();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        // MAM's own words: already replaced or judged (409), another media type (422), no grant.
        const body =
          err instanceof HttpErrorResponse ? (err.error as { detail?: unknown } | null) : null;
        this.error.set(
          typeof body?.detail === 'string' ? body.detail : this.locale.t('versions.failed'),
        );
      },
    });
  }

  protected open(asset: Asset): void {
    this.editors.open({ type: 'asset', resourceId: asset.id, title: asset.title, icon: '▤' });
  }

  protected openId(id: string): void {
    const known = this.chain()?.find((a) => a.id === id);
    this.editors.open({ type: 'asset', resourceId: id, title: known?.title ?? id, icon: '▤' });
  }
}
