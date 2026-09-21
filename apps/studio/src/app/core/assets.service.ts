import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client.ts';
import type { Asset, FileRef, Tag, UpdateAssetInput } from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/**
 * MAM reads, through the gateway (EP-20.1).
 *
 * Types come from `generated/` — projected from `docs/architecture/openapi/mam.yaml` — so this file
 * cannot quietly disagree with the contract about what an asset is. That is the whole point of
 * EP-11.5; hand-written interfaces here would put the drift straight back. The URLs come from the
 * same place (EP-02.4): each call names an operation, and the path, verb and parameters are the
 * contract's.
 */

/** A page of results. `nextCursor` absent means the channel is exhausted. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
  /**
   * `desc` is newest-first, which is what "Recent" means.
   *
   * Not a client-side sort: page one of an ascending list is the OLDEST assets in the channel, so
   * sorting what arrives would put a "Recent" heading over precisely the wrong records.
   */
  order?: 'asc' | 'desc';
}

@Injectable({ providedIn: 'root' })
export class AssetsService {
  private readonly api = inject(ApiClient);

  /** One page of the channel's catalogue. Identity and tenant come from the token, not from here. */
  list(options: ListOptions = {}) {
    // Spread, because an interface has no implicit index signature and `Query` needs one.
    return this.api.call(ops.listAssets, { query: { ...options } }).as<Page<Asset>>();
  }

  /** One complete core record for an editor tab. */
  get(id: string) {
    return this.api.call(ops.getAsset, { params: { id } }).as<Asset>();
  }

  /** Save only changed, user-editable core fields; MAM remains the authorization boundary. */
  update(id: string, patch: UpdateAssetInput) {
    return this.api.call(ops.updateAsset, { params: { id }, body: patch }).as<Asset>();
  }

  /** The asset's files as MAM mirrors them from HSM/MTS (EP-17.8) — the Files tab's rows. */
  files(id: string) {
    return this.api.call(ops.listAssetFiles, { params: { id } }).as<FileRef[]>();
  }

  /**
   * Simple search.
   *
   * The query goes as a PARAMETER, not interpolated into the path — `q` is user text and may
   * contain `/`, `?` or `#`, each of which would silently truncate or reroute a hand-built URL.
   */
  search(q: string, limit?: number) {
    // MAM's search contract is a bounded bare array (there is no search cursor yet). Normalize it
    // to the panel's page shape here so browse and search have one UI-facing interface without
    // lying about the wire response. A fake returning `{ items }` hid this mismatch in EP-20.1.
    return this.api
      .call(ops.simpleSearch, { query: { q, limit } })
      .as<Asset[]>()
      .pipe(map((items) => ({ items })));
  }

  /**
   * Asset counts per lifecycle state, for the whole channel.
   *
   * MAM answers this with a `GROUP BY` over an index rather than a scan, which is why it can cover
   * the channel instead of a page of it. It **403s** for a caller whose read grant is narrowed by
   * category, state or ownership: the aggregate cannot apply the per-asset check that `list()`
   * does, so for those callers it would not be a true statement. They count through `list()`
   * instead, which is filtered and therefore right for them — see the dashboard.
   */
  counts() {
    return this.api
      .call(ops.getAssetStateCounts)
      .as<{ counts: Record<string, number> }>()
      .pipe(map((body) => body.counts));
  }

  /** The channel's tag vocabulary — what the filter list offers. */
  tags() {
    return this.api.call(ops.listTags).as<Tag[]>();
  }
}
