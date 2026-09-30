import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { RightsWindow, RightsWindowInput } from './generated/scheduling.types.ts';
import { SchedulingOperations as ops } from './generated/scheduling.operations.ts';

/**
 * Scheduling's rights windows, through the gateway (EP-31): when the channel may air an asset, or
 * any asset of a category. Read under `asset:read` and written under `asset:write`, both on the
 * asset `rights` field group — the Librarian's grant. A change names the `version` it was read at;
 * a 409 means someone changed the window first, and the answer is a reload, never a retry.
 */
@Injectable({ providedIn: 'root' })
export class RightsService {
  private readonly api = inject(ApiClient);

  /** The channel's windows by `validFrom`; narrowed to one asset or one category when given. */
  list(filter: { assetId?: string; categoryId?: string } = {}) {
    return this.api.call(ops.listRightsWindows, { query: { ...filter } }).as<RightsWindow[]>();
  }

  get(id: string) {
    return this.api.call(ops.getRightsWindow, { params: { id } }).as<RightsWindow>();
  }

  create(input: RightsWindowInput) {
    return this.api.call(ops.createRightsWindow, { body: input }).as<RightsWindow>();
  }

  /** The window's terms, whole, over `version`. */
  replace(id: string, version: number, input: RightsWindowInput) {
    return this.api
      .call(ops.updateRightsWindow, { params: { id }, query: { version }, body: input })
      .as<RightsWindow>();
  }

  remove(id: string, version: number) {
    return this.api.call(ops.deleteRightsWindow, { params: { id }, query: { version } }).as<void>();
  }
}
