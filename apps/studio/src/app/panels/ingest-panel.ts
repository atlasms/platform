import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { IngestService } from '../core/ingest.service.ts';
import type { IngestJob } from '../core/generated/rim.types.ts';
import { IfCanDirective } from '../core/if-can.directive.ts';
import { LocaleService } from '../core/locale.service.ts';
import { UploadService } from '../core/upload.service.ts';

/**
 * The Ingest/Import panel (EP-20.3) — upload, queue, quarantine accept/reject.
 *
 * Backed by RIM through the gateway: the queue is the channel's jobs newest first (EP-15.6), a
 * quarantined one carries the acceptance rule's or the probe's reason (EP-15.3/15.4) until an
 * operator with `ingest:approve` accepts or rejects it, and Upload hands files to the uploader
 * (upload.service.ts) — chunked, resumable, against EP-15.1 — whose progress the transfer tray
 * shows. When an upload's job settles, its row joins the queue here without a refetch.
 */
@Component({
  selector: 'atlas-ingest-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IfCanDirective],
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
              <!-- Both are optional in the contract: a detected job exists before the watcher has
                   named its source or finished sizing the file. An em dash says "not known yet";
                   the previous code rendered a raw undefined and "NaN GB". -->
              <span class="job-source">{{ job.source || '—' }}</span>
              <span class="job-size">{{ formatSize(job.sizeBytes) }}</span>
              <span class="job-state" [attr.data-state]="job.state">{{
                locale.t('ingest.state.' + job.state)
              }}</span>
              @if (job.assetId) {
                <span class="job-asset">→ asset {{ job.assetId }}</span>
              }
            </div>
            @if (job.technicalMetadata; as tech) {
              <!-- What the probe read (EP-15.4): the operator's one-line answer to "what is it".
                   Every field is optional — audio has no picture, a still has no rate. -->
              <div class="job-tech">{{ formatTech(tech) }}</div>
            }
            @if (job.reason) {
              <div class="job-reason">{{ job.reason }}</div>
            }
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

    <!-- The native picker, driven by the button: no dialog of our own to keep accessible, and
         multiple, because a bulletin is rarely one file. -->
    <input
      #picker
      type="file"
      multiple
      hidden
      (change)="onFilesPicked($event)"
      [attr.aria-label]="locale.t('ingest.upload')"
    />
    <div class="actions">
      <button type="button" *atlasIfCan="'ingest:write'" (click)="picker.click()">
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
      gap: 0.5rem;
    }
    .job-row {
      background: var(--color-bg-raised);
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
      color: var(--color-fg-muted);
    }
    .job-source {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .job-size {
      font-size: 0.875rem;
      color: var(--color-fg-muted);
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
      color: var(--color-fg-muted);
      font-family: monospace;
    }
    .job-tech {
      font-size: 0.8rem;
      color: var(--atlas-text-muted, #666);
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
    /* Outlined, not filled. A filled status button needs a foreground that contrasts with the
       status colour, and the status tokens invert between themes — the light palette's danger is
       dark, the dark palette's is bright — so one hard-coded white cannot be right in both.
       Drawing the border from currentColor keeps the whole control on one token. */
    .job-actions button {
      padding: 0.375rem 0.75rem;
      border-radius: 4px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      background: transparent;
      border: 1px solid currentColor;
      transition: opacity 0.1s;
    }
    .job-actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .job-actions button:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
    .job-actions .accept {
      color: var(--color-success);
    }
    .job-actions .reject {
      color: var(--color-danger);
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
  private readonly uploads = inject(UploadService);
  protected readonly locale = inject(LocaleService);
  private readonly picker = viewChild<ElementRef<HTMLInputElement>>('picker');

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
      next: (page) => {
        this.jobs.set(page.items);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load ingest queue.');
        this.loading.set(false);
      },
    });
  }

  /**
   * Each picked file becomes a transfer; when its job has a verdict, the row joins the queue at
   * the top — the panel is the newest-first list, and this is the newest. The picker is reset so
   * choosing the same file again fires `change` again.
   */
  protected onFilesPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      void this.uploads.start(file).then((transfer) => {
        if (transfer.state === 'done' && transfer.job) this.upsert(transfer.job);
      });
    }
  }

  /** The job as it came from its transfer: replaces its row, or leads the list. */
  private upsert(job: IngestJob): void {
    this.jobs.update((list) =>
      list.some((j) => j.id === job.id)
        ? list.map((j) => (j.id === job.id ? job : j))
        : [job, ...list],
    );
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

  /** `h264 1920×1080 16:9 25 fps · aac 2ch · 12.5 s` — whatever of it is known. */
  protected formatTech(tech: NonNullable<IngestJob['technicalMetadata']>): string {
    const picture = [
      tech.videoCodec,
      tech.width && tech.height ? `${tech.width}×${tech.height}` : undefined,
      tech.aspectRatio,
      tech.frameRate ? `${tech.frameRate} fps` : undefined,
    ].filter(Boolean);
    const sound = [
      tech.audioCodec,
      tech.audioChannels ? `${tech.audioChannels}ch` : undefined,
    ].filter(Boolean);
    const parts = [
      tech.container,
      picture.length ? picture.join(' ') : undefined,
      sound.length ? sound.join(' ') : undefined,
      tech.durationSec !== undefined ? `${tech.durationSec} s` : undefined,
    ].filter(Boolean);
    return parts.join(' · ');
  }

  protected formatSize(bytes: number | undefined): string {
    if (bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
