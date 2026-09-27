// The RIM store: a port with two adapters, held to one conformance suite — the shape every
// service here shares.
//
// Uploads and jobs are JSON documents with the columns that are queried alongside (channel,
// state, expiry); parts are ROWS keyed by (upload, n), because "which parts do I hold" is the
// question a resume asks and a row per part answers it without reading the disk. The disk is
// still the ground truth for the bytes; the row is the ledger of what was accepted.

import type { OutboxRecord } from '@atlas/messaging';
import type { AcceptanceRuleSet } from './acceptance.ts';
import type { IngestJob, IngestState, Upload, UploadPart } from './upload.ts';
import type { Capture, CaptureState } from './capture.ts';

/** One recorder's counts over a window of files (a status summary's raw half). */
export interface CaptureCounts {
  recorderId: string;
  missed: number;
  partial: number;
}
import type { Recorder } from './recorder.ts';
import type { Pickup, Watcher } from './watcher.ts';

export interface JobQuery {
  limit: number;
  /** The last id already seen — keyset, never offset. */
  cursor?: string;
  state?: IngestState;
  order: 'asc' | 'desc';
}

export interface RimStore {
  transaction<T>(fn: (tx: RimTx) => Promise<T>): Promise<T>;
  upload(id: string): Promise<Upload | undefined>;
  /** The parts recorded for an upload, ascending by n. */
  parts(uploadId: string): Promise<UploadPart[]>;
  job(id: string): Promise<IngestJob | undefined>;
  /** A channel's jobs, one page, by ULID order. Returns up to `limit + 1` so the caller knows. */
  jobs(channelId: string, query: JobQuery): Promise<IngestJob[]>;
  /**
   * Jobs in a state since before `before` — across channels: what the recovery loop picks up when
   * a job was created and the validation that should have followed did not (a crash between).
   */
  jobsInState(state: IngestState, before: string, limit: number): Promise<IngestJob[]>;
  /** Open uploads whose expiry has passed — what the sweeper discards. */
  expiredUploads(now: string, limit: number): Promise<Upload[]>;
  ruleSets(channelId: string): Promise<AcceptanceRuleSet[]>;
  ruleSet(id: string): Promise<AcceptanceRuleSet | undefined>;
  /** A channel's watchers, enabled or not — what the admin API lists. */
  watchers(channelId: string): Promise<Watcher[]>;
  watcher(id: string): Promise<Watcher | undefined>;
  /** Every enabled watcher, across channels — what the scan loop walks. */
  enabledWatchers(): Promise<Watcher[]>;
  /** The latest pickup of a file name by a watcher, if it ever took one. */
  pickup(watcherId: string, name: string): Promise<Pickup | undefined>;
  /** A channel's recorders, enabled or not. */
  recorders(channelId: string): Promise<Recorder[]>;
  recorder(id: string): Promise<Recorder | undefined>;
  /** Every enabled recorder, across channels — what the planner walks. */
  enabledRecorders(): Promise<Recorder[]>;
  capture(id: string): Promise<Capture | undefined>;
  /** A recorder's captures whose file starts at or after `from`, oldest first. */
  captures(recorderId: string, from: string, limit: number): Promise<Capture[]>;
  /**
   * The recorder's last capture that is not cancelled, by file start — where planning continues,
   * and whose slot the next file must not repeat.
   */
  lastCapture(recorderId: string): Promise<Capture | undefined>;
  /** Captures in `state` whose capture span ENDED before `before`, across recorders. */
  capturesEndedIn(state: CaptureState, before: string, limit: number): Promise<Capture[]>;
  /**
   * What a recorder worker may start (EP-39): `planned` captures whose span begins by `until` and
   * has not ended at `now`, and `running` ones whose lease has LAPSED (their worker is gone) and
   * whose span has not ended — earliest first.
   */
  capturesDue(now: string, until: string, limit: number): Promise<Capture[]>;
  /** A worker's own captures in `state` — what it recovers after a restart. */
  capturesHeldBy(holder: string, state: CaptureState): Promise<Capture[]>;
  /** A worker's finished captures not yet handed over (no job): what its disk still owes RIM. */
  unhandedBy(holder: string): Promise<Capture[]>;
  /** A channel's captures running now, across its recorders. */
  runningCaptures(channelId: string): Promise<Capture[]>;
  /** Per recorder of a channel: missed and partial captures among files starting at/after `since`. */
  captureCounts(channelId: string, since: string): Promise<CaptureCounts[]>;
  /** A channel's latest missed capture per recorder since `since`. */
  lastMissed(channelId: string, since: string): Promise<Capture[]>;
  close(): Promise<void>;
}

export interface RimTx {
  putUpload(upload: Upload): Promise<void>;
  /** Record a part; sending the same part again replaces the record (the last write wins). */
  putPart(part: UploadPart): Promise<void>;
  /** Remove the upload and its parts. The job it produced, if any, stays. */
  deleteUpload(id: string): Promise<void>;
  /**
   * Write a job. With `ifState`, only when the stored row is still in that state — the
   * compare-and-set a transition needs so two validators (the request's and the recovery loop's)
   * cannot both apply it; returns whether it did. Without, an upsert.
   */
  putJob(job: IngestJob, ifState?: IngestState): Promise<boolean>;
  putRuleSet(set: AcceptanceRuleSet): Promise<void>;
  deleteRuleSet(id: string): Promise<void>;
  putWatcher(watcher: Watcher): Promise<void>;
  /**
   * Record that a watcher took a file. Keyed by (watcher, name, checksum): the SAME bytes under
   * the same name again are a duplicate — returns false and the caller creates nothing — while a
   * changed file (a new checksum) is a new pickup.
   */
  putPickup(pickup: Pickup): Promise<boolean>;
  /**
   * Hold a watcher's lease until `until` — one owner per watched folder (rim.md §8). Granted when
   * nobody holds it, the holder is the one asking (a renewal), or the lease ran out; returns
   * whether it was granted. Two RIM pods overlap in a rolling update, and both would otherwise
   * scan the same folder.
   */
  leaseWatcher(
    watcherId: string,
    channelId: string,
    holder: string,
    now: string,
    until: string,
  ): Promise<boolean>;
  putRecorder(recorder: Recorder): Promise<void>;
  /** Insert a planned capture; false when one for that recorder, file start and part exists. */
  insertCapture(capture: Capture): Promise<boolean>;
  /**
   * Write a capture's run state, guarded by the state it was read in — a compare-and-set, so a
   * worker's report and the planner's "missed" cannot both apply.
   */
  putCapture(capture: Capture, ifState: CaptureState): Promise<boolean>;
  /**
   * Remove a recorder's planned captures that have not started (capture span begins after
   * `after`) — a replaced or disabled recorder is planned again. Returns how many went.
   */
  deletePlanned(recorderId: string, after: string): Promise<number>;
  /**
   * Lease a capture to `holder` until `until`: granted when it is `planned`, or `running` under a
   * lease that has run out (its worker is gone), or already the holder's (a renewal) — AND the
   * holder is not running another capture of the same recorder that overlaps it. That last clause
   * is ADR-0007's rule: the two sides of a cut are never one worker. Returns whether it was granted.
   */
  leaseCapture(id: string, holder: string, now: string, until: string): Promise<boolean>;
  enqueue(record: OutboxRecord): Promise<void>;
}
