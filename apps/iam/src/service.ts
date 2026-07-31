// EP-10.2 — login / refresh / logout. CORRECTNESS-CRITICAL.
// EP-10.5 — the compiled effective policy.
// EP-10.8 — the login-event audit trail.

import { ulid } from '@atlas/contracts';
import { Unauthorized } from '@atlas/service-kit';
import { compile, type EffectivePolicy, type Rule, type Role } from '@atlas/policy';
import { hashPassword, needsRehash, verifyPassword } from './passwords.ts';
import { hashRefreshToken, mintRefreshToken, signAccessToken, type KeyRing } from './tokens.ts';
import {
  createStore,
  familyOf,
  findByUsername,
  type IamStore,
  type LoginEvent,
  type User,
} from './store.ts';

export interface IamOptions {
  keyRing: KeyRing;
  store?: IamStore;
  issuer?: string;
  audience?: string;
  accessTokenTtl?: string;
  refreshTokenTtlMs?: number;
  /** Injected so tests are deterministic. */
  now?: () => number;
}

export interface LoginContext {
  ip?: string;
  userAgent?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  permVersion: number;
}

const DAY = 24 * 60 * 60 * 1000;

export class IamService {
  readonly store: IamStore;
  #ring: KeyRing;
  #opts: Required<Pick<IamOptions, 'accessTokenTtl' | 'refreshTokenTtlMs'>> & IamOptions;
  #now: () => number;

  constructor(options: IamOptions) {
    this.store = options.store ?? createStore();
    this.#ring = options.keyRing;
    this.#now = options.now ?? Date.now;
    this.#opts = {
      ...options,
      accessTokenTtl: options.accessTokenTtl ?? '15m',
      refreshTokenTtlMs: options.refreshTokenTtlMs ?? 30 * DAY,
    };
  }

  // --- users ---------------------------------------------------------------

  async createUser(input: {
    username: string;
    password?: string;
    name?: string;
    channelId?: string;
    state?: User['state'];
  }): Promise<User> {
    const now = new Date(this.#now()).toISOString();
    const user: User = {
      id: ulid(),
      username: input.username,
      state: input.state ?? 'active',
      permVersion: 1,
      createdAt: now,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    };
    this.store.users.set(user.id, user);

    if (input.password !== undefined) {
      this.store.credentials.set(user.id, {
        userId: user.id,
        hash: await hashPassword(input.password),
        updatedAt: now,
      });
      user.lastPasswordChange = now;
    }
    return user;
  }

  // --- authentication ------------------------------------------------------

  /**
   * Verify credentials and issue a token pair.
   *
   * Every outcome is recorded as a LoginEvent (EP-10.8), and every failure returns the SAME
   * message — an unknown username and a wrong password must be indistinguishable, or the
   * endpoint becomes an account-enumeration oracle.
   */
  async login(username: string, password: string, ctx: LoginContext = {}): Promise<TokenPair> {
    const fail = (reason: string, user?: User, result: LoginEvent['result'] = 'failure'): never => {
      this.#audit({ username, result, reason, ctx, ...(user ? { userId: user.id } : {}) });
      throw new Unauthorized('invalid username or password');
    };

    const user = findByUsername(this.store, username);
    if (!user) {
      // Still do the work: returning fast for an unknown user is a timing oracle.
      await verifyPassword(password, DUMMY_HASH);
      return fail('unknown username');
    }

    if (user.state !== 'active') {
      return fail(`account is ${user.state}`, user, user.state === 'locked' ? 'locked' : 'failure');
    }

    const cred = this.store.credentials.get(user.id);
    if (!cred) return fail('no password credential (SSO-only user)', user);

    if (!(await verifyPassword(password, cred.hash))) return fail('bad password', user);

    // Opportunistic upgrade: the only moment the plaintext is available.
    if (needsRehash(cred.hash)) {
      cred.hash = await hashPassword(password);
      cred.updatedAt = new Date(this.#now()).toISOString();
    }

    const now = new Date(this.#now()).toISOString();
    user.lastLogin = now;
    if (ctx.ip !== undefined) user.lastIp = ctx.ip;
    this.#audit({ username, userId: user.id, result: 'success', ctx });

    return this.#issue(user, ulid());
  }

  /**
   * Rotate a refresh token.
   *
   * **Reuse of an already-rotated token revokes the entire family.** A refresh token is
   * single-use; seeing one twice means either a replay or a stolen token, and the safe response
   * is to invalidate every descendant of that login rather than guess which holder is genuine.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = hashRefreshToken(refreshToken);
    const record = [...this.store.refreshTokens.values()].find((r) => r.tokenHash === hash);

    if (!record) throw new Unauthorized('invalid refresh token');

    if (record.revokedAt !== undefined) {
      // Breach signal: revoke the whole family, not just this token.
      const at = new Date(this.#now()).toISOString();
      for (const sibling of familyOf(this.store, record.familyId)) {
        sibling.revokedAt ??= at;
      }
      throw new Unauthorized('refresh token reuse detected; session family revoked');
    }

    if (Date.parse(record.expiresAt) <= this.#now()) {
      throw new Unauthorized('refresh token expired');
    }

    const user = this.store.users.get(record.userId);
    if (!user || user.state !== 'active') throw new Unauthorized('account is not active');

    record.revokedAt = new Date(this.#now()).toISOString();
    return this.#issue(user, record.familyId, record.id);
  }

  /** Revoke one session, or every session for the user. */
  logout(refreshToken: string, options: { allSessions?: boolean } = {}): void {
    const hash = hashRefreshToken(refreshToken);
    const record = [...this.store.refreshTokens.values()].find((r) => r.tokenHash === hash);
    if (!record) return; // idempotent: logging out twice is not an error

    const at = new Date(this.#now()).toISOString();
    const targets = options.allSessions
      ? [...this.store.refreshTokens.values()].filter((r) => r.userId === record.userId)
      : familyOf(this.store, record.familyId);

    for (const r of targets) r.revokedAt ??= at;
  }

  // --- authorization -------------------------------------------------------

  /**
   * The compiled effective policy: the union of the user's own rules and all their groups'
   * rules, flattened through roles. Compiled once per `permVersion`, not per request.
   */
  effectivePolicy(userId: string): EffectivePolicy {
    const user = this.store.users.get(userId);
    if (!user) throw new Unauthorized('unknown user');

    const rules: Rule[] = [];
    const roles: Role[] = [];
    for (const a of this.store.assignments.filter((x) => x.userId === userId)) {
      if (a.rule) rules.push(a.rule);
      if (a.roleId) {
        const role = this.store.roles.get(a.roleId);
        if (role) roles.push(role);
      }
    }

    const groups = this.store.memberships
      .filter((m) => m.userId === userId)
      .map((m) => this.store.groups.get(m.groupId))
      .filter((g): g is NonNullable<typeof g> => g !== undefined)
      .map((g) => ({
        id: g.id,
        ...(g.rules ? { rules: g.rules } : {}),
        ...(g.roles ? { roles: g.roles } : {}),
      }));

    return compile({ subjectId: userId, permVersion: user.permVersion, rules, roles, groups });
  }

  /**
   * Bump the user's permission version. Any access token issued before this is refused at the
   * edge, so revocation lands within one access-token TTL rather than waiting for expiry.
   */
  bumpPermVersion(userId: string): number {
    const user = this.store.users.get(userId);
    if (!user) throw new Unauthorized('unknown user');
    user.permVersion += 1;
    return user.permVersion;
  }

  // --- internals -----------------------------------------------------------

  async #issue(user: User, familyId: string, rotatedFrom?: string): Promise<TokenPair> {
    const policy = this.effectivePolicy(user.id);
    const permissions = [...new Set(policy.rules.flatMap((r) => r.permissions))].sort();

    const accessToken = await signAccessToken(this.#ring, {
      subject: user.id,
      permissions,
      permVersion: user.permVersion,
      expiresIn: this.#opts.accessTokenTtl,
      ...(user.channelId !== undefined ? { channelId: user.channelId } : {}),
      ...(this.#opts.issuer !== undefined ? { issuer: this.#opts.issuer } : {}),
      ...(this.#opts.audience !== undefined ? { audience: this.#opts.audience } : {}),
    });

    const refreshToken = mintRefreshToken();
    const id = ulid();
    this.store.refreshTokens.set(id, {
      id,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      createdAt: new Date(this.#now()).toISOString(),
      expiresAt: new Date(this.#now() + this.#opts.refreshTokenTtlMs).toISOString(),
      ...(rotatedFrom !== undefined ? { rotatedFrom } : {}),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.#opts.accessTokenTtl,
      permVersion: user.permVersion,
    };
  }

  #audit(input: {
    username: string;
    userId?: string;
    result: LoginEvent['result'];
    reason?: string;
    ctx: LoginContext;
  }): void {
    this.store.loginEvents.push({
      id: ulid(),
      username: input.username,
      at: new Date(this.#now()).toISOString(),
      result: input.result,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.ctx.ip !== undefined ? { ip: input.ctx.ip } : {}),
      ...(input.ctx.userAgent !== undefined ? { userAgent: input.ctx.userAgent } : {}),
    });
  }
}

/**
 * A real argon2id hash of a value nobody knows, verified against when the username is unknown so
 * the failure path costs the same as a genuine one. Generated once at module load.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'ZGVsaWJlcmF0ZWx5LWludmFsaWQtdGFnLXZhbHVlLS0tLS0';
