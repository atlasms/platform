import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { API_BASE_URL } from './api.ts';
import type { Asset, Tag } from './generated/mam.types.ts';

/**
 * MAM reads, through the gateway (EP-20.1).
 *
 * Types come from `generated/` — projected from `docs/architecture/openapi/mam.yaml` — so this file
 * cannot quietly disagree with the contract about what an asset is. That is the whole point of
 * EP-11.5; hand-written interfaces here would put the drift straight back.
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
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** One page of the channel's catalogue. Identity and tenant come from the token, not from here. */
  list(options: ListOptions = {}) {
    let params = new HttpParams();
    if (options.limit !== undefined) params = params.set('limit', options.limit);
    if (options.cursor !== undefined) params = params.set('cursor', options.cursor);
    if (options.order !== undefined) params = params.set('order', options.order);
    return this.http.get<Page<Asset>>(`${this.base}/api/v1/assets`, { params });
  }

  /**
   * Simple search.
   *
   * The query goes as a PARAMETER, not interpolated into the path — `q` is user text and may
   * contain `/`, `?` or `#`, each of which would silently truncate or reroute a hand-built URL.
   */
  search(q: string, limit?: number) {
    let params = new HttpParams().set('q', q);
    if (limit !== undefined) params = params.set('limit', limit);
    return this.http.get<Page<Asset>>(`${this.base}/api/v1/search`, { params });
  }

  /** The channel's tag vocabulary — what the filter list offers. */
  tags() {
    return this.http.get<Tag[]>(`${this.base}/api/v1/tags`);
  }
}
