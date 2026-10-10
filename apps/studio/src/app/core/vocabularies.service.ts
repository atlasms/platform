import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type {
  CreateTermInput,
  UpdateTermInput,
  VocabularyName,
  VocabularyTerm,
} from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/** Every flat vocabulary MAM manages (EP-28.3), in the order Studio offers them. */
export const VOCABULARY_NAMES: readonly VocabularyName[] = [
  'structure',
  'genre',
  'supply-type',
  'production-group',
  'classification',
  'subject',
  'cast-role',
];

/** The asset fields that hold a term, and the vocabulary each names (MAM's TERM_FIELDS). */
export const TERM_FIELD_VOCABULARY = {
  structureId: 'structure',
  genre: 'genre',
  supplyType: 'supply-type',
  productionGroup: 'production-group',
} as const satisfies Record<string, VocabularyName>;
export type TermField = keyof typeof TERM_FIELD_VOCABULARY;

/** A term's label in a locale, falling back to English, then any, then the key. */
export function termLabel(term: Pick<VocabularyTerm, 'labels' | 'key'>, locale: string): string {
  const labels = term.labels as Record<string, string>;
  return labels[locale] ?? labels['en'] ?? Object.values(labels)[0] ?? term.key;
}

/**
 * MAM's controlled vocabularies, through the gateway (EP-28.3; configuration-and-reference-data.md
 * §2.3): stable id, mutable label, deprecate-not-delete, merge. Every write is a compare-and-set on
 * the version read — a 409 is a reload, never a retry.
 */
@Injectable({ providedIn: 'root' })
export class VocabulariesService {
  private readonly api = inject(ApiClient);

  list(vocabulary: VocabularyName, includeDeprecated = false) {
    return this.api
      .call(ops.listVocabularyTerms, {
        params: { vocabulary },
        query: includeDeprecated ? { includeDeprecated } : {},
      })
      .as<VocabularyTerm[]>();
  }

  create(vocabulary: VocabularyName, input: CreateTermInput) {
    return this.api
      .call(ops.createVocabularyTerm, { params: { vocabulary }, body: input })
      .as<VocabularyTerm>();
  }

  update(vocabulary: VocabularyName, termId: string, version: number, input: UpdateTermInput) {
    return this.api
      .call(ops.updateVocabularyTerm, {
        params: { vocabulary, termId },
        query: { version },
        body: input,
      })
      .as<VocabularyTerm>();
  }

  merge(vocabulary: VocabularyName, termId: string, into: string, version: number) {
    return this.api
      .call(ops.mergeVocabularyTerm, { params: { vocabulary, termId }, body: { into, version } })
      .as<VocabularyTerm>();
  }
}
