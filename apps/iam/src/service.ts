// EP-10.2 — login / refresh / logout. CORRECTNESS-CRITICAL.
// EP-10.5 — the compiled effective policy.
// EP-10.8 — the login-event audit trail.

import { ulid } from '@atlas/contracts';
import { MetricRegistry, Unauthorized } from '@atlas/service-kit';
import { compile, type EffectivePolicy, type Rule, type Role } from '@atlas/policy';
import { authSignals, type AuthSignals, type LoginOutcome } from './auth-signals.ts';
import {
  clearFailures,
  clearLock,
  DEFAULT_LOCKOUT,
  lockExpired,
  nextFailure,
  type LockoutPolicy,
} from './lockout.ts';
import { hashPassword, needsRehash, verifyPassword } from './passwords.ts';
import { hashRefreshToken, mintRefreshToken, signAccessToken, type KeyRing } from './tokens.ts';
import { sqliteIamStore } from './store-sqlite.ts';
import type { IamStore, IamTx, LoginEvent, User } from './store.ts';

export interface IamOptions {
  keyRing: KeyRing;
  /** `pgIamStore` in production; omitted, an in-memory sqlite double — tests and the walking skeleton. */
  store?: IamStore;
  issuer?: string;
  audience?: string;
  accessTokenTtl?: string;
  refreshTokenTtlMs?: number;
  /**
   * Registry backing `/metrics`. Omit and the service makes its own, which `buildIamApp` then
   * exposes — so metrics cannot be forgotten by leaving a wiring step out. There is exactly ONE
   * place to inject a registry into IAM, and it is here.
   */
  metrics?: MetricRegistry;
  /** Failed-attempt lockout thresholds (#240). Defaults to {@link DEFAULT_LOCKOUT}. */
  lockout?: Partial<LockoutPolicy>;
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
  /** Exposed so `buildIamApp` can serve it — see {@link IamOptions.metrics}. */
  readonly metrics: MetricRegistry;
  #signals: AuthSignals;
  #lockout: LockoutPolicy;
  #ring: KeyRing;
  #opts: Required<Pick<IamOptions, 'accessTokenTtl' | 'refreshTokenTtlMs'>> & IamOptions;
  #now: () => number;

  constructor(options: IamOptions) {
    this.store = options.store ?? sqliteIamStore();
    this.metrics = options.metrics ?? new MetricRegistry();
    this.#signals = authSignals(this.metrics);
    this.#lockout = { ...DEFAULT_LOCKOUT, ...options.lockout };
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
    // The hash is computed before the transaction: argon2 takes ~100 ms and a connection should
    // not be held for it.
    const hash = input.password !== undefined ? await hashPassword(input.password) : undefined;
    if (hash !== undefined) user.lastPasswordChange = now;
    await this.store.transaction(async (tx) => {
      await tx.putUser(user); // a taken username is a Conflict, decided by the store
      if (hash !== undefined) await tx.putCredential({ userId: user.id, hash, updatedAt: now });
    });
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
    // The outcome is passed in at each call site rather than parsed back out of `reason`: `reason`
    // is prose for a human reading the audit trail, `outcome` is a closed label set (#205). Deriving
    // one from the other would make an edit to the wording silently fork a time series.
    const fail = async (
      outcome: LoginOutcome,
      reason: string,
      user?: User,
      result: LoginEvent['result'] = 'failure',
    ): Promise<never> => {
      this.#signals.login(outcome);
      await this.store.transaction((tx) =>
        this.#audit(tx, { username, result, reason, ctx, ...(user ? { userId: user.id } : {}) }),
      );
      throw new Unauthorized('invalid username or password');
    };

    const user = await this.store.userByUsername(username);
    const cred = user ? await this.store.credential(user.id) : undefined;

    // ONE argon2 verification on every path, before any branch — including the ones that will
    // refuse for a reason that has nothing to do with the password.
    //
    // The unknown-user case already did this. The others did not, and they returned in microseconds
    // while a wrong password cost ~100ms, so timing alone said "this account exists and is not
    // active". Lockout turns that from a leak into a tool: an attacker could DELIBERATELY lock an
    // account and then read the timing to confirm the username is real. Same work, every path.
    const passwordOk = await verifyPassword(password, cred?.hash ?? DUMMY_HASH);

    if (!user) return fail('unknown_user', 'unknown username');

    // An automatic lock lifts itself. Checked BEFORE the state test, so the very next attempt after
    // the window is an ordinary login rather than needing an operator (#240). The lift is written
    // with whatever this attempt decides, in the one transaction below.
    if (lockExpired(user, this.#now())) clearLock(user);

    if (user.state !== 'active') {
      // `user.state` is the outcome, narrowed to the non-active states — which is exactly what
      // LoginOutcome accepts, so a new UserState cannot reach here unlabelled.
      return fail(
        user.state,
        `account is ${user.state}`,
        user,
        user.state === 'locked' ? 'locked' : 'failure',
      );
    }

    if (!cred) return fail('no_credential', 'no password credential (SSO-only user)', user);

    if (!passwordOk) {
      // The run and the event, together: a crash between them would either lose a failure the
      // policy should count or record a lock the user record does not show.
      this.#signals.login('bad_password');
      await this.store.transaction(async (tx) => {
        await this.#recordFailure(tx, user);
        await this.#audit(tx, {
          username,
          userId: user.id,
          result: 'failure',
          reason: 'bad password',
          ctx,
        });
      });
      throw new Unauthorized('invalid username or password');
    }

    // Opportunistic upgrade: the only moment the plaintext is available.
    const rehash = needsRehash(cred.hash) ? await hashPassword(password) : undefined;

    const now = new Date(this.#now()).toISOString();
    user.lastLogin = now;
    if (ctx.ip !== undefined) user.lastIp = ctx.ip;
    // A correct password ends the run, however long it had grown. Nine failures then a success
    // must not leave the account one mistake from a lock a week later.
    clearFailures(user);
    this.#signals.login('success');

    // One unit of work: the user record (lock lift, run cleared, last login), the rehash, the
    // event, and the refresh token the pair is minted against.
    return this.store.transaction(async (tx) => {
      await tx.putUser(user);
      if (rehash !== undefined) {
        await tx.putCredential({ userId: user.id, hash: rehash, updatedAt: now });
      }
      await this.#audit(tx, { username, userId: user.id, result: 'success', ctx });
      return this.#issue(tx, user, ulid());
    });
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
    const record = await this.store.refreshTokenByHash(hash);

    if (!record) {
      this.#signals.refresh('unknown_token');
      throw new Unauthorized('invalid refresh token');
    }

    // Breach signal: revoke the whole family, not just this token. Counted by the store, so the
    // metric reports tokens this event actually killed — a second replay of the same token revokes
    // nothing and must not look like a second breach.
    const revokeFamily = async (): Promise<never> => {
      const at = new Date(this.#now()).toISOString();
      const family = await this.store.family(record.familyId);
      const sessions = await this.store.transaction((tx) =>
        tx.revokeTokens(
          family.map((r) => r.id),
          at,
        ),
      );
      this.#signals.refresh('reuse_detected');
      this.#signals.revoked('reuse', sessions);
      throw new Unauthorized('refresh token reuse detected; session family revoked');
    };

    if (record.revokedAt !== undefined) return revokeFamily();

    if (Date.parse(record.expiresAt) <= this.#now()) {
      this.#signals.refresh('expired');
      throw new Unauthorized('refresh token expired');
    }

    const user = await this.store.user(record.userId);
    if (!user || user.state !== 'active') {
      this.#signals.refresh('inactive_account');
      throw new Unauthorized('account is not active');
    }

    // Claim the token by revoking it, and let the database count. Two concurrent refreshes with
    // the same token both read it unrevoked above; only one UPDATE lands, and the other sees 0 —
    // which is a reuse, and is handled as one.
    const pair = await this.store.transaction(async (tx) => {
      const claimed = await tx.revokeTokens([record.id], new Date(this.#now()).toISOString());
      if (claimed === 0) return undefined;
      return this.#issue(tx, user, record.familyId, record.id);
    });
    if (pair === undefined) return revokeFamily();
    this.#signals.refresh('success');
    return pair;
  }

  /**
   * Lift a lock, automatic or administrative, and start the user clean (#240).
   *
   * The escape hatch the time bound is not: an operator must be able to give someone their account
   * back now, and must be able to clear a lock they set themselves for cause.
   */
  async unlock(userId: string): Promise<User> {
    const user = await this.store.user(userId);
    if (!user) throw new Unauthorized('unknown user');
    clearLock(user);
    await this.store.transaction((tx) => tx.putUser(user));
    return user;
  }

  /** Revoke one session, or every session for the user. */
  async logout(refreshToken: string, options: { allSessions?: boolean } = {}): Promise<void> {
    const hash = hashRefreshToken(refreshToken);
    const record = await this.store.refreshTokenByHash(hash);
    if (!record) return; // idempotent: logging out twice is not an error

    const at = new Date(this.#now()).toISOString();
    const targets = options.allSessions
      ? await this.store.userTokens(record.userId)
      : await this.store.family(record.familyId);

    const sessions = await this.store.transaction((tx) =>
      tx.revokeTokens(
        targets.map((r) => r.id),
        at,
      ),
    );
    // Logging out twice is idempotent, so the second call revokes nothing and records nothing.
    this.#signals.revoked('logout', sessions);
  }

  // --- authorization -------------------------------------------------------

  /**
   * The compiled effective policy: the union of the user's own rules and all their groups'
   * rules, flattened through roles. Compiled once per `permVersion`, not per request.
   */
  async effectivePolicy(userId: string): Promise<EffectivePolicy> {
    const user = await this.store.user(userId);
    if (!user) throw new Unauthorized('unknown user');
    return this.#compile(user);
  }

  async #compile(user: User): Promise<EffectivePolicy> {
    const roleById = new Map((await this.store.roles()).map((r) => [r.id, r]));
    const rules: Rule[] = [];
    const roles: Role[] = [];
    for (const a of await this.store.assignments(user.id)) {
      if (a.rule) rules.push(a.rule);
      if (a.roleId) {
        const role = roleById.get(a.roleId);
        if (role) roles.push(role);
      }
    }

    const groups: { id: string; rules?: Rule[]; roles?: Role[] }[] = [];
    for (const m of await this.store.memberships(user.id)) {
      const g = await this.store.group(m.groupId);
      if (!g) continue;
      const groupRoles = (g.roleIds ?? [])
        .map((id) => roleById.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
      groups.push({
        id: g.id,
        ...(g.rules ? { rules: g.rules } : {}),
        ...(groupRoles.length > 0 ? { roles: groupRoles } : {}),
      });
    }

    const started = performance.now();
    const policy = compile({
      subjectId: user.id,
      permVersion: user.permVersion,
      rules,
      roles,
      groups,
    });
    this.#signals.policyCompiled((performance.now() - started) / 1000);
    return policy;
  }

  /**
   * Bump the user's permission version. Any access token issued before this is refused at the
   * edge, so revocation lands within one access-token TTL rather than waiting for expiry.
   */
  async bumpPermVersion(userId: string): Promise<number> {
    const user = await this.store.user(userId);
    if (!user) throw new Unauthorized('unknown user');
    user.permVersion += 1;
    await this.store.transaction((tx) => tx.putUser(user));
    return user.permVersion;
  }

  // --- internals -----------------------------------------------------------

  async #issue(tx: IamTx, user: User, familyId: string, rotatedFrom?: string): Promise<TokenPair> {
    const policy = await this.#compile(user);
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
    await tx.putRefreshToken({
      id,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      createdAt: new Date(this.#now()).toISOString(),
      expiresAt: new Date(this.#now() + this.#opts.refreshTokenTtlMs).toISOString(),
      ...(rotatedFrom !== undefined ? { rotatedFrom } : {}),
    });

    // Both grants land here, and `rotatedFrom` is what distinguishes them — a rotation always
    // names the token it replaced. Recorded after the store write, so the count is of pairs that
    // actually exist rather than of attempts.
    this.#signals.issued(rotatedFrom === undefined ? 'password' : 'refresh');

    return {
      accessToken,
      refreshToken,
      expiresIn: this.#opts.accessTokenTtl,
      permVersion: user.permVersion,
    };
  }

  /**
   * Fold one wrong password into the user's run, and lock the account if it trips the threshold.
   *
   * The attempt that trips it is still reported as `bad_password` — that is what happened, and the
   * lock applies from the NEXT attempt. Reporting it as `locked` would make the two counters
   * double-count one event and would tell the attacker precisely which guess closed the door.
   */
  async #recordFailure(tx: IamTx, user: User): Promise<void> {
    const now = this.#now();
    const next = nextFailure(user, now, this.#lockout);
    user.failedAttempts = next.failedAttempts;
    user.firstFailedAt = next.firstFailedAt;
    if (next.locked) {
      user.state = 'locked';
      user.lockedUntil = new Date(now + this.#lockout.durationMs).toISOString();
    }
    await tx.putUser(user);
    if (!next.locked) return;

    this.#signals.lockedOut();
    await this.#audit(tx, {
      username: user.username,
      userId: user.id,
      result: 'locked',
      reason: `locked after ${next.failedAttempts} consecutive failures, until ${user.lockedUntil}`,
      ctx: {},
    });
  }

  #audit(
    tx: IamTx,
    input: {
      username: string;
      userId?: string;
      result: LoginEvent['result'];
      reason?: string;
      ctx: LoginContext;
    },
  ): Promise<void> {
    return tx.appendLoginEvent({
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
