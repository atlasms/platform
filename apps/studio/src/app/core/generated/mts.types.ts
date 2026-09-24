// GENERATED FROM docs/architecture/openapi/mts.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: MTS's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

/** A transcode job (mts.md §3.1). `failed` is not terminal — the job is leased again after `retryAt`; `dead-letter` is, and happens at once for a refusal of the INPUT (bytes FFmpeg will not decode) and after the last attempt for anything else. */
export interface Job {
  id: Ulid;
  channelId: string;
  assetId: Ulid;
  presetIds: string[];
  inputPath: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'dead-letter';
  /** Attempts started. An attempt interrupted by a drain is given back. */
  attempts: number;
  /** Best-effort progress across the job's presets. Never a state. */
  percent?: number;
  /** Set once completed — one per preset, in the order produced. What `transcode.completed` carries, plus the preset. */
  renditions?: RenditionResult[];
  /** Why the last attempt failed, or why it was dead-lettered. */
  reason?: string;
  /** A failed job is not leased again before this. */
  retryAt?: string;
  /** The worker holding (or last holding) it — a pod name. */
  workerId?: string;
  priority: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  version: number;
}

export interface RenditionResult {
  presetId: string;
  /** A RenditionKind (common.schema.json) — defined once there, not repeated here. */
  kind: string;
  path: string;
  checksum: { algorithm: string; value: string };
  sizeBytes: number;
  /** Absent for a still. */
  durationSec?: number;
}

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
