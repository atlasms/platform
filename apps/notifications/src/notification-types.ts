// The notification-type registry (EP-25.5; configuration-and-reference-data.md §2.2, Tier 1).
//
// Code supplies the behaviour — which event raises each type, who it goes to and what they must be
// able to read (decided 2026-10-18) — and so the set of types: a type no code raises cannot be
// configured (`UNKNOWN_TYPE`, the Tier-1 validation rule). An operator supplies, per channel, the
// rest: the title template per locale, the severity, whether it is enabled, whether a person has it
// on until they say otherwise (`defaultOn`), and whether a person may turn it off at all
// (`mandatory`; preferences are EP-25.6).
//
// A template is text with `{{name}}` slots filled from the type's variables; a slot it does not
// know renders as nothing, never as the raw braces.

import type { Severity } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export type Titles = Record<Locale, string>;

/** A type as code defines it: the event that raises it and the defaults a channel starts from. */
export interface BuiltInType {
  key: string;
  /** The event that raises it. */
  event: string;
  /** Who it goes to — the routing decided 2026-10-18, as words for the registry's readers. */
  recipients: string;
  /** The `{{slots}}` its templates may use. */
  vars: readonly string[];
  severity: Severity;
  enabled: boolean;
  defaultOn: boolean;
  mandatory: boolean;
  title: Titles;
}

export const BUILT_IN_TYPES: Readonly<Record<string, BuiltInType>> = {
  'asset.approved': {
    key: 'asset.approved',
    event: 'asset.approved',
    recipients: "the asset's creator",
    vars: ['approver'],
    severity: 'info',
    enabled: true,
    defaultOn: true,
    mandatory: false,
    title: { en: 'An asset you created was approved', ar: 'تمت الموافقة على مادة أنشأتها' },
  },
  'asset.rejected': {
    key: 'asset.rejected',
    event: 'asset.rejected',
    recipients: "the asset's creator",
    vars: ['reason', 'rejectedBy'],
    severity: 'warning',
    enabled: true,
    defaultOn: true,
    mandatory: false,
    title: {
      en: 'An asset you created was rejected: {{reason}}',
      ar: 'رُفضت مادة أنشأتها: {{reason}}',
    },
  },
  'asset.re-review-due': {
    key: 'asset.re-review-due',
    event: 'asset.expired',
    recipients: 'whoever approved it last',
    vars: [],
    severity: 'warning',
    enabled: true,
    defaultOn: true,
    // An approval that lapsed is a broadcaster's legal exposure — not something to mute.
    mandatory: true,
    title: {
      en: 'An asset you approved has expired and needs a fresh review',
      ar: 'انتهت صلاحية مادة وافقت عليها وتحتاج إلى مراجعة جديدة',
    },
  },
  'transcode.failed': {
    key: 'transcode.failed',
    event: 'transcode.failed',
    recipients: 'whoever asked for the transcode',
    vars: ['error'],
    severity: 'warning',
    enabled: true,
    defaultOn: true,
    mandatory: false,
    title: { en: 'A transcode you asked for failed: {{error}}', ar: 'فشل تحويل طلبته: {{error}}' },
  },
  'message.mention': {
    key: 'message.mention',
    event: 'message.sent',
    recipients: 'a user @-mentioned in a message they can read',
    vars: ['from'],
    severity: 'info',
    enabled: true,
    defaultOn: true,
    mandatory: false,
    title: { en: '{{from}} mentioned you in a message', ar: 'ذكرك {{from}} في رسالة' },
  },
};

/** What an operator set for one type in one channel — every field optional, over the built-in. */
export interface TypeOverride {
  key: string;
  channelId: string;
  severity?: Severity;
  enabled?: boolean;
  defaultOn?: boolean;
  mandatory?: boolean;
  title?: Partial<Titles>;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** A type as it applies in a channel: the built-in with the channel's override over it. */
export interface ResolvedType extends Omit<BuiltInType, 'title'> {
  title: Titles;
  origin: 'built-in' | 'channel';
  /** The override's version — 0 when there is none, the `version` a first PUT names. */
  version: number;
}

export function resolveType(builtIn: BuiltInType, override?: TypeOverride): ResolvedType {
  if (!override) return { ...builtIn, title: { ...builtIn.title }, origin: 'built-in', version: 0 };
  return {
    ...builtIn,
    severity: override.severity ?? builtIn.severity,
    enabled: override.enabled ?? builtIn.enabled,
    defaultOn: override.defaultOn ?? builtIn.defaultOn,
    mandatory: override.mandatory ?? builtIn.mandatory,
    title: { ...builtIn.title, ...override.title },
    origin: 'channel',
    version: override.version,
  };
}

/** `{{name}}` filled from `vars`; an unknown or missing slot renders as nothing. */
export function render(template: string, vars: Record<string, string | undefined>): string {
  return template
    .replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_m, name: string) => vars[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEVERITIES = new Set(['info', 'warning', 'critical']);

/** `PUT /notification-types/{key}`'s body. */
export function parseOverride(
  key: string,
  body: Record<string, unknown>,
): Omit<TypeOverride, 'key' | 'channelId' | 'version' | 'updatedBy' | 'updatedAt'> {
  const builtIn = BUILT_IN_TYPES[key];
  if (!builtIn)
    throw new ValidationError(
      `"${key}" is not a notification type this platform raises (${Object.keys(BUILT_IN_TYPES).join(', ')})`,
      { code: 'UNKNOWN_TYPE' },
    );
  for (const k of Object.keys(body))
    if (!['severity', 'enabled', 'defaultOn', 'mandatory', 'title'].includes(k))
      throw new ValidationError(`unknown field ${k}`);
  const out: Omit<TypeOverride, 'key' | 'channelId' | 'version' | 'updatedBy' | 'updatedAt'> = {};
  if (body['severity'] !== undefined) {
    if (typeof body['severity'] !== 'string' || !SEVERITIES.has(body['severity']))
      throw new ValidationError('severity must be info, warning or critical');
    out.severity = body['severity'] as Severity;
  }
  for (const flag of ['enabled', 'defaultOn', 'mandatory'] as const) {
    const v = body[flag];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new ValidationError(`${flag} must be true or false`);
    out[flag] = v;
  }
  const title = body['title'];
  if (title !== undefined) {
    if (typeof title !== 'object' || title === null || Array.isArray(title))
      throw new ValidationError('title must be { en?, ar? }');
    const t: Partial<Titles> = {};
    for (const [locale, text] of Object.entries(title)) {
      if (!(LOCALES as readonly string[]).includes(locale))
        throw new ValidationError(`title has no locale "${locale}" (${LOCALES.join(', ')})`);
      if (typeof text !== 'string' || text.trim() === '' || text.length > 300)
        throw new ValidationError(`title.${locale} must be a non-empty string of at most 300`);
      for (const [, slot] of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g))
        if (!builtIn.vars.includes(slot!))
          throw new ValidationError(
            `title.${locale} uses {{${slot}}}, which ${key} does not have (${builtIn.vars.join(', ') || 'none'})`,
          );
      t[locale as Locale] = text;
    }
    out.title = t;
  }
  return out;
}
