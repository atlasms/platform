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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Job } from '../core/generated/mts.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { TranscodeJobsService } from '../core/transcode-jobs.service.ts';
import { WebSocketService } from '../core/websocket.service.ts';

/** States in which a job may still change — and therefore the page should keep asking. */
const ACTIVE: ReadonlySet<Job['state']> = new Set(['queued', 'running', 'failed']);

/**
 * An asset's transcode jobs, on its Files tab (EP-16): what MTS is doing to produce the renditions
 * the rows above it will hold — queued, running with its progress, waiting to retry and why, given
 * up and why, or done.
 *
 * LIVE where it can be, POLLED always. MTS announces progress on `live.<channel>.transcode.progress`
 * (EP-16.4) — kept by nothing, so a tab listening now sees the bar move and a tab opened later
 * reads the row. The poll is what reports STATE (queued → running → completed), and it runs every
 * 2 s while the socket is down but every 10 s while it is live, since the bar no longer needs it.
 * It stops by itself once every job is completed or dead-lettered, skips a tick while the page is
 * hidden, and dies with the component: a closed tab does not keep asking MTS about an asset.
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
                  @if (speeds()[job.id]; as speed) {
                    <span class="figure">{{ speed }}×</span>
                  }
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
  /** How often to ask while a job is moving and the socket is down. An input so a test can drive it. */
  readonly pollMs = input(2_000);
  /** How often while the socket is live: progress arrives by itself, only STATE is polled for. */
  readonly livePollMs = input(10_000);
  /** A job this component watched moved to `completed`. */
  readonly completed = output<Job>();

  private readonly api = inject(TranscodeJobsService);
  private readonly ws = inject(WebSocketService);
  private readonly session = inject(SessionStore);
  protected readonly locale = inject(LocaleService);
  /** The realtime factor each job last reported, live. Never polled: the row does not carry it. */
  protected readonly speeds = signal<Record<string, string>>({});

  protected readonly jobs = signal<Job[] | null>(null);
  protected readonly error = signal<string | null>(null);
  /** A caller without `asset:read` on files: the section is not shown, rather than shown refused. */
  protected readonly hidden = signal(false);
  /** Newest first: what just happened is what a person opened the tab to see. */
  protected readonly ordered = computed(() => [...(this.jobs() ?? [])].reverse());

  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  /** A read is outstanding — so a burst of frames for a new job asks MTS once, not per frame. */
  private reading = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.timer);
    });
    // The channel's progress stream. Not unsubscribed on destroy — the pattern is shared by every
    // open asset tab of the channel (the client keeps one desired set), and a frame for a job this
    // view does not show is simply ignored below. The same rule the asset editor follows.
    effect(() => {
      const channelId = this.session.channelId();
      if (channelId) void this.ws.subscribe(`live.${channelId}.transcode.progress`);
    });
    this.ws.events$
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(({ subject, payload }) => this.onLive(subject, payload));
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
    this.reading = true;
    this.api.forAsset(assetId).subscribe({
      next: (jobs) => {
        this.reading = false;
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
        this.reading = false;
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

  /**
   * A progress frame: move the bar of the job it names, if this view shows it and it is running.
   *
   * Forward only — frames are at most once and unordered across a reconnect, and a late 40% must
   * not pull back a bar the poll already put at 70. A job this view has not seen yet means one was
   * enqueued since the last read: ask now rather than at the next tick.
   */
  private onLive(subject: string, payload: unknown): void {
    if (!subject.startsWith('live.') || !subject.endsWith('.transcode.progress')) return;
    const progress = (
      payload as {
        payload?: { jobId?: string; assetId?: string; percent?: number; speed?: number };
      }
    )?.payload;
    if (!progress?.jobId || progress.assetId !== this.assetId()) return;
    const jobs = this.jobs();
    const job = jobs?.find((j) => j.id === progress.jobId);
    if (!job) {
      if (!this.reading) this.load(this.assetId());
      return;
    }
    if (job.state !== 'running' && job.state !== 'queued') return;
    const percent = progress.percent ?? 0;
    if (percent > (job.percent ?? 0)) {
      this.jobs.set(
        (jobs ?? []).map((j) => (j.id === job.id ? { ...j, state: 'running', percent } : j)),
      );
    }
    if (progress.speed !== undefined) {
      this.speeds.set({ ...this.speeds(), [job.id]: progress.speed.toFixed(1) });
    }
  }

  private schedule(assetId: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        if (this.destroyed) return;
        // Nobody is looking: skip the request, keep the cadence.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          this.schedule(assetId);
          return;
        }
        this.load(assetId);
      },
      this.ws.state() === 'connected' ? this.livePollMs() : this.pollMs(),
    );
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
