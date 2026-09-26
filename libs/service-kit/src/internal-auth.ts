// Signed internal requests (ADR-0008): how a service's own components call each other — RIM's
// recorder worker handing a file to RIM — without a user token and without the gateway.
//
//   x-atlas-internal: v1,t=<unix seconds>,sig=<hex HMAC-SHA256(key, METHOD\nPATH\nT\nSHA256(BODY))>
//
// The path includes the query string; the body is hashed as the bytes sent. A signature is valid
// within `skewSeconds` of the verifier's clock, under any key it holds (so a key rotates: add the
// new one to every verifier, then sign with it, then drop the old). Replay inside the window is
// tolerated because every internal operation is idempotent — see the ADR.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_SIGNATURE_HEADER = 'x-atlas-internal';
export const DEFAULT_INTERNAL_SKEW_SECONDS = 60;
/** 32 bytes: an HMAC-SHA256 key shorter than its output is weaker than it looks. */
export const MIN_INTERNAL_KEY_BYTES = 32;

export interface InternalRequest {
  method: string;
  /** Path and query, as sent: `/internal/v1/uploads/01H…/parts/2`. */
  path: string;
  body?: Uint8Array | string;
}

const bodyHash = (body: Uint8Array | string | undefined): string =>
  createHash('sha256')
    .update(body ?? '')
    .digest('hex');

const mac = (key: string, req: InternalRequest, t: number): string =>
  createHmac('sha256', key)
    .update(`${req.method.toUpperCase()}\n${req.path}\n${t}\n${bodyHash(req.body)}`)
    .digest('hex');

/** Keys from config: comma-separated, each at least 32 bytes. The first one signs. */
export function internalKeys(raw: string): string[] {
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of keys) {
    if (Buffer.byteLength(k) < MIN_INTERNAL_KEY_BYTES) {
      // The key itself is never in the message: it would land in a log.
      throw new Error(`an internal signing key is shorter than ${MIN_INTERNAL_KEY_BYTES} bytes`);
    }
  }
  return keys;
}

/** The header value for a request, signed with `key` at `now`. */
export function signInternal(key: string, req: InternalRequest, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `v1,t=${t},sig=${mac(key, req, t)}`;
}

export type InternalVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether `header` is a valid signature of `req` under one of `keys`. The reason on a refusal is
 * for the service's log, never for the response — a caller that is not ours learns nothing.
 */
export function verifyInternal(
  keys: readonly string[],
  req: InternalRequest,
  header: string | undefined,
  now: Date = new Date(),
  skewSeconds = DEFAULT_INTERNAL_SKEW_SECONDS,
): InternalVerdict {
  if (keys.length === 0) return { ok: false, reason: 'no internal key configured' };
  if (!header) return { ok: false, reason: 'unsigned' };
  const m = /^v1,t=(\d{1,12}),sig=([0-9a-f]{64})$/.exec(header);
  if (!m) return { ok: false, reason: 'malformed signature' };
  const t = Number(m[1]);
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > skewSeconds) {
    return { ok: false, reason: 'signature outside the time window' };
  }
  const given = Buffer.from(m[2]!, 'hex');
  for (const key of keys) {
    const expected = Buffer.from(mac(key, req, t), 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true };
  }
  return { ok: false, reason: 'bad signature' };
}
