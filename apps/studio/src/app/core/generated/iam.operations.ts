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
  /** List users (scope-filtered) */
  listUsers: { method: 'GET', path: '/api/v1/users', params: [] },
  /** Create a user (admin scope) */
  createUser: { method: 'POST', path: '/api/v1/users', params: [] },
  /** Get a user */
  getUser: { method: 'GET', path: '/api/v1/users/{id}', params: ['id'] },
  /** Update a user */
  updateUser: { method: 'PATCH', path: '/api/v1/users/{id}', params: ['id'] },
  /** Delete a user */
  deleteUser: { method: 'DELETE', path: '/api/v1/users/{id}', params: ['id'] },
  /** Add a user to a group */
  addGroupMember: { method: 'POST', path: '/api/v1/groups/{id}/members', params: ['id'] },
  /** Remove a user from a group */
  removeGroupMember: { method: 'DELETE', path: '/api/v1/groups/{id}/members', params: ['id'] },
  /** Resolved permission set (union of user + group rules, FR-IAM-4) */
  getEffectivePermissions: {
    method: 'GET',
    path: '/api/v1/users/{id}/effective-permissions',
    params: ['id'],
  },
} as const;

export type IamOperation = keyof typeof IamOperations;
