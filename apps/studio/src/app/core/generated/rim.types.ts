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
  /** The client's idea of the media type; acceptance (EP-15.3) decides from the bytes, not from this. */
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
  /** The part numbers the server holds, ascending. Resume by sending the rest. */
  received: number[];
  state: 'open' | 'completed';
  jobId?: Ulid;
  createdBy?: string;
  createdAt?: string;
  /** An open upload not completed by then is swept, parts and all (ATLAS_UPLOAD_TTL_MS). */
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
  /** Server-minted when omitted; a client that supplies one keeps a stable id across replacements, so a job's `ruleId` still names it. */
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

export interface RecordingWindow {
  days: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[];
  /** HH:MM in the recorder's zone. */
  from: string;
  /** HH:MM after `from`; 24:00 is the end of the day. A window across midnight is two windows — windows that touch are merged into one recording. */
  to: string;
}

export interface RecorderInput {
  name: string;
  /** The feed. Two captures read it at once for the seconds of every overlap, so it must serve several readers — multicast, or SRT from an encoder in listener mode that accepts several callers. A unicast UDP push serves one (ADR-0007, measured). */
  input: { url: string; passphraseSecret?: string };
  /** IANA zone the windows are in. */
  timezone: string;
  windows: RecordingWindow[];
  /** The length of a file, on a grid from local midnight — it must divide a day. An hour is the norm; a minute is for testing a recorder end to end. */
  fileMinutes?: number;
  /** Each file is captured from this long before its start to this long after its end. */
  padSeconds?: number;
  /** A disabled recorder is kept and records nothing; captures not yet started are cancelled. */
  enabled?: boolean;
}

export type Recorder = RecorderInput & {
  id: Ulid;
  channelId: string;
  fileMinutes: number;
  padSeconds: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

/** A recorder's health at a glance (EP-39 slice 2). `recording` is every capture of it running now — two for the seconds of an overlap, none between windows. The counts are over the files that started in the last 24 h; a missed file is a hole in the recording and also raised `alert.raised` (recording-missed, critical), a partial one a gap of seconds (warning). */
export interface RecorderStatus {
  recorderId: Ulid;
  recording: { holder: string; part: number; fileStart: string; fileEnd: string }[];
  missed24h: number;
  partial24h: number;
  lastMissed?: { fileStart: string; fileEnd: string; reason?: string };
}

/** One file of a recording, as planned and as run: the grid slot it covers (`fileStart` to `fileEnd`), the padded span it is captured over, and the slot — 0 or 1, alternating — that puts neighbouring files on different workers. */
export interface Capture {
  id: Ulid;
  recorderId: Ulid;
  channelId: string;
  fileStart: string;
  fileEnd: string;
  captureFrom: string;
  captureTo: string;
  slot: number;
  /** A crash continues the same file as part 2, 3, … */
  part: number;
  state: 'planned' | 'running' | 'completed' | 'partial' | 'missed' | 'cancelled';
  /** The worker (a pod) running it, or that last ran it. */
  holder?: string;
  startedAt?: string;
  endedAt?: string;
  /** The ingest job the file became, once handed over. */
  jobId?: Ulid;
  /** Why it is partial or missed. */
  reason?: string;
}

export interface WatcherInput {
  name: string;
  /** The folder, relative to the channel's own directory of RIM's watch root (`<watchRoot>/<channelId>/<path>`) — so a channel can only ever watch its own drops. Checked on the resolved real path, symlinks included. Only files directly in it are picked up. */
  path: string;
  /** A file is picked up once its size and mtime have not changed for this long — a copy still in progress is left alone. */
  settleSeconds?: number;
  /** Only these (lowercase, without the dot). Absent or empty is every file. Hidden files and partial-transfer names (.part, .tmp, .crdownload, ~) are always ignored. */
  extensions?: string[];
  /** What happens to the source file once its job is committed. `keep` leaves it; the pickup ledger stops it being taken twice, and a changed file (new checksum) is taken again. */
  afterPickup?: 'delete' | 'keep';
  /** A disabled watcher is kept and not scanned. */
  enabled?: boolean;
}

export type Watcher = WatcherInput & {
  id: Ulid;
  channelId: string;
  settleSeconds: number;
  afterPickup: 'delete' | 'keep';
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
