// GENERATED FROM docs/architecture/openapi/mts.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: MTS's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in mts.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const MtsOperations = {
  /** The caller's channel's jobs, oldest first, optionally one asset's */
  listJobs: { method: 'GET', path: '/api/v1/jobs', params: [] },
  /** Enqueue a transcode job (normally a broker command from BMS/RIM) */
  enqueueJob: { method: 'POST', path: '/api/v1/jobs', params: [] },
  /** Job status, progress and — once completed — its renditions. Another channel's job is 404. */
  getJob: { method: 'GET', path: '/api/v1/jobs/{id}', params: ['id'] },
  /** List transcode profiles */
  listProfiles: { method: 'GET', path: '/api/v1/profiles', params: [] },
  /** Create a transcode profile per channel/type */
  createProfile: { method: 'POST', path: '/api/v1/profiles', params: [] },
  /** Current worker topology (for dashboards) */
  getWorkers: { method: 'GET', path: '/api/v1/workers', params: [] },
} as const;

export type MtsOperation = keyof typeof MtsOperations;
