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

export interface Error {
  code: string;
  message: string;
  correlationId?: string;
}
