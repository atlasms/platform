// GENERATED FROM docs/architecture/openapi/mam.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: MAM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

/** One of an asset's files, as MAM mirrors it from HSM/MTS (data-model.md §1.5; file.schema.json). A file belongs to exactly one asset; unique per (asset, kind, variant). */
export interface FileRef {
  id: Ulid;
  channelId: string;
  assetId: Ulid;
  kind: 'original' | 'proxy' | 'broadcast' | 'thumbnail' | 'vtt-filmstrip' | 'hover-preview';
  /** A subtitle language, a thumbnail index — what tells two files of one kind apart. */
  variant?: string;
  storage: {
    path: string;
    tier: 'online' | 'near-line' | 'offline';
    status: 'available' | 'restoring' | 'missing' | 'quarantined';
  };
  checksum: { algorithm: string; value: string };
  sizeBytes?: number;
  durationSec?: number;
  /** The event that last wrote this row — the ledger entry it mirrors. */
  sourceMessageId: Ulid;
  /** Bumped on every write to the row; the audit revision. */
  version: number;
  updatedAt: string;
}

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

/** A node of the channel's category tree (../data-model.md §2.6): a hierarchical vocabulary term whose path is built from immutable keys. */
export interface Category {
  id: string;
  channelId: string;
  /** Absent at the root. */
  parentId?: string;
  /** Fixed at creation; unique among its siblings. */
  key: string;
  /** The keys from the root, slash-separated with a trailing slash: /sports/football/. What category-scoped grants and field schemas match by prefix. */
  path: string;
  depth: number;
  /** Display labels by locale tag (en, ar, ...). Mutable. */
  labels: Record<string, string>;
  description?: string;
  /** The node's role — department, program, season, ... A word, not an enum: code never branches on it. */
  kind?: string;
  sortOrder: number;
  /** Whether media may be put directly here; usually false on organizational nodes. */
  mediaAddable: boolean;
  /** Hidden from pickers and refuses new media; existing references keep resolving. */
  deprecatedAt?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCategoryInput {
  /** Absent for a root category. */
  parentId?: string;
  key: string;
  labels: Record<string, string>;
  description?: string;
  kind?: string;
  sortOrder?: number;
  mediaAddable?: boolean;
}

/** Omitted fields are unchanged. The key and the parent are not here — the key never changes, the parent changes by a move. */
export interface UpdateCategoryInput {
  labels?: Record<string, string>;
  description?: string;
  kind?: string;
  sortOrder?: number;
  mediaAddable?: boolean;
  /** true deprecates, false restores. */
  deprecated?: boolean;
}

export interface MoveCategoryInput {
  /** The new parent; null or absent moves the category to the root. */
  parentId?: string | null;
  /** The category's version as read. */
  version: number;
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
