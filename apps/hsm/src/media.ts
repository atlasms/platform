// HTTP Range for the media route (ADR-0012) — pure. A `<video>` seeks by asking for byte ranges, and
// a proxy that cannot answer one is a proxy that downloads whole before it plays (ADR-0011).
//
// One range is served (206); anything this does not understand — several ranges, another unit, a
// malformed header — is IGNORED and the whole file served (200), which RFC 9110 §14.2 allows a
// server to do. A range that starts past the end is unsatisfiable (416).

import type { ByteRange } from './driver.ts';

/** A media URL on the platform's origin must never be a page that runs anything (ADR-0012). */
export const SANDBOX_CSP = "default-src 'none'; sandbox";

export type RangeAnswer =
  { kind: 'whole' } | { kind: 'partial'; range: ByteRange } | { kind: 'unsatisfiable' };

export function parseRange(header: string | undefined, size: number): RangeAnswer {
  if (header === undefined) return { kind: 'whole' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'whole' };
  if (size === 0) return { kind: 'unsatisfiable' };
  if (m[1] === '') {
    // A suffix: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', range: { start: Math.max(0, size - n), end: size - 1 } };
  }
  const start = Number(m[1]);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return { kind: 'whole' };
  return { kind: 'partial', range: { start, end } };
}

/**
 * The path a log may carry for a request. A media URL's QUERY is its credential (ADR-0012), so it
 * never reaches a log line; every other path keeps its query, which is how an operator debugs it.
 */
export function loggablePath(url: string): string {
  return url.startsWith('/media/') ? url.split('?')[0]! : url;
}
