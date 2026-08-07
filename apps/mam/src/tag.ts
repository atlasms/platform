// Free-form tags (EP-17.3, FR-TAX-1).
//
// Tags are the one classification axis with NO controlled vocabulary behind it: an editor types a
// keyword and it exists ([data-model.md §1.2](../../../docs/architecture/data-model.md)). That is
// the point of them, and it is also the whole difficulty — the only thing standing between "ad-hoc
// labelling" and an unusable cloud full of near-duplicates is how a typed string is folded into an
// identity.
//
// So this module separates the *label* (what someone typed, and what Studio displays) from the
// *normalized* form (what decides whether two tags are the same tag). Everything here is pure, and
// no adapter normalizes anything — otherwise sqlite and Postgres could disagree about what "the
// same tag" means, which is precisely the class of bug the conformance suite exists to catch.

/** A minted tag. Free-form, but still per-channel — one tenant's keywords are not another's. */
export interface Tag {
  id: string;
  channelId: string;
  /** As **first** typed. What Studio displays. */
  label: string;
  /** Identity within the channel. Two labels with the same normalized form are one tag. */
  normalized: string;
}

/**
 * A tag the service is asking the store to resolve.
 *
 * `id` is a *candidate*: used only if the label is new to the channel. A tag that already exists
 * comes back with the id it already had, which is how ids stay stable across every asset carrying
 * them — and how the service can tell a newly minted tag from a reused one without a second query.
 */
export interface TagCandidate {
  id: string;
  label: string;
  normalized: string;
}

/** What a caller may submit. Longer than this is a sentence, not a keyword. */
export const MAX_TAG_LENGTH = 64;

/**
 * How many tags one asset may carry.
 *
 * A cap rather than none, because every tag is a row in the join, a term in the future search index
 * and a chip in the UI — and "free-form" is otherwise an invitation to paste a transcript into the
 * tag box.
 */
export const MAX_TAGS_PER_ASSET = 50;

/**
 * Invisible formatting characters that must not create a distinct tag.
 *
 * ZWSP, the Arabic letter mark, the LTR/RTL marks, the bidi embeddings/overrides/isolates and BOM
 * are formatting, not content: two tags differing only by one of these are indistinguishable on
 * screen and distinct in the database — exactly the duplicate normalization exists to prevent — and
 * they arrive constantly from copy-paste out of RTL documents.
 *
 * Two deliberate absences:
 * - **U+200C ZWNJ** is a letter-joining control in Persian; `می‌رود` and `میرود` are different
 *   words. Stripping it would silently merge distinct terms, which is worse than the duplicate.
 * - **U+200D ZWJ** joins emoji sequences, so removing it would shatter `👨‍👩‍👧` into three tags.
 */
const INVISIBLE = /[\u200B\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/**
 * Control characters that are not whitespace.
 *
 * Tab and newline are *collapsed* rather than refused — pasting a wrapped phrase is a reasonable
 * thing to do. The rest render as nothing, or as a replacement glyph, or corrupt a CSV export, and
 * no keyword legitimately contains one.
 *
 * The `no-control-regex` disable below is the point of the rule inverted: it exists to catch
 * control characters that arrive in a pattern by accident, and here they are the subject.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/**
 * Strip formatting, collapse whitespace, compose.
 *
 * NFC because `é` composed and `e` + combining acute are the same word to a human and different
 * strings to a database, and the two arrive from different keyboards and different paste sources.
 */
function cleanLabel(value: string): string {
  return value.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

/**
 * Fold a typed label into its identity within a channel.
 *
 * `toLowerCase()`, not `toLocaleLowerCase()` — the locale-sensitive form maps Turkish `I` to `ı`,
 * so the same tag would fold differently depending on the *server's* locale. A channel's tag
 * identity must not depend on where the process happens to be running.
 */
export function normalizeTag(label: string): string {
  return cleanLabel(label).toLowerCase();
}

export interface ParsedTags {
  /** Deduplicated and sorted by normalized form. Empty when anything failed. */
  labels: { label: string; normalized: string }[];
  errors: string[];
}

/**
 * Validate and fold a submitted tag list.
 *
 * Arrives as `unknown[]` on purpose: this is JSON off the wire, and `string[]` is a claim the type
 * system cannot check at runtime.
 *
 * Duplicates are **not** an error — a form submitting `Football` and `football` is a user typing
 * the same tag twice, not a mistake worth a 422. The first spelling wins, which keeps display
 * casing stable rather than letting it flicker with whoever typed last.
 */
export function parseTagLabels(raw: readonly unknown[]): ParsedTags {
  const errors: string[] = [];
  const bySlug = new Map<string, { label: string; normalized: string }>();

  for (const value of raw) {
    if (typeof value !== 'string') {
      errors.push(`a tag must be a string, got ${value === null ? 'null' : typeof value}`);
      continue;
    }
    if (CONTROL.test(value)) {
      errors.push('a tag must not contain control characters');
      continue;
    }

    const label = cleanLabel(value);
    if (label === '') {
      errors.push('a tag must not be blank');
      continue;
    }
    // Counted in CODE POINTS, not UTF-16 units: `[...'🎬'].length` is 1 and `'🎬'.length` is 2, and
    // a limit that says 64 should mean 64 characters to whoever is typing them.
    if ([...label].length > MAX_TAG_LENGTH) {
      errors.push(`a tag may not exceed ${MAX_TAG_LENGTH} characters`);
      continue;
    }

    // The stored label keeps its original casing — folding is for identity, and showing an editor
    // their `UEFA` back as `uefa` would look like the platform mangled it.
    const normalized = label.toLowerCase();
    if (!bySlug.has(normalized)) bySlug.set(normalized, { label, normalized });
  }

  if (bySlug.size > MAX_TAGS_PER_ASSET) {
    errors.push(`an asset may not carry more than ${MAX_TAGS_PER_ASSET} tags`);
  }
  if (errors.length > 0) return { labels: [], errors };

  // Sorted so the stored order is a function of the SET, not of submission order — otherwise two
  // identical tag sets compare unequal and every save looks like a change.
  return {
    labels: [...bySlug.values()].sort((a, b) => (a.normalized < b.normalized ? -1 : 1)),
    errors: [],
  };
}

/**
 * Do these describe the same set of tags?
 *
 * Compared on the normalized form, so re-submitting `FOOTBALL` over an existing `football` is
 * correctly a no-op — no version bump, no `asset.updated`, no consumer woken for nothing.
 */
export function sameTags(
  current: readonly Tag[],
  wanted: readonly { normalized: string }[],
): boolean {
  if (current.length !== wanted.length) return false;
  const have = new Set(current.map((t) => t.normalized));
  return wanted.every((t) => have.has(t.normalized));
}
