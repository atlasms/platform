// MTS's persistence port (EP-16.1).
//
// The queue is a TABLE, not the broker. `transcode.job.create` is a command that arrives once and
// is acknowledged immediately; what happens to the job afterwards — leased, retried, resumed
// after a crash, read by `GET /jobs/{id}` — is state, and state that only exists as an unacked
// broker message cannot be read, counted or resumed. So the broker delivers the command, the row
// is the job, and a worker leases the row.
//
// Leasing is a compare-and-set, not a SELECT then an UPDATE: two workers polling the same channel
// is the normal case, not a race to be avoided by arranging for only one poller.

import type { OutboxRecord } from '@atlas/messaging';
import type { JobState, TranscodeJob } from './job.ts';
import type { TranscodeProfile } from './profile.ts';

export interface JobQuery {
  channelId?: string;
  state?: JobState;
  assetId?: string;
  limit?: number;
  /** Keyset: the last id already seen. Ids are ULIDs, so this is an index range. */
  after?: string;
}

export interface JobStore {
  /** One unit of work. Everything written inside commits together, or none of it does. */
  transaction<T>(fn: (tx: JobTx) => Promise<T>): Promise<T>;

  job(id: string): Promise<TranscodeJob | undefined>;
  jobs(query?: JobQuery): Promise<TranscodeJob[]>;

  /**
   * The next job a worker should run: `queued`, or `failed` with its backoff passed as of `now`;
   * highest priority first, oldest first within a priority. Reading it is not claiming it —
   * {@link JobTx.putJob} with `ifState` set to the state it was read in is, and it is what
   * decides between two workers that read the same row.
   */
  nextQueued(now: string): Promise<TranscodeJob | undefined>;

  /**
   * Jobs left `running` by a worker that never came back, as of `before`.
   *
   * mts.md calls this the visibility timeout. Ours is a sweep rather than a lease expiry in the
   * broker, because the job lives in the table: a row whose `updatedAt` has not moved for longer
   * than any heartbeat would is a job whose worker is gone.
   */
  stale(before: string): Promise<TranscodeJob[]>;

  /**
   * One profile, in exactly one scope: a channel's (`channelId`), or the platform-wide one
   * (`null`). The same id may exist in both — the channel's redefines the platform's for that
   * channel — so the scope is part of the key, never inferred.
   */
  profile(id: string, channelId: string | null): Promise<TranscodeProfile | undefined>;
  /** A channel's profiles AND the platform-wide ones, enabled or not — what an admin page lists. */
  profiles(channelId: string): Promise<TranscodeProfile[]>;

  close(): Promise<void>;
}

/** The write surface, reachable only from inside {@link JobStore.transaction}. */
export interface JobTx {
  /**
   * Write a job. With `ifState`, only when the stored row is still in that state — the
   * compare-and-set a lease and every transition needs — and returns whether it did. Without, an
   * upsert.
   */
  putJob(job: TranscodeJob, ifState?: JobState): Promise<boolean>;
  /** Enqueue a domain event on the outbox — in THIS transaction, with the row it announces. */
  enqueue(record: OutboxRecord): Promise<void>;
  /**
   * Claim a broker message id IN this transaction (EP-03.3) — `false` means it was already
   * consumed and nothing must be done. The claim commits with the effect or rolls back with it.
   */
  markSeen(messageId: string): Promise<boolean>;
  /**
   * Write a profile. With `ifVersion`, only when the stored row is still at that version — the
   * compare-and-set a PUT carries, so a stale write is refused instead of silently replacing
   * another administrator's change; returns whether it wrote. Without, an insert that returns
   * false when the (scope, id) already exists.
   */
  putProfile(profile: TranscodeProfile, ifVersion?: number): Promise<boolean>;
}
