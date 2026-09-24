// The command subscription (EP-16.1) and the worker loop (EP-16.2).
//
// Two separate things that are easy to conflate: the SUBSCRIPTION turns a `transcode.job.create`
// command into a queued row and acknowledges it, in milliseconds; the LOOP leases queued rows and
// spends minutes in FFmpeg. Keeping them apart is what lets the broker's redelivery window stay
// short while a transcode takes as long as it takes — a consumer that ran the encode inside the
// message handler would have its message redelivered mid-encode by any sane ack deadline.

import type { Broker, Message, Subscription } from '@atlas/messaging';
import type { MtsService, RunOutcome } from './service.ts';

export interface JobConsumerOptions {
  broker: Broker;
  service: MtsService;
  /** Delivery attempts before the broker dead-letters a command this consumer keeps refusing. */
  maxAttempts?: number;
  onQueued?: (subject: string) => void;
  onDuplicate?: (subject: string) => void;
  onError?: (err: unknown, msg: Message) => void;
}

/** Every channel's transcode commands — `*` is the channel token. */
export const JOB_CREATE_PATTERN = 'atlas.*.transcode.job.create';

export function startJobConsumer(options: JobConsumerOptions): Subscription {
  return options.broker.subscribe(
    JOB_CREATE_PATTERN,
    async (msg: Message) => {
      try {
        const outcome = await options.service.consumeJobCreate(msg);
        if (outcome === 'applied') options.onQueued?.(msg.subject);
        else options.onDuplicate?.(msg.subject);
      } catch (err) {
        // Thrown, not swallowed: a command this service cannot honour — not an envelope, an
        // unknown preset, an input outside the work root — is retried and then dead-lettered
        // where `scripts/dlq.mjs` shows it to a person. Acking it would lose the job silently.
        options.onError?.(err, msg);
        throw err;
      }
    },
    { maxAttempts: options.maxAttempts ?? 5 },
  );
}

export interface WorkerOptions {
  service: MtsService;
  /** How long to wait after finding nothing to do. Default 1s. */
  idleMs?: number;
  /** How long a `running` row may go unwritten before the sweep takes it back. Default 5 min. */
  staleAfterMs?: number;
  signal: AbortSignal;
  onRun?: (outcome: RunOutcome) => void;
  onError?: (err: unknown) => void;
}

/**
 * Drain the queue until the signal aborts.
 *
 * ONE job at a time per process. mts.md's elasticity is horizontal — more workers, not more
 * concurrency per worker — because FFmpeg already uses the cores it is given, and two transcodes
 * on one pod contend for exactly the resource the pod is sized around.
 *
 * The loop never throws: a failure here would take the process down and leave the lease to the
 * sweep, when the job itself has already recorded what happened.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const idleMs = options.idleMs ?? 1_000;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
  let sweptAt = 0;

  while (!options.signal.aborted) {
    try {
      // Before asking for work, take back anything a dead worker still holds — otherwise a pod
      // that was killed mid-job leaves it `running` forever and the asset never gets its proxy.
      if (Date.now() - sweptAt > staleAfterMs) {
        sweptAt = Date.now();
        await options.service.sweepStale(staleAfterMs);
      }
      const outcome = await options.service.runNext(options.signal);
      options.onRun?.(outcome);
      if (outcome === 'idle') await sleep(idleMs, options.signal);
    } catch (err) {
      options.onError?.(err);
      await sleep(idleMs, options.signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
