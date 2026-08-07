// Simple search (EP-17.4, FR-MAM-4 / FR-TAX-6).
//
// The target architecture puts faceted search on OpenSearch, fed by the outbox as a rebuildable
// read model ([mam.md §6.2](../../../docs/architecture/services/mam.md)). That is Beta work, and
// this is not it. What MVP needs is that an editor can type a word and find their asset — so the
// index here is a **term table in the same database**, written in the same transaction as the row
// it describes.
//
// Two consequences are worth stating plainly, because they are both why this is the right MVP and
// why it will not be the answer forever:
//
//   • It cannot drift. A separate store has to be reconciled — the outbox exists precisely because
//     dual writes desynchronise. An index that commits with its row has no such window at all,
//     which is strictly stronger than what the doc's outbox projection promises.
//   • It does not stem, and it does not rank the way a search engine does. `running` will not find
//     `run`. That is a real limitation, stated rather than hidden.
//
// Tokenizing happens HERE, in pure domain code, not in SQL — the same reasoning as `tag.ts`: a
// tokenizer living in the database would be a different tokenizer per adapter, and the conformance
// suite could no longer assert that the two stores agree. It also sidesteps a specific trap.
// **Postgres ships no `persian` text-search configuration** — arabic yes, persian no, checked
// against the Postgres 17 this project runs — so `to_tsvector` on Persian content silently falls
// back to no stemming while *looking* language-aware. An explicit token index treats Persian and
// English alike: worse than a real Persian analyser, and much better than one that pretends. (When
// OpenSearch arrives it does have a Lucene `persian` analyser, which is a genuine argument for the
// move rather than a restatement of the plan.)

import { foldText, ZWNJ } from './text.ts';

/**
 * What counts as being inside a word.
 *
 * `\p{L}` and `\p{N}` — Unicode letter and number — rather than `\w`, which is ASCII-only and would
 * reduce every Persian or Arabic title to a single empty token. `\p{M}` (combining marks) keeps a
 * decomposed accent attached to its letter instead of splitting one word in two. ZWNJ is imported
 * rather than typed, because it is invisible in source and a reviewer cannot check what they
 * cannot see.
 */
const WORD = `\\p{L}\\p{N}\\p{M}${ZWNJ}`;
const SEPARATORS = new RegExp(`[^${WORD}]+`, 'gu');
const ENDS_WITH_SEPARATOR = new RegExp(`[^${WORD}]$`, 'u');

/**
 * Terms shorter than this are dropped from the INDEX.
 *
 * A one-character token matches most of the library and narrows nothing, so it costs a row per
 * asset to be useless. Queries are NOT subject to it — a one-character query is handled as a
 * prefix, which is what someone typing means by it.
 */
export const MIN_TERM_LENGTH = 2;

/** Guards against a pathological asset — a pasted transcript in a description — owning the index. */
export const MAX_TERMS_PER_ASSET = 400;

/** A query longer than this is a paste, not a search. Extra terms are dropped, not refused. */
export const MAX_QUERY_TERMS = 16;

/**
 * Split folded text into search terms.
 *
 * U+200C ZWNJ stays INSIDE a token, matching `tag.ts`: in Persian it joins parts of one word
 * (`می‌رود`), so splitting on it would index two fragments that neither the writer nor the searcher
 * would ever type.
 */
export function tokenize(text: string): string[] {
  return foldText(text)
    .split(SEPARATORS)
    .filter((t) => t !== '');
}

/**
 * The terms an asset is findable by.
 *
 * Deduplicated: this is a membership index, not a frequency one. Counting frequency would let a
 * word repeated in a long description outrank the same word in a title, which is backwards — so
 * relevance is HOW MANY of the query's terms an asset matches, never how often.
 */
export function indexTerms(sources: readonly (string | undefined)[]): string[] {
  const terms = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const term of tokenize(source)) {
      if ([...term].length < MIN_TERM_LENGTH) continue;
      terms.add(term);
      if (terms.size >= MAX_TERMS_PER_ASSET) return [...terms].sort();
    }
  }
  return [...terms].sort();
}

export interface ParsedQuery {
  /** Must match exactly. Every word the user finished typing. */
  exact: string[];
  /**
   * The final token, matched as a PREFIX.
   *
   * Someone typing `foot` means "football", not "nothing yet" — search-as-you-type is the normal
   * way this endpoint gets used. Only the LAST token, because the earlier ones are words the user
   * finished writing, and prefix-matching those would quietly widen the query behind their back.
   */
  prefix?: string;
}

/**
 * Parse a raw `q` into terms.
 *
 * Folded through exactly the same path as the index, which is the property that matters: a query
 * tokenized differently from the document is a query that cannot match it.
 */
export function parseQuery(q: string): ParsedQuery {
  const tokens = tokenize(q).slice(0, MAX_QUERY_TERMS);
  if (tokens.length === 0) return { exact: [] };

  // A trailing separator means the last word is finished. `football ` is a completed term;
  // `football` may still be being typed, and the difference is the whole of search-as-you-type.
  if (ENDS_WITH_SEPARATOR.test(q)) return { exact: tokens };

  return { exact: tokens.slice(0, -1), prefix: tokens[tokens.length - 1] as string };
}

/**
 * The exclusive upper bound of every string starting with `prefix`.
 *
 * A prefix match expressed as a **range** (`term >= p AND term < bound`) is an index scan on any
 * btree; `LIKE 'p%'` is one only when the planner can prove the pattern is a prefix, which on
 * Postgres additionally requires a `text_pattern_ops` opclass or a C-collated database. The range
 * is the portable form, so the sqlite adapter uses it directly.
 *
 * The bound increments the last CODE POINT rather than appending a high sentinel: appending
 * U+10FFFF fails on any term that itself ends in U+10FFFF, and incrementing is exact. UTF-8 sorts
 * in code-point order, so this is a true bound under both stores' binary collation.
 */
export function prefixUpperBound(prefix: string): string {
  const points = [...prefix];
  const last = points.pop();
  if (last === undefined) return '';
  return points.join('') + String.fromCodePoint((last.codePointAt(0) as number) + 1);
}

/** A hit, before the caller's permissions have been applied to it. */
export interface SearchHit {
  assetId: string;
  /** How many of the query's terms this asset matched. Higher is better. */
  score: number;
}
