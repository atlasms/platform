// The transcode job (EP-16.1) — mts.md §3.1's state machine, as data and one pure function.
//
// A job is a request to produce a set of renditions from one input. It is queue-driven: nothing
// about it is a user's session, and the only thing that moves it through its states is a worker
// leasing it. The states are mts.yaml's, and they mean:
//
//   queued      nobody is working on it. The only state a worker may lease FROM.
//   running     a worker holds it. `workerId` says which, `percent` is best-effort progress.
//   completed   every requested preset produced a rendition, and each one was checksummed.
//   failed      this attempt did not; `attempts` says how many there have been and `reason` why.
//   dead-letter attempts are exhausted. A person decides what happens next.
//
// `failed` is deliberately not terminal: a transcode fails for reasons that pass (a node under
// memory pressure, a transient read), and the retry is what the attempt counter is for. A
// refusal about the BYTES is different — no number of retries makes an unreadable file readable
// — so it goes straight to dead-letter with the reason. See `transcoder.ts` for that distinction.

import type { Checksum, Rendition, RenditionKind } from '@atlas/contracts';

export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'dead-letter'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** What one preset produced, as the rendition MAM's FileRef mirror will copy (EP-17.8). */
export interface RenditionResult extends Rendition {
  kind: RenditionKind;
  presetId: string;
  path: string;
  checksum: Checksum;
  sizeBytes: number;
  durationSec?: number;
  /** The FFmpeg encoder that produced it (EP-16.6), e.g. `libx264`, `h264_nvenc`. */
  encoder?: string;
  /** The profile asked for a GPU this node could not use, and the CPU encoded it. */
  fallback?: boolean;
}

export interface TranscodeJob {
  id: string;
  channelId: string;
  assetId: string;
  /** Which presets to produce. Order is the order they run in: cheapest first is the caller's job. */
  presetIds: string[];
  /** The input, as a path MTS can read. Until HSM (EP-14), that is a path under its work root. */
  inputPath: string;
  state: JobState;
  /** Delivery attempts made. 1 while the first one runs — an attempt is counted when it starts. */
  attempts: number;
  /** Best-effort, 0–100, from the encoder's own progress. Never a state, and never trusted as one. */
  percent?: number;
  /** Set once the job completes. One entry per requested preset, in the order they were produced. */
  renditions?: RenditionResult[];
  /** Why it failed or was dead-lettered — the encoder's words, trimmed, or the supervisor's. */
  reason?: string;
  /**
   * A `failed` job is not leased before this. Backoff, because the failures worth retrying are
   * the ones that pass — a full disk, a node under memory pressure — and retrying one of those
   * the instant it happened only spends an attempt finding out it has not passed yet.
   */
  retryAt?: string;
  /** Which worker holds (or last held) it. For operators reading logs, not for routing. */
  workerId?: string;
  /** Higher runs sooner; equal priorities run oldest first. */
  priority: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  version: number;
  /**
   * The chain the job belongs to (EP-03.5): the request's correlation id, or the command's —
   * opened from the command's own id when it carried none. KEPT on the row because most of what
   * a job announces is emitted by the worker, long after the request or message is gone.
   */
  correlationId?: string;
  /** The `transcode.job.create` message that created it; absent when a request did. */
  causationId?: string;
}

/**
 * Which transitions exist. Everything else is a bug, and the store's compare-and-set is what
 * makes the answer here binding rather than advisory — two workers can both believe a job is
 * theirs, and only one of them can write it.
 */
const ALLOWED: Record<JobState, readonly JobState[]> = {
  queued: ['running'],
  // A failed job is leased again once its backoff has passed: `failed` IS the waiting room, and
  // routing it back through `queued` first would be a second write that says nothing.
  failed: ['running', 'dead-letter'],
  // A worker that dies mid-job leaves `running`; the recovery sweep is what moves it back to
  // `queued`, which is why that edge exists here and is not only the happy path's.
  running: ['completed', 'failed', 'dead-letter', 'queued'],
  completed: [],
  'dead-letter': [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED[from].includes(to);
}

/** A job's renditions as the `transcode.completed` payload carries them (no `presetId` there). */
export function renditionsFor(job: TranscodeJob): Rendition[] {
  // `Rendition` is closed (additionalProperties: false): what only MTS knows stays on the job.
  return (job.renditions ?? []).map(
    ({ presetId: _presetId, encoder: _encoder, fallback: _fallback, ...rendition }) => rendition,
  );
}
