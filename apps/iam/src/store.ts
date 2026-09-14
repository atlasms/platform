// The identity store: a port with two adapters — node:sqlite for tests, Postgres in production —
// held to one conformance suite (store-conformance.ts), the shape every service here uses.
//
// IAM was in-memory Maps until EP-10.4, "until the data plane lands". It landed; and a store that
// forgets every user, grant and session on restart is not one an admin API can be built on. The
// port is narrow on purpose: the service reads by key and writes whole records inside ONE unit of
// work per operation, so the login path — verify, rehash, record the event, mint the token — is
// atomic on Postgres exactly as it was on a single-threaded Map.

import type { OutboxRecord } from '@atlas/messaging';
import type { Rule, Role } from '@atlas/policy';

export type UserState = 'active' | 'disabled' | 'locked' | 'invited';

export interface User {
  id: string;
  channelId?: string;
  username: string;
  name?: string;
  state: UserState;
  /** Bumped on ANY grant or membership change (authorization-model.md §6). */
  permVersion: number;
  /** Bumped on every write to the record; the audit revision. Distinct from `permVersion`. */
  version: number;
  lastPasswordChange?: string;
  lastLogin?: string;
  lastIp?: string;
  createdAt: string;
  /** Consecutive failed logins in the current run — see lockout.ts (#240). */
  failedAttempts?: number;
  /** When the current run of failures began; a run older than the window is stale. */
  firstFailedAt?: string;
  /**
   * When an AUTOMATIC lock lifts. Absent on an administrative lock, which never expires — that
   * distinction is what stops the clock from undoing an operator's decision.
   */
  lockedUntil?: string;
}

export interface Credential {
  userId: string;
  /** PHC-encoded argon2id. Absent for pure-SSO users. */
  hash: string;
  updatedAt: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  /** Only the hash is stored. */
  tokenHash: string;
  /** All descendants of one login share a family; reuse revokes the whole family. */
  familyId: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  rotatedFrom?: string;
}

export interface LoginEvent {
  id: string;
  userId?: string;
  username: string;
  at: string;
  ip?: string;
  userAgent?: string;
  result: 'success' | 'failure' | 'locked';
  reason?: string;
}

export interface Membership {
  userId: string;
  groupId: string;
}

/**
 * A group: a named set of users that share rules and roles (authorization-model.md §3). Roles are
 * held BY ID — a role edited once is edited for every group that carries it, which is what a
 * named bundle is for. `channelId` absent means platform-wide.
 */
export interface Group {
  id: string;
  channelId?: string;
  name: string;
  description?: string;
  rules?: Rule[];
  roleIds?: string[];
  version: number;
}

/** A role as stored: the policy library's `Role`, plus where it belongs. */
export interface StoredRole extends Role {
  channelId?: string;
  description?: string;
  version: number;
}

/** One grant to one user: a role by id, OR a rule inline. Addressable, so it can be revoked. */
export interface Assignment {
  id: string;
  userId: string;
  roleId?: string;
  rule?: Rule;
}

export interface IamStore {
  /** The unit of work. Every mutation the service makes for one operation happens inside ONE. */
  transaction<T>(fn: (tx: IamTx) => Promise<T>): Promise<T>;

  user(id: string): Promise<User | undefined>;
  userByUsername(username: string): Promise<User | undefined>;
  /** A page of users, by id; `channelId` narrows. */
  users(options?: { channelId?: string; after?: string; limit?: number }): Promise<User[]>;
  credential(userId: string): Promise<Credential | undefined>;

  refreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  /** Every record in one family — what reuse revokes. */
  family(familyId: string): Promise<RefreshTokenRecord[]>;
  /** Every record a user holds — what "sign out everywhere" revokes. */
  userTokens(userId: string): Promise<RefreshTokenRecord[]>;

  /** Newest first. */
  loginEvents(options?: {
    userId?: string;
    username?: string;
    limit?: number;
  }): Promise<LoginEvent[]>;

  group(id: string): Promise<Group | undefined>;
  groups(options?: { channelId?: string }): Promise<Group[]>;
  memberships(userId: string): Promise<Membership[]>;
  members(groupId: string): Promise<Membership[]>;
  role(id: string): Promise<StoredRole | undefined>;
  roles(options?: { channelId?: string }): Promise<StoredRole[]>;
  assignments(userId: string): Promise<Assignment[]>;

  close(): Promise<void>;
}

export interface IamTx {
  /** Insert or replace, whole record. A username already taken by ANOTHER user is a Conflict. */
  putUser(user: User): Promise<void>;
  deleteUser(id: string): Promise<void>;
  putCredential(credential: Credential): Promise<void>;
  putRefreshToken(record: RefreshTokenRecord): Promise<void>;
  /**
   * Revoke the tokens that are not yet revoked, and say how many that was. The count is the
   * point: two callers racing to rotate the same token both see it unrevoked, and only the one the
   * database lets through gets 1 — the other gets 0 and must treat that as a reuse. A read-then-
   * write in application code cannot make that promise; a single UPDATE … WHERE revoked_at IS NULL
   * can.
   */
  revokeTokens(ids: string[], at: string): Promise<number>;
  appendLoginEvent(event: LoginEvent): Promise<void>;

  putGroup(group: Group): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  putMembership(membership: Membership): Promise<void>;
  deleteMembership(membership: Membership): Promise<void>;
  putRole(role: StoredRole): Promise<void>;
  deleteRole(id: string): Promise<void>;
  putAssignment(assignment: Assignment): Promise<void>;
  deleteAssignment(id: string): Promise<void>;

  /** The outbox, in this transaction (EP-10.6): `permissions.changed` rides out with the grant. */
  enqueue(record: OutboxRecord): Promise<void>;
}
