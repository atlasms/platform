// Which field group each part of an asset belongs to (#225).
//
// A write grant may be narrowed to field groups, so "may edit metadata but not rights" is
// expressible ([authorization-model.md §3.1](../../../docs/architecture/authorization-model.md)).
// The starter roles depend on it: an Editor gets `core`, `taxonomy`, `cast`, `shotlist`; a Librarian
// gets `files` and `rights`.
//
// It only means anything if the service ASKS. And that is the trap this module exists for: omitting
// the group does not fail closed, it fails **open** — a rule declaring field groups matches a check
// that names none, because there is nothing to fail the predicate against. So every unasked write
// was a grant quietly widened to every group, and the Editor/Librarian split was decorative
// everywhere except tags.
//
// The mapping below is not invented here; it is transcribed from the table in §3.1.

import type { UpdateAssetInput } from './asset.ts';

/**
 * The groups defined for an `asset`.
 *
 * Tier 0 — the same reasoning as `FIELD_TYPES`. Roles reference these by name, so adding one is a
 * change to the authorization contract, not an operator edit.
 */
export const ASSET_FIELD_GROUPS = [
  'core',
  'taxonomy',
  'cast',
  'rights',
  'shotlist',
  'files',
  'web',
] as const;

export type AssetFieldGroup = (typeof ASSET_FIELD_GROUPS)[number];

/**
 * Every writable core field, and the group it belongs to.
 *
 * Transcribed from §3.1: `core` (title/description/…), `taxonomy` (category/structure/…), `rights`
 * (allowed count, recommended window, expiry). An entry missing here is a field nobody can write,
 * which is the safe direction to be wrong in — and `pickUpdatable`'s allowlist is checked against
 * this by a test, so the two cannot drift apart silently.
 */
export const CORE_FIELD_GROUPS: Readonly<Record<keyof UpdateAssetInput, AssetFieldGroup>> = {
  title: 'core',
  description: 'core',
  episodeNo: 'core',
  durationSec: 'core',
  // The doc is explicit that category and structure are taxonomy, not core. That is the whole
  // Editor/Librarian distinction in miniature: reclassifying an asset is a different act from
  // retitling it, and a role may legitimately allow one and not the other.
  categoryId: 'taxonomy',
  structureId: 'taxonomy',
  // "allowed count, recommended window, expiry" — §3.1, verbatim. Expiry decides when media stops
  // being usable on air, which is why it is not an ordinary metadata field.
  allowedBroadcastCount: 'rights',
  expiresAt: 'rights',
};

/**
 * The default group for an extended field whose schema does not name one.
 *
 * `core` because it is the group every editing role holds. Defaulting to something narrower would
 * lock operators out of fields they had already defined the moment this shipped — a migration that
 * breaks working deployments to enforce a distinction those deployments never expressed. Operators
 * tighten by annotating; they should not have to annotate to keep working.
 */
export const DEFAULT_EXTENDED_GROUP: AssetFieldGroup = 'core';

/** The distinct groups a set of core field names touches. */
export function groupsForCoreFields(fields: readonly string[]): AssetFieldGroup[] {
  const groups = new Set<AssetFieldGroup>();
  for (const field of fields) {
    const group = CORE_FIELD_GROUPS[field as keyof UpdateAssetInput];
    if (group !== undefined) groups.add(group);
  }
  return [...groups].sort();
}

/**
 * The distinct groups a set of EXTENDED field names touches.
 *
 * Unknown names contribute nothing — they are already refused by validation before this is reached,
 * and inventing a group for one would make an authorization decision about a field that does not
 * exist. A field whose schema names no group falls to {@link DEFAULT_EXTENDED_GROUP}.
 *
 * An unrecognised group string is passed through as written. The evaluator will simply not match it
 * against any rule, so a typo in a schema fails CLOSED — which is the right direction, and better
 * than silently rewriting it to `core` and granting more than the operator asked for.
 */
export function groupsForExtended(
  fields: readonly { name: string; fieldGroup?: string }[],
  names: readonly string[],
): AssetFieldGroup[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const groups = new Set<string>();
  for (const name of names) {
    const field = byName.get(name);
    if (field === undefined) continue;
    groups.add(field.fieldGroup ?? DEFAULT_EXTENDED_GROUP);
  }
  return [...groups].sort() as AssetFieldGroup[];
}
