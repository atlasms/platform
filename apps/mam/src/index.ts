export {
  ASSET_STATES,
  canTransition,
  eventFor,
  hasLapsed,
  isPurgeable,
  isSchedulable,
  missingMandatory,
  type AssetState,
  type LifecycleAction,
  type LifecycleContext,
  type TransitionResult,
} from './lifecycle.ts';
export {
  BASE_MANDATORY_FIELDS,
  presentFieldsOf,
  type Asset,
  type CreateAssetInput,
  type UpdateAssetInput,
} from './asset.ts';
export {
  FACETS,
  MamService,
  systemCaller,
  type CacheOutcome,
  type MirrorOutcome,
  type MamReferenceSnapshot,
  type VocabularyTermRef,
  type Caller,
  type MamOptions,
  type ReadOptions,
  type SearchSources,
} from './service.ts';
export {
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  MemoryAssetCache,
  type AssetCache,
  type CacheFamilies,
  type CacheFamily,
  type MemoryCacheOptions,
} from './cache.ts';
export {
  CACHE_INVALIDATION_PATTERN,
  assetOf,
  startCacheInvalidation,
  type CacheInvalidationOptions,
} from './cache-invalidation.ts';
export {
  FIELD_TYPES,
  orphanedFields,
  requiredFieldNames,
  resolveFields,
  validateExtended,
  type FieldDefinition,
  type FieldError,
  type FieldSchema,
  type FieldType,
  type SchemaSubject,
  type ValidationOptions,
} from './field-schema.ts';
export {
  ASSET_FIELD_GROUPS,
  CORE_FIELD_GROUPS,
  DEFAULT_EXTENDED_GROUP,
  groupsForCoreFields,
  groupsForExtended,
  type AssetFieldGroup,
} from './field-groups.ts';
export {
  MAX_QUERY_TERMS,
  MAX_TERMS_PER_ASSET,
  MIN_TERM_LENGTH,
  indexTerms,
  parseQuery,
  prefixUpperBound,
  tokenize,
  type ParsedQuery,
  type SearchHit,
} from './search.ts';
export { CONTROL, INVISIBLE, ZWNJ, cleanText, foldText } from './text.ts';
export {
  fileFromPlacement,
  fileFromRendition,
  fileKey,
  type FileRef,
  type FileStatus,
} from './file.ts';
export { FILE_MIRROR_PATTERNS, startFileMirror, type FileMirrorOptions } from './files.ts';
export {
  INGEST_ACCEPTED_PATTERN,
  startIngestConsumer,
  type IngestConsumerOptions,
} from './ingest.ts';
export {
  MAX_TAGS_PER_ASSET,
  MAX_TAG_LENGTH,
  normalizeTag,
  parseTagLabels,
  sameTags,
  type ParsedTags,
  type Tag,
  type TagCandidate,
} from './tag.ts';
export {
  CategoryPathTaken,
  StaleCategory,
  StaleWrite,
  type AssetStore,
  type AssetTx,
  type ExtendedValues,
  type ListOptions,
} from './store.ts';
export {
  sqliteAssetStore,
  sqliteAssetsMigration,
  sqliteExtendedMigration,
  sqliteTagsMigration,
  sqliteSearchMigration,
} from './store-sqlite.ts';
export {
  pgAssetStore,
  pgAssetsMigration,
  pgExtendedMigration,
  pgTagsMigration,
  pgSearchMigration,
  mamMigrations,
} from './store-pg.ts';
// Re-exported, not owned. `PolicyClient` moved to `@atlas/policy/client` when the WebSocket
// service needed the same fail-closed cache; this line keeps `@atlas/mam`'s surface unchanged for
// anything already importing it from here.
export { PolicyClient, type PolicyClientOptions } from '@atlas/policy/client';
export { buildMamApp, type MamAppOptions } from './app.ts';
export {
  childPath,
  labelOf,
  MAX_CATEGORY_DEPTH,
  moved,
  within,
  type Category,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './category.ts';
export { startFacetProjector, TAXONOMY_UPDATED_PATTERN } from './facets.ts';
export {
  isVocabulary,
  resolveTerm,
  TERM_FIELDS,
  termLabel,
  VOCABULARIES,
  type CreateTermInput,
  type TermField,
  type UpdateTermInput,
  type Vocabulary,
  type VocabularyTerm,
} from './vocabulary.ts';
export {
  addDuration,
  chainOf,
  effectiveAsset,
  expiryFrom,
  inheritedByAsset,
  inheritedByCategory,
  MEDIA_DEFAULT_FIELDS,
  parseDuration,
  POLICY_FIELDS,
  type CategoryPolicies,
  type Inheritance,
  type InheritedValue,
  type MediaDefaultField,
  type MediaDefaults,
} from './inheritance.ts';
