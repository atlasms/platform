// GENERATED FROM docs/architecture/openapi/rim.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: RIM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

export type Ulid = string;

export interface IngestJob {
  id: Ulid;
  channelId: string;
  source?: string;
  state: 'detected' | 'validating' | 'rejected' | 'quarantined' | 'accepted' | 'registered';
  sizeBytes?: number;
  assetId?: Ulid;
  reason?: string;
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
