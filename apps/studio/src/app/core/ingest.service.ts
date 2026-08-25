import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { API_BASE_URL } from './api.ts';
import type { IngestJob } from './generated/rim.types.ts';

/**
 * RIM reads, through the gateway (EP-20.3).
 *
 * Types come from `generated/` — projected from `docs/architecture/openapi/rim.yaml`.
 */
export interface IngestListOptions {
  limit?: number;
  cursor?: string;
}

@Injectable({ providedIn: 'root' })
export class IngestService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** The Ingest/Import page listing. */
  list(options: IngestListOptions = {}) {
    let params = new HttpParams();
    if (options.limit !== undefined) params = params.set('limit', options.limit);
    if (options.cursor !== undefined) params = params.set('cursor', options.cursor);
    return this.http.get<IngestJob[]>(`${this.base}/api/v1/ingest/queue`, { params });
  }

  /** Accept a quarantined job (operator override). */
  accept(id: string) {
    return this.http.post<IngestJob>(
      `${this.base}/api/v1/ingest/${encodeURIComponent(id)}/accept`,
      {},
    );
  }

  /** Reject a quarantined job. */
  reject(id: string, reason: string) {
    return this.http.post<IngestJob>(
      `${this.base}/api/v1/ingest/${encodeURIComponent(id)}/reject`,
      { reason },
    );
  }
}
