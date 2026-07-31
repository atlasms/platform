// EP-10.3 — signing keys and the JWKS. Services verify tokens LOCALLY against these public
// keys; nothing calls IAM per request (authorization-model.md §6).

import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from 'jose';
import type { Claims } from '@atlas/service-kit';

export interface SigningKey {
  kid: string;
  publicJwk: JWK;
  privateKey: KeyObject;
  createdAt: string;
  /** Retired keys still publish their public half so tokens they signed stay verifiable. */
  retired?: boolean;
}

/**
 * Holds the signing keys and serves the JWKS.
 *
 * **Rotation keeps the old public key published.** Dropping it immediately would invalidate
 * every access token already in flight — a rotation should never look like a mass logout.
 */
export class KeyRing {
  #keys: SigningKey[] = [];

  get active(): SigningKey {
    const k = this.#keys.find((x) => !x.retired);
    if (!k) throw new Error('key ring has no active signing key');
    return k;
  }

  /** Every key still trusted for verification, newest first. */
  get all(): readonly SigningKey[] {
    return this.#keys;
  }

  static async create(kid = `k-${Date.now()}`): Promise<KeyRing> {
    const ring = new KeyRing();
    await ring.rotate(kid);
    return ring;
  }

  /** Generate a new active key; the previous one is retired but still published. */
  async rotate(kid = `k-${Date.now()}`): Promise<SigningKey> {
    for (const k of this.#keys) k.retired = true;
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const key: SigningKey = {
      kid,
      publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
      privateKey: privateKey as KeyObject,
      createdAt: new Date().toISOString(),
    };
    this.#keys.unshift(key);
    return key;
  }

  /** Stop publishing a key entirely — only once no live token can have been signed by it. */
  drop(kid: string): void {
    this.#keys = this.#keys.filter((k) => k.kid !== kid);
  }

  /** The document served at /.well-known/jwks.json. Public halves only. */
  jwks(): { keys: JWK[] } {
    return { keys: this.#keys.map((k) => k.publicJwk) };
  }
}

export interface AccessTokenInput {
  subject: string;
  channelId?: string;
  permissions: string[];
  /** Bumped on any grant change; a token below the current version is refused at the edge. */
  permVersion: number;
  expiresIn?: string;
  issuer?: string;
  audience?: string;
}

/**
 * Mint an access token.
 *
 * **The token carries `permVersion`, not the rules.** Grants are fetched once per version from
 * `/users/me/effective-permissions` and cached — keeping the JWT small and revocation cheap
 * (authorization-model.md §6).
 */
export async function signAccessToken(ring: KeyRing, input: AccessTokenInput): Promise<string> {
  const key = ring.active;
  const claims: Claims = {
    sub: input.subject,
    permissions: input.permissions,
    permVersion: input.permVersion,
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
  };

  let jwt = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuedAt()
    .setSubject(input.subject)
    .setExpirationTime(input.expiresIn ?? '15m');

  if (input.issuer !== undefined) jwt = jwt.setIssuer(input.issuer);
  if (input.audience !== undefined) jwt = jwt.setAudience(input.audience);

  return jwt.sign(key.privateKey);
}

/** Refresh tokens are opaque random strings — never JWTs, so they carry no readable claims. */
export function mintRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the HASH of a refresh token is stored. A database dump must not yield usable tokens.
 * SHA-256 is right here (unlike for passwords): the input is already 256 bits of entropy, so
 * there is nothing to brute-force and no need for a slow KDF.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
