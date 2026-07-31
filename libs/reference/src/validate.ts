// EP-06.2 — validation FROM the descriptor, so the server and Studio enforce the same bounds.
// EP-06.5 — the Tier-1 registry guard.

import type {
  RegistryEntry,
  ScopeLevel,
  SettingDescriptor,
  SettingValue,
  ValidationProblem,
  ValidationResult,
} from './types.ts';
import { SCOPE_LEVELS } from './types.ts';

// ISO-8601 duration, the form the design uses for retention/keep knobs (e.g. P30D, PT12H).
const DURATION_RE = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+S)?)?$/;
// 5- or 6-field cron. Deliberately structural, not semantic: a real scheduler validates ranges.
const CRON_RE = /^(\S+\s+){4,5}\S+$/;

const ok = (): ValidationResult => ({ valid: true, problems: [] });
const bad = (key: string, message: string): ValidationResult => ({
  valid: false,
  problems: [{ key, message }],
});

/** Validate one value against its descriptor. */
export function validateSetting(d: SettingDescriptor, value: SettingValue): ValidationResult {
  const key = `${d.area}.${d.key}`;

  if (value === null || value === undefined) {
    return d.required === true ? bad(key, 'is required') : ok();
  }

  switch (d.type) {
    case 'boolean':
      return typeof value === 'boolean' ? ok() : bad(key, 'must be a boolean');

    case 'int':
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return bad(key, 'must be a number');
      if (d.type === 'int' && !Number.isInteger(value)) return bad(key, 'must be an integer');
      if (d.min !== undefined && value < d.min) return bad(key, `must be >= ${d.min}`);
      if (d.max !== undefined && value > d.max) return bad(key, `must be <= ${d.max}`);
      return ok();
    }

    case 'string':
    case 'text':
    case 'template':
    case 'reference': {
      if (typeof value !== 'string') return bad(key, 'must be a string');
      if (d.minLength !== undefined && value.length < d.minLength) {
        return bad(key, `must be at least ${d.minLength} characters`);
      }
      if (d.maxLength !== undefined && value.length > d.maxLength) {
        return bad(key, `must be at most ${d.maxLength} characters`);
      }
      if (d.pattern !== undefined && !new RegExp(d.pattern).test(value)) {
        return bad(key, `must match ${d.pattern}`);
      }
      return ok();
    }

    case 'duration':
      if (typeof value !== 'string') return bad(key, 'must be a string');
      return DURATION_RE.test(value) ? ok() : bad(key, 'must be an ISO-8601 duration, e.g. P30D');

    case 'cron':
      if (typeof value !== 'string') return bad(key, 'must be a string');
      return CRON_RE.test(value.trim()) ? ok() : bad(key, 'must be a 5- or 6-field cron expression');

    case 'date-time': {
      if (typeof value !== 'string') return bad(key, 'must be a string');
      return Number.isNaN(Date.parse(value)) ? bad(key, 'must be an ISO-8601 date-time') : ok();
    }

    case 'oneOf': {
      const allowed = (d.options ?? []).map((o) => o.value);
      return allowed.includes(value as string) ? ok() : bad(key, `must be one of ${allowed.join(', ')}`);
    }

    case 'manyOf': {
      if (!Array.isArray(value)) return bad(key, 'must be an array');
      const allowed = (d.options ?? []).map((o) => String(o.value));
      const unknown = value.filter((v) => !allowed.includes(String(v)));
      return unknown.length === 0 ? ok() : bad(key, `unknown value(s): ${unknown.join(', ')}`);
    }

    case 'json':
      return typeof value === 'object' ? ok() : bad(key, 'must be an object');

    default:
      return bad(key, `unsupported type "${String(d.type)}"`);
  }
}

/**
 * May this level set this key?
 *
 * The descriptor's `scope` names the **deepest** level allowed, so a `deployment`-scoped knob
 * cannot be overridden per channel — that is what stops a channel admin editing a
 * deployment-wide setting (design §2.4).
 */
export function levelPermitted(d: SettingDescriptor, level: ScopeLevel): boolean {
  return SCOPE_LEVELS.indexOf(level) <= SCOPE_LEVELS.indexOf(d.scope);
}

/** Validate a value *and* the level it is being written at. */
export function validateWrite(
  d: SettingDescriptor,
  value: SettingValue,
  level: ScopeLevel,
): ValidationResult {
  const key = `${d.area}.${d.key}`;
  if (!levelPermitted(d, level)) {
    return bad(key, `cannot be set at "${level}"; deepest allowed level is "${d.scope}"`);
  }
  if (d.deprecated === true) {
    const to = d.replacedBy ? ` — use "${d.replacedBy}"` : '';
    return bad(key, `is deprecated${to}`);
  }
  return validateSetting(d, value);
}

/** Validate many values at once, collecting every problem rather than failing on the first. */
export function validateAll(
  descriptors: Map<string, SettingDescriptor>,
  values: Record<string, SettingValue>,
): ValidationResult {
  const problems: ValidationProblem[] = [];
  for (const [id, value] of Object.entries(values)) {
    const d = descriptors.get(id);
    if (!d) {
      problems.push({ key: id, message: 'unknown setting' });
      continue;
    }
    problems.push(...validateSetting(d, value).problems);
  }
  return { valid: problems.length === 0, problems };
}

/**
 * **The Tier-1 safety property** (EP-06.5, design §2.2).
 *
 * A registry entry's `kind` must be declared by the RUNNING code. This is the single check that
 * stops an admin creating a value nothing can handle — a `mediaType: "hologram"` for which MTS
 * has no profile, HSM no tier policy and Studio no player, which would otherwise fail far away
 * and long after the edit.
 */
export function validateRegistryEntry(
  entry: RegistryEntry,
  knownKinds: readonly string[],
): ValidationResult {
  const key = `${entry.registry}.${entry.key}`;
  if (!knownKinds.includes(entry.kind)) {
    return bad(
      key,
      `unknown kind "${entry.kind}" for registry "${entry.registry}" — ` +
        `the running code declares: ${knownKinds.join(', ')}. ` +
        `Adding a new kind needs a release, not an admin edit.`,
    );
  }
  return ok();
}
