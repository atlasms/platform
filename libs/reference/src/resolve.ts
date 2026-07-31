// EP-06.3 — nearest-wins resolution, returning the value AND its origin.

import { SCOPE_LEVELS, type Resolved, type ScopeLevel, type SettingDescriptor, type SettingRow, type SettingValue } from './types.ts';

/** Which scope instance the caller is resolving for, per level. */
export type ScopeContext = Partial<Record<ScopeLevel, string>>;

/**
 * Resolve one setting: **nearest wins** along
 * `code default → deployment → channel → category → user` (design §2.5).
 *
 * Returns the origin as well as the value, so Studio can render *"inherited from channel"* with
 * a **Reset to inherited** action — the same affordance as category field inheritance.
 *
 * Rows at a level deeper than the descriptor's `scope` are **ignored**, not honoured: a
 * deployment-scoped knob must not be silently overridden per user because a stale row exists.
 */
export function resolveSetting(
  descriptor: SettingDescriptor,
  rows: SettingRow[],
  context: ScopeContext = {},
): Resolved {
  const maxDepth = SCOPE_LEVELS.indexOf(descriptor.scope);

  let best: SettingRow | undefined;
  let bestDepth = -1;

  for (const row of rows) {
    if (row.key !== descriptor.key) continue;

    const depth = SCOPE_LEVELS.indexOf(row.level);
    if (depth < 0 || depth > maxDepth) continue; // deeper than allowed — ignore

    // A non-deployment row only applies to the scope instance being asked about.
    if (row.level !== 'deployment') {
      const wanted = context[row.level];
      if (wanted === undefined || row.scopeId !== wanted) continue;
    }

    if (depth > bestDepth) {
      best = row;
      bestDepth = depth;
    }
  }

  if (!best) {
    return {
      value: descriptor.default ?? null,
      origin: 'default',
      overridable: maxDepth >= 0,
    };
  }

  return {
    value: best.value,
    origin: best.level,
    ...(best.scopeId !== undefined ? { scopeId: best.scopeId } : {}),
    // Could something nearer still override this?
    overridable: bestDepth < maxDepth,
  };
}

/** Resolve every descriptor in a registry against the same rows and context. */
export function resolveAll(
  descriptors: Iterable<SettingDescriptor>,
  rows: SettingRow[],
  context: ScopeContext = {},
): Record<string, Resolved> {
  const out: Record<string, Resolved> = {};
  for (const d of descriptors) {
    out[`${d.area}.${d.key}`] = resolveSetting(d, rows, context);
  }
  return out;
}

/** Convenience: just the values, for code that does not care where they came from. */
export function valuesOf(resolved: Record<string, Resolved>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [k, r] of Object.entries(resolved)) out[k] = r.value;
  return out;
}
