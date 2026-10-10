// Live per-field inheritance (EP-28.2; data-model.md §2.2, FR-TAX-7/9, FR-APP-7) — pure.
//
// Two cascades: a category inherits from its ancestors, and media inherits from its category.
// For each inheritable field, the NEAREST level that sets a value wins — the asset itself, then its
// category, then that category's parent, up to the root — like CSS. Nothing is copied down: the
// value is resolved when it is read, so editing a category's value is at once the value of every
// descendant and every asset below it that has not set its own.
//
// Two kinds of field:
//   - MEDIA DEFAULTS — `structureId`, `genre`, `supplyType`, `productionGroup`, `productionDate`:
//     fields of the asset that a category supplies when the asset sets none. The asset's own value
//     is the override; "reset to inherited" removes it.
//   - POLICIES — `reviewNeeded`, `keepDuration`, `defaultExpiry`: set on categories only, resolved
//     the same way, and applied to the media below (an asset does not carry them). `defaultExpiry`
//     is the exception that proves §2.2's rule: it is SNAPSHOTTED into the asset's `expiresAt` at
//     approval, never live, so a later category edit cannot re-expire media already approved.
//
// The asset's list fields (subjects, classifications, tags, cast) are EP-28.4/28.5.

import type { Asset } from './asset.ts';
import type { Category } from './category.ts';

export const MEDIA_DEFAULT_FIELDS = [
  'structureId',
  'genre',
  'supplyType',
  'productionGroup',
  'productionDate',
] as const;
export type MediaDefaultField = (typeof MEDIA_DEFAULT_FIELDS)[number];
export type MediaDefaults = Partial<Record<MediaDefaultField, string>>;

export const POLICY_FIELDS = ['reviewNeeded', 'keepDuration', 'defaultExpiry'] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];
export interface CategoryPolicies {
  /** Media here needs manual approval (EP-28.7 makes it take effect). */
  reviewNeeded?: boolean;
  /** ISO-8601 duration: how long media stays ONLINE after use (§2.5; HSM, EP-36). */
  keepDuration?: string;
  /** An instant, or an ISO-8601 duration from approval: the usable-until set at approval. */
  defaultExpiry?: string;
}

/** Where an inherited value comes from. */
export interface Origin {
  categoryId: string;
  path: string;
}

export interface InheritedValue<T> {
  value: T;
  from: Origin;
}

/** The inherited values of one node or asset: only the fields it does not set itself. */
export interface Inheritance {
  defaults: Partial<Record<MediaDefaultField, InheritedValue<string>>>;
  policies: {
    reviewNeeded?: InheritedValue<boolean>;
    keepDuration?: InheritedValue<string>;
    defaultExpiry?: InheritedValue<string>;
  };
}

/** The node's ancestors and the node, root first — from the channel's tree. */
export function chainOf(tree: readonly Category[], node: Category): Category[] {
  return tree
    .filter((c) => c.channelId === node.channelId && node.path.startsWith(c.path))
    .sort((a, b) => a.depth - b.depth);
}

/** The nearest value in `chain` (root first) for one field, and where it came from. */
function nearest<T>(
  chain: readonly Category[],
  read: (c: Category) => T | undefined,
): InheritedValue<T> | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]!;
    const value = read(c);
    if (value !== undefined) return { value, from: { categoryId: c.id, path: c.path } };
  }
  return undefined;
}

/**
 * What a CATEGORY inherits: each field it does not set, from its nearest ancestor that does.
 * `chain` is the node's chain (root first, the node last).
 */
export function inheritedByCategory(chain: readonly Category[]): Inheritance {
  const node = chain[chain.length - 1];
  const ancestors = chain.slice(0, -1);
  const out: Inheritance = { defaults: {}, policies: {} };
  if (!node) return out;
  for (const field of MEDIA_DEFAULT_FIELDS) {
    if (node.defaults?.[field] !== undefined) continue;
    const hit = nearest(ancestors, (c) => c.defaults?.[field]);
    if (hit) out.defaults[field] = hit;
  }
  resolvePolicies(out, ancestors, (field) => node[field] !== undefined);
  return out;
}

/**
 * What an ASSET inherits from its category's chain (root first, its category last): each media
 * default it does not set, and every policy (an asset sets none).
 */
export function inheritedByAsset(asset: Asset, chain: readonly Category[]): Inheritance {
  const out: Inheritance = { defaults: {}, policies: {} };
  for (const field of MEDIA_DEFAULT_FIELDS) {
    if (asset[field] !== undefined) continue;
    const hit = nearest(chain, (c) => c.defaults?.[field]);
    if (hit) out.defaults[field] = hit;
  }
  resolvePolicies(out, chain, () => false);
  return out;
}

function resolvePolicies(
  out: Inheritance,
  chain: readonly Category[],
  setLocally: (field: PolicyField) => boolean,
): void {
  if (!setLocally('reviewNeeded')) {
    const hit = nearest(chain, (c) => c.reviewNeeded);
    if (hit) out.policies.reviewNeeded = hit;
  }
  if (!setLocally('keepDuration')) {
    const hit = nearest(chain, (c) => c.keepDuration);
    if (hit) out.policies.keepDuration = hit;
  }
  if (!setLocally('defaultExpiry')) {
    const hit = nearest(chain, (c) => c.defaultExpiry);
    if (hit) out.policies.defaultExpiry = hit;
  }
}

/** The asset with its inherited media defaults filled in — what a gate or a reader judges. */
export function effectiveAsset(asset: Asset, inheritance: Inheritance): Asset {
  const filled: Partial<Record<MediaDefaultField, string>> = {};
  for (const [field, hit] of Object.entries(inheritance.defaults)) {
    filled[field as MediaDefaultField] = hit.value;
  }
  return { ...filled, ...stripUndefined(asset) } as Asset;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// --- ISO-8601 durations and the default expiry ----------------------------------------------------

const DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export interface Duration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** `P1Y2M3DT4H` → its parts; `undefined` for anything else (`P`, `PT`, fractions, negatives). */
export function parseDuration(text: string): Duration | undefined {
  const m = DURATION.exec(text);
  if (!m || text === 'P' || text.endsWith('T')) return undefined;
  const [years, months, weeks, days, hours, minutes, seconds] = m
    .slice(1)
    .map((v) => (v === undefined ? 0 : Number(v)));
  return {
    years: years!,
    months: months!,
    weeks: weeks!,
    days: days!,
    hours: hours!,
    minutes: minutes!,
    seconds: seconds!,
  };
}

/**
 * `instant` plus `d`, on the CALENDAR for years and months (1 Jan + P1M is 1 Feb, 31 Jan + P1M is
 * the last day of February — the month is clamped, never overflowed into March) and in exact
 * time for the rest, all in UTC.
 */
export function addDuration(instant: string, d: Duration): string {
  const t = new Date(instant);
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCFullYear(t.getUTCFullYear() + d.years);
  t.setUTCMonth(t.getUTCMonth() + d.months);
  const lastOfMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, lastOfMonth));
  const ms =
    ((d.weeks * 7 + d.days) * 86_400 + d.hours * 3_600 + d.minutes * 60 + d.seconds) * 1_000;
  return new Date(t.getTime() + ms).toISOString();
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether `text` is a usable `defaultExpiry`: an instant with a zone, or a duration. */
export function isExpirySpec(text: string): boolean {
  return (
    (INSTANT.test(text) && !Number.isNaN(Date.parse(text))) || parseDuration(text) !== undefined
  );
}

/** The `expiresAt` a `defaultExpiry` gives media approved at `approvedAt`. */
export function expiryFrom(spec: string, approvedAt: string): string | undefined {
  const d = parseDuration(spec);
  if (d) return addDuration(approvedAt, d);
  return INSTANT.test(spec) && !Number.isNaN(Date.parse(spec))
    ? new Date(spec).toISOString()
    : undefined;
}

// --- validation of what a write may set ------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every reason a set of media-default values is refused (an asset's, or a category's defaults). */
export function defaultsProblems(values: Record<string, unknown>, where = ''): string[] {
  const problems: string[] = [];
  for (const field of MEDIA_DEFAULT_FIELDS) {
    const v = values[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '' || v.length > 128) {
      problems.push(`${where}${field} must be non-empty text of at most 128 characters`);
    } else if (field === 'productionDate' && (!DATE.test(v) || Number.isNaN(Date.parse(v)))) {
      problems.push(`${where}productionDate must be a date, YYYY-MM-DD`);
    }
  }
  return problems;
}

/** Every reason a category's policy values are refused. */
export function policyProblems(values: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (values['reviewNeeded'] !== undefined && typeof values['reviewNeeded'] !== 'boolean') {
    problems.push('reviewNeeded must be true or false');
  }
  const keep = values['keepDuration'];
  if (keep !== undefined && (typeof keep !== 'string' || parseDuration(keep) === undefined)) {
    problems.push('keepDuration must be an ISO-8601 duration, e.g. P30D');
  }
  const expiry = values['defaultExpiry'];
  if (expiry !== undefined && (typeof expiry !== 'string' || !isExpirySpec(expiry))) {
    problems.push(
      'defaultExpiry must be an instant with a zone, or an ISO-8601 duration from approval (P1Y)',
    );
  }
  return problems;
}

/** Every reason an `inherit` list (the fields to stop setting locally) is refused. */
export function inheritProblems(value: unknown, allowed: readonly string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((f) => typeof f !== 'string' || !allowed.includes(f))) {
    return [`inherit must list fields among ${allowed.join(', ')}`];
  }
  return [];
}
