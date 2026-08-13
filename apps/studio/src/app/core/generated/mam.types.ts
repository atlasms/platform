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

export interface Asset {
  id?: Ulid;
  title: string;
  description?: string;
  durationSec?: number;
  fileType?: string;
  resolution?: string;
  aspectRatio?: string;
  audioChannels?: number;
  state?:
    | 'created'
    | 'processing'
    | 'ready'
    | 'approved'
    | 'expired'
    | 'rejected'
    | 'replaced'
    | 'purged';
  version?: number;
  /** Usable-until; past this the media is unusable and needs re-review (FR-APP-7). Absent = permanent. */
  expiresAt?: string;
  /** For rejected media: purge time (FR-APP-8). */
  retainUntil?: string;
  tags?: string[];
  extended?: Record<string, unknown>;
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
