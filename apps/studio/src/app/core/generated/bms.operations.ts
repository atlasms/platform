// GENERATED FROM docs/architecture/openapi/bms.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: BMS's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in bms.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const BmsOperations = {
  /** The channel's workflows in every state, by id (workflow:read or workflow:admin) */
  listWorkflows: { method: 'GET', path: '/api/v1/workflows', params: [] },
  /** Create a workflow — its draft is version 1 (workflow:admin) */
  createWorkflow: { method: 'POST', path: '/api/v1/workflows', params: [] },
  /** Every ACTIVE workflow of the channel with its published definition — the copy every authenticated user's client loads at sign-in and refreshes on `workflow.changed` (EP-22.11). No workflow permission is needed: an active workflow is visible to everyone in the channel. */
  getWorkflowCatalog: { method: 'GET', path: '/api/v1/workflows/catalog', params: [] },
  /** An inactive workflow becomes active again — in the catalog, able to start instances (workflow:admin) */
  activateWorkflow: { method: 'POST', path: '/api/v1/workflows/{id}/activate', params: ['id'] },
  /** An active workflow becomes inactive — out of the catalog, no new instances (workflow:admin). REFUSED while any instance of it is still running or waiting. */
  deactivateWorkflow: { method: 'POST', path: '/api/v1/workflows/{id}/deactivate', params: ['id'] },
  /** Retire a workflow for good — kept for its history, never active again (workflow:admin). REFUSED while any instance of it is still running or waiting. */
  archiveWorkflow: { method: 'POST', path: '/api/v1/workflows/{id}/archive', params: ['id'] },
  /** Step kinds + their config schemas (drives the designer palette, FR-BMS-8; EP-23.1) — workflow:admin */
  getPalette: { method: 'GET', path: '/api/v1/workflows/palette', params: [] },
  /** A BPMN 2.0 file becomes a NEW workflow's draft (workflow:admin; FR-BMS-10, EP-23.8, DSL §11): its graph, layout, description and scope, in the caller's channel under a new id — never the file's. Not validated here: the draft is judged like any other, and publish gates it. */
  importWorkflow: { method: 'POST', path: '/api/v1/workflows/import', params: [] },
  /** A workflow — its header, its open draft (if any) and its published versions */
  getWorkflow: { method: 'GET', path: '/api/v1/workflows/{id}', params: ['id'] },
  /** Save the draft — the whole graph, as the designer holds it (workflow:admin). An invalid graph is SAVED (a draft is work in progress); only publish refuses it. With no open draft, this opens one at the next version. */
  saveDraft: { method: 'PUT', path: '/api/v1/workflows/{id}/draft', params: ['id'] },
  /** Validate a graph without saving it (live designer feedback, FR-BMS-9) — the body's, or with no body the stored draft's. The same rules publish applies. */
  validateWorkflow: { method: 'POST', path: '/api/v1/workflows/{id}/validate', params: ['id'] },
  /** Validate the draft and publish it as an immutable version (FR-BMS-9; workflow:admin) */
  publishWorkflow: { method: 'POST', path: '/api/v1/workflows/{id}/publish', params: ['id'] },
  /** One version's definition — a published one is immutable; the draft's is its latest save */
  getWorkflowVersion: {
    method: 'GET',
    path: '/api/v1/workflows/{id}/versions/{version}',
    params: ['id', 'version'],
  },
  /** A version as BPMN 2.0 XML with DI layout (workflow:read or :admin; FR-BMS-10, EP-23.8, DSL §11) — the version named, else the open draft, else the latest published. */
  exportWorkflow: { method: 'GET', path: '/api/v1/workflows/{id}/export', params: ['id'] },
  /** The channel's workflow instances, newest first (workflow:read, :act or :admin) */
  listInstances: { method: 'GET', path: '/api/v1/instances', params: [] },
  /** Start an instance of a PUBLISHED workflow version (workflow:act). It is pinned to that version for its whole life. Runs on Temporal (ADR-0010); 503 when the runtime is away. */
  startInstance: { method: 'POST', path: '/api/v1/instances', params: [] },
  /** An instance's state, where it is waiting, and its step history (FR-BMS-6) */
  getInstance: { method: 'GET', path: '/api/v1/instances/{id}', params: ['id'] },
  /** Deliver a step's completion or event to a waiting instance (workflow:act) — the generic path until EP-22.4's event router delivers completions from the bus. A signal for a step not yet waiting is kept until it waits. */
  signalInstance: { method: 'POST', path: '/api/v1/instances/{id}/signal', params: ['id'] },
} as const;

export type BmsOperation = keyof typeof BmsOperations;
