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
  /** The request or message chain the job belongs to. Every event the job causes carries it, including the ones the worker emits minutes later. */
  correlationId?: string;
  /** The transcode.job.create message that created the job. Absent for a job created over HTTP, which no message caused. */
  causationId?: string;
}

/** A transcode profile as an administrator writes it. Structured, never raw FFmpeg arguments — every value is an enum or a bounded number (the grammar in apps/mts/src/profile.ts), and a combination FFmpeg would refuse is a 422 naming the rule. At least one of `video` / `audio`. */
export interface ProfileInput {
  id: string;
  /** Omit for the caller's channel; null for platform-wide (unscoped config:admin). */
  channelId?: string | null;
  name: string;
  description?: string;
  kind: 'proxy' | 'broadcast' | 'thumbnail';
  container: 'mp4' | 'mov' | 'mxf' | 'm4a' | 'jpg';
  video?: {
    codec: 'h264' | 'mpeg2' | 'prores';
    width: number;
    height: number;
    fit?: 'pad' | 'fit';
    frameRate?: '23.976' | '24' | '25' | '29.97' | '30' | '50' | '59.94' | '60';
    scan?: 'progressive' | 'tff' | 'bff';
    chroma?: '420' | '422';
    bitrateMbps?: number;
    quality?: number;
    gpu?: 'none' | 'nvenc' | 'qsv';
  };
  audio?: {
    codec: 'aac' | 'pcm_s16le' | 'pcm_s24le';
    sampleRate?: number;
    channels?: number;
    bitrateKbps?: number;
  };
  /** false hides it from new jobs; profiles are disabled, never deleted. */
  enabled: boolean;
}

export type ProfileReplace = ProfileInput & { version: number };

export type Profile = ProfileInput & {
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export interface RenditionResult {
  presetId: string;
  /** A RenditionKind (common.schema.json) — defined once there, not repeated here. */
  kind: string;
  path: string;
  checksum: { algorithm: string; value: string };
  sizeBytes: number;
  /** Absent for a still. */
  durationSec?: number;
  /** The FFmpeg encoder that produced it, e.g. libx264 or h264_nvenc. */
  encoder?: string;
  /** The profile asked for a GPU this node could not use; the CPU encoded it. */
  fallback?: boolean;
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
