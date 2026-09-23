// GENERATED FROM docs/architecture/openapi/iam.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: IAM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

/** Who a role reaches. `groups` are the groups that carry it; `users` is every person it reaches, whether by their own grant, through a group, or both — flattened, because the question "who gets this rule change" has one answer per person, not one per path. */
export interface RoleHolders {
  users: { id: Ulid; username: string; assignmentId?: string; viaGroupIds?: string[] }[];
  groups: { id: Ulid; name: string }[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime, e.g. "15m". */
  expiresIn: string;
  permVersion: number;
}

/** common.schema.json#/$defs/UserState. `locked` is the lockout policy's, `invited` the invitation flow's; an admin sets only active or disabled. */
export type UserState = 'active' | 'disabled' | 'locked' | 'invited';

export interface User {
  id: Ulid;
  /** Absent for a platform-wide account. */
  channelId?: string;
  username: string;
  name?: string;
  state: UserState;
  /** Bumped on ANY change to what the user may do; tokens below it are refused at the edge. */
  permVersion: number;
  /** Bumped on every write to the record; the audit revision. */
  version: number;
  lastPasswordChange?: string;
  lastLogin?: string;
  lastIp?: string;
  createdAt: string;
}

export interface UserPage {
  items: User[];
  nextCursor?: Ulid;
}

export interface CreateUser {
  username: string;
  /** Omit for an SSO-only account. */
  password?: string;
  name?: string;
  /** Defaults to the caller's channel. Null for platform-wide, which needs an unscoped user:admin. */
  channelId?: string | null;
  state?: 'active' | 'invited';
}

export interface UpdateUser {
  name?: string;
  state?: 'active' | 'disabled';
  password?: string;
}

/** policy-rule.schema.json#/properties/scope — an OMITTED predicate means any. */
export interface Scope {
  channelIds?: string[];
  categoryPaths?: string[];
  states?: string[];
  ownedOnly?: boolean;
}

/** The atomic grant — policy-rule.schema.json, which is what @atlas/policy evaluates. */
export interface Rule {
  id: string;
  description?: string;
  effect?: 'allow' | 'deny';
  permissions: string[];
  scope?: Scope;
  fieldGroups?: string[];
}

export interface Role {
  id: string;
  /** Absent for a platform-wide role (the starter roles). */
  channelId?: string;
  name?: string;
  description?: string;
  rules: Rule[];
  version: number;
}

export interface RoleInput {
  /** Chosen on create (kebab-case); minted when omitted. Ignored on update. */
  id?: string;
  /** On create only. Defaults to the caller's channel; null is platform-wide. */
  channelId?: string | null;
  name?: string;
  description?: string;
  rules?: Rule[];
}

export interface Group {
  /** Minted by IAM — it travels in group.membership.changed. */
  id: Ulid;
  channelId?: string;
  name: string;
  description?: string;
  rules?: Rule[];
  /** Roles by id — editing the role edits it for every group carrying it. */
  roleIds?: string[];
  version: number;
}

export type GroupWithMembers = Group & { members: Ulid[] };

export interface GroupInput {
  /** On create only. */
  channelId?: string | null;
  name?: string;
  description?: string;
  rules?: Rule[];
  roleIds?: string[];
}

/** One direct grant to one user: a role by id OR an inline rule, never both. */
export interface Assignment {
  id: string;
  userId: Ulid;
  roleId?: string;
  rule?: Rule;
}

export interface AssignmentInput {
  roleId?: string;
  rule?: Rule;
}

/** What @atlas/policy compiles and evaluates; cached by consumers against permVersion. */
export interface EffectivePolicy {
  subjectId: Ulid;
  permVersion: number;
  rules: Rule[];
}

/** RFC 9457 Problem Details, served as application/problem+json, with the platform's keys kept: `code` is the machine key (a closed enum — VALIDATION, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, PAYLOAD_TOO_LARGE, RATE_LIMITED, UNAVAILABLE, INTERNAL), `message` the text. The RFC members are derived from them: `type` is https://atlas.example/problems/<code>, `title` is constant per code, `detail` equals `message`, `instance` is urn:atlas:correlation:<correlationId>. */
export interface Error {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code:
    | 'VALIDATION'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PAYLOAD_TOO_LARGE'
    | 'RATE_LIMITED'
    | 'UNAVAILABLE'
    | 'INTERNAL';
  message: string;
  details?: unknown;
  correlationId?: string;
}
