// Controlled vocabularies (EP-28.3; configuration-and-reference-data.md §2.3, FR-TAX-3/4/8) — pure.
//
// The SET of vocabularies is code-known (Tier 0 — each feeds a known field or list); the TERMS are
// data an operator manages without a deploy. Four rules keep that safe (§2.3):
//   1. stable id, mutable label — an asset references the id, so a rename rewrites nothing;
//   2. deprecate, never delete — a deprecated term leaves the pickers and still resolves;
//   3. merge is one operation — `replacedById` redirects, and the merge is one audited write;
//   4. a `key` beside the id — imports and feeds map external values without knowing ULIDs.
//
// The category tree is a vocabulary too, but hierarchical and with its own aggregate (category.ts).

import { ValidationError } from '@atlas/service-kit';

export const VOCABULARIES = [
  'structure',
  'genre',
  'supply-type',
  'production-group',
  'classification',
  'subject',
  'cast-role',
] as const;
export type Vocabulary = (typeof VOCABULARIES)[number];

export const isVocabulary = (v: string): v is Vocabulary =>
  (VOCABULARIES as readonly string[]).includes(v);

/**
 * The asset fields (and category defaults) that hold a TERM of a vocabulary (EP-28.3, decided with
 * the product owner): validated on write, an id, never a label.
 */
export const TERM_FIELDS = {
  structureId: 'structure',
  genre: 'genre',
  supplyType: 'supply-type',
  productionGroup: 'production-group',
} as const satisfies Record<string, Vocabulary>;
export type TermField = keyof typeof TERM_FIELDS;

/** The asset LIST fields that hold terms (EP-28.4): every id must name a live term. */
export const TERM_LIST_FIELDS = {
  subjectIds: 'subject',
  classificationIds: 'classification',
} as const satisfies Record<string, Vocabulary>;

export interface VocabularyTerm {
  id: string;
  vocabulary: Vocabulary;
  channelId: string;
  key: string;
  labels: Record<string, string>;
  description?: string;
  sortOrder: number;
  colour?: string;
  /** Mappings to third-party identifiers (EPG codes, …), for feeds to round-trip the term. */
  external?: Record<string, string>;
  deprecatedAt?: string;
  /** Set by a merge: readers follow it, so an old reference still resolves. */
  replacedById?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTermInput {
  key: string;
  labels: Record<string, string>;
  description?: string;
  sortOrder?: number;
  colour?: string;
  external?: Record<string, string>;
}

export interface UpdateTermInput {
  labels?: Record<string, string>;
  description?: string;
  sortOrder?: number;
  colour?: string;
  external?: Record<string, string>;
  /** true deprecates, false restores — a merged term cannot be restored (it has a replacement). */
  deprecated?: boolean;
}

const KEY = /^[a-z0-9][a-z0-9-]*$/;
const LOCALE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

export function createTermProblems(input: Partial<CreateTermInput>): string[] {
  const problems: string[] = [];
  if (typeof input.key !== 'string' || !KEY.test(input.key) || input.key.length > 64) {
    problems.push(
      'key must be lower-case letters, digits and hyphens, starting with a letter or digit, at most 64',
    );
  }
  if (input.labels === undefined) problems.push('labels are required — at least one locale');
  return [...problems, ...commonProblems(input)];
}

export function updateTermProblems(
  input: Partial<UpdateTermInput> & Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  if ('key' in input) problems.push('key cannot change — imports and feeds map by it');
  if ('replacedById' in input) problems.push('a replacement is set by merging, not by an update');
  if (input.deprecated !== undefined && typeof input.deprecated !== 'boolean') {
    problems.push('deprecated must be true or false');
  }
  return [...problems, ...commonProblems(input)];
}

function commonProblems(input: Partial<UpdateTermInput>): string[] {
  const problems: string[] = [];
  const labels = input.labels as unknown;
  if (
    labels !== undefined &&
    (typeof labels !== 'object' ||
      labels === null ||
      Array.isArray(labels) ||
      Object.keys(labels).length === 0 ||
      Object.entries(labels).some(
        ([locale, text]) => !LOCALE.test(locale) || typeof text !== 'string' || !text.trim(),
      ))
  ) {
    problems.push('labels must map locale tags (en, ar, …) to non-empty text, at least one');
  }
  if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) {
    problems.push('sortOrder must be a whole number');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    problems.push('description must be text');
  }
  if (
    input.colour !== undefined &&
    (typeof input.colour !== 'string' || !COLOUR.test(input.colour))
  ) {
    problems.push('colour must be #rrggbb');
  }
  const external = input.external as unknown;
  if (
    external !== undefined &&
    (typeof external !== 'object' ||
      external === null ||
      Array.isArray(external) ||
      Object.values(external).some((v) => typeof v !== 'string'))
  ) {
    problems.push('external must map system names to identifiers (text)');
  }
  return problems;
}

export function refuseTerm(problems: string[]): void {
  if (problems.length > 0) throw new ValidationError(problems.join('; '));
}

/** The term a reference resolves to: itself, or the end of its merge chain (bounded). */
export function resolveTerm(
  term: VocabularyTerm,
  byId: ReadonlyMap<string, VocabularyTerm>,
): VocabularyTerm {
  let current = term;
  for (let hops = 0; current.replacedById !== undefined && hops < 16; hops++) {
    const next = byId.get(current.replacedById);
    if (!next) break;
    current = next;
  }
  return current;
}

/** Display label in a locale, falling back to English, then to any, then to the key. */
export function termLabel(term: Pick<VocabularyTerm, 'labels' | 'key'>, locale = 'en'): string {
  return term.labels[locale] ?? term.labels['en'] ?? Object.values(term.labels)[0] ?? term.key;
}
