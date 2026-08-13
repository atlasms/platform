// `GET /reference` — the serving half of the versioned snapshot (EP-04.8).
//
// Design: [configuration-and-reference-data.md §5](../../../docs/architecture/configuration-and-reference-data.md).
// Reference data is read from a VERSIONED SNAPSHOT, never row-by-row per request, so validating
// "is this a known classification?" is an in-memory set lookup on every service and in the browser.
//
// `@atlas/reference` already has the CLIENT (SnapshotClient: cache, ETag revalidate, keep stale on
// failure). This is what it talks to, and it lives in service-kit rather than there because every
// service serves one — that is what "baked into the template" means.
//
// Deliberately no dependency on `@atlas/reference`: the caller hands over a snapshot object and
// this decides the HTTP question. service-kit sits below the domain libraries, and a snapshot is
// just "something with a configVersion" as far as caching is concerned.

/** The minimum this needs to know about a snapshot. Everything else is the owning service's. */
export interface Versioned {
  /**
   * MONOTONIC, and the design says so: any admin change bumps it and emits `config.changed`.
   *
   * Not a content hash. A hash would revalidate correctly but says nothing about ordering, and
   * §5's convergence story — holders refresh when they see a higher version — needs the ordering.
   */
  configVersion: number;
}

export interface SnapshotResult<T> {
  status: 200 | 304;
  /** Always present, on both statuses: a 304 that omits it invalidates the client's cache entry. */
  etag: string;
  /** Absent on 304 — that is the entire saving. */
  body?: T;
}

/**
 * Weak ETag for a config version.
 *
 * Weak (`W/`) because the body is JSON assembled per request: two responses at the same
 * configVersion are semantically identical but not guaranteed byte-identical, and a strong ETag
 * promises byte-equality it cannot keep. Same shape IAM already uses for `permVersion`.
 */
export const configEtag = (configVersion: number): string => `W/"cv-${configVersion}"`;

/**
 * Decide 200-with-body or 304, given the request's `If-None-Match`.
 *
 * The header is not a single value. RFC 9110 §13.1.2 allows a comma-separated LIST and the literal
 * `*`, and requires **weak comparison** — so `"cv-4"` and `W/"cv-4"` match each other. Getting that
 * wrong fails in one of two ways, and both are quiet: compare strictly and a client that echoes the
 * tag without the `W/` prefix never gets a 304, so every poll ships the whole snapshot; ignore the
 * list form and a browser sending two cached tags gets the same.
 */
export function serveSnapshot<T extends Versioned>(
  snapshot: T,
  ifNoneMatch: string | string[] | undefined,
): SnapshotResult<T> {
  const etag = configEtag(snapshot.configVersion);
  return matchesEtag(ifNoneMatch, etag)
    ? { status: 304, etag }
    : { status: 200, etag, body: snapshot };
}

/** Does an `If-None-Match` header match this ETag, by RFC 9110's weak comparison? */
export function matchesEtag(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  // A repeated header arrives as an array; the semantics are the same as one comma-separated value.
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch;

  const wanted = weaken(etag);
  for (const candidate of raw.split(',')) {
    const value = candidate.trim();
    if (value === '') continue;
    // `*` means "if any representation exists". For a snapshot one always does, so this is a 304 —
    // which is what makes `If-None-Match: *` a cheap "do I already have the current one?".
    if (value === '*') return true;
    if (weaken(value) === wanted) return true;
  }
  return false;
}

/** Strip the weak marker so `W/"x"` and `"x"` compare equal. */
const weaken = (tag: string): string => (tag.startsWith('W/') ? tag.slice(2) : tag);
