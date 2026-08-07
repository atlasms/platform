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

import { CONTROL, cleanText, foldText } from './text.ts';

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
 * Fold a typed label into its identity within a channel.
 *
 * Delegates to {@link foldText}, which is shared with search (EP-17.4) — and that sharing is
 * load-bearing rather than tidy. If tagging folded `Football` one way and the search index folded
 * the query another, an asset would carry a tag nobody could find it by, and both halves would look
 * correct in isolation.
 */
export function normalizeTag(label: string): string {
  return foldText(label);
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

    const label = cleanText(value);
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
