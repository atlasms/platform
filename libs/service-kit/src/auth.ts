import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  createRemoteJWKSet,
  type JWTPayload,
} from 'jose';
import { Unauthorized, Forbidden } from './errors.ts';

// JWT verification via a JWKS (each service validates locally against IAM's public keys — no
// per-request call to IAM). Also test helpers to mint tokens against a locally generated key.
export interface Claims extends JWTPayload {
  sub?: string;
  permissions?: string[];
  permVersion?: number;
  channelId?: string;
}
export interface VerifyOptions {
  issuer?: string;
  audience?: string;
}

/**
 * A key resolver. Local for tests and for a key set held in config; **remote for production**,
 * where services fetch IAM's JWKS so a key rotation propagates without redeploying anything.
 *
 * Both are just resolver functions to `jwtVerify`, but their types differ — a local set carries
 * its `jwks` payload — so the union is what lets one `verifyJwt` serve both.
 */
export type JWKS = ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;

/**
 * Fetch and cache a JWKS from a URL.
 *
 * `jose` caches the key set and refetches only when it sees an unknown `kid`, with its own
 * cooldown — so this is not a per-request call to IAM, and a rotated key is picked up on the
 * first token that needs it.
 */
export function remoteJwks(url: URL | string): JWKS {
  return createRemoteJWKSet(typeof url === 'string' ? new URL(url) : url);
}

/** Verify a bearer token against a JWKS; throws Unauthorized on any failure. */
export async function verifyJwt(
  token: string,
  jwks: JWKS,
  opts: VerifyOptions = {},
): Promise<Claims> {
  try {
    // Omit rather than pass undefined — jose's options are exact-optional, and an explicit
    // `issuer: undefined` is not the same as "do not check the issuer".
    const { payload } = await jwtVerify(token, jwks, {
      ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    });
    return payload as Claims;
  } catch (e: unknown) {
    const reason =
      (e as { code?: string } | undefined)?.code ??
      (e instanceof Error ? e.message : undefined) ??
      'verification failed';
    throw new Unauthorized(`invalid token: ${reason}`);
  }
}

/** Enforce a required permission on verified claims. */
export function requirePermission(claims: Claims, permission: string): void {
  if (!claims.permissions?.includes(permission))
    throw new Forbidden(`missing permission "${permission}"`);
}

// --- test helpers (also handy for local dev without a real IAM) ---
export interface TestKey {
  jwks: JWKS;
  sign: (
    claims: Claims,
    opts?: { expiresIn?: string; issuer?: string; audience?: string },
  ) => Promise<string>;
}

export async function generateTestKey(kid = 'test-kid'): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (
    claims: Claims,
    opts: { expiresIn?: string; issuer?: string; audience?: string } = {},
  ) => {
    let t = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '1h');
    if (opts.issuer) t = t.setIssuer(opts.issuer);
    if (opts.audience) t = t.setAudience(opts.audience);
    return t.sign(privateKey);
  };
  return { jwks, sign };
}
