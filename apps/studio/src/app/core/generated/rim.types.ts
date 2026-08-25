// GENERATED FROM docs/architecture/openapi/rim.yaml — DO NOT EDIT.
export type Ulid = string;

export interface IngestJob {
  id: Ulid;
  channelId: string;
  source: string;
  state: 'detected' | 'validating' | 'rejected' | 'quarantined' | 'accepted' | 'registered';
  sizeBytes: number;
  assetId?: Ulid;
  reason?: string;
}

export interface Error {
  code: string;
  message: string;
  correlationId?: string;
}
