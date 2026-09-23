export { IamService, type IamOptions, type TokenPair, type LoginContext } from './service.ts';
export {
  clearFailures,
  clearLock,
  lockExpired,
  nextFailure,
  DEFAULT_LOCKOUT,
  type FailureState,
  type LockoutPolicy,
} from './lockout.ts';
export {
  authSignals,
  type AuthSignals,
  type Grant,
  type LoginOutcome,
  type RefreshOutcome,
  type RevocationReason,
} from './auth-signals.ts';
export { buildIamApp, type IamAppOptions } from './app.ts';
export {
  IamAdmin,
  parseRule,
  PLATFORM,
  type AdminCaller,
  type IamAdminOptions,
  type CreateUserInput,
  type UpdateUserInput,
  type RoleInput,
  type GroupInput,
  type AssignmentInput,
  type RoleHolders,
} from './admin.ts';
export {
  KeyRing,
  signAccessToken,
  mintRefreshToken,
  hashRefreshToken,
  type SigningKey,
  type AccessTokenInput,
} from './tokens.ts';
export {
  hashPassword,
  verifyPassword,
  needsRehash,
  DEFAULT_PARAMS,
  type Argon2Params,
} from './passwords.ts';
export { STARTER_ROLES, seedStarterRoles } from './roles.ts';
export {
  type IamStore,
  type IamTx,
  type User,
  type UserState,
  type Credential,
  type RefreshTokenRecord,
  type LoginEvent,
  type Group,
  type StoredRole,
  type Membership,
  type Assignment,
} from './store.ts';
export { sqliteIamStore, sqliteMigrations } from './store-sqlite.ts';
export { pgIamStore, pgMigrations } from './store-pg.ts';
export { iamStoreConformance, type IamStoreHarness } from './store-conformance.ts';
