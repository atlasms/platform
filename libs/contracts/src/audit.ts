// EP-19.2 — the field-level delta every mutation carries in its `audit.recorded` event.
//
// In @atlas/contracts because it builds a contract payload and every owning service needs it —
// MAM first, Scheduling second. Produced by the OWNING service at write time, because only it holds
// the prior state: by the time
// a consumer sees `asset.updated` the old value is gone. The sink (Logging, EP-19.1) appends these
// to a per-entity history and the diff viewer renders them; it never asks MAM what changed.
//
// Field granularity, whole values. `extended` is one field whose value is the whole document, and
// `tags` one field whose value is the whole list — a JSON diff at the level the schema names, which
// is what the viewer shows and what a query can index. Finer diffs (a text delta for a long
// description) are a later refinement the contract already allows, since `before`/`after` are
// unconstrained.

import type { EventPayloads } from './generated/events.ts';

export type Delta = EventPayloads['audit.recorded']['delta'];

/**
 * Fields that change on every write and carry no information a reader wants in a diff. `version`
 * IS the revision — it is on the record itself, not in the delta.
 */
const ALWAYS_CHANGES: ReadonlySet<string> = new Set(['updatedAt', 'version']);

/**
 * What changed between two states of one entity.
 *
 * `before` undefined is a creation: every field is an `after`. A field present before and absent
 * after is a removal: only a `before`. Equality is structural — two objects that serialise the
 * same did not change — so a PATCH that re-sends an identical nested document produces no entry,
 * and a no-op write produces an empty delta, which is the caller's cue that nothing happened.
 */
export function delta(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  exclude: ReadonlySet<string> = ALWAYS_CHANGES,
): Delta {
  const out: Delta = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  for (const key of keys) {
    if (exclude.has(key)) continue;
    const b = before?.[key];
    const a = after[key];
    if (b !== undefined && a !== undefined && JSON.stringify(b) === JSON.stringify(a)) continue;
    if (b === undefined && a === undefined) continue;
    out[key] = {
      ...(b !== undefined ? { before: b } : {}),
      ...(a !== undefined ? { after: a } : {}),
    };
  }
  return out;
}
