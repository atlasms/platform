// GENERATED FROM docs/architecture/openapi/iam.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: IAM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime, e.g. "15m". */
  expiresIn: string;
  permVersion: number;
}

export interface User {
  id: Ulid;
  login: string;
  displayName?: string;
  channelIds?: string[];
  status?: 'active' | 'disabled';
  mfaEnrolled?: boolean;
}

export interface PermissionRule {
  action: string;
  resourceType: string;
  /** channel/department/resource selector */
  scope?: string;
}

export interface Error {
  code: string;
  message: string;
  correlationId?: string;
}
