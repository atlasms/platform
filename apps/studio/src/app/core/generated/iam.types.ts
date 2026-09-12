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

/** RFC 9457 Problem Details, served as application/problem+json, with the platform's keys kept: `code` is the machine key (a closed enum — VALIDATION, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, PAYLOAD_TOO_LARGE, RATE_LIMITED, INTERNAL), `message` the text. The RFC members are derived from them: `type` is https://atlas.example/problems/<code>, `title` is constant per code, `detail` equals `message`, `instance` is urn:atlas:correlation:<correlationId>. */
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
    | 'INTERNAL';
  message: string;
  details?: unknown;
  correlationId?: string;
}
