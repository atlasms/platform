// GENERATED FROM docs/architecture/openapi/iam.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: IAM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in iam.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const IamOperations = {
  /** Authenticate; returns access + refresh (or triggers MFA/SSO) */
  login: { method: 'POST', path: '/auth/login', params: [] },
  /** Rotate the refresh token and mint a new access token */
  refresh: { method: 'POST', path: '/auth/refresh', params: [] },
  /** Revoke the refresh-token family */
  logout: { method: 'POST', path: '/auth/logout', params: [] },
  /** Public keys for local JWT validation (served at root, not /api/v1) */
  getJwks: { method: 'GET', path: '/.well-known/jwks.json', params: [] },
  /** The users the caller may administer, by id (keyset) */
  listUsers: { method: 'GET', path: '/api/v1/users', params: [] },
  /** Create a user (user:admin in its channel); emits user.created */
  createUser: { method: 'POST', path: '/api/v1/users', params: [] },
  /** Get a user */
  getUser: { method: 'GET', path: '/api/v1/users/{id}', params: ['id'] },
  /** Update a user's profile, state or password; emits user.updated */
  updateUser: { method: 'PATCH', path: '/api/v1/users/{id}', params: ['id'] },
  /** The user's direct grants — roles by id and inline rules */
  listAssignments: { method: 'GET', path: '/api/v1/users/{id}/assignments', params: ['id'] },
  /** Grant a role or a rule to the user; emits permissions.changed */
  createAssignment: { method: 'POST', path: '/api/v1/users/{id}/assignments', params: ['id'] },
  /** Revoke a grant; emits permissions.changed */
  deleteAssignment: {
    method: 'DELETE',
    path: '/api/v1/users/{id}/assignments/{assignmentId}',
    params: ['id', 'assignmentId'],
  },
  /** The compiled policy (union of user + group rules, flattened through roles, FR-IAM-4) */
  getEffectivePermissions: {
    method: 'GET',
    path: '/api/v1/users/{id}/effective-permissions',
    params: ['id'],
  },
  /** The groups the caller may administer — the channel's, and the platform-wide ones */
  listGroups: { method: 'GET', path: '/api/v1/groups', params: [] },
  /** Create a group */
  createGroup: { method: 'POST', path: '/api/v1/groups', params: [] },
  /** A group, with its members */
  getGroup: { method: 'GET', path: '/api/v1/groups/{id}', params: ['id'] },
  /** Change a group's name, rules or roles; a grant change reaches every member */
  updateGroup: { method: 'PATCH', path: '/api/v1/groups/{id}', params: ['id'] },
  /** Delete a group; every member is removed first (group.membership.changed each) */
  deleteGroup: { method: 'DELETE', path: '/api/v1/groups/{id}', params: ['id'] },
  /** The members' user ids */
  listGroupMembers: { method: 'GET', path: '/api/v1/groups/{id}/members', params: ['id'] },
  /** Add a user to a group; emits group.membership.changed and permissions.changed */
  addGroupMember: { method: 'POST', path: '/api/v1/groups/{id}/members', params: ['id'] },
  /** Remove a user from a group; emits group.membership.changed and permissions.changed */
  removeGroupMember: { method: 'DELETE', path: '/api/v1/groups/{id}/members', params: ['id'] },
  /** The roles the caller may administer — the channel's, and the platform-wide starter roles */
  listRoles: { method: 'GET', path: '/api/v1/roles', params: [] },
  /** Create a role — a named bundle of rules */
  createRole: { method: 'POST', path: '/api/v1/roles', params: [] },
  /** A role */
  getRole: { method: 'GET', path: '/api/v1/roles/{id}', params: ['id'] },
  /** Change a role's name or rules; a rule change reaches every holder, directly or through a group */
  updateRole: { method: 'PATCH', path: '/api/v1/roles/{id}', params: ['id'] },
  /** Delete a role that nothing holds; 409 while an assignment or group still carries it */
  deleteRole: { method: 'DELETE', path: '/api/v1/roles/{id}', params: ['id'] },
} as const;

export type IamOperation = keyof typeof IamOperations;
