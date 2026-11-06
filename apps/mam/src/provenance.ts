// EP-27.5 — field provenance (FR-MAM-8; mam.md §13u).
//
// Every core field an asset sets carries WHO set it: a person (`user`), a measurement of the media
// (`technical` — the probe at ingest, a transcode's measured duration) or AI enrichment (`ai`).
// The three are ranked user > technical > ai, and one rule follows from the ranking: a derived
// value is applied to a field only when nothing ranked higher set it. Otherwise it is HELD — kept
// beside the field in `derived`, never written over what a person entered — until a person takes
// it (an ordinary PATCH of the field) or dismisses it.
//
// Pure: the service decides who is asking and commits; this decides what the record becomes.

import type { Asset } from './asset.ts';

export type MetadataSource = 'user' | 'technical' | 'ai';

export interface FieldProvenance {
  source: MetadataSource;
  /** The user id for `user`; the measuring service (`rim`, `mts`) or the AI service otherwise. */
  by: string;
  at: string;
  /** An AI value's confidence, 0..1. */
  confidence?: number;
  /** The ingest, transcode or enrichment job it came from. */
  jobId?: string;
}

/** A value proposed for a field a person owns — held, not applied. */
export interface DerivedValue extends FieldProvenance {
  value: unknown;
}

/** Where a derived proposal comes from — anything but a person. */
export interface Derivation extends Omit<FieldProvenance, 'source'> {
  source: Exclude<MetadataSource, 'user'>;
}

export const RANK: Readonly<Record<MetadataSource, number>> = { ai: 1, technical: 2, user: 3 };

/**
 * The rank of whoever owns a field now. A field with a value and NO provenance was set before
 * EP-27.5 and may well be a person's, so it ranks as one: a derived value never replaces it. An
 * empty field with no provenance is nobody's.
 */
export function ownerRank(asset: Asset, field: string): number {
  const recorded = asset.provenance?.[field];
  if (recorded) return RANK[recorded.source];
  return (asset as unknown as Record<string, unknown>)[field] === undefined ? 0 : RANK.user;
}

export interface DerivedOutcome {
  /** The record as it should be written (version not bumped — the caller's, if anything changed). */
  asset: Asset;
  /** Fields whose value was set from the proposal. */
  applied: string[];
  /** Fields whose proposal was held in `derived` (new, or a different value than was held). */
  held: string[];
}

/**
 * Apply a derived proposal by the ranking. `mandatory` is the asset's mandatory-metadata set: an AI
 * value is never written into one of those, even an empty one (FR-AI-3) — it is held for a person.
 */
export function deriveInto(
  asset: Asset,
  values: Readonly<Record<string, unknown>>,
  derivation: Derivation,
  mandatory: readonly string[] = [],
): DerivedOutcome {
  const record = asset as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  const provenance: Record<string, FieldProvenance> = { ...asset.provenance };
  const derived: Record<string, DerivedValue> = { ...asset.derived };
  const applied: string[] = [];
  const held: string[] = [];
  const stamp = withoutUndefined(derivation);

  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const aiIntoMandatory = derivation.source === 'ai' && mandatory.includes(field);
    if (!aiIntoMandatory && RANK[derivation.source] >= ownerRank(asset, field)) {
      if (same(record[field], value) && provenance[field]?.source === derivation.source) continue;
      next[field] = value;
      provenance[field] = stamp;
      delete derived[field];
      applied.push(field);
      continue;
    }
    // Held. The field already says it, or the same value is already held: nothing to record.
    if (same(record[field], value)) continue;
    const already = derived[field];
    if (already && already.source === derivation.source && same(already.value, value)) continue;
    derived[field] = { value, ...stamp };
    held.push(field);
  }

  return { asset: withMaps(next, provenance, derived), applied, held };
}

/**
 * A NEW record's fields, as set by a measurement: each that has a value is stamped with where it
 * came from. Nothing to rank against — there is no earlier owner.
 */
export function stampedBy(asset: Asset, fields: readonly string[], derivation: Derivation): Asset {
  const record = asset as unknown as Record<string, unknown>;
  const provenance: Record<string, FieldProvenance> = { ...asset.provenance };
  for (const field of fields) {
    if (record[field] !== undefined) provenance[field] = withoutUndefined(derivation);
  }
  return withMaps({ ...record }, provenance, { ...asset.derived });
}

/**
 * A person wrote these fields: each is theirs now, and anything held beside it is settled — taking
 * the held value IS this write. `cleared` fields stop being set by the asset at all (inherited
 * again from the category, EP-28.2), so they carry no provenance and nothing is held for them.
 */
export function userWrote(
  asset: Asset,
  fields: readonly string[],
  by: string,
  at: string,
  cleared: readonly string[] = [],
): Asset {
  const provenance: Record<string, FieldProvenance> = { ...asset.provenance };
  const derived: Record<string, DerivedValue> = { ...asset.derived };
  for (const field of fields) {
    provenance[field] = { source: 'user', by, at };
    delete derived[field];
  }
  for (const field of cleared) {
    delete provenance[field];
    delete derived[field];
  }
  return withMaps({ ...(asset as unknown as Record<string, unknown>) }, provenance, derived);
}

/** The record without the value held for `field` — `undefined` if nothing is held for it. */
export function dismissDerived(asset: Asset, field: string): Asset | undefined {
  if (!asset.derived?.[field]) return undefined;
  const derived: Record<string, DerivedValue> = { ...asset.derived };
  delete derived[field];
  return withMaps(
    { ...(asset as unknown as Record<string, unknown>) },
    { ...asset.provenance },
    derived,
  );
}

/** Empty maps are left off the record, so an asset nobody derived anything for reads as before. */
function withMaps(
  record: Record<string, unknown>,
  provenance: Record<string, FieldProvenance>,
  derived: Record<string, DerivedValue>,
): Asset {
  delete record['provenance'];
  delete record['derived'];
  if (Object.keys(provenance).length > 0) record['provenance'] = provenance;
  if (Object.keys(derived).length > 0) record['derived'] = derived;
  return record as unknown as Asset;
}

function withoutUndefined(derivation: Derivation): FieldProvenance {
  return Object.fromEntries(
    Object.entries(derivation).filter(([, v]) => v !== undefined),
  ) as unknown as FieldProvenance;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
