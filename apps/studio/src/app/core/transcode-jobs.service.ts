import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Job } from './generated/mts.types.ts';
import { MtsOperations as ops } from './generated/mts.operations.ts';

/**
 * MTS's transcode jobs, through the gateway (EP-16). Read-only here: a person does not start a
 * transcode from Studio yet — the input is a path in MTS's work area until HSM (EP-14) resolves
 * inputs, and nothing in the browser knows one. What Studio does is SHOW what is happening to an
 * asset's renditions, which until now was visible only in MTS's logs.
 *
 * `asset:read` on the `files` group, the same grant as the asset's file rows.
 */
@Injectable({ providedIn: 'root' })
export class TranscodeJobsService {
  private readonly api = inject(ApiClient);

  /** One asset's jobs, oldest first (the order MTS answers in). */
  forAsset(assetId: string) {
    return this.api.call(ops.listJobs, { query: { assetId, limit: 50 } }).as<Job[]>();
  }
}
