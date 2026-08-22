// GENERATED FROM docs/architecture/openapi/mam.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: MAM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

export interface Tag {
  id: Ulid;
  channelId: string;
  /** As FIRST typed. What Studio displays. */
  label: string;
  normalized: string;
}

/** The complete core asset record returned by MAM. Extensible metadata and tags have separate resources. */
export interface Asset {
  id: Ulid;
  channelId: string;
  title: string;
  description?: string;
  /** Operator-managed media kind vocabulary key. */
  mediaType: string;
  durationSec?: number;
  fileType: string;
  categoryId?: string;
  structureId?: string;
  state:
    | 'created'
    | 'processing'
    | 'ready'
    | 'approved'
    | 'expired'
    | 'rejected'
    | 'replaced'
    | 'purged';
  episodeNo?: number;
  allowedBroadcastCount?: number;
  recommendedBroadcastStart?: string;
  recommendedBroadcastEnd?: string;
  version: number;
  /** Usable-until; past this the media is unusable and needs re-review (FR-APP-7). Absent = permanent. */
  expiresAt?: string;
  /** For rejected media: purge time (FR-APP-8). */
  retainUntil?: string;
  replacesId?: Ulid;
  /** True once MTS renditions have been attached; individual files arrive through the FileRef projection (EP-17.8). */
  hasRenditions: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

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

/** User-editable core metadata. Omitted fields are unchanged. */
export interface UpdateAssetInput {
  title?: string;
  description?: string;
  categoryId?: string;
  structureId?: string;
  episodeNo?: number;
  durationSec?: number;
  allowedBroadcastCount?: number;
  expiresAt?: string;
}

export interface Person {
  id?: Ulid;
  name: string;
  roleInMedia?: string;
  hasImage?: boolean;
}

/** A media-editor timeline over one source asset (basic-NLE, D3). Full model in ../services/media-editor.md. */
export interface EditProject {
  id?: Ulid;
  sourceAssetId: Ulid;
  mediaKind: 'video' | 'audio' | 'photo';
  state?: 'draft' | 'rendering' | 'rendered' | 'failed';
  timeline?: {
    clips?: {
      renditionRef: string;
      inSec: number;
      outSec: number;
      transitionIn?: string;
      filters?: string[];
    }[];
  };
  updatedAt?: string;
}

/** See ../schemas/vocabulary-term.schema.json. */
export interface VocabularyTerm {
  id?: Ulid;
  vocabulary: string;
  key: string;
  labels: Record<string, string>;
  parentId?: Ulid;
  sortOrder?: number;
  deprecatedAt?: string | null;
  replacedById?: Ulid;
}

/** Versioned bundle of this service's reference data. See ../configuration-and-reference-data.md §5. */
export interface ReferenceSnapshot {
  configVersion: number;
  vocabularies?: Record<string, VocabularyTerm[]>;
  settings?: Record<string, unknown>;
}

export interface Error {
  code: string;
  message: string;
  correlationId?: string;
}
