// Signed media URLs (ADR-0012): how a BROWSER reads a file — a `<video src>` cannot carry a bearer.
//
// MAM answers the authorization question and signs a URL granting exactly one file of one asset in
// one channel, as one content type, until a time. HSM verifies it and serves the bytes. What is
// signed is a canonical string, never the raw URL, so query order and percent-encoding cannot make
// a valid URL fail or an altered one pass:
//
//   atlas-media-v1 \n channelId \n assetId \n kind \n variant \n contentType \n exp
//
// HMAC-SHA256 under a `media-url-keys` key (the signer uses the first; the verifier accepts any, so a
// key rotates), hex, compared in constant time. The reason a verification fails is for the log,
// never the response.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The longest a media URL may live, whatever a signer asks for — ADR-0012's ceiling. */
export const MAX_MEDIA_URL_SECONDS = 4 * 60 * 60;
export const DEFAULT_MEDIA_URL_SECONDS = 30 * 60;
/** The path every media URL is served under, by HSM, through the gateway's `/media/` route. */
export const MEDIA_URL_PREFIX = '/media/v1';

/** Exactly what one media URL grants. */
export interface MediaGrant {
  channelId: string;
  assetId: string;
  kind: string;
  variant?: string;
  contentType: string;
  /** Unix seconds after which the URL no longer serves. */
  exp: number;
}

const canonical = (g: MediaGrant): string =>
  [
    'atlas-media-v1',
    g.channelId,
    g.assetId,
    g.kind,
    g.variant ?? '',
    g.contentType,
    String(g.exp),
  ].join('\n');

const macOf = (key: string, g: MediaGrant): string =>
  createHmac('sha256', key).update(canonical(g)).digest('hex');

/**
 * The path and query of a URL granting `grant`, signed with `key` (the first of `media-url-keys`).
 * Relative: the caller prefixes the public origin, or leaves it for the browser to resolve.
 */
export function signMediaUrl(key: string, grant: MediaGrant): string {
  const query = new URLSearchParams({
    ch: grant.channelId,
    ...(grant.variant !== undefined ? { v: grant.variant } : {}),
    ct: grant.contentType,
    exp: String(grant.exp),
    sig: macOf(key, grant),
  });
  return `${MEDIA_URL_PREFIX}/${encodeURIComponent(grant.assetId)}/${encodeURIComponent(grant.kind)}?${query}`;
}

export type MediaVerdict = { ok: true; grant: MediaGrant } | { ok: false; reason: string };

/**
 * The grant a request carries, if its signature holds under one of `keys`, it has not expired, and
 * it does not reach further ahead than the ceiling (a signer bug must not mint a long-lived
 * capability). `params` is the route's `assetId` and `kind` and the query, as the server parsed them.
 */
export function verifyMediaUrl(
  keys: readonly string[],
  params: {
    assetId: string;
    kind: string;
    query: Readonly<Record<string, string | undefined>>;
  },
  now: Date = new Date(),
): MediaVerdict {
  if (keys.length === 0) return { ok: false, reason: 'no media URL key configured' };
  const { ch, v, ct, exp, sig } = params.query;
  if (!ch || !ct || !exp || !sig) return { ok: false, reason: 'incomplete media URL' };
  if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, reason: 'malformed media URL' };
  }
  const grant: MediaGrant = {
    channelId: ch,
    assetId: params.assetId,
    kind: params.kind,
    ...(v !== undefined && v !== '' ? { variant: v } : {}),
    contentType: ct,
    exp: Number(exp),
  };
  const t = Math.floor(now.getTime() / 1000);
  if (grant.exp <= t) return { ok: false, reason: 'media URL expired' };
  if (grant.exp > t + MAX_MEDIA_URL_SECONDS) {
    return { ok: false, reason: 'media URL lives longer than the ceiling' };
  }
  const given = Buffer.from(sig, 'hex');
  for (const key of keys) {
    const expected = Buffer.from(macOf(key, grant), 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return { ok: true, grant };
    }
  }
  return { ok: false, reason: 'bad media URL signature' };
}
