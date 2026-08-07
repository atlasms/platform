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
  createStore,
  findByUsername,
  familyOf,
  type IamStore,
  type User,
  type UserState,
  type Credential,
  type RefreshTokenRecord,
  type LoginEvent,
  type Group,
  type Membership,
  type Assignment,
} from './store.ts';
