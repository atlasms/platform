// The recorder worker (EP-39; ADR-0007 decisions 6–10): the process that actually records.
//
// One pass (`tick`, every second from recorder-main.ts):
//   1. RECOVER — on the first pass only: a capture this worker holds as `running` but is not
//      running (the pod restarted) is `partial`, and continued.
//   2. RENEW   — every capture it is recording keeps its lease.
//   3. START   — what is due: a planned capture whose span has begun, or one whose worker is gone
//      (its lease lapsed) — that one is marked `partial` for its old holder and CONTINUED here as
//      part n+1 from now. The lease rule never gives this worker both sides of a cut.
//   4. HAND OVER — every finished capture of this worker's still on its disk goes to RIM (signed,
//      ADR-0008); the file is deleted only when RIM has made it a job.
//
// A capture ends one of two ways. At the end of its span (FFmpeg exits 0 at `-t`): `completed`.
// Anything else — a crash, a feed that dropped, a drain — `partial`, the file kept (decision 3),
// and the rest of the span planned at once as a continuation. A feed that fails straight away is
// retried with a growing wait, so a dead feed is a few tries a minute, not one a second.
//
// Every state change is a compare-and-set on the state the worker last saw: if another worker
// took the capture over meanwhile, the change is simply not applied — the recording duplicated
// for a moment is the price, and it is the right one: a gap is the thing ADR-0007 exists to avoid.

import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '@atlas/contracts';
import type { Capture } from './capture.ts';
import type { Capturer } from './capturer.ts';
import type { HandOff } from './handoff-client.ts';
import type { Recorder } from './recorder.ts';
import { recordingAlert } from './recording-alerts.ts';
import type { RimStore } from './store.ts';

export interface RecorderWorkerOptions {
  store: RimStore;
  capturer: Capturer;
  handOff: HandOff;
  /** This worker: the pod's name — stable across restarts in a StatefulSet. */
  holder: string;
  /** Its own disk, where files wait until RIM has them. */
  workDir: string;
  now?: () => Date;
  /** How long a lease lasts; renewed every pass, so this bounds how long a dead worker holds one. */
  leaseMs?: number;
  /** The feed's URL with any passphrase applied — never logged. */
  feedUrl?: (recorder: Recorder) => Promise<string>;
  /** Where the worker reports; main.ts logs it. No URL and no passphrase is ever in `context`. */
  onEvent?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    context: Record<string, unknown>,
  ) => void;
}

export const DEFAULT_CAPTURE_LEASE_MS = 30_000;
/** A capture that ran less than this before failing is a feed that is not there: back off. */
const FAILED_FAST_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/** Ending this close to the span's end is ending AT it. */
const END_TOLERANCE_MS = 2_000;
/** Every alert this worker raises names it as the actor. */
const WORKER_ACTOR = { kind: 'service', id: 'rim-recorder' } as const;

interface Running {
  capture: Capture;
  abort: AbortController;
  done: Promise<void>;
}

export class RecorderWorker {
  private readonly store: RimStore;
  private readonly capturer: Capturer;
  private readonly handOffTo: HandOff;
  private readonly holder: string;
  private readonly workDir: string;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly feedUrl: (recorder: Recorder) => Promise<string>;
  private readonly onEvent: NonNullable<RecorderWorkerOptions['onEvent']>;
  private readonly running = new Map<string, Running>();
  /** Consecutive fast failures per file (recorder + file start): the continuation's wait. */
  private readonly failures = new Map<string, number>();
  private recovered = false;
  private handingOver = false;

  constructor(options: RecorderWorkerOptions) {
    this.store = options.store;
    this.capturer = options.capturer;
    this.handOffTo = options.handOff;
    this.holder = options.holder;
    this.workDir = options.workDir;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_CAPTURE_LEASE_MS;
    this.feedUrl = options.feedUrl ?? (async (r) => r.input.url);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /** How many captures this worker is recording now. */
  get active(): number {
    return this.running.size;
  }

  async tick(): Promise<void> {
    if (!this.recovered) {
      await this.recover();
      this.recovered = true;
    }
    await this.renew();
    await this.startDue();
    await this.handOverFinished();
  }

  /**
   * Stop recording (SIGTERM): every capture is stopped — FFmpeg finishes its file — marked
   * `partial` and continued, so another worker takes the rest of each span at once. Their files
   * stay on this worker's disk and are handed over when it comes back.
   */
  async drain(): Promise<void> {
    const all = [...this.running.values()];
    for (const r of all) r.abort.abort();
    await Promise.all(all.map((r) => r.done));
  }

  /** Wait for every capture in flight to end — for the suite. */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  // --- the pass ------------------------------------------------------------------------------------

  private async recover(): Promise<void> {
    for (const c of await this.store.capturesHeldBy(this.holder, 'running')) {
      if (this.running.has(c.id)) continue;
      await this.endPartial(c, 'recorder worker restarted', 'running');
    }
  }

  private async renew(): Promise<void> {
    const now = this.now().getTime();
    for (const { capture } of this.running.values()) {
      // A renewal. Refused means another worker has taken it over; recording on costs a
      // moment's duplicate and is never a gap, so the capture is left to finish.
      await this.lease(capture.id, now);
    }
  }

  private async startDue(): Promise<void> {
    const now = this.now().getTime();
    const due = await this.store.capturesDue(
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      20,
    );
    for (const found of due) {
      if (this.running.has(found.id)) continue;
      let capture = found;
      if (found.state === 'running') {
        // Its worker is gone. Its file is on that worker's disk, handed over when it returns.
        const continued = await this.endPartial(
          found,
          `recorder worker ${found.holder ?? 'unknown'} lost`,
          'running',
        );
        if (!continued) continue;
        capture = continued;
        if (Date.parse(capture.captureFrom) > now) continue;
      }
      if (!(await this.lease(capture.id, now))) continue;
      const leased = await this.store.capture(capture.id);
      if (leased) this.start(leased);
    }
  }

  private start(capture: Capture): void {
    const abort = new AbortController();
    const done = this.record(capture, abort.signal).finally(() => this.running.delete(capture.id));
    this.running.set(capture.id, { capture, abort, done });
  }

  private async record(capture: Capture, signal: AbortSignal): Promise<void> {
    const recorder = await this.store.recorder(capture.recorderId);
    if (!recorder || !recorder.enabled) {
      await this.transition(capture, {
        ...capture,
        state: 'cancelled',
        reason: 'recorder disabled',
      });
      return;
    }
    const startedMs = this.now().getTime();
    const file = this.fileOf(capture);
    const context = { captureId: capture.id, recorderId: capture.recorderId, part: capture.part };
    this.onEvent('info', 'capture started', context);
    const result = await this.capturer.run({
      url: await this.feedUrl(recorder),
      file,
      durationMs: Date.parse(capture.captureTo) - startedMs,
      signal,
    });
    const endedMs = this.now().getTime();
    const current = (await this.store.capture(capture.id)) ?? capture;
    if (
      result.exitCode === 0 &&
      !signal.aborted &&
      endedMs >= Date.parse(capture.captureTo) - END_TOLERANCE_MS
    ) {
      this.failures.delete(this.fileKey(capture));
      await this.transition(current, {
        ...current,
        state: 'completed',
        endedAt: new Date(endedMs).toISOString(),
      });
      this.onEvent('info', 'capture completed', context);
      return;
    }
    const why = signal.aborted
      ? 'recorder worker drained'
      : `ffmpeg exited ${result.exitCode}${result.stderrTail ? `: ${result.stderrTail}` : ''}`;
    if (endedMs - startedMs < FAILED_FAST_MS && !signal.aborted) {
      this.failures.set(this.fileKey(capture), (this.failures.get(this.fileKey(capture)) ?? 0) + 1);
    }
    this.onEvent('warn', 'capture ended early', { ...context, reason: why.slice(0, 300) });
    await this.endPartial(current, why, 'running');
  }

  /**
   * End a capture as `partial` — the file kept — and plan the rest of its span as the next part,
   * unless the span is (nearly) over. Returns the continuation, or undefined when there is none or
   * another worker already made it.
   */
  private async endPartial(
    capture: Capture,
    reason: string,
    ifState: Capture['state'],
  ): Promise<Capture | undefined> {
    const now = this.now().getTime();
    const ended: Capture = {
      ...capture,
      state: 'partial',
      endedAt: new Date(now).toISOString(),
      reason: reason.slice(0, 500),
    };
    const failures = this.failures.get(this.fileKey(capture)) ?? 0;
    const wait = failures === 0 ? 0 : Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS);
    const from = now + wait;
    const next: Capture | undefined =
      Date.parse(capture.captureTo) - from > END_TOLERANCE_MS
        ? {
            id: ulid(),
            recorderId: capture.recorderId,
            channelId: capture.channelId,
            fileStart: capture.fileStart,
            fileEnd: capture.fileEnd,
            captureFrom: new Date(from).toISOString(),
            captureTo: capture.captureTo,
            slot: capture.slot,
            part: capture.part + 1,
            state: 'planned',
          }
        : undefined;
    let inserted = false;
    const alert = recordingAlert(ended, 'recording-partial', ended.reason!, {
      ...(await this.nameOf(capture.recorderId)),
      now: this.now(),
      actor: WORKER_ACTOR,
    });
    const applied = await this.store.transaction(async (tx) => {
      if (!(await tx.putCapture(ended, ifState))) return false;
      if (next) inserted = await tx.insertCapture(next);
      // The gap is said out loud in the same transaction (EP-39 slice 2).
      await tx.enqueue(alert);
      return true;
    });
    if (!applied) return undefined;
    return inserted ? next : undefined;
  }

  private async handOverFinished(): Promise<void> {
    if (this.handingOver) return; // one hand-off pass at a time: a big file outlasts a tick
    this.handingOver = true;
    try {
      for (const c of await this.store.unhandedBy(this.holder)) {
        if (this.running.has(c.id)) continue;
        const file = this.fileOf(c);
        const size = await stat(file).then(
          (s) => s.size,
          () => undefined,
        );
        if (size === undefined || size === 0) {
          // Nothing to hand over: the feed sent nothing, or the disk was lost with the pod.
          const missed: Capture = {
            ...c,
            state: 'missed',
            reason:
              size === 0 ? 'no data received from the feed' : 'the file is not on this worker',
          };
          const alert = recordingAlert(missed, 'recording-missed', missed.reason!, {
            ...(await this.nameOf(c.recorderId)),
            now: this.now(),
            actor: WORKER_ACTOR,
          });
          // The hole and its alert commit together.
          await this.store.transaction(async (tx) => {
            if (await tx.putCapture(missed, c.state)) await tx.enqueue(alert);
          });
          await rm(file, { force: true });
          continue;
        }
        try {
          const { jobId } = await this.handOffTo.handOver(c, file);
          await rm(file, { force: true });
          this.onEvent('info', 'capture handed over', { captureId: c.id, jobId, bytes: size });
        } catch (err) {
          // The file stays; the next pass tries again.
          this.onEvent('error', 'hand-off failed', {
            captureId: c.id,
            error: (err as Error).message.slice(0, 300),
          });
        }
      }
    } finally {
      this.handingOver = false;
    }
  }

  // --- helpers -------------------------------------------------------------------------------------

  private lease(id: string, now: number): Promise<boolean> {
    return this.store.transaction((tx) =>
      tx.leaseCapture(
        id,
        this.holder,
        new Date(now).toISOString(),
        new Date(now + this.leaseMs).toISOString(),
      ),
    );
  }

  private transition(from: Capture, to: Capture): Promise<boolean> {
    return this.store.transaction((tx) => tx.putCapture(to, from.state));
  }

  /** The recorder's name for an alert's message — absent if the recorder is gone. */
  private async nameOf(recorderId: string): Promise<{ recorderName?: string }> {
    const name = (await this.store.recorder(recorderId))?.name;
    return name !== undefined ? { recorderName: name } : {};
  }

  private fileOf(capture: Pick<Capture, 'id'>): string {
    return join(this.workDir, `${capture.id}.ts`);
  }

  private fileKey(capture: Pick<Capture, 'recorderId' | 'fileStart'>): string {
    return `${capture.recorderId}/${capture.fileStart}`;
  }
}
