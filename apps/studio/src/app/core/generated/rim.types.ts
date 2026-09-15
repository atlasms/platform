// GENERATED FROM docs/architecture/openapi/rim.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: RIM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

export interface StartUpload {
  /** The client's file name, kept as the received file's name after sanitising (no path, no control characters). */
  filename: string;
  /** The whole file's length. What the parts must add up to. */
  sizeBytes: number;
  /** The client's idea of the media type; acceptance (EP-15.3) decides from the bytes */
  contentType?: string;
}

export interface Upload {
  uploadId: Ulid;
  channelId: string;
  filename: string;
  sizeBytes: number;
  contentType?: string;
  /** Chosen by the server (ATLAS_UPLOAD_PART_BYTES). Every part but the last is exactly this long. */
  partSizeBytes: number;
  /** `ceil(sizeBytes / partSizeBytes)`; parts are numbered 1..partCount. */
  partCount: number;
  /** The part numbers the server holds */
  received: number[];
  state: 'open' | 'completed';
  jobId?: Ulid;
  createdBy?: string;
  createdAt?: string;
  /** An open upload not completed by then is swept */
  expiresAt: string;
}

export interface IngestJob {
  id: Ulid;
  channelId: string;
  /** The source that produced it: `upload` for the built-in web upload; a watcher or recorder id later (EP-15.2). */
  source?: string;
  sourceKind?: 'upload' | 'ftp' | 'watch' | 'recorder';
  state: 'detected' | 'validating' | 'rejected' | 'quarantined' | 'accepted' | 'registered';
  filename?: string;
  sizeBytes?: number;
  /** sha256 of the received bytes, lowercase hex — computed while the parts were assembled, so it is the checksum of what was actually written. */
  checksum?: string;
  contentType?: string;
  technicalMetadata?: TechnicalMetadata;
  assetId?: Ulid;
  /** Why it is quarantined or rejected: the failed rule's reason, or the operator's. Cleared when an operator accepts; the history keeps it. */
  reason?: string;
  /** The acceptance rule that quarantined or rejected it (EP-15.3). */
  ruleId?: Ulid;
  /** The rule set that rule belongs to. */
  ruleSetId?: Ulid;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** The audit revision (EP-19.2); every write bumps it. */
  version: number;
}

/** ffprobe-derived technical metadata; additive fields allowed. */
export interface TechnicalMetadata {
  /** The demuxer's own name (mxf, mov, wav). */
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  /** W:H — the container's declared display aspect, or the frame's own reduced ratio. */
  aspectRatio?: string;
  audioChannels?: number;
  frameRate?: number;
}

export interface IngestQueuePage {
  items: IngestJob[];
  /** Absent when the channel is exhausted. */
  nextCursor?: Ulid;
}

export interface AcceptanceRuleInput {
  /** Server-minted when omitted; a client that supplies one keeps a stable id across replacements */
  id?: Ulid;
  kind: 'container' | 'minSizeBytes' | 'maxSizeBytes' | 'aspectRatio';
  /** What failing this rule does to the job. `reject` beats `quarantine` when several rules fail. */
  onFail: 'reject' | 'quarantine';
  /** For the reason an operator reads. */
  label?: string;
  /** `container`: the file extensions accepted, lowercase, no dot (mxf, mov, mp4). The name is the evidence until the probe (EP-15.4) reads the bytes. */
  containers?: string[];
  /** `minSizeBytes` / `maxSizeBytes`: the bound, inclusive. */
  bytes?: number;
  /** `aspectRatio`: the ratio the picture must have, W:H (16:9). */
  aspectRatio?: string;
}

export type AcceptanceRule = AcceptanceRuleInput & { id: Ulid };

export interface AcceptanceRuleSetInput {
  name: string;
  /** Which jobs the set applies to. Empty (or absent) is every job in the channel. */
  scope?: { sourceKind?: 'upload' | 'ftp' | 'watch' | 'recorder'; sourceId?: string };
  rules: AcceptanceRuleInput[];
  /** A disabled set is kept and not applied. */
  enabled?: boolean;
}

export type AcceptanceRuleSet = AcceptanceRuleSetInput & {
  id: Ulid;
  channelId: string;
  rules: AcceptanceRule[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

/** RFC 9457 Problem Details, served as application/problem+json, with the platform's keys kept: `code` is the machine key (a closed enum — VALIDATION, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, PAYLOAD_TOO_LARGE, RATE_LIMITED, UNAVAILABLE, INTERNAL), `message` the text. The RFC members are derived from them: `type` is https://atlas.example/problems/<code>, `title` is constant per code, `detail` equals `message`, `instance` is urn:atlas:correlation:<correlationId>. */
export interface Error {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code:
    | 'VALIDATION'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PAYLOAD_TOO_LARGE'
    | 'RATE_LIMITED'
    | 'UNAVAILABLE'
    | 'INTERNAL';
  message: string;
  details?: unknown;
  correlationId?: string;
}
