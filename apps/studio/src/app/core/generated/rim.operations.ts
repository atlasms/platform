// GENERATED FROM docs/architecture/openapi/rim.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: RIM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in rim.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const RimOperations = {
  /** Start a chunked/resumable upload (scope ingest:write) */
  startUpload: { method: 'POST', path: '/api/v1/uploads', params: [] },
  /** Upload a chunk (resumable) */
  putUploadPart: { method: 'PUT', path: '/api/v1/uploads/{id}/parts/{n}', params: ['id', 'n'] },
  /** Finalize an upload; creates an ingest job */
  completeUpload: { method: 'POST', path: '/api/v1/uploads/{id}/complete', params: ['id'] },
  /** The Ingest/Import page listing (scope ingest:read) */
  getIngestQueue: { method: 'GET', path: '/api/v1/ingest/queue', params: [] },
  /** Accept a quarantined job (scope ingest:approve) */
  acceptIngest: { method: 'POST', path: '/api/v1/ingest/{id}/accept', params: ['id'] },
  /** Reject a quarantined job (scope ingest:approve) */
  rejectIngest: { method: 'POST', path: '/api/v1/ingest/{id}/reject', params: ['id'] },
  /** List folder watchers */
  listWatchers: { method: 'GET', path: '/api/v1/watchers', params: [] },
  /** Create a folder watcher */
  createWatcher: { method: 'POST', path: '/api/v1/watchers', params: [] },
  /** List recorders */
  listRecorders: { method: 'GET', path: '/api/v1/recorders', params: [] },
  /** Create a recorder */
  createRecorder: { method: 'POST', path: '/api/v1/recorders', params: [] },
  /** List acceptance rule sets */
  listAcceptanceRules: { method: 'GET', path: '/api/v1/acceptance-rules', params: [] },
  /** Create an acceptance rule set */
  createAcceptanceRules: { method: 'POST', path: '/api/v1/acceptance-rules', params: [] },
} as const;

export type RimOperation = keyof typeof RimOperations;
