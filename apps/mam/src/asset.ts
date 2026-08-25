// The asset aggregate's core record (EP-17.1).
//
// Mirrors [data-model.md §1.1](../../../docs/architecture/data-model.md). Only the *core*
// relational fields live here — extensible per-media-type metadata (`AssetExtended`, EP-17.2) is a
// document store and is not modelled yet.

import type { AssetState } from './lifecycle.ts';

export interface Asset {
  id: string;
  /** Tenant scope. Every query and every authorization check is bounded by this. */
  channelId: string;
  title: string;
  description?: string;
  /**
   * The media KIND — video, photo, audio, live-event. A vocabulary reference, not an enum: it is
   * operator-managed (configuration-and-reference-data.md tier 2), and it drives both the
   * extensible field schema and the expected file set.
   */
  mediaType: string;
  /**
   * The technical container/format, e.g. `mxf`. Distinct from `mediaType`, and carried separately
   * because the `asset.created` contract requires it — one describes what the thing IS, the other
   * how it is stored.
   */
  fileType: string;
  categoryId?: string;
  structureId?: string;
  state: AssetState;
  episodeNo?: number;
  durationSec?: number;
  allowedBroadcastCount?: number;
  recommendedBroadcastStart?: string;
  recommendedBroadcastEnd?: string;
  /** Enforced usable-until. Absent ⇒ permanent. */
  expiresAt?: string;
  /** Purge time for rejected media. */
  retainUntil?: string;
  /** A new media FILE means a new asset id; this chains the versions. */
  replacesId?: string;
  version: number;
  /** Renditions attached by MTS. Gates `markReady`. */
  hasRenditions: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a caller may set when creating. Identity, state and audit fields are the service's. */
export interface CreateAssetInput {
  title: string;
  mediaType: string;
  fileType: string;
  description?: string;
  categoryId?: string;
  structureId?: string;
  episodeNo?: number;
  durationSec?: number;
  allowedBroadcastCount?: number;
  expiresAt?: string;
}

/**
 * What a caller may change.
 *
 * `state` is absent on purpose: lifecycle moves through explicit transitions with their own guards
 * and events, never through a metadata PATCH. Allowing it here would route approval around review.
 */
export type UpdateAssetInput = Partial<Omit<CreateAssetInput, 'mediaType' | 'fileType'>>;

/** Fields the platform always requires before an asset may go `ready`, whatever its category. */
export const BASE_MANDATORY_FIELDS: readonly string[] = ['title', 'mediaType', 'categoryId'];

/** Which of an asset's fields are actually populated — feeds the mandatory-metadata gate. */
export function presentFieldsOf(asset: Asset): readonly string[] {
  return Object.entries(asset)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key]) => key);
}

/**
 * FileRef — MAM's mirror of the HSM file ledger (EP-17.8).
 *
 * HSM is the system of record for physical files (location, tier, integrity). MAM holds the
 * logical references so the catalogue and Studio can display file rows with checksums, storage
 * tier, and technical metadata without querying HSM directly.
 *
 * A file belongs to EXACTLY ONE asset (assetId). An asset has many files (original, proxy,
 * broadcast, thumbnail, vtt-filmstrip, hover-preview). The (assetId, kind, variant) tuple is
 * unique — variants distinguish multiple files of the same kind (e.g. subtitle languages,
 * thumbnail indices).
 */
export interface FileRef {
  id: string;
  channelId: string;
  assetId: string;
  /** The kind of rendition — original, proxy, broadcast, thumbnail, vtt-filmstrip, hover-preview. */
  kind: 'original' | 'proxy' | 'broadcast' | 'thumbnail' | 'vtt-filmstrip' | 'hover-preview';
  /** Distinguishes multiple files of the same kind (e.g. subtitle language, thumbnail index). */
  variant?: string;
  /** HSM storage target id. */
  storageTargetId: string;
  /** HSM-resolved logical path. */
  path: string;
  /** Storage tier: online, near-line, offline. */
  tier: 'online' | 'near-line' | 'offline';
  /** File status: available, restoring, missing, quarantined. */
  status: 'available' | 'restoring' | 'missing' | 'quarantined';
  /** System-generated checksum on placement; re-verified by HSM integrity sweeps. */
  checksum: { algorithm: string; value: string };
  /** When the checksum was last verified. */
  lastVerifiedAt?: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** ffprobe-derived technical metadata. */
  technical: {
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    durationSec?: number;
    width?: number;
    height?: number;
    aspectRatio?: string;
    audioChannels?: number;
    frameRate?: number;
    [key: string]: unknown;
  };
  /** How this file came to exist. */
  provenance: {
    producedBy: 'ingest' | 'transcode' | 'editor' | 'import';
    jobId?: string;
    profile?: string;
  };
  createdAt: string;
  deletedAt?: string;
}
