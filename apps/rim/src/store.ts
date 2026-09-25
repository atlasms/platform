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
  enqueue(record: OutboxRecord): Promise<void>;
}
