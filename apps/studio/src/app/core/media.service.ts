import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import { skipAuth } from './auth.service.ts';
import type { MediaUrl } from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/**
 * The browser media path (ADR-0012): MAM authorizes `asset:read` on the files group and signs ONE
 * file into a short-lived URL, which HSM serves with HTTP Range through the gateway's public
 * `/media/` route. A `<video src>` cannot carry a bearer, so the signature is the credential.
 *
 * The URL is a capability until `expiresAt`: kept in memory by whoever asked, never persisted or
 * logged. Fetching a signed file as text (the filmstrip's cues) goes WITHOUT the bearer — the
 * route is public, and a token has no business on a request that does not need one.
 */
@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);

  /** A signed URL for one of the asset's files: 409 near-line/offline, 503 no key on the platform. */
  url(assetId: string, kind: string, variant?: string) {
    return this.api
      .call(ops.getAssetMediaUrl, {
        params: { id: assetId, kind },
        ...(variant !== undefined ? { query: { variant } } : {}),
      })
      .as<MediaUrl>();
  }

  /** A signed text file — the filmstrip's WebVTT. */
  text(url: string) {
    return this.http.get(url, { responseType: 'text', context: skipAuth() });
  }
}
