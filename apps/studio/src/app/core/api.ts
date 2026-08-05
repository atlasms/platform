import { InjectionToken } from '@angular/core';

/**
 * Where the API gateway lives.
 *
 * An injection token rather than a constant so tests can point it somewhere harmless and a
 * deployment can point it at its own host. Empty by default: Studio is served from the same origin
 * as the gateway in every environment we ship, so a relative URL is correct and there is no CORS
 * preflight on the critical path.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '',
});

/** IAM's token pair, exactly as `/auth/login` and `/auth/refresh` return it. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  permVersion: number;
}
