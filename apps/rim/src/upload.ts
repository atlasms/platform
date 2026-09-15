// The upload and the ingest job — rim.md §3, rim.yaml — and the arithmetic of parts.
//
// The SERVER chooses the part size (rim.yaml, `Upload.partSizeBytes`) and tells the client at
// start. Every part but the last is exactly that long, the last is the remainder, and a part of
// any other length is refused before it is stored: the assembled file is then `sizeBytes` long by
// construction, and a client that sliced wrongly finds out at the first part, not at completion.

import { ulid, type TechnicalMetadata } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';

export type UploadState = 'open' | 'completed';

export interface Upload {
  uploadId: string;
  channelId: string;
  filename: string;
  sizeBytes: number;
  contentType?: string;
  partSizeBytes: number;
  partCount: number;
  state: UploadState;
  /** Set once completed: the ingest job the bytes became. */
  jobId?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface UploadPart {
  uploadId: string;
  n: number;
  sizeBytes: number;
  /** sha256 of this part's bytes, hex — what a client can compare against after a resume. */
  sha256: string;
}

export type IngestState =
  'detected' | 'validating' | 'rejected' | 'quarantined' | 'accepted' | 'registered';
export const INGEST_STATES: readonly IngestState[] = [
  'detected',
  'validating',
  'rejected',
  'quarantined',
  'accepted',
  'registered',
];
export type SourceKind = 'upload' | 'ftp' | 'watch' | 'recorder';

export interface IngestJob {
  id: string;
  channelId: string;
  source: string;
  sourceKind: SourceKind;
  state: IngestState;
  filename: string;
  sizeBytes: number;
  /** sha256 of the received bytes, lowercase hex. */
  checksum: string;
  contentType?: string;
  /** What the probe read from the bytes (EP-15.4). Absent until `validating` has run it. */
  technicalMetadata?: TechnicalMetadata;
  /**
   * Where the received bytes sit in RIM's staging area. Internal: not on the wire. Absent once
   * the bytes are gone — a rejected job's file is discarded; the row stays as the record.
   */
  receivedPath?: string;
  assetId?: string;
  /** Why it is quarantined or rejected — the failed rule's words, or the operator's. */
  reason?: string;
  /** The acceptance rule and set that quarantined or rejected it (EP-15.3). */
  ruleId?: string;
  ruleSetId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface StartUploadInput {
  filename: string;
  sizeBytes: number;
  contentType?: string;
}

/** `Upload.received` on the wire — the row plus the part numbers the server holds. */
export type UploadStatus = Upload & { received: number[] };

/** The one built-in source until watchers and recorders are entities (EP-15.2). */
export const UPLOAD_SOURCE = 'upload';

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * A file name, not a path. The client's name is kept for the received file and the job — an
 * operator recognises `bulletin-1800.mxf` — but never as a path component anyone else chose:
 * separators, `..`, control characters and an empty or over-long name are refused rather than
 * cleaned, because a silently "fixed" name is a name the client did not send.
 */
export function checkFilename(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('filename is required');
  }
  if (name.length > 255) throw new ValidationError('filename must be at most 255 characters');
  if (/[/\\]/.test(name) || name === '.' || name === '..' || CONTROL.test(name)) {
    throw new ValidationError('filename must be a plain file name, not a path');
  }
  return name;
}

export function parseStartUpload(body: unknown): StartUploadInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be an object');
  }
  const b = body as Record<string, unknown>;
  const filename = checkFilename(b['filename']);
  const sizeBytes = b['sizeBytes'];
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw new ValidationError('sizeBytes must be a positive integer');
  }
  const contentType = b['contentType'];
  if (contentType !== undefined && (typeof contentType !== 'string' || contentType === '')) {
    throw new ValidationError('contentType must be a non-empty string when given');
  }
  return {
    filename,
    sizeBytes,
    ...(contentType !== undefined ? { contentType: contentType as string } : {}),
  };
}

export function partCountOf(sizeBytes: number, partSizeBytes: number): number {
  return Math.ceil(sizeBytes / partSizeBytes);
}

/** The exact length part `n` must have: the part size, or the remainder for the last one. */
export function expectedPartSize(
  upload: Pick<Upload, 'sizeBytes' | 'partSizeBytes' | 'partCount'>,
  n: number,
): number {
  if (!Number.isInteger(n) || n < 1 || n > upload.partCount) {
    throw new ValidationError(`part number must be between 1 and ${upload.partCount}`);
  }
  if (n < upload.partCount) return upload.partSizeBytes;
  return upload.sizeBytes - (upload.partCount - 1) * upload.partSizeBytes;
}

/** The parts of 1..partCount that are not in `received`. */
export function missingParts(partCount: number, received: readonly number[]): number[] {
  const have = new Set(received);
  const missing: number[] = [];
  for (let n = 1; n <= partCount; n += 1) if (!have.has(n)) missing.push(n);
  return missing;
}

export function newUpload(
  input: StartUploadInput,
  by: { userId: string; channelId: string },
  options: { partSizeBytes: number; ttlMs: number; now: number },
): Upload {
  const partSizeBytes = options.partSizeBytes;
  return {
    uploadId: ulid(),
    channelId: by.channelId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
    partSizeBytes,
    partCount: partCountOf(input.sizeBytes, partSizeBytes),
    state: 'open',
    createdBy: by.userId,
    createdAt: new Date(options.now).toISOString(),
    expiresAt: new Date(options.now + options.ttlMs).toISOString(),
  };
}
