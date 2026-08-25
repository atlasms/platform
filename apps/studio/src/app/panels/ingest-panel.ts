import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { IngestService } from '../core/ingest.service.ts';
import type { IngestJob } from '../core/generated/rim.types.ts';
import { IfCanDirective } from '../core/if-can.directive.ts';
import { LocaleService } from '../core/locale.service.ts';

@Component({
  selector: 'atlas-ingest-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IfCanDirective, DatePipe],
  template: `
    <h2 class="panel-title">{{ locale.t('ingest.title') }}</h2>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <p class="muted">{{ locale.t('ingest.loading') }}</p>
    } @else if (jobs().length === 0) {
      <p class="muted">{{ locale.t('ingest.empty') }}</p>
    } @else {
      <ul class="items">
        @for (job of jobs(); track job.id) {
          <li class="job-row" [class]="'state-' + job.state">
            <div class="job-main">
              <span class="job-id">{{ job.id }}</span>
              <span class="job-source">{{ job.source }}</span>
              <span class="job-size">{{ formatSize(job.sizeBytes) }}</span>
              <span class="job-state" [attr.data-state]="job.state">{{
                locale.t('ingest.state.' + job.state)
              }}</span>
              @if (job.assetId) {
                <span class="job-asset">→ asset {{ job.assetId }}</span>
              }
            </div>
            <div class="job-reason" *ngIf="job.reason">{{ job.reason }}</div>
            <div class="job-actions">
              @if (job.state === 'quarantined') {
                <button
                  type="button"
                  class="accept"
                  (click)="accept(job)"
                  *atlasIfCan="'ingest:approve'"
                >
                  {{ locale.t('ingest.accept') }}
                </button>
                <button
                  type="button"
                  class="reject"
                  (click)="promptReject(job)"
                  *atlasIfCan="'ingest:approve'"
                >
                  {{ locale.t('ingest.reject') }}
                </button>
              }
            </div>
          </li>
        }
      </ul>
    }

    <div class="actions">
      <button type="button" *atlasIfCan="'ingest:write'" (click)="openUpload()">
        {{ locale.t('ingest.upload') }}
      </button>
    </div>
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
      gap: 0.5rem;
    }
    .job-row {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 6px;
      padding: 0.75rem;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 1rem;
      align-items: start;
    }
    .job-main {
      display: grid;
      grid-template-columns: auto 1fr auto auto auto;
      gap: 0.75rem;
      align-items: center;
      min-width: 0;
    }
    .job-id {
      font-family: monospace;
      font-size: 0.75rem;
      color: var(--color-text-muted);
    }
    .job-source {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .job-size {
      font-size: 0.875rem;
      color: var(--color-text-muted);
      white-space: nowrap;
    }
    .job-state {
      font-size: 0.75rem;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-weight: 500;
      white-space: nowrap;
    }
    .job-state[data-state='detected'] {
      background: var(--color-info-bg);
      color: var(--color-info);
    }
    .job-state[data-state='validating'] {
      background: var(--color-warning-bg);
      color: var(--color-warning);
    }
    .job-state[data-state='quarantined'] {
      background: var(--color-warning-bg);
      color: var(--color-warning);
    }
    .job-state[data-state='rejected'] {
      background: var(--color-danger-bg);
      color: var(--color-danger);
    }
    .job-state[data-state='accepted'] {
      background: var(--color-success-bg);
      color: var(--color-success);
    }
    .job-state[data-state='registered'] {
      background: var(--color-success-bg);
      color: var(--color-success);
    }
    .job-asset {
      font-size: 0.75rem;
      color: var(--color-text-muted);
      font-family: monospace;
    }
    .job-reason {
      grid-column: 1 / -1;
      font-size: 0.875rem;
      color: var(--color-danger);
      padding-top: 0.25rem;
    }
    .job-actions {
      display: flex;
      gap: 0.5rem;
    }
    .job-actions button {
      padding: 0.375rem 0.75rem;
      border-radius: 4px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: opacity 0.1s;
    }
    .job-actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .job-actions .accept {
      background: var(--color-success);
      color: white;
    }
    .job-actions .reject {
      background: var(--color-danger);
      color: white;
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
export class IngestPanel {
  private readonly ingestApi = inject(IngestService);
  protected readonly locale = inject(LocaleService);

  protected readonly jobs = signal<IngestJob[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);

    this.ingestApi.list({ limit: 100 }).subscribe({
      next: (jobs) => {
        this.jobs.set(jobs);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load ingest queue.');
        this.loading.set(false);
      },
    });
  }

  protected accept(job: IngestJob): void {
    this.ingestApi.accept(job.id).subscribe({
      next: (updated) => {
        this.jobs.update((list) => list.map((j) => (j.id === job.id ? updated : j)));
      },
      error: () => {
        this.error.set('Could not accept job.');
      },
    });
  }

  protected promptReject(job: IngestJob): void {
    const reason = prompt(this.locale.t('ingest.rejectPrompt'));
    if (reason?.trim()) {
      this.reject(job, reason.trim());
    }
  }

  protected reject(job: IngestJob, reason: string): void {
    this.ingestApi.reject(job.id, reason).subscribe({
      next: (updated) => {
        this.jobs.update((list) => list.map((j) => (j.id === job.id ? updated : j)));
      },
      error: () => {
        this.error.set('Could not reject job.');
      },
    });
  }

  protected openUpload(): void {
    // TODO: Implement upload dialog (EP-20.3 full)
    alert('Upload dialog - to be implemented');
  }

  protected formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
