// The version chain (EP-27.6; data-model §1.7, FR-MAM-6, FR-APP-3) — pure.
//
// A new media FILE is a new asset id: the new media arrives as an asset of its own (an upload
// through RIM, later an editor's render — EP-26.7) and is then made the NEXT VERSION of the asset
// it supersedes. That link copies the old asset's metadata onto the new one, here, by one rule:
//
//   - what the new asset's own media says is kept — its media type is the old one's (or a 422),
//     and its file type and duration are measured from ITS file, never copied;
//   - a field a PERSON set on the new asset is kept: they set it for this media (EP-27.5's rank —
//     a value with no provenance is a person's);
//   - every other field the old asset has is copied, with the provenance it had there, and any
//     value held beside it on the new asset is settled by the copy;
//   - the extended document and the tags are merged the same way: the new asset's own entries win.
//
// NOT copied: the approval and everything bound to it (`expiresAt`, `approvedBy`, `retainUntil`) —
// the new media needs its own verdict; the shot list — its offsets are into the OLD media's
// timeline; the files; the verdict history.

import type { Asset } from './asset.ts';
import { ownerRank, RANK, type DerivedValue, type FieldProvenance } from './provenance.ts';

/** The core fields a new version takes from the version it supersedes. */
export const CLONED_FIELDS = [
  'title',
  'description',
  'episodeNo',
  'categoryId',
  'structureId',
  'genre',
  'supplyType',
  'productionGroup',
  'productionDate',
  'subjectIds',
  'classificationIds',
  'cast',
  'allowedBroadcastCount',
] as const satisfies readonly (keyof Asset)[];

export interface CloneOutcome {
  /** The new version as it should be written (version not bumped — the caller's). */
  asset: Asset;
  /** Core fields whose value changed by the copy. */
  cloned: string[];
}

/** Copy `previous`'s metadata onto `next` by the rule above, and link it as the next version. */
export function cloneOnto(previous: Asset, next: Asset): CloneOutcome {
  const record = { ...next } as unknown as Record<string, unknown>;
  const from = previous as unknown as Record<string, unknown>;
  const provenance: Record<string, FieldProvenance> = { ...next.provenance };
  const derived: Record<string, DerivedValue> = { ...next.derived };
  const cloned: string[] = [];
  for (const field of CLONED_FIELDS) {
    const value = from[field];
    if (value === undefined) continue;
    if (ownerRank(next, field) === RANK.user) continue; // a person's word on THIS media
    if (JSON.stringify(record[field]) !== JSON.stringify(value)) cloned.push(field);
    record[field] = value;
    const origin = previous.provenance?.[field];
    if (origin) provenance[field] = origin;
    else delete provenance[field]; // a value with no provenance ranks as a person's, as it did
    delete derived[field];
  }
  record['replacesId'] = previous.id;
  delete record['provenance'];
  delete record['derived'];
  if (Object.keys(provenance).length > 0) record['provenance'] = provenance;
  if (Object.keys(derived).length > 0) record['derived'] = derived;
  return { asset: record as unknown as Asset, cloned };
}

/** The extended document of the new version: the old one's, under the new asset's own entries. */
export function mergeExtended(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): { merged: Record<string, unknown>; cloned: string[] } {
  const cloned = Object.keys(previous).filter((name) => !(name in next));
  return { merged: { ...previous, ...next }, cloned };
}

/** The tag labels of the new version: its own, then the old one's it does not have. */
export function mergeTagLabels(
  previous: readonly { label: string; normalized: string }[],
  next: readonly { label: string; normalized: string }[],
): { labels: { label: string; normalized: string }[]; added: boolean } {
  const have = new Set(next.map((t) => t.normalized));
  const extra = previous.filter((t) => !have.has(t.normalized));
  return {
    labels: [...next, ...extra].map(({ label, normalized }) => ({ label, normalized })),
    added: extra.length > 0,
  };
}

/** Why `next` cannot become the version after `previous` — or undefined when it can. */
export function versionProblem(
  previous: Asset,
  next: Asset,
): { status: 409 | 422; message: string } | undefined {
  if (previous.id === next.id) {
    return { status: 422, message: 'an asset cannot be its own next version' };
  }
  if (previous.replacedById !== undefined) {
    return {
      status: 409,
      message: `asset ${previous.id} is already replaced by ${previous.replacedById} — make the new version from the newest`,
    };
  }
  if (next.replacesId !== undefined || next.replacedById !== undefined) {
    return { status: 409, message: `asset ${next.id} is already in a version chain` };
  }
  if (next.mediaType !== previous.mediaType) {
    return {
      status: 422,
      message: `the new version is ${next.mediaType}, the asset it replaces ${previous.mediaType}`,
    };
  }
  if (next.state === 'approved' || next.state === 'rejected' || next.state === 'expired') {
    return {
      status: 409,
      message: `asset ${next.id} already has a verdict (${next.state}); a new version is reviewed after it is made`,
    };
  }
  return undefined;
}
