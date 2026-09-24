import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { Job } from '../core/generated/mts.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { TranscodeJobsService } from '../core/transcode-jobs.service.ts';

/** States in which a job may still change — and therefore the page should keep asking. */
const ACTIVE: ReadonlySet<Job['state']> = new Set(['queued', 'running', 'failed']);

/**
 * An asset's transcode jobs, on its Files tab (EP-16): what MTS is doing to produce the renditions
 * the rows above it will hold — queued, running with its progress, waiting to retry and why, given
 * up and why, or done.
 *
 * POLLED, while anything is still moving, and only then. MTS keeps progress on the job row rather
 * than broadcasting it (a per-tick event through the transactional outbox would cost what a domain
 * event costs — apps/mts/README.md), so `GET /jobs` is how a progress bar learns anything. The
 * poll stops by itself once every job is completed or dead-lettered, skips a tick while the page
 * is hidden, and dies with the component: a closed tab does not keep asking MTS about an asset.
 *
 * When a job it watched completes, `completed` tells the editor, which then waits for MAM's
 * FileRef mirror to catch up — a separate consumer of the same event, with no order between them.
 * A job already completed on first sight emits nothing: those rows were read with the tab.
 */
@Component({
  selector: 'atlas-transcode-jobs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!hidden()) {
      <section class="jobs" [attr.aria-label]="locale.t('assetEditor.jobs')">
        <h4>{{ locale.t('assetEditor.jobs') }}</h4>
        @if (error()) {
          <p class="note" role="alert">{{ error() }}</p>
        } @else if (jobs() === null) {
          <p class="note">{{ locale.t('assetEditor.jobsLoading') }}</p>
        } @else if (ordered().length === 0) {
          <p class="note">{{ locale.t('assetEditor.noJobs') }}</p>
        } @else {
          <ul>
            @for (job of ordered(); track job.id) {
              <li [attr.data-state]="job.state">
                <span class="presets">{{ job.presetIds.join(' · ') }}</span>
                <span class="state">{{ locale.t('assetEditor.jobStates.' + job.state) }}</span>
                @if (job.state === 'running') {
                  <progress
                    max="100"
                    [value]="job.percent ?? 0"
                    [attr.aria-label]="locale.t('assetEditor.jobProgress')"
                  ></progress>
                  <span class="figure">{{ percent(job) }}%</span>
                }
                @if (job.attempts > 1 || job.state === 'failed') {
                  <span class="figure">
                    {{ locale.t('assetEditor.jobAttempt') }} {{ job.attempts }}
                  </span>
                }
                @if (job.state === 'completed') {
                  <span class="figure">
                    {{ job.renditions?.length ?? 0 }} {{ locale.t('assetEditor.jobRenditions') }}
                  </span>
                }
                @if (job.state === 'failed' || job.state === 'dead-letter') {
                  <p class="reason">
                    {{ job.reason }}
                    @if (job.state === 'failed' && job.retryAt) {
                      — {{ locale.t('assetEditor.jobRetryAt') }} {{ time(job.retryAt) }}
                    }
                  </p>
                }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: `
    .jobs {
      margin-block-start: var(--space-4);
    }
    h4 {
      margin: 0 0 var(--space-2);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-2);
    }
    li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .presets {
      font-weight: 600;
    }
    .state {
      padding: 0 var(--space-2);
      border-radius: var(--radius-md);
      background: var(--color-info-bg);
      color: var(--color-info);
    }
    [data-state='completed'] .state {
      background: var(--color-success-bg);
      color: var(--color-success);
    }
    [data-state='failed'] .state {
      background: var(--color-warning-bg);
      color: var(--color-warning);
    }
    [data-state='dead-letter'] .state {
      background: var(--color-danger-bg);
      color: var(--color-danger);
    }
    progress {
      inline-size: 10rem;
      accent-color: var(--color-accent);
    }
    .figure,
    .note {
      color: var(--color-fg-muted);
    }
    .reason {
      flex-basis: 100%;
      margin: 0;
      color: var(--color-fg-muted);
    }
    [data-state='dead-letter'] .reason {
      color: var(--color-danger);
    }
  `,
})
export class TranscodeJobs {
  readonly assetId = input.required<string>();
  /** How often to ask while a job is moving. An input so a test can drive it. */
  readonly pollMs = input(2_000);
  /** A job this component watched moved to `completed`. */
  readonly completed = output<Job>();

  private readonly api = inject(TranscodeJobsService);
  protected readonly locale = inject(LocaleService);

  protected readonly jobs = signal<Job[] | null>(null);
  protected readonly error = signal<string | null>(null);
  /** A caller without `asset:read` on files: the section is not shown, rather than shown refused. */
  protected readonly hidden = signal(false);
  /** Newest first: what just happened is what a person opened the tab to see. */
  protected readonly ordered = computed(() => [...(this.jobs() ?? [])].reverse());

  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.timer);
    });
    // A new asset (the same tab reused) starts from nothing: no stale rows, no stale timer.
    effect(() => {
      const assetId = this.assetId();
      untracked(() => {
        clearTimeout(this.timer);
        this.jobs.set(null);
        this.error.set(null);
        this.hidden.set(false);
        this.load(assetId);
      });
    });
  }

  private load(assetId: string): void {
    this.api.forAsset(assetId).subscribe({
      next: (jobs) => {
        if (this.destroyed || assetId !== this.assetId()) return;
        const before = new Map((this.jobs() ?? []).map((j) => [j.id, j.state]));
        this.jobs.set(jobs);
        this.error.set(null);
        for (const job of jobs) {
          const was = before.get(job.id);
          if (job.state === 'completed' && was !== undefined && ACTIVE.has(was)) {
            this.completed.emit(job);
          }
        }
        if (jobs.some((j) => ACTIVE.has(j.state))) this.schedule(assetId);
      },
      error: (err: { status?: number }) => {
        if (this.destroyed) return;
        if (err.status === 403) {
          this.hidden.set(true);
          return;
        }
        this.error.set(this.locale.t('assetEditor.jobsError'));
        // A failed poll while something was moving is most likely a blip; keep asking.
        if ((this.jobs() ?? []).some((j) => ACTIVE.has(j.state))) this.schedule(assetId);
      },
    });
  }

  private schedule(assetId: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.destroyed) return;
      // Nobody is looking: skip the request, keep the cadence.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.schedule(assetId);
        return;
      }
      this.load(assetId);
    }, this.pollMs());
  }

  protected percent(job: Job): number {
    return Math.round(job.percent ?? 0);
  }

  protected time(iso: string): string {
    return new Intl.DateTimeFormat(this.locale.locale(), { timeStyle: 'medium' }).format(
      new Date(iso),
    );
  }
}
