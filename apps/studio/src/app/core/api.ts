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

// Re-exported from the GENERATED types rather than declared here (EP-11.5).
//
// This interface used to be hand-written, and that is exactly how it drifted: the contract said
// `permissionVersion`, this said `permVersion`, and both were "obviously right" to whoever last
// looked at one of them. Now the contract decides and `npm run api:check` fails the build if this
// file's source and `docs/architecture/openapi/iam.yaml` disagree.
export type { TokenPair, User, PermissionRule } from './generated/iam.types.ts';
export type { Asset, Tag, Person, VocabularyTerm } from './generated/mam.types.ts';
export type { IngestJob } from './generated/rim.types.ts';
