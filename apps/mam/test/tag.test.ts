// EP-17.3 — the folding rules, in isolation.
//
// Everything here is about one question: when are two typed strings the same tag? Get it wrong in
// the permissive direction and the channel's tag cloud fills with `Football`, `football` and
// `football ` as three separate terms; get it wrong in the strict direction and two genuinely
// different Persian words collapse into one. Both failures are invisible until somebody searches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TAGS_PER_ASSET,
  MAX_TAG_LENGTH,
  normalizeTag,
  parseTagLabels,
  sameTags,
} from '../src/tag.ts';

test('case, padding and repeated whitespace do not make a new tag', () => {
  const forms = ['football', 'Football', 'FOOTBALL', '  football  ', 'foot\tball'];
  assert.deepEqual(
    [...new Set(forms.map(normalizeTag))],
    ['football', 'foot ball'],
    'only the one with an internal break is a different keyword',
  );
});

test('composed and decomposed accents are the same tag', () => {
  // The same word from two keyboards, or from a paste out of macOS versus Windows. Without NFC
  // these are different strings and the database has no way to know they are one term.
  assert.equal(normalizeTag('caf\u00E9'), normalizeTag('cafe\u0301'));
  assert.equal(normalizeTag('cafe\u0301'), 'caf\u00E9');
});

test('lowercasing is locale-INDEPENDENT', () => {
  // `toLocaleLowerCase` on a Turkish locale maps `I` to `ı`, which would make a channel's tag
  // identity depend on the locale of whichever pod happened to serve the request.
  assert.equal(normalizeTag('ISTANBUL'), 'istanbul');
});

test('invisible formatting characters cannot fork a tag', () => {
  // A zero-width space or a bidi mark survives copy-paste out of an RTL document and is impossible
  // to see in an input box — two identical-looking tags, two rows.
  for (const invisible of [
    '\u200B', // U+200B
    '\u200E', // U+200E
    '\u200F', // U+200F
    '\uFEFF', // U+FEFF
    '\u061C', // U+061C
    '\u202B', // U+202B
  ]) {
    assert.equal(normalizeTag(`foot${invisible}ball`), 'football', JSON.stringify(invisible));
  }
});

test('ZWNJ is PRESERVED — it changes the word in Persian', () => {
  // می‌رود and میرود are different words. Folding the zero-width non-joiner away would merge two
  // distinct terms, which is a worse failure than the duplicate it would prevent.
  const withZwnj = '\u{645}\u{6CC}\u200C\u{631}\u{648}\u{62F}';
  const without = '\u{645}\u{6CC}\u{631}\u{648}\u{62F}';
  assert.notEqual(normalizeTag(withZwnj), normalizeTag(without));
});

test('ZWJ is preserved, so an emoji sequence stays one tag', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  assert.equal(normalizeTag(family), family);
});

test('duplicates collapse and the FIRST spelling is kept', () => {
  const { labels, errors } = parseTagLabels(['Football', 'football', 'FOOTBALL']);
  assert.deepEqual(errors, []);
  assert.deepEqual(labels, [{ label: 'Football', normalized: 'football' }]);
});

test('the result is sorted, so an unchanged set compares equal whatever the order', () => {
  const a = parseTagLabels(['zebra', 'apple', 'mango']).labels;
  const b = parseTagLabels(['mango', 'zebra', 'apple']).labels;
  assert.deepEqual(a, b);
});

test('blank, non-string and control-bearing entries are refused', () => {
  const { labels, errors } = parseTagLabels(['   ', 42, null, 'a\u0007b', 'ok']);
  assert.equal(labels.length, 0, 'nothing is stored when any entry is bad');
  assert.equal(errors.length, 4);
  assert.match(errors.join('; '), /blank/);
  assert.match(errors.join('; '), /control characters/);
});

test('a newline is collapsed, not refused — a pasted phrase is a reasonable tag', () => {
  // Tab and newline are whitespace; the control characters that get refused are the ones that
  // render as nothing and corrupt an export.
  assert.deepEqual(parseTagLabels(['world\ncup']).labels, [
    { label: 'world cup', normalized: 'world cup' },
  ]);
});

test('length is capped in CODE POINTS, not UTF-16 units', () => {
  // `'🎬'.length` is 2. Counting units would let a limit of 64 mean 32 emoji, which is not what the
  // number on the form says.
  const emoji = '\u{1F3AC}'.repeat(MAX_TAG_LENGTH);
  assert.deepEqual(parseTagLabels([emoji]).errors, [], 'exactly at the cap is allowed');
  assert.match(parseTagLabels([emoji + '\u{1F3AC}']).errors.join(), /may not exceed/);
});

test('an asset may not carry more tags than the cap', () => {
  const many = Array.from({ length: MAX_TAGS_PER_ASSET + 1 }, (_, i) => `tag-${i}`);
  assert.match(parseTagLabels(many).errors.join(), /may not carry more than/);
  assert.equal(parseTagLabels(many.slice(0, MAX_TAGS_PER_ASSET)).errors.length, 0);
});

test('the cap counts DISTINCT tags — duplicates are a typo, not an attack', () => {
  const dupes = Array.from({ length: MAX_TAGS_PER_ASSET * 2 }, () => 'same');
  assert.deepEqual(parseTagLabels(dupes).errors, []);
});

test('sameTags compares the folded form, so re-casing is a no-op', () => {
  const current = [{ id: 'T1', channelId: 'ch12', label: 'Football', normalized: 'football' }];
  assert.equal(sameTags(current, parseTagLabels(['FOOTBALL']).labels), true);
  assert.equal(sameTags(current, parseTagLabels(['football', 'rugby']).labels), false);
  assert.equal(sameTags(current, []), false);
  assert.equal(sameTags([], []), true);
});

test('an empty submission is valid — clearing tags is a legitimate edit', () => {
  assert.deepEqual(parseTagLabels([]), { labels: [], errors: [] });
});
