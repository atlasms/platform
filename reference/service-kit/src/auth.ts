import { SignJWT, jwtVerify, generateKeyPair, exportJWK, createLocalJWKSet, type JWTPayload } from 'jose';
import { Unauthorized, Forbidden } from './errors.ts';

// JWT verification via a JWKS (each service validates locally against IAM's public keys — no
// per-request call to IAM). Also test helpers to mint tokens against a locally generated key.
export interface Claims extends JWTPayload { sub?: string; permissions?: string[]; permVersion?: number; channelId?: string; }
export interface VerifyOptions { issuer?: string; audience?: string; }

type JWKS = ReturnType<typeof createLocalJWKSet>;

/** Verify a bearer token against a JWKS; throws Unauthorized on any failure. */
export async function verifyJwt(token: string, jwks: JWKS, opts: VerifyOptions = {}): Promise<Claims> {
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audience });
    return payload as Claims;
  } catch (e: any) {
    throw new Unauthorized(`invalid token: ${e?.code ?? e?.message ?? 'verification failed'}`);
  }
}

/** Enforce a required permission on verified claims. */
export function requirePermission(claims: Claims, permission: string): void {
  if (!claims.permissions?.includes(permission)) throw new Forbidden(`missing permission "${permission}"`);
}

// --- test helpers (also handy for local dev without a real IAM) ---
export interface TestKey { jwks: JWKS; sign: (claims: Claims, opts?: { expiresIn?: string; issuer?: string; audience?: string }) => Promise<string>; }

export async function generateTestKey(kid = 'test-kid'): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Claims, opts: { expiresIn?: string; issuer?: string; audience?: string } = {}) => {
    let t = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt().setExpirationTime(opts.expiresIn ?? '1h');
    if (opts.issuer) t = t.setIssuer(opts.issuer);
    if (opts.audience) t = t.setAudience(opts.audience);
    return t.sign(privateKey);
  };
  return { jwks, sign };
}
