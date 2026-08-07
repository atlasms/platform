// EP-17.4 — the tokenizer and query parser, in isolation.
//
// The property everything else depends on: a query is folded through EXACTLY the same path as the
// document. If the two ever diverge, an asset carries terms nobody can type — and both halves look
// correct on their own, which is why this file pins the shared path rather than each side of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUERY_TERMS,
  MAX_TERMS_PER_ASSET,
  MIN_TERM_LENGTH,
  indexTerms,
  parseQuery,
  prefixUpperBound,
  tokenize,
} from '../src/search.ts';
import { normalizeTag } from '../src/tag.ts';

test('words split on punctuation and whitespace, and case folds away', () => {
  assert.deepEqual(tokenize('UEFA Champions League, 2026!'), [
    'uefa',
    'champions',
    'league',
    '2026',
  ]);
});

test('tokenizing uses UNICODE word classes, not ASCII', () => {
  // `\w` is [A-Za-z0-9_]. Splitting on its complement would treat every Persian letter as a
  // separator and reduce the whole title to nothing — the failure would be a search box that
  // silently returns no results for half the library.
  const tokens = tokenize(
    '\u0645\u06CC\u200C\u0631\u0648\u062F \u0628\u0647 \u062E\u0627\u0646\u0647',
  );
  assert.deepEqual(tokens, [
    '\u0645\u06CC\u200C\u0631\u0648\u062F',
    '\u0628\u0647',
    '\u062E\u0627\u0646\u0647',
  ]);
});

test('ZWNJ stays INSIDE a token', () => {
  // Persian می‌رود is one word joined by a zero-width non-joiner. Splitting on it would index two
  // fragments that neither the writer nor the searcher would ever type.
  const [only, ...rest] = tokenize('\u0645\u06CC\u200C\u0631\u0648\u062F');
  assert.equal(rest.length, 0, 'must be a single token');
  assert.ok(only?.includes('\u200C'));
});

test('search and tags fold text the SAME way', () => {
  // This is the one that keeps the two features honest. A tag stored under one folding and a query
  // tokenized under another means an asset carrying a tag that cannot be searched for.
  for (const raw of ['Football', '  FOOTBALL  ', 'foot\u200Bball', 'cafe\u0301']) {
    assert.deepEqual(tokenize(raw), [normalizeTag(raw)], JSON.stringify(raw));
  }
});

test('index terms are deduplicated, sorted, and drop one-character noise', () => {
  const terms = indexTerms(['Match match MATCH', 'a great game', undefined, '']);
  assert.deepEqual(terms, ['game', 'great', 'match']);
  assert.equal(
    terms.includes('a'),
    false,
    `a ${MIN_TERM_LENGTH - 1}-character term narrows nothing and costs a row per asset`,
  );
});

test('a pathological description cannot own the index', () => {
  const flood = Array.from({ length: MAX_TERMS_PER_ASSET * 2 }, (_, i) => `term${i}`).join(' ');
  assert.equal(indexTerms([flood]).length, MAX_TERMS_PER_ASSET);
});

test('the LAST term is a prefix while it is still being typed', () => {
  assert.deepEqual(parseQuery('champions leag'), { exact: ['champions'], prefix: 'leag' });
});

test('a trailing separator means the word is finished', () => {
  // `football ` is a completed term; `football` may still be being typed. That difference is the
  // whole of search-as-you-type, and getting it backwards makes `foot ` match `football`.
  assert.deepEqual(parseQuery('champions leag '), { exact: ['champions', 'leag'] });
  assert.deepEqual(parseQuery('cup,'), { exact: ['cup'] });
});

test('a single word is a prefix, so one-character queries still search', () => {
  // MIN_TERM_LENGTH applies to the INDEX, not the query — someone who has typed one letter means
  // "starting with this", and refusing would make the box feel broken for the first keystroke.
  assert.deepEqual(parseQuery('f'), { exact: [], prefix: 'f' });
});

test('an empty or punctuation-only query yields no terms', () => {
  for (const q of ['', '   ', '!!!', '\u200B']) {
    assert.deepEqual(parseQuery(q), { exact: [] }, JSON.stringify(q));
  }
});

test('a pasted wall of text is truncated, not refused', () => {
  const many = Array.from({ length: MAX_QUERY_TERMS + 10 }, (_, i) => `w${i}`).join(' ');
  const parsed = parseQuery(many);
  assert.equal(parsed.exact.length + (parsed.prefix ? 1 : 0), MAX_QUERY_TERMS);
});

test('the prefix upper bound increments the last CODE POINT', () => {
  // Appending a high sentinel is the tempting version and it is wrong: it fails for any term that
  // itself ends in that sentinel. Incrementing is exact.
  assert.equal(prefixUpperBound('ab'), 'ac');
  assert.equal(prefixUpperBound('az'), 'a{');
  assert.equal(prefixUpperBound(''), '');

  // Astral plane: the last code point is one character, not two UTF-16 units.
  assert.equal(prefixUpperBound('a\u{1F3AC}'), 'a\u{1F3AD}');
});

test('the bound is exclusive and strictly above every string with that prefix', () => {
  const bound = prefixUpperBound('ab');
  for (const inside of ['ab', 'abz', 'ab\u{10FFFF}', 'abzzzzzz']) {
    assert.ok(inside >= 'ab' && inside < bound, inside);
  }
  assert.ok('ac' >= bound, 'the next term must fall outside');
});
