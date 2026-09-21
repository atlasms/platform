// The FileRef (EP-17.8; mam.md §3, data-model.md §1.5, file.schema.json): MAM's mirror of the
// files an asset has — kind, variant, where the bytes are and on which tier, the checksum, the
// size. HSM is the system of record for location, tier and integrity; MTS produces the renditions.
// MAM holds a COPY, written from their events, so the asset editor's Files tab and the search can
// answer without a call across services, and so the answer is what the ledger last said, not what
// a client last claimed.
//
// A file belongs to exactly one asset and is unique per (asset, kind, variant): a second
// `transcode.completed` for the same kind replaces the row — MTS re-ran — and the version says so.

import {
  ulid,
  type Checksum,
  type EventPayloads,
  type Rendition,
  type RenditionKind,
  type TechnicalMetadata,
  type Tier,
} from '@atlas/contracts';

export type FileStatus = 'available' | 'restoring' | 'missing' | 'quarantined';

export interface FileRef {
  id: string;
  channelId: string;
  assetId: string;
  kind: RenditionKind;
  /** A subtitle language, a thumbnail index — what tells two files of one kind apart. */
  variant?: string;
  storage: {
    path: string;
    tier: Tier;
    status: FileStatus;
  };
  checksum: Checksum;
  sizeBytes?: number;
  durationSec?: number;
  technical?: TechnicalMetadata;
  /** The message that last wrote this row — the ledger entry it mirrors. */
  sourceMessageId: string;
  version: number;
  updatedAt: string;
}

/** The identity of a file within its asset: kind and variant (none is ''). No kind contains '#'. */
export const fileKey = (kind: string, variant: string | undefined): string =>
  `${kind}#${variant ?? ''}`;

/**
 * A rendition as MTS announced it → a FileRef. Renditions land on the online tier — that is what
 * a transcode produces and where a proxy lives; a later `file.placed` says where HSM moved it.
 */
export function fileFromRendition(
  rendition: Rendition,
  context: {
    channelId: string;
    assetId: string;
    messageId: string;
    now: string;
    existing?: FileRef;
  },
): FileRef {
  return {
    id: context.existing?.id ?? ulid(),
    channelId: context.channelId,
    assetId: context.assetId,
    kind: rendition.kind,
    storage: { path: rendition.path, tier: 'online', status: 'available' },
    checksum: rendition.checksum,
    ...(rendition.sizeBytes !== undefined ? { sizeBytes: rendition.sizeBytes } : {}),
    ...(rendition.durationSec !== undefined ? { durationSec: rendition.durationSec } : {}),
    sourceMessageId: context.messageId,
    version: (context.existing?.version ?? 0) + 1,
    updatedAt: context.now,
  };
}

/**
 * A placement as HSM announced it → the FileRef's storage, on the row it names (by kind) or a new
 * row when nothing announced the file before (HSM placing the original after ingest). `path` and
 * `tier` are the ledger's; the checksum too when HSM sent one, else the row keeps what it had — a
 * new row without one records the placement's absence of a checksum honestly, as `unknown`.
 */
export function fileFromPlacement(
  placed: EventPayloads['file.placed'],
  context: { channelId: string; messageId: string; now: string; existing?: FileRef },
): FileRef {
  const existing = context.existing;
  return {
    id: existing?.id ?? ulid(),
    channelId: context.channelId,
    assetId: placed.assetId,
    kind: placed.renditionKind ?? existing?.kind ?? 'original',
    ...(existing?.variant !== undefined ? { variant: existing.variant } : {}),
    storage: { path: placed.path, tier: placed.tier, status: 'available' },
    checksum: placed.checksum ?? existing?.checksum ?? { algorithm: 'unknown', value: '' },
    ...(existing?.sizeBytes !== undefined ? { sizeBytes: existing.sizeBytes } : {}),
    ...(existing?.durationSec !== undefined ? { durationSec: existing.durationSec } : {}),
    ...(existing?.technical !== undefined ? { technical: existing.technical } : {}),
    sourceMessageId: context.messageId,
    version: (existing?.version ?? 0) + 1,
    updatedAt: context.now,
  };
}
