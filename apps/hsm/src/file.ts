// The file ledger's record (EP-14.1; data-model §1.5, file.schema.json) — HSM is the system of
// record for where a file's bytes are and whether they are intact.
//
// ONE LIVE ROW per (assetId, kind, variant): a file belongs to exactly one asset and is never shared.
// A placement that replaces a file keeps the row's id and bumps its version — the history is the
// audit trail — and points it at NEW bytes under a new key; the old bytes are released by an
// operation queued in the same transaction, never overwritten in place (ADR-0009 §3).

import { ValidationError } from '@atlas/service-kit';

export const FILE_KINDS = [
  'original',
  'proxy',
  'broadcast',
  'thumbnail',
  'vtt-filmstrip',
  'hover-preview',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const TIERS = ['online', 'near-line', 'offline'] as const;
export type Tier = (typeof TIERS)[number];
export type FileStatus = 'available' | 'restoring' | 'missing' | 'quarantined';
export const PRODUCERS = ['ingest', 'transcode', 'editor', 'import'] as const;
export type Producer = (typeof PRODUCERS)[number];

export interface FileEntry {
  id: string;
  channelId: string;
  assetId: string;
  kind: FileKind;
  variant?: string;
  storage: { targetId: string; path: string; tier: Tier; status: FileStatus };
  checksum: { algorithm: 'sha256'; value: string };
  sizeBytes: number;
  lastVerifiedAt?: string;
  technical?: Record<string, unknown>;
  provenance?: { producedBy: Producer; jobId?: string; profile?: string };
  /** Bumped on every change; the audit revision and the compare-and-set token. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Set when the file is deleted; the row stays, for audit. */
  deletedAt?: string;
}

/** A verified copy of a file's bytes on another target (a `copy` operation's result). */
export interface Replica {
  fileId: string;
  channelId: string;
  targetId: string;
  path: string;
  tier: Tier;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

/** What a producer says about the file it pushes — from the SIGNED query string, never headers. */
export interface PlacementInput {
  channelId: string;
  assetId: string;
  kind: FileKind;
  variant?: string;
  producedBy: Producer;
  jobId?: string;
  profile?: string;
  technical?: Record<string, unknown>;
}

const VARIANT = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The storage key of one placement: `<channel>/<asset>/<kind>[.<variant>]/<blobId>`. A new blob id
 * per placement — so a placement never writes where live bytes are.
 */
export function keyFor(
  file: Pick<FileEntry, 'channelId' | 'assetId' | 'kind' | 'variant'>,
  blobId: string,
): string {
  const kind = file.variant !== undefined ? `${file.kind}.${file.variant}` : file.kind;
  return `${file.channelId}/${file.assetId}/${kind}/${blobId}`;
}

/** Parse a placement's query string (it is inside the signature; the headers are not). */
export function parsePlacement(
  assetId: string,
  kind: string,
  query: Record<string, string | undefined>,
): PlacementInput {
  const errors: string[] = [];
  if (!ULID.test(assetId)) errors.push('assetId must be a ULID');
  if (!(FILE_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind must be one of ${FILE_KINDS.join(', ')}`);
  }
  const channelId = query['channelId'];
  if (channelId === undefined || !CHANNEL.test(channelId)) {
    errors.push('channelId is required: letters, digits, _ and -');
  }
  const variant = query['variant'];
  if (variant !== undefined && !VARIANT.test(variant)) {
    errors.push('variant must be 1–64 letters, digits, _ or -');
  }
  const producedBy = query['producedBy'] ?? 'transcode';
  if (!(PRODUCERS as readonly string[]).includes(producedBy)) {
    errors.push(`producedBy must be one of ${PRODUCERS.join(', ')}`);
  }
  const jobId = query['jobId'];
  if (jobId !== undefined && !ULID.test(jobId)) errors.push('jobId must be a ULID');
  let technical: Record<string, unknown> | undefined;
  if (query['technical'] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(query['technical']);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      technical = parsed as Record<string, unknown>;
    } catch {
      errors.push('technical must be a JSON object');
    }
  }
  if (errors.length > 0) throw new ValidationError(errors.join('; '));
  return {
    channelId: channelId!,
    assetId,
    kind: kind as FileKind,
    ...(variant !== undefined ? { variant } : {}),
    producedBy: producedBy as Producer,
    ...(jobId !== undefined ? { jobId } : {}),
    ...(query['profile'] !== undefined ? { profile: query['profile'] } : {}),
    ...(technical !== undefined ? { technical } : {}),
  };
}

/** The record on the wire (hsm.yaml `File`) — the File record, with its replicas. */
export function fileView(file: FileEntry, replicas: readonly Replica[] = []): object {
  return {
    ...file,
    replicas: replicas.map((r) => ({
      targetId: r.targetId,
      path: r.path,
      tier: r.tier,
      sizeBytes: r.sizeBytes,
      createdAt: r.createdAt,
    })),
  };
}
