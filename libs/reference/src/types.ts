// Contract: docs/architecture/schemas/setting-descriptor.schema.json
// Design:   docs/architecture/configuration-and-reference-data.md
//
// Browser-safe: no Node built-ins, no runtime dependencies. Studio generates its admin UI from
// the same descriptors the services validate against — one definition, two consumers.

/** The levels a value can be set at, **nearest wins** (design §2.5). */
export const SCOPE_LEVELS = ['deployment', 'channel', 'category', 'user'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** Where a resolved value came from. `default` means no row existed at any level. */
export type Origin = ScopeLevel | 'default';

export type SettingType =
  | 'string'
  | 'text'
  | 'int'
  | 'number'
  | 'boolean'
  | 'duration'
  | 'cron'
  | 'date-time'
  | 'oneOf'
  | 'manyOf'
  | 'json'
  | 'template'
  | 'reference';

export type SettingValue = string | number | boolean | string[] | Record<string, unknown> | null;

export interface SettingOption {
  value: string | number | boolean;
  label?: string;
  description?: string;
}

/**
 * Declares one admin-editable setting. The descriptor ships with the code that READS the
 * setting; only the value is stored. This is what makes the admin UI generatable and the
 * validation identical on both sides.
 */
export interface SettingDescriptor {
  key: string;
  area: string;
  type: SettingType;
  label?: string;
  description?: string;
  group?: string;
  default?: SettingValue;
  required?: boolean;
  /** The **deepest** level allowed to set this key. */
  scope: ScopeLevel;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  options?: SettingOption[];
  /** For `type: 'reference'` — the registry/vocabulary whose entries are selectable. */
  refTarget?: string;
  /** Stored via vault reference; redacted in APIs, masked in UI and in audit diffs. */
  sensitive?: boolean;
  /** Change takes effect only after the owning service restarts. */
  restart?: boolean;
  /** Overrides the default `config:admin` grant required to write this key. */
  permission?: string;
  deprecated?: boolean;
  replacedBy?: string;
  since?: string;
}

/** A validated set of descriptors for one area, keyed by setting key. */
export interface SettingsRegistry {
  area: string;
  descriptors: Record<string, SettingDescriptor>;
}

/** One stored value, at one level. */
export interface SettingRow {
  key: string;
  level: ScopeLevel;
  /** Id of the scope instance (channelId / categoryId / userId). Absent at `deployment`. */
  scopeId?: string;
  value: SettingValue;
}

/** The resolution answer: the value **and where it came from** (design §2.5). */
export interface Resolved<T = SettingValue> {
  value: T;
  origin: Origin;
  /** Which scope instance supplied it, when origin is not `deployment`/`default`. */
  scopeId?: string;
  /** True when a nearer level could override this — drives "Reset to inherited" in Studio. */
  overridable: boolean;
}

export interface ValidationProblem {
  key: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  problems: ValidationProblem[];
}

/**
 * A Tier-1 registry entry: the *kind* is code-known, the *entry* is admin data.
 * See design §2.2 — creating one with an unknown kind is the failure this library prevents.
 */
export interface RegistryEntry {
  id: string;
  registry: string;
  kind: string;
  key: string;
  labels?: Record<string, string>;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
}
