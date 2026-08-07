// One definition of how user-typed text is folded, shared by tags (EP-17.3) and search (EP-17.4).
//
// It lives in its own module because the two MUST agree. If tagging folded `Football` one way and
// search folded the query another, an asset would carry a tag nobody could find it by — and the
// failure would be silent, because both halves would look correct in isolation.
//
// Everything here is pure. No adapter folds anything, so sqlite and Postgres cannot disagree about
// what the same word is.

/**
 * Invisible formatting characters that must not change a word's identity.
 *
 * ZWSP, the Arabic letter mark, the LTR/RTL marks, the bidi embeddings/overrides/isolates and BOM
 * are formatting, not content: text differing only by one of these is indistinguishable on screen
 * and distinct in the database, and it arrives constantly from copy-paste out of RTL documents.
 *
 * Two deliberate absences:
 * - **U+200C ZWNJ** is a letter-joining control in Persian; `می‌رود` and `میرود` are different
 *   words. Stripping it would silently merge distinct terms, which is worse than the duplicate.
 * - **U+200D ZWJ** joins emoji sequences, so removing it would shatter `👨‍👩‍👧` into three tokens.
 */
export const INVISIBLE = /[\u200B\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** U+200C, kept inside a word rather than treated as a separator. See {@link INVISIBLE}. */
export const ZWNJ = '\u200C';

/**
 * Control characters that are not whitespace.
 *
 * Tab and newline are *collapsed* rather than refused — pasting a wrapped phrase is a reasonable
 * thing to do. The rest render as nothing, or as a replacement glyph, or corrupt a CSV export, and
 * no word legitimately contains one.
 *
 * The `no-control-regex` disable is the point of the rule inverted: it exists to catch control
 * characters that reach a pattern by accident, and here they are the subject.
 */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/**
 * Strip formatting, collapse whitespace, compose — preserving case.
 *
 * NFC because `é` composed and `e` + combining acute are the same word to a human and different
 * strings to a database, and the two arrive from different keyboards and different paste sources.
 */
export function cleanText(value: string): string {
  return value.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

/**
 * {@link cleanText}, then case-folded — the form that decides whether two pieces of text are "the
 * same".
 *
 * `toLowerCase()`, not `toLocaleLowerCase()` — the locale-sensitive form maps Turkish `I` to `ı`,
 * so the same word would fold differently depending on the *server's* locale. Identity must not
 * depend on where the process happens to be running.
 */
export function foldText(value: string): string {
  return cleanText(value).toLowerCase();
}
