import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { IngestJob, IngestQueuePage } from './generated/rim.types.ts';
import { RimOperations as ops } from './generated/rim.operations.ts';

/**
 * RIM reads, through the gateway (EP-20.3; the service is EP-15.1/15.3/15.6).
 *
 * Types and operations come from `generated/` — projected from `docs/architecture/openapi/rim.yaml`.
 */
export interface IngestListOptions {
  limit?: number;
  /** The last id already seen — keyset, like every list here. */
  cursor?: string;
  /** Only jobs in this state; `quarantined` is the review queue. */
  state?: IngestJob['state'];
}

@Injectable({ providedIn: 'root' })
export class IngestService {
  private readonly api = inject(ApiClient);

  /** The Ingest/Import page listing — one page, newest first. */
  list(options: IngestListOptions = {}) {
    return this.api.call(ops.getIngestQueue, { query: { ...options } }).as<IngestQueuePage>();
  }

  /** One job — what an uploader polls after completing, until the rules have decided. */
  get(id: string) {
    return this.api.call(ops.getIngestJob, { params: { id } }).as<IngestJob>();
  }

  /** Accept a quarantined job (operator override). */
  accept(id: string) {
    return this.api.call(ops.acceptIngest, { params: { id }, body: {} }).as<IngestJob>();
  }

  /** Reject a quarantined job. */
  reject(id: string, reason: string) {
    return this.api.call(ops.rejectIngest, { params: { id }, body: { reason } }).as<IngestJob>();
  }
}
