// In-memory stores behind narrow interfaces. The relational implementation lands with the data
// plane (EP-07.4); everything above this file is written against the interfaces, so swapping the
// backing store is not a rewrite of the auth logic.

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

export interface Group {
  id: string;
  name: string;
  rules?: Rule[];
  roles?: Role[];
}

export interface Assignment {
  userId: string;
  roleId?: string;
  rule?: Rule;
}

/** Everything IAM persists. One interface so the relational swap is mechanical. */
export interface IamStore {
  users: Map<string, User>;
  credentials: Map<string, Credential>;
  refreshTokens: Map<string, RefreshTokenRecord>;
  loginEvents: LoginEvent[];
  groups: Map<string, Group>;
  memberships: Membership[];
  roles: Map<string, Role>;
  assignments: Assignment[];
}

export function createStore(): IamStore {
  return {
    users: new Map(),
    credentials: new Map(),
    refreshTokens: new Map(),
    loginEvents: [],
    groups: new Map(),
    memberships: [],
    roles: new Map(),
    assignments: [],
  };
}

export function findByUsername(store: IamStore, username: string): User | undefined {
  for (const u of store.users.values()) if (u.username === username) return u;
  return undefined;
}

/** All refresh-token records in one family — used to revoke on reuse. */
export function familyOf(store: IamStore, familyId: string): RefreshTokenRecord[] {
  return [...store.refreshTokens.values()].filter((r) => r.familyId === familyId);
}
