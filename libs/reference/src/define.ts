// EP-06.1 — the descriptor registry.

import { SCOPE_LEVELS, type SettingDescriptor, type SettingsRegistry } from './types.ts';

/** What a caller writes: everything but `key` and `area`, which come from the call site. */
export type DescriptorInput = Omit<SettingDescriptor, 'key' | 'area'>;

// Kept in lockstep with setting-descriptor.schema.json. Segments are lowerCamelCase, matching
// the TypeScript convention used everywhere else (`sweep.throughputMBps`); the area is
// lower-kebab because it names a service (`hsm`, `integration-feeds`).
const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)*$/;
const AREA_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Declare an area's settings.
 *
 * ```ts
 * export const hsmSettings = defineSettings('hsm', {
 *   'restore.concurrency': { type: 'int', default: 4, min: 1, max: 64, scope: 'channel' },
 * });
 * ```
 *
 * Throws on a malformed descriptor **at module load**, not at first use — a typo in a setting
 * declaration should stop the service starting, not surface as a mysterious validation failure
 * weeks later.
 */
export function defineSettings(
  area: string,
  input: Record<string, DescriptorInput>,
): SettingsRegistry {
  if (!AREA_RE.test(area)) {
    throw new Error(`invalid settings area "${area}": expected lower-kebab, e.g. "hsm"`);
  }

  const descriptors: Record<string, SettingDescriptor> = {};

  for (const [key, d] of Object.entries(input)) {
    if (!KEY_RE.test(key)) {
      throw new Error(`invalid setting key "${area}.${key}": expected dotted lower-case`);
    }
    if (!SCOPE_LEVELS.includes(d.scope)) {
      throw new Error(`"${area}.${key}": scope must be one of ${SCOPE_LEVELS.join(', ')}`);
    }
    if ((d.type === 'oneOf' || d.type === 'manyOf') && (!d.options || d.options.length === 0)) {
      throw new Error(`"${area}.${key}": type ${d.type} requires non-empty options`);
    }
    if (d.type === 'reference' && !d.refTarget) {
      throw new Error(`"${area}.${key}": type reference requires refTarget`);
    }
    if (d.min !== undefined && d.max !== undefined && d.min > d.max) {
      throw new Error(`"${area}.${key}": min ${d.min} exceeds max ${d.max}`);
    }
    // A required setting with a default is a contradiction: the default satisfies it, so
    // "required" can never fail and the operator is misled about what they must supply.
    if (d.required === true && d.default !== undefined) {
      throw new Error(`"${area}.${key}": a required setting must not also declare a default`);
    }
    if (d.replacedBy !== undefined && d.deprecated !== true) {
      throw new Error(`"${area}.${key}": replacedBy is only meaningful on a deprecated setting`);
    }

    descriptors[key] = { ...d, key, area };
  }

  return { area, descriptors };
}

/** Merge several areas into one lookup, rejecting duplicate `area.key` pairs. */
export function mergeRegistries(...registries: SettingsRegistry[]): Map<string, SettingDescriptor> {
  const out = new Map<string, SettingDescriptor>();
  for (const reg of registries) {
    for (const d of Object.values(reg.descriptors)) {
      const id = `${d.area}.${d.key}`;
      if (out.has(id)) throw new Error(`duplicate setting descriptor "${id}"`);
      out.set(id, d);
    }
  }
  return out;
}
