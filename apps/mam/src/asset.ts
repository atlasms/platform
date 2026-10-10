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
  /**
   * The media defaults (EP-28.2): set here, they override the category's; absent, the category
   * chain supplies them when they are read (inheritance.ts). Stored only when the asset sets them.
   */
  structureId?: string;
  genre?: string;
  supplyType?: string;
  productionGroup?: string;
  /** `YYYY-MM-DD`. */
  productionDate?: string;
  /**
   * Subject and classification TERM ids (EP-28.4). Absent: the category chain's list is inherited;
   * present — even empty — the asset's own list replaces it whole.
   */
  subjectIds?: string[];
  classificationIds?: string[];
  state: AssetState;
  episodeNo?: number;
  durationSec?: number;
  allowedBroadcastCount?: number;
  recommendedBroadcastStart?: string;
  recommendedBroadcastEnd?: string;
  /** Enforced usable-until. Absent ⇒ permanent. */
  expiresAt?: string;
  /**
   * Where `expiresAt` came from: `category` when it is the category's `defaultExpiry` snapshotted at
   * approval (EP-28.2, FR-TAX-7); absent when the asset's own — `asset.expired` reports it.
   */
  expirySource?: 'asset' | 'category';
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
  genre?: string;
  supplyType?: string;
  productionGroup?: string;
  productionDate?: string;
  subjectIds?: string[];
  classificationIds?: string[];
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
