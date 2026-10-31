import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { FieldSchema } from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/**
 * MAM's custom field schemas (EP-27.4), through the gateway. Read under `asset:read`, written
 * under `taxonomy:admin`. A write without `version` is a NEW schema; with it, a compare-and-set
 * replacement of exactly that version — a 409 is a reload, never a retry. A 422's
 * `details.problems` place every refusal at its path (`fields[2].options`).
 */
@Injectable({ providedIn: 'root' })
export class FieldSchemasService {
  private readonly api = inject(ApiClient);

  list() {
    return this.api.call(ops.listFieldSchemas).as<FieldSchema[]>();
  }

  put(schema: FieldSchema, version?: number) {
    return this.api
      .call(ops.putFieldSchema, { query: { version }, body: schema })
      .as<FieldSchema>();
  }
}
