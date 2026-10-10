// GENERATED FROM docs/architecture/openapi/mam.yaml — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// contract disagree, which is the whole point: MAM's API shape is decided in the contract
// and this file is a projection of it, not a second opinion.

/**
 * Every operation in mam.yaml: method, the path as the gateway serves it, and its path
 * parameters. Studio's `ApiClient` builds each request from one of these entries.
 */
export const MamOperations = {
  /** List/browse assets (scope asset:read, category-scoped) */
  listAssets: { method: 'GET', path: '/api/v1/assets', params: [] },
  /** Create an asset (scope asset:write) */
  createAsset: { method: 'POST', path: '/api/v1/assets', params: [] },
  /** Asset counts per lifecycle state for the channel (scope asset:read, UNSCOPED only) */
  getAssetStateCounts: { method: 'GET', path: '/api/v1/assets/counts', params: [] },
  /** Get an asset (core + extensible metadata) */
  getAsset: { method: 'GET', path: '/api/v1/assets/{id}', params: ['id'] },
  /** Update asset metadata (scope asset:write) */
  updateAsset: { method: 'PATCH', path: '/api/v1/assets/{id}', params: ['id'] },
  /** Create a new version (clone metadata on replace, FR-MAM-6) */
  createAssetVersion: { method: 'POST', path: '/api/v1/assets/{id}/versions', params: ['id'] },
  /** Approve an asset for air - manual verdict (scope asset:approve) */
  approveAsset: { method: 'POST', path: '/api/v1/assets/{id}/approve', params: ['id'] },
  /** Reject an asset - manual verdict (scope asset:approve) */
  rejectAsset: { method: 'POST', path: '/api/v1/assets/{id}/reject', params: ['id'] },
  /** Retained review-verdict history for an asset (scope asset:read) */
  listVerdicts: { method: 'GET', path: '/api/v1/assets/{id}/verdicts', params: ['id'] },
  /** Associate a person + role with an asset (scope asset:write) */
  linkPerson: { method: 'POST', path: '/api/v1/assets/{id}/people', params: ['id'] },
  /** Simple free-text search (scope asset:read) */
  simpleSearch: { method: 'GET', path: '/api/v1/search', params: [] },
  /** Faceted search over the projected EFFECTIVE values — inherited ones included (scope asset:read, per asset; EP-28.6, FR-TAX-5/6) */
  advancedSearch: { method: 'POST', path: '/api/v1/search', params: [] },
  /** Rebuild the channel's search index from the assets (scope taxonomy:admin) */
  reindexSearch: { method: 'POST', path: '/api/v1/search/reindex', params: [] },
  /** List custom field schemas */
  listFieldSchemas: { method: 'GET', path: '/api/v1/field-schemas', params: [] },
  /** Define or replace the custom fields of a type/category scope (scope taxonomy:admin) */
  putFieldSchema: { method: 'PUT', path: '/api/v1/field-schemas', params: [] },
  /** The asset's extended values with the field definitions that govern them (scope asset:read) */
  getAssetExtended: { method: 'GET', path: '/api/v1/assets/{id}/extended', params: ['id'] },
  /** Merge extended values; each is validated against its field definition (scope asset:write) */
  updateAssetExtended: { method: 'PATCH', path: '/api/v1/assets/{id}/extended', params: ['id'] },
  /** What the asset inherits from its category chain, live, each value with its origin (scope asset:read; EP-28.2) */
  getAssetInherited: { method: 'GET', path: '/api/v1/assets/{id}/inherited', params: ['id'] },
  /** The asset's files as mirrored from the HSM ledger (scope asset:read / files) */
  listAssetFiles: { method: 'GET', path: '/api/v1/assets/{id}/files', params: ['id'] },
  /** The asset's free-form tags (FR-TAX-1) */
  listAssetTags: { method: 'GET', path: '/api/v1/assets/{id}/tags', params: ['id'] },
  /** Replace the asset's tag set; unknown labels are minted (scope asset:write / taxonomy) */
  setAssetTags: { method: 'PUT', path: '/api/v1/assets/{id}/tags', params: ['id'] },
  /** The channel's tag cloud (scope taxonomy:read) */
  listTags: { method: 'GET', path: '/api/v1/tags', params: [] },
  /** Create a tag (scope taxonomy:admin) */
  createTag: { method: 'POST', path: '/api/v1/tags', params: [] },
  /** The channel's category tree, flat and in path order (scope taxonomy:read). See ../data-model.md §2.6. */
  listCategories: { method: 'GET', path: '/api/v1/categories', params: [] },
  /** Create a category under a parent, or at the root (scope taxonomy:admin over the new path; audited). Its key is fixed for good: the path is built from keys. */
  createCategory: { method: 'POST', path: '/api/v1/categories', params: [] },
  /** One category (scope taxonomy:read) */
  getCategory: { method: 'GET', path: '/api/v1/categories/{id}', params: ['id'] },
  /** Change labels, kind, sort order, description (core), media defaults (defaults) or mediaAddable, deprecation, reviewNeeded, keepDuration, defaultExpiry (policies) over the version read (compare-and-set; taxonomy:admin over its path, in each group touched; audited). Not the key, not the parent: see move. */
  updateCategory: { method: 'PATCH', path: '/api/v1/categories/{id}', params: ['id'] },
  /** What the category inherits from its ancestors — each default and policy it does not set, with its origin (scope taxonomy:read; EP-28.2) */
  getCategoryInherited: {
    method: 'GET',
    path: '/api/v1/categories/{id}/inherited',
    params: ['id'],
  },
  /** Move a category and its subtree under another parent, or to the root, in one transaction (taxonomy:admin over BOTH positions; every node a revision, audited). Grants follow the position: one scoped to the old path stops covering the subtree. */
  moveCategory: { method: 'POST', path: '/api/v1/categories/{id}/move', params: ['id'] },
  /** List subjects (controlled vocabulary) */
  listSubjects: { method: 'GET', path: '/api/v1/subjects', params: [] },
  /** Create a subject */
  createSubject: { method: 'POST', path: '/api/v1/subjects', params: [] },
  /** List the people register */
  listPeople: { method: 'GET', path: '/api/v1/people', params: [] },
  /** Create a person (name, role, optional image only - FR-PPL-2) */
  createPerson: { method: 'POST', path: '/api/v1/people', params: [] },
  /** Start a media-editor project over an asset's renditions (scope asset:write). See ../services/media-editor.md. */
  createEditProject: { method: 'POST', path: '/api/v1/assets/{id}/edit-projects', params: ['id'] },
  /** Get an edit project (timeline) (scope asset:read) */
  getEditProject: { method: 'GET', path: '/api/v1/edit-projects/{id}', params: ['id'] },
  /** Save the timeline (clips, in/out, transitions, filters) (scope asset:write) */
  updateEditProject: { method: 'PATCH', path: '/api/v1/edit-projects/{id}', params: ['id'] },
  /** Flatten the timeline into a rendition - issues editor.render.requested to MTS (scope asset:write, FR-EDT-4) */
  renderEditProject: { method: 'POST', path: '/api/v1/edit-projects/{id}/render', params: ['id'] },
  /** The cached reference snapshot MAM owns (vocabularies + resolved settings) with a configVersion (scope config:read). Supports If-None-Match. See ../configuration-and-reference-data.md §5. */
  getReferenceSnapshot: { method: 'GET', path: '/api/v1/reference', params: [] },
  /** A vocabulary's live terms by sortOrder then key — the deprecated and merged too with includeDeprecated (scope taxonomy:read; EP-28.3) */
  listVocabularyTerms: {
    method: 'GET',
    path: '/api/v1/vocabularies/{vocabulary}',
    params: ['vocabulary'],
  },
  /** Add a term (scope taxonomy:admin in the channel — not a category-scoped grant; audited) */
  createVocabularyTerm: {
    method: 'POST',
    path: '/api/v1/vocabularies/{vocabulary}',
    params: ['vocabulary'],
  },
  /** One term, deprecated or merged included — every reference still resolves (scope taxonomy:read) */
  getVocabularyTerm: {
    method: 'GET',
    path: '/api/v1/vocabularies/{vocabulary}/{termId}',
    params: ['vocabulary', 'termId'],
  },
  /** Rename / reorder / annotate / deprecate or restore a term over the version read (compare-and-set; scope taxonomy:admin; audited). The key never changes; a merged term cannot be restored. Never deletes. */
  updateVocabularyTerm: {
    method: 'PATCH',
    path: '/api/v1/vocabularies/{vocabulary}/{termId}',
    params: ['vocabulary', 'termId'],
  },
  /** Merge this term into another live term of the same vocabulary — it is deprecated with replacedById; ONE audited write, no asset rewritten (scope taxonomy:admin) */
  mergeVocabularyTerm: {
    method: 'POST',
    path: '/api/v1/vocabularies/{vocabulary}/{termId}/merge',
    params: ['vocabulary', 'termId'],
  },
  /** Resolved settings for this service with their descriptors and origin level (scope config:read) */
  listSettings: { method: 'GET', path: '/api/v1/settings', params: [] },
  /** Set a setting value at a scope level within its descriptor bounds (scope config:admin, scoped by level). Emits config.changed. */
  updateSetting: { method: 'PATCH', path: '/api/v1/settings', params: [] },
} as const;

export type MamOperation = keyof typeof MamOperations;
