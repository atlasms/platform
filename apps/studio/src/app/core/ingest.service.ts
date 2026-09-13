import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { IngestJob } from './generated/rim.types.ts';
import { RimOperations as ops } from './generated/rim.operations.ts';

/**
 * RIM reads, through the gateway (EP-20.3).
 *
 * Types and operations come from `generated/` — projected from `docs/architecture/openapi/rim.yaml`.
 */
export interface IngestListOptions {
  limit?: number;
  cursor?: string;
}

@Injectable({ providedIn: 'root' })
export class IngestService {
  private readonly api = inject(ApiClient);

  /** The Ingest/Import page listing. */
  list(options: IngestListOptions = {}) {
    return this.api.call(ops.getIngestQueue, { query: { ...options } }).as<IngestJob[]>();
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
