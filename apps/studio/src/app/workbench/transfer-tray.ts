import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LocaleService } from '../core/locale.service.ts';
import { TransferStore, type Transfer } from '../core/transfer.store.ts';
import { UploadService } from '../core/upload.service.ts';

/**
 * The transfer tray (EP-20.8; FR-UI-9; studio-frontend.md §1.1 "grouped transfer tray"):
 * bottom-corner, minimizable, one row per transfer with its own progress and actions. It shows
 * only when there is something to show, and it lives in the workbench frame rather than a panel
 * so an upload started from Ingest stays visible wherever the user goes next.
 */
@Component({
  selector: 'atlas-transfer-tray',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (transfers.transfers().length > 0) {
      <section class="tray" [class.minimized]="transfers.minimized()" aria-live="polite">
        <header>
          <button
            type="button"
            class="toggle"
            (click)="transfers.minimized.set(!transfers.minimized())"
            [attr.aria-expanded]="!transfers.minimized()"
            [attr.aria-label]="
              locale.t(transfers.minimized() ? 'transfers.expand' : 'transfers.minimize')
            "
          >
            <span class="title">{{ locale.t('transfers.title') }}</span>
            @if (transfers.active().length > 0) {
              <span class="summary"
                >{{ transfers.active().length }} {{ locale.t('transfers.active') }} ·
                {{ transfers.overallPercent() }}%</span
              >
            } @else {
              <span class="summary">{{ locale.t('transfers.idle') }}</span>
            }
            <span class="chevron" aria-hidden="true">{{ transfers.minimized() ? '▴' : '▾' }}</span>
          </button>
          @if (transfers.finished().length > 0) {
            <button type="button" class="link" (click)="transfers.clearFinished()">
              {{ locale.t('transfers.clear') }}
            </button>
          }
        </header>

        @if (!transfers.minimized()) {
          <ul>
            @for (t of transfers.transfers(); track t.id) {
              <li [class]="'state-' + t.state">
                <div class="row">
                  <span class="name" [title]="t.name">{{ t.name }}</span>
                  <span class="state">{{ stateOf(t) }}</span>
                </div>
                <progress
                  [value]="t.sentBytes"
                  [max]="t.sizeBytes || 1"
                  [attr.aria-label]="t.name"
                ></progress>
                <div class="row">
                  <span class="muted"
                    >{{ formatSize(t.sentBytes) }} / {{ formatSize(t.sizeBytes) }}</span
                  >
                  <span class="actions">
                    @if (isActive(t)) {
                      <button type="button" class="link" (click)="uploads.cancel(t.id)">
                        {{ locale.t('common.cancel') }}
                      </button>
                    } @else if (t.state === 'failed') {
                      <button type="button" class="link" (click)="uploads.retry(t.id)">
                        {{ locale.t('common.retry') }}
                      </button>
                    } @else {
                      <button type="button" class="link" (click)="transfers.remove(t.id)">
                        {{ locale.t('transfers.dismiss') }}
                      </button>
                    }
                  </span>
                </div>
                @if (t.error) {
                  <p class="error">{{ t.error }}</p>
                }
                @if (t.state === 'done' && t.job?.reason; as reason) {
                  <p class="muted">{{ reason }}</p>
                }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: `
    .tray {
      position: fixed;
      inset-inline-end: 1rem;
      inset-block-end: calc(var(--status-bar-height) + 0.75rem);
      inline-size: min(24rem, calc(100vw - 2rem));
      max-block-size: 60vh;
      display: grid;
      grid-template-rows: auto 1fr;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-bg-raised);
      color: var(--color-fg);
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
      z-index: 10;
    }
    header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.5rem;
      border-block-end: 1px solid var(--color-border);
    }
    .minimized header {
      border-block-end: none;
    }
    .toggle {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: none;
      border: none;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .title {
      font-weight: 600;
    }
    .summary,
    .muted {
      color: var(--color-fg-muted);
      font-size: 0.8rem;
    }
    .chevron {
      margin-inline-start: auto;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
    }
    li {
      display: grid;
      gap: 0.25rem;
      padding: 0.5rem;
      border-block-end: 1px solid var(--color-border);
    }
    li:last-child {
      border-block-end: none;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.85rem;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state {
      flex-shrink: 0;
    }
    .state-done .state {
      color: var(--color-success);
    }
    .state-failed .state,
    .error {
      color: var(--color-danger);
    }
    .error,
    li .muted {
      margin: 0;
      font-size: 0.8rem;
    }
    progress {
      inline-size: 100%;
      block-size: 0.35rem;
      accent-color: var(--color-accent);
    }
    .link {
      background: none;
      border: none;
      padding: 0;
      color: var(--color-accent);
      font: inherit;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .link:focus-visible,
    .toggle:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
  `,
})
export class TransferTray {
  protected readonly transfers = inject(TransferStore);
  protected readonly uploads = inject(UploadService);
  protected readonly locale = inject(LocaleService);

  protected isActive(t: Transfer): boolean {
    return (
      t.state === 'queued' ||
      t.state === 'uploading' ||
      t.state === 'completing' ||
      t.state === 'validating'
    );
  }

  /** The transfer's state — and once done, the JOB's verdict, which is what the person waited for. */
  protected stateOf(t: Transfer): string {
    if (t.state === 'done' && t.job) return this.locale.t('ingest.state.' + t.job.state);
    return this.locale.t('transfers.state.' + t.state);
  }

  protected formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
