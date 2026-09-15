// The RIM store: a port with two adapters, held to one conformance suite — the shape every
// service here shares.
//
// Uploads and jobs are JSON documents with the columns that are queried alongside (channel,
// state, expiry); parts are ROWS keyed by (upload, n), because "which parts do I hold" is the
// question a resume asks and a row per part answers it without reading the disk. The disk is
// still the ground truth for the bytes; the row is the ledger of what was accepted.

import type { OutboxRecord } from '@atlas/messaging';
import type { IngestJob, Upload, UploadPart } from './upload.ts';

export interface RimStore {
  transaction<T>(fn: (tx: RimTx) => Promise<T>): Promise<T>;
  upload(id: string): Promise<Upload | undefined>;
  /** The parts recorded for an upload, ascending by n. */
  parts(uploadId: string): Promise<UploadPart[]>;
  job(id: string): Promise<IngestJob | undefined>;
  /** Open uploads whose expiry has passed — what the sweeper discards. */
  expiredUploads(now: string, limit: number): Promise<Upload[]>;
  close(): Promise<void>;
}

export interface RimTx {
  putUpload(upload: Upload): Promise<void>;
  /** Record a part; sending the same part again replaces the record (the last write wins). */
  putPart(part: UploadPart): Promise<void>;
  /** Remove the upload and its parts. The job it produced, if any, stays. */
  deleteUpload(id: string): Promise<void>;
  putJob(job: IngestJob): Promise<void>;
  enqueue(record: OutboxRecord): Promise<void>;
}
