// GENERATED FROM docs/architecture/openapi/scheduling.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: Scheduling's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in scheduling.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const SchedulingOperations = {
  /** The channel's program tables (scope schedule:read) */
  listSchedules: { method: 'GET', path: '/api/v1/schedules', params: [] },
  /** Create a program table for a broadcast day (scope schedule:write) */
  createSchedule: { method: 'POST', path: '/api/v1/schedules', params: [] },
  /** A program table with its reel (scope schedule:read) */
  getSchedule: { method: 'GET', path: '/api/v1/schedules/{id}', params: ['id'] },
  /** Change the header — timezone, notes (scope schedule:write) */
  updateSchedule: { method: 'PATCH', path: '/api/v1/schedules/{id}', params: ['id'] },
  /** The reel, in order (scope schedule:read) */
  listScheduleItems: { method: 'GET', path: '/api/v1/schedules/{id}/items', params: ['id'] },
  /** Append one item (scope schedule:write) */
  addScheduleItem: { method: 'POST', path: '/api/v1/schedules/{id}/items', params: ['id'] },
  /** Replace the whole reel — the editor's save (scope schedule:write) */
  replaceScheduleItems: { method: 'PUT', path: '/api/v1/schedules/{id}/items', params: ['id'] },
  /** Change one item (scope schedule:write) */
  updateScheduleItem: {
    method: 'PATCH',
    path: '/api/v1/schedules/{id}/items/{itemId}',
    params: ['id', 'itemId'],
  },
  /** Remove one item, and its sub-schedule if it has one (scope schedule:write) */
  removeScheduleItem: {
    method: 'DELETE',
    path: '/api/v1/schedules/{id}/items/{itemId}',
    params: ['id', 'itemId'],
  },
  /** Validate gaps/overlaps/rights/availability (FR-SCH-2/3) */
  validateSchedule: { method: 'POST', path: '/api/v1/schedules/{id}/validate', params: ['id'] },
  /** Serialize the playlist and trigger HSM delivery (scope schedule:send; audited) */
  sendToAir: { method: 'POST', path: '/api/v1/schedules/{id}/send-to-air', params: ['id'] },
  /** List export profiles */
  listExportProfiles: { method: 'GET', path: '/api/v1/export-profiles', params: [] },
  /** Create an export profile (format + destination + path-rewrite) */
  createExportProfile: { method: 'POST', path: '/api/v1/export-profiles', params: [] },
} as const;

export type SchedulingOperation = keyof typeof SchedulingOperations;
