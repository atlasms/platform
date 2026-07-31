// EP-10.1 — password hashing. CORRECTNESS-CRITICAL.
//
// argon2id via Node's built-in crypto.argon2 (Node 24+), so there is no native dependency to
// build and nothing to keep patched. Parameters follow the OWASP argon2id recommendation
// (19 MiB, t=2, p=1), which is the "second choice" profile sized for interactive logins.

import * as nodeCrypto from 'node:crypto';

const { randomBytes, timingSafeEqual } = nodeCrypto;

// crypto.argon2 exists in the Node 24 runtime but is not yet in @types/node. Declared here
// rather than reached for with `any`, so the call site stays fully typed and this shim can be
// deleted the moment the types land.
interface Argon2Options {
  message: Buffer;
  nonce: Buffer;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
  secret?: Buffer;
  associatedData?: Buffer;
}
type Argon2Fn = (
  algorithm: 'argon2d' | 'argon2i' | 'argon2id',
  options: Argon2Options,
  callback: (err: Error | null, tag: Buffer) => void,
) => void;

const maybeArgon2 = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;
if (typeof maybeArgon2 !== 'function') {
  // Fail at load, loudly. A silent fallback to a weaker KDF would be far worse than not starting.
  throw new Error(
    'node:crypto.argon2 is unavailable — Atlas requires Node >= 24 for built-in argon2id ' +
      '(see package.json engines).',
  );
}
const argon2: Argon2Fn = maybeArgon2;

export interface Argon2Params {
  memory: number; // KiB
  passes: number;
  parallelism: number;
  tagLength: number;
}

/** OWASP-recommended argon2id profile: 19 MiB, t=2, p=1. */
export const DEFAULT_PARAMS: Argon2Params = {
  memory: 19456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
};

const NONCE_BYTES = 16;

/**
 * Encoded as `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>` — the PHC string format.
 *
 * The parameters travel WITH the hash, so raising the cost later does not invalidate existing
 * credentials: an old hash still verifies against its own parameters, and `needsRehash` tells
 * you to upgrade it on the next successful login.
 */
export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_PARAMS,
): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES);
  const tag = await argon2Async(password, nonce, params);
  const p = params;
  return [
    '',
    'argon2id',
    'v=19',
    `m=${p.memory},t=${p.passes},p=${p.parallelism}`,
    nonce.toString('base64url'),
    tag.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against an encoded hash.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupt row must fail the
 * login, not 500 the auth endpoint (which would leak that the account exists).
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseEncoded(encoded);
  if (!parsed) return false;

  const computed = await argon2Async(password, parsed.nonce, parsed.params);
  if (computed.length !== parsed.tag.length) return false;
  return timingSafeEqual(computed, parsed.tag);
}

/** True when the stored hash used weaker parameters than we now require. */
export function needsRehash(encoded: string, params: Argon2Params = DEFAULT_PARAMS): boolean {
  const parsed = parseEncoded(encoded);
  if (!parsed) return true;
  return (
    parsed.params.memory < params.memory ||
    parsed.params.passes < params.passes ||
    parsed.params.parallelism !== params.parallelism
  );
}

// --- internals -------------------------------------------------------------

function argon2Async(password: string, nonce: Buffer, params: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce,
        parallelism: params.parallelism,
        tagLength: params.tagLength,
        memory: params.memory,
        passes: params.passes,
      },
      (err: Error | null, tag: Buffer) => (err ? reject(err) : resolve(tag)),
    );
  });
}

interface Parsed {
  params: Argon2Params;
  nonce: Buffer;
  tag: Buffer;
}

function parseEncoded(encoded: string): Parsed | undefined {
  const parts = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, hash]
  if (parts.length !== 6 || parts[1] !== 'argon2id') return undefined;

  const m = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3] ?? '');
  if (!m) return undefined;

  try {
    const nonce = Buffer.from(parts[4] ?? '', 'base64url');
    const tag = Buffer.from(parts[5] ?? '', 'base64url');
    if (nonce.length === 0 || tag.length === 0) return undefined;
    return {
      params: {
        memory: Number(m[1]),
        passes: Number(m[2]),
        parallelism: Number(m[3]),
        tagLength: tag.length,
      },
      nonce,
      tag,
    };
  } catch {
    return undefined;
  }
}
