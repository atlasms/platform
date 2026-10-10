// MAM's domain service (EP-17.1, EP-17.5, EP-17.6).
//
// Every mutation does four things, in this order and in one transaction:
//   1. scope to the caller's channel,
//   2. authorize with canEnforce and the FULL resource context,
//   3. write the record,
//   4. enqueue the event on the outbox — atomically with (3).
//
// Steps 3 and 4 sharing a transaction is the whole reason the outbox exists: the state change and
// the announcement commit together, or neither does.

import {
  buildEnvelope,
  envelopeShapeErrors,
  subjectFor,
  ulid,
  validatePayload,
  delta,
  type Delta,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message } from '@atlas/messaging';
import { can, canEnforce, compile, type EffectivePolicy } from '@atlas/policy';
import {
  Conflict,
  currentTraceparent,
  Forbidden,
  NotFound,
  ValidationError,
} from '@atlas/service-kit';
import {
  orphanedFields,
  requiredFieldNames,
  resolveFields,
  validateExtended,
  type FieldDefinition,
  type FieldSchema,
} from './field-schema.ts';
import {
  fileFromMove,
  fileFromPlacement,
  fileFromRendition,
  fileKey,
  type FileRef,
} from './file.ts';
import type { AssetCache, CacheFamilies, CacheFamily } from './cache.ts';
import { StaleWrite, type AssetStore, type AssetTx, type ExtendedValues } from './store.ts';
import {
  childPath,
  createProblems,
  labelOf,
  MAX_CATEGORY_DEPTH,
  moved,
  refuse,
  updateProblems,
  within,
  type Category,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './category.ts';
import { StaleCategory, StaleTerm } from './store.ts';
import {
  createTermProblems,
  isVocabulary,
  refuseTerm,
  resolveTerm,
  TERM_FIELDS,
  termLabel,
  updateTermProblems,
  VOCABULARIES,
  type CreateTermInput,
  type TermField,
  type UpdateTermInput,
  type Vocabulary,
  type VocabularyTerm,
} from './vocabulary.ts';
import { groupsForCoreFields, groupsForExtended } from './field-groups.ts';
import {
  chainOf,
  defaultsProblems,
  effectiveAsset,
  expiryFrom,
  inheritedByAsset,
  inheritedByCategory,
  inheritProblems,
  MEDIA_DEFAULT_FIELDS,
  POLICY_FIELDS,
  type Inheritance,
  type MediaDefaultField,
} from './inheritance.ts';
import { indexTerms, parseQuery } from './search.ts';
import { parseTagLabels, sameTags, type Tag } from './tag.ts';
import {
  BASE_MANDATORY_FIELDS,
  presentFieldsOf,
  type Asset,
  type CreateAssetInput,
  type UpdateAssetInput,
} from './asset.ts';
import {
  canTransition,
  eventFor,
  type LifecycleAction,
  type LifecycleContext,
} from './lifecycle.ts';

export interface MamOptions {
  store: AssetStore;
  /** Extra mandatory fields for a category, beyond the platform's base set. */
  mandatoryFieldsFor?: (asset: Asset) => readonly string[];
  /**
   * Terms per controlled vocabulary, for validating `type: 'vocabulary'` fields.
   *
   * The cached snapshot in a deployment (`@atlas/reference`). A vocabulary that is absent makes
   * its fields unwritable rather than unchecked — see `field-schema.ts`.
   */
  vocabularies?: () => ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The read cache for hot assets (EP-17.7). Absent, every read goes to the store. See
   * `cache.ts` for what is cached and, more importantly, how it is invalidated.
   */
  cache?: AssetCache;
  /** One call per cached read, for the hit-rate counter. `family`, never an id, is the label. */
  onCacheRead?: (family: CacheFamily, outcome: CacheOutcome) => void;
  now?: () => Date;
}

export type CacheOutcome = 'hit' | 'miss' | 'bypass';

/**
 * How a read may be answered.
 *
 * `fresh` reads through the cache — what `Cache-Control: no-cache` on the request means, and what
 * a client refetching on a live event asks for, since the event and this replica's eviction are
 * two consumers of one stream with no order between them.
 */
export interface ReadOptions {
  fresh?: boolean;
}

/**
 * Extended field names are namespaced in the lifecycle context.
 *
 * An operator is free to define an extended field called `title`, and the core asset already has
 * one. Without a prefix the mandatory-metadata gate would see a single flat `title` and let the
 * core value satisfy a requirement on the extended field — passing a check nobody actually met.
 */
const EXTENDED_PREFIX = 'extended.';

/**
 * The field group a tag write belongs to.
 *
 * The starter roles scope `asset:write` by field group — an Editor gets `core`, `taxonomy`, `cast`
 * and `shotlist`; a Librarian gets `files` and `rights`
 * ([authorization-model.md §9](../../../docs/architecture/authorization-model.md)). Asking without
 * a group means *any* group satisfies the check, so naming it here is a genuine narrowing: a
 * Librarian's file-and-rights grant no longer reaches an asset's keywords.
 */
const TAXONOMY_GROUP = 'taxonomy';

/** Page size when a caller does not ask. Large enough to be useful, small enough to render. */
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

/**
 * How many candidates to pull per requested result.
 *
 * Search authorizes each hit individually, so the store's rows are a superset of what the caller
 * may see. Four is a guess, and an honest one: a caller whose grant covers most of the channel
 * never notices, and one whose grant covers a narrow slice may get a short page even though more
 * matches exist. Fixing that properly means pushing the policy predicate into the query, which is
 * the point at which the search engine has to understand the authorization model.
 */
const SEARCH_OVERFETCH = 4;

/** Listing page size, and the same over-fetch reasoning as search. */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const PAGE_OVERFETCH = 4;

/**
 * How many store round trips one listing request may make while trying to fill its page.
 *
 * Without a bound, a caller whose read grant matches almost nothing walks the whole channel to
 * discover that — turning a listing into a denial of service against its own database. With it,
 * they get a short page and a cursor, which is the honest answer: "nothing here, continue from
 * this point".
 */
const MAX_PAGE_SCANS = 5;

/** Where to resume. `cursor` is the last id the caller has already been shown a decision for. */
export interface ListPage {
  limit?: number;
  cursor?: string;
  /** `desc` reads newest-first — what a "Recent" listing means (EP-20.1). Default `asc`. */
  order?: 'asc' | 'desc';
  /** Only assets in this category (#260) — the Media panel's browse tree. */
  categoryId?: string;
  /** With `categoryId`: that category AND everything below it. */
  subtree?: boolean;
}

/** What an authorization check knows about the asset it is asked about. */
interface AssetScope {
  categoryPath?: string;
  ownerId?: string;
}

/**
 * A page of results.
 *
 * `nextCursor` absent means the channel is exhausted. Present with a SHORT `items` is normal, not a
 * bug: the permission filter runs after the read, so a page can legitimately come back thin while
 * more matches lie beyond it.
 */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** The text an asset is findable by, gathered from every part of it that carries words. */
export interface SearchSources {
  tagLabels: readonly string[];
  extended: ExtendedValues;
}

/**
 * Flatten an asset into search terms.
 *
 * Only string-ish extended values are indexed. A number, a boolean or a date renders as a token
 * nobody searches for — `true`, `4.5` — while filling the index with noise; those belong in the
 * structured filters that arrive with faceted search, not in free text.
 */
function termsFor(asset: Asset, sources: SearchSources): string[] {
  const extendedText = Object.values(sources.extended).filter(
    (v): v is string => typeof v === 'string',
  );
  return indexTerms([
    asset.title,
    asset.description,
    // The MEDIA TYPE and structure are words an editor genuinely searches by ("video", "drama").
    // Ids are not: a ULID is not a term, and `categoryId` is one until categories exist.
    asset.mediaType,
    ...sources.tagLabels,
    ...extendedText,
  ]);
}

/** Who is asking, and in which tenant. Established by the gateway, never parsed from a JWT here. */
export interface Caller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
  /** The message this write answers (EP-03.5) — set by the mirror, never by a request. */
  causationId?: string;
  /** Who the envelope names as actor. A person by default; this service for what it does itself. */
  actorKind?: 'user' | 'service';
}

/**
 * The platform's own hands (EP-17.8): the caller for a mutation no person requested — a mirror
 * of another service's event. Its policy is empty and never consulted; a system path does not go
 * through `authorize`, which is exactly why it is a separate constructor rather than a grant.
 */
const SYSTEM_POLICY = compile({ subjectId: 'mam', permVersion: 0, rules: [] });
export const systemCaller = (
  channelId: string,
  cause?: Pick<Envelope, 'messageId' | 'correlationId'>,
): Caller => ({
  userId: 'mam',
  channelId,
  policy: SYSTEM_POLICY,
  actorKind: 'service',
  // follow()'s rule (@atlas/contracts, EP-03.5): the cause's chain continues — or starts at the
  // cause when it carried none — and every record this write emits names the message it answers.
  ...(cause
    ? { correlationId: cause.correlationId ?? cause.messageId, causationId: cause.messageId }
    : {}),
});

export type MirrorOutcome = 'applied' | 'duplicate';

/**
 * What `GET /reference` returns for MAM — the shape mam.yaml's `ReferenceSnapshot` describes.
 *
 * `key` is the NORMALIZED label and `label` the display spelling, because a snapshot is used for
 * validation ("is this a known tag?") as well as for rendering, and those want different strings.
 */
export interface MamReferenceSnapshot {
  configVersion: number;
  vocabularies: {
    tag: Array<{ id: string; key: string; label: string }>;
    /** The live tree (#260): what a client validates a `categoryId` against. */
    category: Array<{
      id: string;
      key: string;
      label: string;
      labels: Record<string, string>;
      parentId?: string;
      path: string;
      mediaAddable: boolean;
    }>;
  } & Record<Vocabulary, VocabularyTermRef[]>;
}

/** A live term as the reference snapshot carries it (EP-28.3). */
export interface VocabularyTermRef {
  id: string;
  key: string;
  label: string;
  labels: Record<string, string>;
}

export class MamService {
  private readonly options: MamOptions;
  private readonly now: () => Date;

  constructor(options: MamOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  // --- reads -----------------------------------------------------------------

  /**
   * Fetch one asset.
   *
   * A cross-tenant id is reported as NOT FOUND, not FORBIDDEN. "You may not see this" confirms the
   * asset exists, which is itself a leak across a tenant boundary.
   */
  async get(caller: Caller, id: string, options: ReadOptions = {}): Promise<Asset> {
    const asset = await this.cachedAsset(id, options.fresh ?? false);
    if (!asset || asset.channelId !== caller.channelId) throw new NotFound(`no asset ${id}`);
    this.authorize(caller, 'asset:read', await this.scopeOf(asset));
    return asset;
  }

  /**
   * The base of a mutation: the same scoping and permission as {@link get}, from the STORE.
   *
   * A write computes `version + 1` from what it read. Read from another replica's stale cache
   * entry, that is a lost update wearing a valid version number — so a mutation's base never comes
   * from the cache, whatever the cache's invalidation promises.
   */
  private async fresh(caller: Caller, id: string): Promise<Asset> {
    return this.get(caller, id, { fresh: true });
  }

  // --- the read cache (EP-17.7) ---------------------------------------------

  private async cachedAsset(id: string, fresh: boolean): Promise<Asset | undefined> {
    return this.cached('asset', id, fresh, () => this.options.store.get(id));
  }

  private async cachedExtended(id: string, fresh: boolean): Promise<ExtendedValues | undefined> {
    const value = await this.cached(
      'extended',
      id,
      fresh,
      async () => (await this.options.store.extended(id)) ?? null,
    );
    return value ?? undefined;
  }

  private async cachedTags(id: string, fresh: boolean): Promise<Tag[]> {
    return (await this.cached('tags', id, fresh, () => this.options.store.tagsOf(id))) ?? [];
  }

  /**
   * Cache-aside for one family. A miss is NOT cached: a probe for an id that does not exist is an
   * index lookup anyway, and an unbounded key space of misses is how a cache is filled with
   * nothing.
   */
  private async cached<F extends CacheFamily>(
    family: F,
    id: string,
    fresh: boolean,
    load: () => Promise<CacheFamilies[F] | undefined>,
  ): Promise<CacheFamilies[F] | undefined> {
    const cache = this.options.cache;
    if (!cache || fresh) {
      if (cache) this.options.onCacheRead?.(family, 'bypass');
      return load();
    }
    const hit = await cache.get(id, family);
    if (hit !== undefined) {
      this.options.onCacheRead?.(family, 'hit');
      return hit;
    }
    this.options.onCacheRead?.(family, 'miss');
    const loaded = await load();
    if (loaded !== undefined) await cache.set(id, family, loaded);
    return loaded;
  }

  /**
   * Forget what is cached about one asset — called after every committed mutation here, and by
   * the broadcast subscription for the mutations OTHER replicas commit (`cache-invalidation.ts`).
   */
  async evictCached(assetId: string): Promise<void> {
    await this.options.cache?.evict(assetId);
  }

  /**
   * One page of the caller's channel, filtered to what they may actually read.
   *
   * This used to ask `canEnforce('asset:read')` once with no category and then return the channel
   * unfiltered — wrong in **both** directions at once, which is why neither half had surfaced. A
   * read grant scoped to `categoryPaths` cannot satisfy a check that names no category, so a
   * category-scoped reader was refused outright; and anyone who *did* pass saw every asset in the
   * channel, including the ones their scope excluded. Each bug hid the other.
   *
   * So: lenient once as an early-out (see {@link search} for why strict is wrong there), then the
   * strict evaluator per asset with the full resource context — which is the only place the
   * question "may you read THIS" can honestly be answered.
   */
  /**
   * How many assets are in each lifecycle state, across the WHOLE channel.
   *
   * Only for callers whose read grant is unconditioned, and the check is what makes that safe:
   * `canEnforce` with a context carrying ONLY `channelId` passes exactly when no matching rule
   * narrows by category, state or ownership — because in strict mode a declared predicate with no
   * supplied value cannot be satisfied. That is not a clever reuse of the flag, it is the property
   * it exists for, and it is the precondition for this aggregate to be a true statement.
   *
   * WHY A CATEGORY-SCOPED READER IS REFUSED RATHER THAN SERVED A FILTERED NUMBER. The store counts
   * with a `GROUP BY` over an index; it cannot apply the per-asset check {@link list} runs, and
   * making it do so means scanning the channel — which is the cost this endpoint exists to avoid.
   * The two honest options are a refusal or a scan, and #236 is the reminder of what the third
   * option costs: `list()` once answered a category-scoped reader with the whole channel.
   *
   * A refusal is not a regression for those callers. Studio falls back to counting through
   * `list()`, which is per-asset filtered and therefore right for them — just bounded.
   */
  /**
   * What the asset inherits (EP-28.2): each media default it does not set, and the policies of its
   * category's chain, each with the category it comes from. Live — read, never stored.
   */
  async inherited(caller: Caller, id: string): Promise<Inheritance & { assetId: string }> {
    const asset = await this.get(caller, id, { fresh: true });
    return { assetId: asset.id, ...(await this.inheritanceOf(asset)) };
  }

  /** The asset's inheritance from its category chain; nothing when it has no category. */
  private async inheritanceOf(asset: Asset): Promise<Inheritance> {
    if (asset.categoryId === undefined) return { defaults: {}, policies: {} };
    const tree = await this.options.store.categories(asset.channelId);
    const node = tree.find((c) => c.id === asset.categoryId);
    return node ? inheritedByAsset(asset, chainOf(tree, node)) : { defaults: {}, policies: {} };
  }

  async counts(caller: Caller): Promise<Record<string, number>> {
    if (!canEnforce(caller.policy, 'asset:read', { channelId: caller.channelId }).allowed) {
      throw new Forbidden(
        'state counts are available only to callers who may read the whole channel; ' +
          'a grant narrowed by category, state or ownership must count through /assets',
      );
    }
    return this.options.store.countByState(caller.channelId);
  }

  async list(caller: Caller, options: ListPage = {}): Promise<Page<Asset>> {
    if (!can(caller.policy, 'asset:read', { channelId: caller.channelId }).allowed) {
      throw new Forbidden('no rule grants "asset:read"');
    }

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const categoryIds =
      options.categoryId === undefined
        ? undefined
        : await this.categoryFilter(caller.channelId, options.categoryId, options.subtree ?? false);
    const items: Asset[] = [];
    let cursor = options.cursor;
    let more = true;
    let scans = 0;

    // Filtering happens after the read, so a page from the store is a superset of the page the
    // caller gets. Looping fills the page instead of returning a short one — but bounded, because
    // a caller who may read almost nothing would otherwise walk the entire channel in one request
    // and turn a listing into a denial of service against its own database.
    while (items.length < limit && more && scans < MAX_PAGE_SCANS) {
      scans++;
      const fetch = limit * PAGE_OVERFETCH;
      const page = await this.options.store.listByChannel(caller.channelId, {
        limit: fetch,
        ...defined({ after: cursor, order: options.order, categoryIds }),
      });
      // A short page from the store means the channel is exhausted; a full one means there is more.
      more = page.length === fetch;
      // One query for the page's category paths, not one per asset.
      const paths = await this.pathsOf(page);

      for (const asset of page) {
        if (items.length >= limit) {
          // Stopped mid-page: everything after this point is undecided, so there IS more.
          more = true;
          break;
        }
        // The cursor advances per asset CONSIDERED, not per asset returned. Advancing it to the
        // end of the store's page would skip every row this loop never reached; advancing it only
        // on a match would re-scan the filtered ones forever.
        cursor = asset.id;
        if (this.mayRead(caller, asset, paths)) items.push(asset);
      }
    }

    return { items, ...defined({ nextCursor: more && cursor !== undefined ? cursor : undefined }) };
  }

  // --- writes ----------------------------------------------------------------

  async create(caller: Caller, input: CreateAssetInput): Promise<Asset> {
    // No resource yet, so the check asks the broad question — but still inside the caller's
    // channel, which is the part that must never be omitted, and narrowed to the field groups the
    // input actually touches. Creating an asset WITH an expiry is a rights write; creating one
    // without is not, and an Editor should not need a Librarian's grant for the ordinary case.
    // With a category, the check is against ITS path (#260): a writer scoped to /news/ creates in
    // /news/, and nowhere else. Without one, the broad question, as before.
    const category =
      input.categoryId === undefined
        ? undefined
        : await this.requireCategory(caller.channelId, input.categoryId);
    this.authorizeGroups(
      caller,
      'asset:write',
      { ...defined({ categoryPath: category?.path }) },
      groupsForCoreFields(Object.keys(input)),
    );

    if (!input.title?.trim()) throw new ValidationError('title is required');
    if (!input.mediaType?.trim()) throw new ValidationError('mediaType is required');
    if (!input.fileType?.trim()) throw new ValidationError('fileType is required');
    refuse(defaultsProblems(input as unknown as Record<string, unknown>));
    await this.requireTerms(caller.channelId, input as unknown as Record<string, unknown>);

    const at = this.now().toISOString();
    const asset: Asset = {
      id: ulid(),
      channelId: caller.channelId,
      title: input.title,
      mediaType: input.mediaType,
      fileType: input.fileType,
      state: 'created',
      version: 1,
      hasRenditions: false,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      ...defined({
        description: input.description,
        categoryId: input.categoryId,
        structureId: input.structureId,
        genre: input.genre,
        supplyType: input.supplyType,
        productionGroup: input.productionGroup,
        productionDate: input.productionDate,
        episodeNo: input.episodeNo,
        durationSec: input.durationSec,
        allowedBroadcastCount: input.allowedBroadcastCount,
        expiresAt: input.expiresAt,
      }),
    };

    await this.commit(
      caller,
      asset,
      undefined,
      'asset.created',
      {
        assetId: asset.id,
        core: {
          title: asset.title,
          fileType: asset.fileType,
          ...defined({ description: asset.description, durationSec: asset.durationSec }),
        },
      },
      // A new asset has neither tags nor a document yet, so the sources are known without a read.
      { tagLabels: [], extended: {} },
    );

    return asset;
  }

  /**
   * Change an asset's core metadata. `inherit` names media defaults the asset stops setting, so its
   * category's value shows through again (EP-28.2) — the "reset to inherited" of data-model §2.2.
   */
  async update(
    caller: Caller,
    id: string,
    patch: UpdateAssetInput & { inherit?: unknown },
  ): Promise<Asset> {
    return this.onCurrent(() => this.updateOnce(caller, id, patch));
  }

  private async updateOnce(
    caller: Caller,
    id: string,
    patch: UpdateAssetInput & { inherit?: unknown },
  ): Promise<Asset> {
    refuse([
      ...defaultsProblems(patch as unknown as Record<string, unknown>),
      ...inheritProblems(patch.inherit, MEDIA_DEFAULT_FIELDS),
    ]);
    const inherit = (patch.inherit ?? []) as MediaDefaultField[];
    const clash = inherit.filter((f) => patch[f] !== undefined);
    if (clash.length > 0) {
      throw new ValidationError(`${clash.join(', ')}: set and inherited at once — choose one`);
    }
    const existing = await this.fresh(caller, id);

    // ALLOWLIST, not the caller's object. `UpdateAssetInput` omits `state`, but a type is erased
    // at runtime and this patch arrives as JSON — spreading it would let `{"state":"approved"}`
    // route straight around review. Same for id, channelId, version and the audit fields.
    const safe = pickUpdatable(patch);
    // A term field CHANGED must name a live term; one re-sent unchanged is left as it is, so a
    // value written before the vocabulary existed does not block an unrelated edit.
    await this.requireTerms(
      existing.channelId,
      Object.fromEntries(
        Object.entries(safe).filter(([f, v]) => v !== existing[f as keyof UpdateAssetInput]),
      ),
    );

    const changedFields = [
      ...(Object.keys(safe) as (keyof UpdateAssetInput)[]).filter(
        (key) => safe[key] !== undefined && safe[key] !== existing[key],
      ),
      // Inheriting a field the asset set is a change; inheriting one it never set is not.
      ...inherit.filter((f) => existing[f] !== undefined),
    ];
    // No-op PATCHes are common from UIs that submit whole forms. Emitting `asset.updated` with an
    // empty changedFields would both violate the contract (minItems: 1) and wake every consumer
    // for nothing.
    if (changedFields.length === 0) return existing;

    // Authorized on the groups the CHANGED fields belong to, after the no-op check — so a form
    // resubmitting an untouched `expiresAt` does not demand a rights grant to change a title.
    // A patch spanning several groups needs all of them; holding one is not holding the others.
    this.authorizeGroups(
      caller,
      'asset:write',
      await this.scopeOf(existing),
      groupsForCoreFields(changedFields),
    );
    // Moving an asset INTO a category is a write there too: a writer scoped to /news/ cannot
    // file an asset under /sports/ (#260). The target must also be a live, addable category.
    if (changedFields.includes('categoryId') && safe.categoryId !== undefined) {
      const target = await this.requireCategory(caller.channelId, safe.categoryId);
      this.authorizeGroups(
        caller,
        'asset:write',
        { categoryPath: target.path, ...defined({ ownerId: existing.createdBy }) },
        groupsForCoreFields(['categoryId']),
      );
    }

    const updated: Asset = {
      ...existing,
      ...defined(safe),
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
    };
    for (const field of inherit) delete updated[field];
    // An expiry set by hand is the asset's own, whatever a category default once put there.
    if (changedFields.includes('expiresAt')) delete updated.expirySource;

    await this.commit(
      caller,
      updated,
      existing,
      'asset.updated',
      {
        assetId: updated.id,
        changedFields,
        source: 'user',
        // The one lifecycle value an edit changes, carried with its name: Scheduling keeps each
        // approval's expiry to validate against (EP-31) and must not have to read it back.
        ...(changedFields.includes('expiresAt') ? { expiresAt: updated.expiresAt ?? null } : {}),
      },
      // `title` and `description` are indexed, so this path must reindex. Tags and the extended
      // document are untouched here, and are read rather than assumed empty — assuming would
      // silently strip every tag term from the index on an ordinary rename.
      await this.sourcesFor(existing),
    );

    return updated;
  }

  /**
   * Move an asset through its lifecycle.
   *
   * The single entry point for state change — `update()` cannot touch `state`, so review cannot be
   * routed around by a metadata PATCH.
   */
  async transition(
    caller: Caller,
    id: string,
    action: LifecycleAction,
    options: { expiresAt?: string; retainUntil?: string; reason?: string } = {},
  ): Promise<Asset> {
    return this.onCurrent(() => this.transitionOnce(caller, id, action, options));
  }

  private async transitionOnce(
    caller: Caller,
    id: string,
    action: LifecycleAction,
    options: { expiresAt?: string; retainUntil?: string; reason?: string },
  ): Promise<Asset> {
    const existing = await this.fresh(caller, id);

    // Approving is its own permission: someone who may edit metadata is not thereby entitled to
    // sign an asset off for air.
    const permission =
      action === 'approve' || action === 'reject' ? 'asset:approve' : 'asset:write';
    this.authorize(caller, permission, await this.scopeOf(existing));

    // The contract makes `reason` required on asset.rejected, and it is right to. A rejection with
    // no stated cause leaves whoever has to fix the asset with nothing to act on — and it would be
    // caught by schema validation anyway, but as an opaque 500 instead of a clear 422.
    if (action === 'reject' && !options.reason?.trim()) {
      throw new ValidationError('a rejection must state a reason');
    }

    const context = await this.contextFor(existing);
    const result = canTransition(context, action);
    if (!result.allowed) {
      throw new Conflict(result.reason ?? `cannot ${action} this asset`);
    }

    const updated: Asset = {
      ...existing,
      state: result.next ?? existing.state,
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
      ...defined({ expiresAt: options.expiresAt, retainUntil: options.retainUntil }),
    };
    // FR-APP-7 / FR-TAX-7: approved with no expiry of its own and none given, the media takes its
    // category's `defaultExpiry` — SNAPSHOTTED here (data-model §2.2's one exception to live
    // inheritance), so a later category edit never re-expires media already approved.
    if (action === 'approve' && updated.expiresAt === undefined) {
      const spec = (await this.inheritanceOf(existing)).policies.defaultExpiry;
      const expiresAt = spec ? expiryFrom(spec.value, updated.updatedAt) : undefined;
      if (expiresAt !== undefined) {
        updated.expiresAt = expiresAt;
        updated.expirySource = 'category';
      }
    }

    const eventType = eventFor(action);
    if (eventType === undefined) {
      // An internal step with no contract event still commits — and is still audited. It used to
      // commit with a bare `tx.put`, which is a mutation nothing could ever account for.
      await this.commitWith(caller, updated, existing, { action: `asset.${action}` });
      return updated;
    }

    await this.commit(
      caller,
      updated,
      existing,
      eventType,
      this.payloadFor(caller, eventType, updated, options),
    );
    return updated;
  }

  /** Attach renditions — normally driven by `transcode.completed` from MTS. */
  async attachRenditions(caller: Caller, id: string): Promise<Asset> {
    return this.onCurrent(() => this.attachRenditionsOnce(caller, id));
  }

  private async attachRenditionsOnce(caller: Caller, id: string): Promise<Asset> {
    const existing = await this.fresh(caller, id);
    // `files` — renditions are the file set, which §3.1 puts in the Librarian's half, not the
    // Editor's. Normally driven by MTS rather than by a person, but the grant is what it is.
    this.authorize(caller, 'asset:write', await this.scopeOf(existing), 'files');
    const updated: Asset = {
      ...existing,
      hasRenditions: true,
      // A mutation, so a revision — every other write bumps it, and the audit record is keyed on it.
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.commitWith(caller, updated, existing, { action: 'asset.attachRenditions' });
    return updated;
  }

  // --- the FileRef mirror (EP-17.8) ---------------------------------------------------------------
  //
  // HSM is the system of record for where a file is and whether it is intact; MTS produces the
  // renditions. MAM keeps a COPY of what they announce, so the asset's files can be read here.
  // Each consumer is one unit of work — the seen-mark, the rows, the audit — committed together,
  // so a redelivery is a duplicate and a crash mid-way is a retry (EP-03.3). An event for an
  // asset this channel does not have is thrown: ordering may deliver it again after the asset
  // exists, and if not the broker's dead-letter queue shows it to a person.

  /** The asset's files as last mirrored. `files` is the Librarian's group (§3.1), read here. */
  async files(caller: Caller, assetId: string): Promise<FileRef[]> {
    const asset = await this.get(caller, assetId);
    this.authorize(caller, 'asset:read', await this.scopeOf(asset), 'files');
    return this.options.store.filesOf(assetId);
  }

  /**
   * `transcode.completed`: every rendition becomes (or replaces) a FileRef, and the asset has
   * renditions — the same bump `attachRenditions` makes, with the same audit action, plus one
   * audit record per file at the file's own revision. An asset that already HAS renditions is not
   * written at all: a second completion changes its files, not the asset, and a revision whose
   * delta is empty records nothing (it used to bump anyway, and every such bump was one more writer
   * racing the editor — #385).
   *
   * The asset write is compare-and-set on the version read here: if an editor committed in
   * between, the StaleWrite goes to the broker and the redelivery reads afresh.
   */
  async mirrorTranscode(msg: Message): Promise<MirrorOutcome> {
    const envelope = this.envelopeOf<EventPayloads['transcode.completed']>(
      msg,
      'transcode.completed',
    );
    const { assetId, renditions } = envelope.payload;
    const existing = await this.assetInChannel(assetId, envelope.channelId);
    const current = new Map(
      (await this.options.store.filesOf(assetId)).map((f) => [fileKey(f.kind, f.variant), f]),
    );
    const now = this.now().toISOString();
    const files = renditions.map((r) =>
      fileFromRendition(r, {
        channelId: envelope.channelId,
        assetId,
        messageId: msg.id,
        now,
        ...defined({ existing: current.get(fileKey(r.kind, undefined)) }),
      }),
    );
    const updated: Asset | undefined = existing.hasRenditions
      ? undefined
      : { ...existing, hasRenditions: true, version: existing.version + 1, updatedAt: now };
    const caller = systemCaller(envelope.channelId, envelope);
    const assetAudit = updated
      ? this.auditRecord(caller, updated, existing, 'asset.attachRenditions')
      : undefined;
    const fileAudits = files.map((f) =>
      this.fileAudit(caller, f, current.get(fileKey(f.kind, f.variant)), 'transcode.completed'),
    );
    let outcome: MirrorOutcome = 'applied';
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      if (updated) await tx.put(updated, existing.version);
      for (const f of files) await tx.putFile(f);
      if (assetAudit) await tx.enqueue(assetAudit);
      for (const a of fileAudits) await tx.enqueue(a);
    });
    if (updated) await this.evictCached(assetId);
    return outcome;
  }

  /**
   * `file.placed`: the ledger's word on where a file is — its path and tier, and the checksum
   * when HSM sent one — on the row of that kind, or a new row when nothing announced the file
   * before (the original, placed after ingest). The asset row does not change.
   */
  async mirrorPlacement(msg: Message): Promise<MirrorOutcome> {
    const envelope = this.envelopeOf<EventPayloads['file.placed']>(msg, 'file.placed');
    const placed = envelope.payload;
    await this.assetInChannel(placed.assetId, envelope.channelId);
    const kind = placed.renditionKind ?? 'original';
    const existing = (await this.options.store.filesOf(placed.assetId)).find(
      (f) => f.kind === kind && f.variant === placed.variant,
    );
    const file = fileFromPlacement(placed, {
      channelId: envelope.channelId,
      messageId: msg.id,
      now: this.now().toISOString(),
      ...defined({ existing }),
    });
    const caller = systemCaller(envelope.channelId, envelope);
    const audit = this.fileAudit(caller, file, existing, 'file.placed');
    let outcome: MirrorOutcome = 'applied';
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      await tx.putFile(file);
      await tx.enqueue(audit);
    });
    return outcome;
  }

  /**
   * `file.moved`: HSM moved a file's bytes to another tier (ADR-0009). The row of that kind and
   * variant takes the new path and tier. A move for a row this mirror has not seen yet is THROWN —
   * `file.placed` travels on another subject and may not have been applied yet; the redelivery finds
   * it. Skipping would leave the row pointing at bytes that are gone.
   */
  async mirrorMove(msg: Message): Promise<MirrorOutcome> {
    const envelope = this.envelopeOf<EventPayloads['file.moved']>(msg, 'file.moved');
    const moved = envelope.payload;
    await this.assetInChannel(moved.assetId, envelope.channelId);
    const kind = moved.renditionKind ?? 'original';
    const existing = (await this.options.store.filesOf(moved.assetId)).find(
      (f) => f.kind === kind && f.variant === moved.variant,
    );
    if (!existing) {
      throw new NotFound(`no ${kind} file of asset ${moved.assetId} to move yet`);
    }
    const file = fileFromMove(moved, existing, {
      messageId: msg.id,
      now: this.now().toISOString(),
    });
    const caller = systemCaller(envelope.channelId, envelope);
    const audit = this.fileAudit(caller, file, existing, 'file.moved');
    let outcome: MirrorOutcome = 'applied';
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      await tx.putFile(file);
      await tx.enqueue(audit);
    });
    return outcome;
  }

  /**
   * `ingest.accepted` (EP-15.5; mam.md §5 "create asset"): RIM accepted a file and placed it in HSM
   * as the original of an asset whose id RIM minted — the job's own id. MAM creates that asset, in
   * state `created`, with what RIM said about the file (title from the filename, media and file
   * type from the probe, who brought it in). The seen-mark commits with the asset, so a redelivery
   * is a duplicate; an asset that already exists in the SAME channel is a duplicate too (the
   * message was applied before its mark could be checked — or RIM's retry announced it twice); one
   * in ANOTHER channel is thrown, never overwritten.
   */
  async createFromIngest(msg: Message): Promise<MirrorOutcome> {
    const envelope = this.envelopeOf<EventPayloads['ingest.accepted']>(msg, 'ingest.accepted');
    const accepted = envelope.payload;
    const existing = await this.options.store.get(accepted.assetId);
    if (existing) {
      if (existing.channelId !== envelope.channelId) {
        throw new Conflict(`asset ${accepted.assetId} exists in another channel`);
      }
      return 'duplicate';
    }
    const at = this.now().toISOString();
    const asset: Asset = {
      id: accepted.assetId,
      channelId: envelope.channelId,
      title: accepted.title ?? accepted.filename ?? accepted.assetId,
      mediaType: accepted.mediaType ?? 'other',
      fileType: accepted.fileType ?? 'bin',
      state: 'created',
      version: 1,
      hasRenditions: false,
      createdBy: accepted.createdBy ?? 'rim',
      createdAt: at,
      updatedAt: at,
      ...defined({ durationSec: accepted.technicalMetadata?.durationSec }),
    };
    const caller = systemCaller(envelope.channelId, envelope);
    const duplicate = new Error('duplicate');
    try {
      await this.commitWith(
        caller,
        asset,
        undefined,
        {
          type: 'asset.created',
          payload: {
            assetId: asset.id,
            core: {
              title: asset.title,
              fileType: asset.fileType,
              ...defined({ durationSec: asset.durationSec }),
            },
          },
        },
        async (tx) => {
          if (!(await tx.markSeen(msg.id))) throw duplicate;
        },
        { tagLabels: [], extended: {} },
      );
    } catch (err) {
      if (err === duplicate) return 'duplicate';
      throw err;
    }
    return 'applied';
  }

  /** The envelope, checked for shape, type and payload — a message that is not one is refused for good. */
  private envelopeOf<P extends object>(msg: Message, type: string): Envelope<P> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid) {
      throw new ValidationError(
        `message ${msg.id} on ${msg.subject} is not an envelope: ${shape.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    const envelope = msg.body as Envelope;
    if (envelope.type !== type) {
      throw new ValidationError(`message ${msg.id} is a ${envelope.type}, not a ${type}`);
    }
    const check = validatePayload(type, envelope.payload);
    if (!check.valid) {
      throw new ValidationError(
        `${type} ${msg.id} does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    return envelope as unknown as Envelope<P>;
  }

  private async assetInChannel(assetId: string, channelId: string): Promise<Asset> {
    const asset = await this.options.store.get(assetId);
    if (!asset || asset.channelId !== channelId) {
      throw new NotFound(`no asset ${assetId} in channel ${channelId}`);
    }
    return asset;
  }

  /** The audit record of one file row (EP-19.2): entity `file`, revision the row's own version. */
  private fileAudit(
    caller: Caller,
    file: FileRef,
    before: FileRef | undefined,
    action: string,
  ): { id: string; message: { id: string; subject: string; body: Envelope } } {
    const payload: EventPayloads['audit.recorded'] = {
      entityType: 'file',
      entityId: file.id,
      revision: file.version,
      action,
      origin: { service: 'mam' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        file as unknown as Record<string, unknown>,
      ),
    };
    return this.eventRecord(caller, file.channelId, 'audit.recorded', payload);
  }

  // --- the category tree (#260; data-model.md §2.6) ------------------------------------------------
  //
  // A tree per channel, its paths built from immutable keys. Read under `taxonomy:read`, written
  // under `taxonomy:admin` over the node's path — a channel's sports editor may hold it over
  // `/sports/` alone — with the write's field group: `core` (labels, kind, order, description) or
  // `policies` (mediaAddable, deprecation), as the authorization model groups a category. Every
  // write is a revision: the row (compare-and-set on its version), `taxonomy.updated` and an
  // `audit.recorded` delta commit together.

  /** The channel's tree in path order — the live part, unless the deprecated is asked for. */
  async categories(
    caller: Caller,
    options: { includeDeprecated?: boolean } = {},
  ): Promise<Category[]> {
    this.authorize(caller, 'taxonomy:read');
    const all = await this.options.store.categories(caller.channelId);
    return options.includeDeprecated ? all : live(all);
  }

  async category(caller: Caller, id: string): Promise<Category> {
    this.authorize(caller, 'taxonomy:read');
    return this.categoryInChannel(caller.channelId, id);
  }

  /** What a category inherits from its ancestors: each default and policy it does not set. */
  async categoryInherited(
    caller: Caller,
    id: string,
  ): Promise<Inheritance & { categoryId: string }> {
    this.authorize(caller, 'taxonomy:read');
    const node = await this.categoryInChannel(caller.channelId, id);
    const tree = await this.options.store.categories(caller.channelId);
    return { categoryId: node.id, ...inheritedByCategory(chainOf(tree, node)) };
  }

  async createCategory(caller: Caller, input: Partial<CreateCategoryInput>): Promise<Category> {
    refuse(createProblems(input));
    const valid = input as CreateCategoryInput;
    const parent =
      valid.parentId === undefined
        ? undefined
        : await this.categoryInChannel(caller.channelId, valid.parentId);
    await this.requireTerms(caller.channelId, valid.defaults ?? {}, 'defaults.');
    const path = childPath(parent?.path, valid.key);
    const depth = (parent?.depth ?? 0) + 1;
    this.authorizeCategory(caller, path, [
      'core',
      ...(valid.defaults !== undefined ? ['defaults'] : []),
      ...(valid.mediaAddable !== undefined || POLICY_FIELDS.some((f) => valid[f] !== undefined)
        ? ['policies']
        : []),
    ]);
    if (depth > MAX_CATEGORY_DEPTH) {
      throw new ValidationError(`a category may be at most ${MAX_CATEGORY_DEPTH} levels deep`);
    }
    if (parent && (await this.deprecatedAt(parent))) {
      throw new ValidationError(`${parent.path} is deprecated — restore it before adding below it`);
    }
    const at = this.now().toISOString();
    const category: Category = {
      id: ulid(),
      channelId: caller.channelId,
      key: valid.key,
      path,
      depth,
      labels: trimmedLabels(valid.labels),
      sortOrder: valid.sortOrder ?? 0,
      mediaAddable: valid.mediaAddable ?? true,
      version: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      ...defined({
        parentId: parent?.id,
        kind: valid.kind?.trim() || undefined,
        description: valid.description,
        defaults:
          valid.defaults && Object.keys(valid.defaults).length > 0 ? valid.defaults : undefined,
        reviewNeeded: valid.reviewNeeded,
        keepDuration: valid.keepDuration,
        defaultExpiry: valid.defaultExpiry,
      }),
    };
    await this.options.store.transaction(async (tx) => {
      await tx.putCategory(category);
      await tx.enqueue(this.categoryEvent(caller, category, 'created'));
      await tx.enqueue(this.categoryAudit(caller, category, undefined, 'category.created'));
    });
    return category;
  }

  async updateCategory(
    caller: Caller,
    id: string,
    version: number,
    input: Partial<UpdateCategoryInput> & Record<string, unknown>,
  ): Promise<Category> {
    refuse(updateProblems(input));
    const existing = await this.categoryInChannel(caller.channelId, id);
    // The category's own groups (authorization-model.md §4): `defaults` — what the media below
    // inherit — and `policies` — how the platform treats them — beside `core`; an `inherit` of a
    // field needs that field's group, since taking a value away is as much a change as setting one.
    const inherit = input.inherit ?? [];
    const groups = [
      ...(['labels', 'kind', 'sortOrder', 'description'].some((f) => input[f] !== undefined)
        ? ['core']
        : []),
      ...(input.defaults !== undefined ||
      inherit.some((f) => (MEDIA_DEFAULT_FIELDS as readonly string[]).includes(f))
        ? ['defaults']
        : []),
      ...(input.mediaAddable !== undefined ||
      input.deprecated !== undefined ||
      POLICY_FIELDS.some((f) => input[f] !== undefined) ||
      inherit.some((f) => (POLICY_FIELDS as readonly string[]).includes(f))
        ? ['policies']
        : []),
    ];
    this.authorizeCategory(caller, existing.path, groups);
    if (existing.version !== version) throw new StaleCategory(id, version);
    await this.requireTerms(caller.channelId, input.defaults ?? {}, 'defaults.');

    const next: Category = {
      ...existing,
      ...defined({
        labels: input.labels === undefined ? undefined : trimmedLabels(input.labels),
        kind: input.kind,
        sortOrder: input.sortOrder,
        mediaAddable: input.mediaAddable,
        description: input.description,
        reviewNeeded: input.reviewNeeded,
        keepDuration: input.keepDuration,
        defaultExpiry: input.defaultExpiry,
      }),
    };
    // Defaults MERGE: a field given is set, the rest kept; `inherit` takes a field off the node.
    const defaults: Record<string, string> = { ...existing.defaults, ...input.defaults };
    for (const field of inherit) {
      delete defaults[field];
      if ((POLICY_FIELDS as readonly string[]).includes(field)) {
        delete next[field as (typeof POLICY_FIELDS)[number]];
      }
    }
    if (Object.keys(defaults).length > 0) next.defaults = defaults;
    else delete next.defaults;
    if (input.deprecated === true && existing.deprecatedAt === undefined) {
      next.deprecatedAt = this.now().toISOString();
    }
    if (input.deprecated === false) delete next.deprecatedAt;
    if (JSON.stringify(next) === JSON.stringify(existing)) return existing; // nothing to record

    next.version = existing.version + 1;
    next.updatedAt = this.now().toISOString();
    const action =
      input.deprecated === true && existing.deprecatedAt === undefined ? 'deprecated' : 'updated';
    await this.options.store.transaction(async (tx) => {
      await tx.putCategory(next, existing.version);
      await tx.enqueue(this.categoryEvent(caller, next, action));
      await tx.enqueue(this.categoryAudit(caller, next, existing, `category.${action}`));
    });
    return next;
  }

  /**
   * Move a category, and everything below it, under another parent (or to the root) — in ONE
   * transaction, every node a revision. Grants follow the position: a grant on the old path stops
   * covering the subtree, one on the new path starts to — so the mover must hold `taxonomy:admin`
   * over BOTH (data-model.md §2.6).
   */
  async moveCategory(
    caller: Caller,
    id: string,
    input: { parentId?: string | null; version?: unknown },
  ): Promise<Category> {
    if (typeof input.version !== 'number' || !Number.isInteger(input.version)) {
      throw new ValidationError('version is required — the version of the category as read');
    }
    const existing = await this.categoryInChannel(caller.channelId, id);
    const target =
      input.parentId === undefined || input.parentId === null
        ? undefined
        : await this.categoryInChannel(caller.channelId, input.parentId);
    const destination = childPath(target?.path, existing.key);
    this.authorizeCategory(caller, existing.path, ['core']);
    this.authorizeCategory(caller, destination, ['core']);
    if (existing.version !== input.version) throw new StaleCategory(id, input.version);
    if ((target?.id ?? undefined) === existing.parentId) return existing; // already there
    if (target && within(target.path, existing.path)) {
      throw new ValidationError('a category cannot move under itself or one of its descendants');
    }

    const all = await this.options.store.categories(caller.channelId);
    const subtree = all.filter((c) => within(c.path, existing.path));
    const after = moved(subtree, existing, target);
    const deepest = Math.max(...after.map((c) => c.depth));
    if (deepest > MAX_CATEGORY_DEPTH) {
      throw new ValidationError(
        `the move would put a category ${deepest} levels deep; at most ${MAX_CATEGORY_DEPTH}`,
      );
    }
    const at = this.now().toISOString();
    const before = new Map(subtree.map((c) => [c.id, c]));
    const writes = after.map((c) => ({ ...c, version: c.version + 1, updatedAt: at }));
    await this.options.store.transaction(async (tx) => {
      for (const c of writes) {
        const was = before.get(c.id)!;
        await tx.putCategory(c, was.version);
        await tx.enqueue(this.categoryAudit(caller, c, was, 'category.moved'));
      }
      await tx.enqueue(this.categoryEvent(caller, writes[0]!, 'moved'));
    });
    return writes.find((c) => c.id === id)!;
  }

  private authorizeCategory(caller: Caller, path: string, groups: readonly string[]): void {
    for (const group of groups.length > 0 ? groups : [undefined]) {
      const decision = canEnforce(caller.policy, 'taxonomy:admin', {
        channelId: caller.channelId,
        categoryPath: path,
        ...defined({ fieldGroup: group }),
      });
      if (!decision.allowed) throw new Forbidden(decision.reason ?? 'missing taxonomy:admin');
    }
  }

  private async categoryInChannel(channelId: string, id: string): Promise<Category> {
    const category = await this.options.store.category(id);
    // Another channel's category is NOT FOUND, like another channel's asset.
    if (!category || category.channelId !== channelId) throw new NotFound(`no category ${id}`);
    return category;
  }

  /** When the category or an ancestor was deprecated — a deprecated branch takes no new media. */
  private async deprecatedAt(category: Category): Promise<string | undefined> {
    if (category.deprecatedAt) return category.deprecatedAt;
    const all = await this.options.store.categories(category.channelId);
    return all.find((c) => c.deprecatedAt && within(category.path, c.path))?.deprecatedAt;
  }

  /**
   * The category an asset is being put in: one of this channel's, live (neither it nor an ancestor
   * deprecated), and taking media directly (#260). A 422 otherwise — `categoryId` was an opaque
   * string nothing checked, and an asset could be filed under a category that did not exist.
   */
  private async requireCategory(channelId: string, id: string): Promise<Category> {
    const category = await this.options.store.category(id);
    if (!category || category.channelId !== channelId) {
      throw new ValidationError(`categoryId ${id} names no category of this channel`);
    }
    if (await this.deprecatedAt(category)) {
      throw new ValidationError(`${category.path} is deprecated — choose another category`);
    }
    if (!category.mediaAddable) {
      throw new ValidationError(
        `media cannot be added directly to ${category.path} — choose a category below it`,
      );
    }
    return category;
  }

  /** The category ids a browse filter matches: the one, or the one and everything below it. */
  private async categoryFilter(channelId: string, id: string, subtree: boolean): Promise<string[]> {
    if (!subtree) return [id];
    const all = await this.options.store.categories(channelId);
    const root = all.find((c) => c.id === id);
    return root ? all.filter((c) => within(c.path, root.path)).map((c) => c.id) : [];
  }

  private categoryEvent(
    caller: Caller,
    category: Category,
    action: 'created' | 'updated' | 'moved' | 'deprecated',
  ): ReturnType<MamService['eventRecord']> {
    return this.eventRecord(caller, category.channelId, 'taxonomy.updated', {
      kind: 'category',
      action,
      id: category.id,
      label: labelOf(category),
      path: category.path,
      ...defined({ parentId: category.parentId }),
    } satisfies EventPayloads['taxonomy.updated']);
  }

  /** The audit record of one category revision: entity `category`, revision its own version. */
  private categoryAudit(
    caller: Caller,
    category: Category,
    before: Category | undefined,
    action: string,
  ): ReturnType<MamService['eventRecord']> {
    const payload: EventPayloads['audit.recorded'] = {
      entityType: 'category',
      entityId: category.id,
      revision: category.version,
      action,
      origin: { service: 'mam' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        category as unknown as Record<string, unknown>,
      ),
    };
    return this.eventRecord(caller, category.channelId, 'audit.recorded', payload);
  }

  // --- controlled vocabularies (EP-28.3) --------------------------------------
  //
  // configuration-and-reference-data.md §2.3: stable id, mutable label; deprecate, never delete;
  // merge as one audited operation; a key for imports. Governed by `taxonomy:admin` in the channel —
  // with no category path, so a grant narrowed to a subtree cannot edit a channel-wide vocabulary.

  /** A vocabulary's terms, live unless the deprecated (and merged) are asked for. */
  async terms(
    caller: Caller,
    vocabulary: string,
    options: { includeDeprecated?: boolean } = {},
  ): Promise<VocabularyTerm[]> {
    this.authorize(caller, 'taxonomy:read');
    const all = await this.options.store.terms(caller.channelId, this.vocabulary(vocabulary));
    return options.includeDeprecated ? all : all.filter((t) => t.deprecatedAt === undefined);
  }

  async term(caller: Caller, vocabulary: string, id: string): Promise<VocabularyTerm> {
    this.authorize(caller, 'taxonomy:read');
    return this.termIn(caller.channelId, this.vocabulary(vocabulary), id);
  }

  async createTerm(
    caller: Caller,
    vocabulary: string,
    input: Partial<CreateTermInput>,
  ): Promise<VocabularyTerm> {
    const vocab = this.vocabulary(vocabulary);
    this.authorizeVocabulary(caller);
    refuseTerm(createTermProblems(input));
    const valid = input as CreateTermInput;
    const at = this.now().toISOString();
    const term: VocabularyTerm = {
      id: ulid(),
      vocabulary: vocab,
      channelId: caller.channelId,
      key: valid.key,
      labels: trimmedLabels(valid.labels),
      sortOrder: valid.sortOrder ?? 0,
      version: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      ...defined({
        description: valid.description,
        colour: valid.colour,
        external: valid.external,
      }),
    };
    await this.options.store.transaction(async (tx) => {
      await tx.putTerm(term);
      await tx.enqueue(this.termEvent(caller, term, 'created'));
      await tx.enqueue(this.termAudit(caller, term, undefined, 'vocabulary-term.created'));
    });
    return term;
  }

  async updateTerm(
    caller: Caller,
    vocabulary: string,
    id: string,
    version: number,
    input: Partial<UpdateTermInput> & Record<string, unknown>,
  ): Promise<VocabularyTerm> {
    const vocab = this.vocabulary(vocabulary);
    this.authorizeVocabulary(caller);
    refuseTerm(updateTermProblems(input));
    const existing = await this.termIn(caller.channelId, vocab, id);
    if (existing.version !== version) throw new StaleTerm(id, version);
    if (input.deprecated === false && existing.replacedById !== undefined) {
      throw new ValidationError(
        `${existing.key} was merged into another term — it cannot be restored`,
      );
    }
    const next: VocabularyTerm = {
      ...existing,
      ...defined({
        labels: input.labels === undefined ? undefined : trimmedLabels(input.labels),
        description: input.description,
        sortOrder: input.sortOrder,
        colour: input.colour,
        external: input.external,
      }),
    };
    if (input.deprecated === true && existing.deprecatedAt === undefined) {
      next.deprecatedAt = this.now().toISOString();
    }
    if (input.deprecated === false) delete next.deprecatedAt;
    if (JSON.stringify(next) === JSON.stringify(existing)) return existing;
    next.version = existing.version + 1;
    next.updatedAt = this.now().toISOString();
    const action =
      input.deprecated === true && existing.deprecatedAt === undefined ? 'deprecated' : 'updated';
    await this.options.store.transaction(async (tx) => {
      await tx.putTerm(next, existing.version);
      await tx.enqueue(this.termEvent(caller, next, action));
      await tx.enqueue(this.termAudit(caller, next, existing, `vocabulary-term.${action}`));
    });
    return next;
  }

  /**
   * Merge a term INTO another of the same vocabulary (§2.3 rule 3): the term is deprecated with
   * `replacedById` pointing at the survivor — ONE audited write, no asset rewritten. Readers follow
   * the redirect; a write naming the merged term is refused with the survivor's name.
   */
  async mergeTerm(
    caller: Caller,
    vocabulary: string,
    id: string,
    input: { into?: unknown; version?: unknown },
  ): Promise<VocabularyTerm> {
    const vocab = this.vocabulary(vocabulary);
    this.authorizeVocabulary(caller);
    if (typeof input.version !== 'number' || !Number.isInteger(input.version)) {
      throw new ValidationError('version is required — the version of the term as read');
    }
    if (typeof input.into !== 'string') throw new ValidationError('into names the surviving term');
    const existing = await this.termIn(caller.channelId, vocab, id);
    if (existing.version !== input.version) throw new StaleTerm(id, input.version);
    if (existing.replacedById !== undefined) {
      throw new ValidationError(`${existing.key} is already merged`);
    }
    const into = await this.termIn(caller.channelId, vocab, input.into);
    if (into.id === existing.id) throw new ValidationError('a term cannot be merged into itself');
    if (into.deprecatedAt !== undefined) {
      throw new ValidationError(`${into.key} is deprecated — merge into a live term`);
    }
    const at = this.now().toISOString();
    const next: VocabularyTerm = {
      ...existing,
      replacedById: into.id,
      deprecatedAt: existing.deprecatedAt ?? at,
      version: existing.version + 1,
      updatedAt: at,
    };
    await this.options.store.transaction(async (tx) => {
      await tx.putTerm(next, existing.version);
      await tx.enqueue(this.termEvent(caller, next, 'merged'));
      await tx.enqueue(this.termAudit(caller, next, existing, 'vocabulary-term.merged'));
    });
    return next;
  }

  /**
   * Every term a write names must be a live term of the field's vocabulary in this channel
   * (EP-28.3, decided with the product owner: the fields hold term ids). A merged term is refused
   * with the survivor named, a deprecated one as such, anything else as unknown — a 422 either way.
   */
  private async requireTerms(
    channelId: string,
    values: Partial<Record<string, unknown>>,
    where = '',
  ): Promise<void> {
    const problems: string[] = [];
    for (const [field, vocab] of Object.entries(TERM_FIELDS) as [TermField, Vocabulary][]) {
      const id = values[field];
      if (typeof id !== 'string') continue;
      const term = await this.options.store.term(id);
      if (!term || term.channelId !== channelId || term.vocabulary !== vocab) {
        problems.push(`${where}${field} must name a term of the ${vocab} vocabulary`);
      } else if (term.replacedById !== undefined) {
        const all = await this.options.store.terms(channelId, vocab);
        const survivor = resolveTerm(term, new Map(all.map((t) => [t.id, t])));
        problems.push(
          `${where}${field}: ${term.key} was merged into ${survivor.key} (${survivor.id}) — use that`,
        );
      } else if (term.deprecatedAt !== undefined) {
        problems.push(`${where}${field}: ${term.key} is deprecated — choose a live term`);
      }
    }
    if (problems.length > 0) throw new ValidationError(problems.join('; '));
  }

  private vocabulary(name: string): Vocabulary {
    if (!isVocabulary(name)) {
      throw new NotFound(`no vocabulary ${name} — one of ${VOCABULARIES.join(', ')}`);
    }
    return name;
  }

  private authorizeVocabulary(caller: Caller): void {
    const decision = canEnforce(caller.policy, 'taxonomy:admin', { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? 'missing taxonomy:admin');
  }

  private async termIn(
    channelId: string,
    vocabulary: Vocabulary,
    id: string,
  ): Promise<VocabularyTerm> {
    const term = await this.options.store.term(id);
    // Another channel's — or another vocabulary's — term is NOT FOUND here.
    if (!term || term.channelId !== channelId || term.vocabulary !== vocabulary) {
      throw new NotFound(`no ${vocabulary} term ${id}`);
    }
    return term;
  }

  private termEvent(
    caller: Caller,
    term: VocabularyTerm,
    action: 'created' | 'updated' | 'deprecated' | 'merged',
  ): ReturnType<MamService['eventRecord']> {
    return this.eventRecord(caller, term.channelId, 'taxonomy.updated', {
      kind: term.vocabulary,
      action,
      id: term.id,
      label: termLabel(term),
      ...defined({ replacedById: term.replacedById }),
    } satisfies EventPayloads['taxonomy.updated']);
  }

  /** One term revision: entity `vocabulary-term`, revision its own version. */
  private termAudit(
    caller: Caller,
    term: VocabularyTerm,
    before: VocabularyTerm | undefined,
    action: string,
  ): ReturnType<MamService['eventRecord']> {
    const payload: EventPayloads['audit.recorded'] = {
      entityType: 'vocabulary-term',
      entityId: term.id,
      revision: term.version,
      action,
      origin: { service: 'mam' },
      delta: delta(
        before as unknown as Record<string, unknown> | undefined,
        term as unknown as Record<string, unknown>,
      ),
    };
    return this.eventRecord(caller, term.channelId, 'audit.recorded', payload);
  }

  // --- extensible metadata (EP-17.2) -----------------------------------------

  /**
   * The extensible document, the fields that govern it, and anything orphaned.
   *
   * All three together because none is useful alone: values without their definitions cannot be
   * rendered or labelled, and definitions without values cannot be filled in.
   */
  async extended(
    caller: Caller,
    id: string,
    options: ReadOptions = {},
  ): Promise<{
    values: ExtendedValues;
    fields: FieldDefinition[];
    orphaned: string[];
  }> {
    const fresh = options.fresh ?? false;
    const asset = await this.get(caller, id, options);
    // The RAW document is what is cached; the schema join happens here, on every read, so a
    // schema change needs no eviction.
    const [values, fields] = await Promise.all([
      this.cachedExtended(id, fresh),
      this.fieldsFor(asset),
    ]);
    const stored = values ?? {};
    return { values: stored, fields, orphaned: orphanedFields(fields, stored) };
  }

  /**
   * Patch the extensible document.
   *
   * A MERGE, not a replacement: a form that submits one section must not erase the others. An
   * explicit `null` clears a field, which is the only way to express removal in a merge — omitting
   * it means "leave alone".
   */
  async updateExtended(
    caller: Caller,
    id: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ExtendedValues> {
    return this.onCurrent(() => this.updateExtendedOnce(caller, id, patch));
  }

  private async updateExtendedOnce(
    caller: Caller,
    id: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ExtendedValues> {
    const asset = await this.fresh(caller, id);

    const fields = await this.fieldsFor(asset);
    const errors = validateExtended(fields, patch, {
      ...defined({ vocabularies: this.options.vocabularies?.() }),
    });
    if (errors.length > 0) {
      throw new ValidationError(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    }

    // Authorized AFTER validation, on the groups the patched fields declare. Order matters here:
    // an unknown field is already refused above, so the group lookup below only ever sees fields
    // that exist — otherwise a caller could probe which field names are defined by watching a 403
    // turn into a 422.
    this.authorizeGroups(
      caller,
      'asset:write',
      await this.scopeOf(asset),
      groupsForExtended(fields, Object.keys(patch)),
    );

    const current = (await this.options.store.extended(id)) ?? {};
    const merged: ExtendedValues = { ...current };
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) delete merged[name];
      else merged[name] = value;
    }

    // Same transaction as the version bump: the document and the record it belongs to move
    // together, so a reader can never see a version that does not match the metadata.
    const updated: Asset = {
      ...asset,
      version: asset.version + 1,
      updatedAt: this.now().toISOString(),
    };
    const changedFields = Object.keys(patch).map((name) => `${EXTENDED_PREFIX}${name}`);
    if (changedFields.length === 0) return current;

    await this.commitWith(
      caller,
      updated,
      asset,
      {
        type: 'asset.updated',
        payload: { assetId: updated.id, changedFields, source: 'user' },
        // The document is in its own table: the record diff sees only the version bump.
        delta: { extended: { before: current, after: merged } },
      },
      async (tx) => tx.putExtended(id, asset.channelId, merged),
      // The MERGED document, not the stored one — a value written by this very call has to be
      // findable the moment it commits, and `sourcesFor` would read the version it replaces.
      { tagLabels: (await this.options.store.tagsOf(id)).map((t) => t.label), extended: merged },
    );

    return merged;
  }

  /** Define or replace a FieldSchema. Operator-managed configuration, not asset data. */
  async putSchema(caller: Caller, schema: FieldSchema): Promise<FieldSchema> {
    // `taxonomy:admin`, not `asset:write`: editing a schema changes what every asset in its scope
    // must carry, which is a governance action rather than an editorial one.
    this.authorize(caller, 'taxonomy:admin');
    if (schema.channelId !== caller.channelId) {
      throw new Forbidden('a schema cannot be written into another channel');
    }
    await this.options.store.transaction(async (tx) => tx.putSchema(schema));
    return schema;
  }

  async schemas(caller: Caller): Promise<FieldSchema[]> {
    this.authorize(caller, 'asset:read');
    return this.options.store.schemas(caller.channelId);
  }

  // --- free-form tags (EP-17.3) ----------------------------------------------

  /** The tags on one asset. Scoped and authorized by {@link get}. */
  async tags(caller: Caller, id: string, options: ReadOptions = {}): Promise<Tag[]> {
    const asset = await this.get(caller, id, options);
    return this.cachedTags(asset.id, options.fresh ?? false);
  }

  /**
   * Every tag in the caller's channel — the cloud, and what an autocomplete offers.
   *
   * `taxonomy:read`, not the `taxonomy:admin` the service catalogue lists against `GET /tags`. That
   * table describes the *management* surface; gating the read behind admin would make tag
   * autocomplete an administrator-only feature, which defeats free-form tagging for every editor
   * the feature exists for. Administering the vocabulary — renaming, merging, deleting — is still
   * `taxonomy:admin` and still unbuilt.
   */
  async listTags(caller: Caller): Promise<Tag[]> {
    this.authorize(caller, 'taxonomy:read');
    return this.options.store.listTags(caller.channelId);
  }

  /**
   * MAM's reference snapshot — its vocabularies and the version they are at (EP-04.8).
   *
   * Channel-scoped like every other read here, and behind the same `taxonomy:read` grant as
   * `listTags`: the snapshot IS the tag vocabulary, so serving it more freely would hand out under
   * one name exactly what is guarded under another.
   *
   * `config.changed` (configuration-and-reference-data.md §5 step 3) is not emitted yet — that
   * belongs with the admin write path in EP-33. Until then holders converge on their cache TTL,
   * which the design already allows for: "convergence is bounded by the cache TTL".
   */
  async referenceSnapshot(caller: Caller): Promise<MamReferenceSnapshot> {
    this.authorize(caller, 'taxonomy:read');
    const [configVersion, tags, categories, ...terms] = await Promise.all([
      this.options.store.configVersion(),
      this.options.store.listTags(caller.channelId),
      this.options.store.categories(caller.channelId),
      ...VOCABULARIES.map((v) => this.options.store.terms(caller.channelId, v)),
    ]);
    // The LIVE terms of each vocabulary: what a picker offers and a write is validated against.
    const vocabularyTerms = Object.fromEntries(
      VOCABULARIES.map((v, i) => [
        v,
        terms[i]!.filter((t) => t.deprecatedAt === undefined).map((t) => ({
          id: t.id,
          key: t.key,
          label: termLabel(t),
          labels: t.labels,
        })),
      ]),
    ) as Record<Vocabulary, VocabularyTermRef[]>;
    return {
      configVersion,
      vocabularies: {
        tag: tags.map((t) => ({ id: t.id, key: t.normalized, label: t.label })),
        // The LIVE tree — what a picker offers and what an asset write is validated against.
        category: live(categories).map((c) => ({
          id: c.id,
          key: c.key,
          label: labelOf(c),
          labels: c.labels,
          path: c.path,
          mediaAddable: c.mediaAddable,
          ...defined({ parentId: c.parentId }),
        })),
        ...vocabularyTerms,
      },
    };
  }

  /**
   * Replace an asset's tags.
   *
   * Whole-set: a tag input hands back the final list, and there is no partial form of "these are
   * the keywords". Labels the channel has not seen are minted on the spot — that is what makes a
   * tag free-form — and each minting is announced as `taxonomy.updated` so Search and Studio learn
   * about a new term without polling for one.
   */
  async setTags(caller: Caller, id: string, labels: readonly unknown[]): Promise<Tag[]> {
    return this.onCurrent(() => this.setTagsOnce(caller, id, labels));
  }

  private async setTagsOnce(
    caller: Caller,
    id: string,
    labels: readonly unknown[],
  ): Promise<Tag[]> {
    const asset = await this.fresh(caller, id);
    this.authorize(caller, 'asset:write', await this.scopeOf(asset), TAXONOMY_GROUP);

    const parsed = parseTagLabels(labels);
    if (parsed.errors.length > 0) throw new ValidationError(parsed.errors.join('; '));

    const current = await this.options.store.tagsOf(id);
    // Re-submitting the same set — which a form that PUTs on every keystroke does constantly — must
    // not bump the version or wake every consumer. Compared on the normalized form, so `FOOTBALL`
    // over an existing `football` is correctly nothing.
    if (sameTags(current, parsed.labels)) return current;

    // Candidate ids are minted HERE rather than in the adapter, so ULID generation stays a domain
    // concern and both stores behave identically. A candidate is used only if its label is new;
    // that is also how a newly minted tag is recognised below, without a second query.
    const candidates = parsed.labels.map((l) => ({ id: ulid(), ...l }));
    const fresh = new Set(candidates.map((c) => c.id));

    const updated: Asset = {
      ...asset,
      version: asset.version + 1,
      updatedAt: this.now().toISOString(),
    };

    // Read BEFORE the transaction — on Postgres a read inside it would not see the uncommitted
    // write anyway, and this is the prior state the audit delta needs.
    const previousLabels = (await this.options.store.tagsOf(id)).map((t) => t.label);

    let resolved: Tag[] = [];
    await this.commitWith(
      caller,
      updated,
      asset,
      {
        type: 'asset.updated',
        // `['tags']`, not a field-level list of what was added and removed. The contract's
        // `changedFields` names FIELDS; the before/after list is in the audit event (EP-19.2).
        payload: { assetId: updated.id, changedFields: ['tags'], source: 'user' },
        delta: { tags: { before: previousLabels, after: candidates.map((c) => c.label) } },
      },
      async (tx) => {
        resolved = await tx.setTags(id, asset.channelId, candidates);
        for (const tag of resolved) {
          if (!fresh.has(tag.id)) continue; // reused an existing tag — nothing new to announce
          await tx.enqueue(
            this.eventRecord(caller, asset.channelId, 'taxonomy.updated', {
              kind: 'tag',
              action: 'created',
              id: tag.id,
              label: tag.label,
            }),
          );
        }
      },
      // The labels being WRITTEN, not the ones stored — `parsed.labels` is what this transaction
      // is about to make true, and reading the store here would index the set being replaced.
      // A tag added and immediately searched for is the obvious case, and the one that would fail.
      {
        tagLabels: parsed.labels.map((l) => l.label),
        extended: (await this.options.store.extended(id)) ?? {},
      },
    );

    return resolved;
  }

  // --- simple search (EP-17.4) -----------------------------------------------

  /**
   * Find assets in the caller's channel by free text.
   *
   * Every hit is authorized INDIVIDUALLY. A read grant scoped to a category subtree makes "may this
   * user see it" a per-asset question, and a search that answered it once for the channel would
   * turn the index into a way to enumerate assets the caller cannot open — the classifieds version
   * of a permissions bug, where the titles leak even though the records do not.
   */
  async search(caller: Caller, q: string, options: { limit?: number } = {}): Promise<Asset[]> {
    // LENIENT here, and deliberately — this is an early-out, not the enforcement point.
    //
    // There is no meaningful channel-wide "may you search?" question: the answer is per asset, and
    // it is answered per asset by `mayRead` below with the strict evaluator and the full context.
    // Asking strictly *here* would be actively wrong, because a read grant scoped to a category
    // subtree cannot satisfy a check that names no category — so a Journalist scoped to `/news/`
    // would be refused outright rather than shown their own news assets. Strict-widens-on-omission
    // cuts both ways (authorization-model.md §5.1); this is the direction that denies too much.
    if (!can(caller.policy, 'asset:read', { channelId: caller.channelId }).allowed) {
      throw new Forbidden('no rule grants "asset:read"');
    }

    const parsed = parseQuery(q ?? '');
    if (parsed.exact.length === 0 && parsed.prefix === undefined) return [];

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    // Over-fetch, because the permission filter below removes rows the store cannot know about.
    // Bounded rather than unlimited: a caller who may read almost nothing would otherwise walk the
    // whole index one page at a time to find that out.
    const hits = await this.options.store.search(
      caller.channelId,
      parsed,
      limit * SEARCH_OVERFETCH,
    );

    const assets: Asset[] = [];
    for (const hit of hits) {
      if (assets.length >= limit) break;
      // Through the cache: a results page is one primary-key read per hit, and the same assets
      // top the same searches — this is the read the cache exists for.
      const asset = await this.cachedAsset(hit.assetId, false);
      // Belt and braces on the channel: the store filters by it, and a hit that somehow escaped
      // that filter must not be rescued by a permissive policy.
      if (!asset || asset.channelId !== caller.channelId) continue;
      if (!this.mayRead(caller, asset, await this.pathsOf([asset]))) continue;
      assets.push(asset);
    }
    return assets;
  }

  /**
   * Rebuild a channel's search index from the assets themselves.
   *
   * The index cannot drift — it commits with the row it describes — but it CAN become stale in a
   * different sense: changing the tokenizer changes what the same text indexes to, and every asset
   * written before that change is still carrying the old terms. So the read model has to be
   * rebuildable, exactly as [mam.md §6.2](../../../docs/architecture/services/mam.md) requires.
   *
   * `taxonomy:admin`: reindexing is an operator action, and on a large channel an expensive one.
   * It reads each asset's tags and document individually — fine for the MVP's scale, and the first
   * thing to revisit when this moves to a real search engine.
   */
  async reindex(caller: Caller, options: { batch?: number } = {}): Promise<{ indexed: number }> {
    this.authorize(caller, 'taxonomy:admin');
    const batch = Math.max(options.batch ?? 100, 1);

    let indexed = 0;
    let cursor: string | undefined;

    // Walked a batch at a time rather than loaded whole. Reading five million assets into memory to
    // rebuild their index is a rebuild that only works on a small channel — the exact scale at
    // which nobody needs it.
    for (;;) {
      const slice = await this.options.store.listByChannel(caller.channelId, {
        limit: batch,
        ...defined({ after: cursor }),
      });
      if (slice.length === 0) break;

      // Sources are read OUTSIDE the transaction. Reading through the store from inside would take
      // a second pooled connection while holding the first, which is how a rebuild deadlocks a
      // service under load rather than merely slowing it down.
      const prepared = await Promise.all(
        slice.map(async (asset) => ({ asset, sources: await this.sourcesFor(asset) })),
      );
      await this.options.store.transaction(async (tx) => {
        for (const { asset, sources } of prepared) {
          await tx.indexTerms(asset.id, asset.channelId, termsFor(asset, sources));
        }
      });

      indexed += slice.length;
      cursor = slice[slice.length - 1]?.id;
      if (slice.length < batch) break;
    }
    return { indexed };
  }

  /** An asset's current searchable sources, for the paths that are not changing them. */
  private async sourcesFor(asset: Asset): Promise<SearchSources> {
    const [tags, extended] = await Promise.all([
      this.options.store.tagsOf(asset.id),
      this.options.store.extended(asset.id),
    ]);
    return { tagLabels: tags.map((t) => t.label), extended: extended ?? {} };
  }

  /** Lenient-free read check for one asset. Same strict evaluator, no exception thrown. */
  private mayRead(caller: Caller, asset: Asset, paths: ReadonlyMap<string, string>): boolean {
    return canEnforce(caller.policy, 'asset:read', {
      channelId: caller.channelId,
      ...defined({
        categoryPath: asset.categoryId === undefined ? undefined : paths.get(asset.categoryId),
        ownerId: asset.createdBy,
      }),
    }).allowed;
  }

  /**
   * What a check knows about an asset: its owner, and its category's PATH (#260) — looked up at
   * the time of the check, so a moved category is authorized where it is now. Before #260 the raw
   * `categoryId` was passed as the path, and a grant scoped to `/news/` matched no real asset. An
   * asset whose category does not exist has no path, and a category-scoped grant does not reach
   * it: fail closed.
   */
  private async scopeOf(asset: Asset): Promise<AssetScope> {
    const paths = await this.pathsOf([asset]);
    return {
      ...defined({
        categoryPath: asset.categoryId === undefined ? undefined : paths.get(asset.categoryId),
        ownerId: asset.createdBy,
      }),
    };
  }

  /** The category paths of these assets, by category id — one query. */
  private async pathsOf(assets: readonly Asset[]): Promise<Map<string, string>> {
    const ids = assets.map((a) => a.categoryId).filter((id): id is string => id !== undefined);
    return ids.length === 0 ? new Map() : this.options.store.categoryPaths(ids);
  }

  /** The resolved field definitions for one asset. */
  private async fieldsFor(asset: Asset): Promise<FieldDefinition[]> {
    const [schemas, scope] = await Promise.all([
      this.options.store.schemas(asset.channelId),
      this.scopeOf(asset),
    ]);
    // By the category's PATH (#260): a schema keyed `/sports/` applies to everything under Sports.
    return resolveFields(schemas, {
      channelId: asset.channelId,
      mediaType: asset.mediaType,
      ...defined({ categoryPath: scope.categoryPath }),
    });
  }

  /**
   * The lifecycle's view of an asset, including the category's mandatory fields AND any extended
   * fields an operator marked required.
   *
   * This is where FR-MAM-2 meets FR-MAM-5: making a field required has to actually stop an asset
   * advancing, or "required" is a label on a form.
   */
  async contextFor(asset: Asset): Promise<LifecycleContext> {
    const extra = this.options.mandatoryFieldsFor?.(asset) ?? [];
    const [fields, values, inheritance] = await Promise.all([
      this.fieldsFor(asset),
      this.options.store.extended(asset.id),
      this.inheritanceOf(asset),
    ]);

    const requiredExtended = requiredFieldNames(fields).map((n) => `${EXTENDED_PREFIX}${n}`);
    const presentExtended = Object.entries(values ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([name]) => `${EXTENDED_PREFIX}${name}`);

    return {
      state: asset.state,
      hasRenditions: asset.hasRenditions,
      mandatoryFields: [...new Set([...BASE_MANDATORY_FIELDS, ...extra, ...requiredExtended])],
      // A media default the category supplies is present (EP-28.2): requiring `genre` of a
      // drama season whose category sets it must not make every episode type it again.
      presentFields: [...presentFieldsOf(effectiveAsset(asset, inheritance)), ...presentExtended],
      ...defined({ expiresAt: asset.expiresAt, retainUntil: asset.retainUntil }),
    };
  }

  // --- internals -------------------------------------------------------------

  /**
   * STRICT authorization with the full resource context.
   *
   * Lenient `can()` would treat a predicate it cannot evaluate as satisfied, so an incomplete
   * context would yield a WIDER grant (authorization-model.md §5.1). Studio uses lenient to decide
   * what to show; a service enforcing must not.
   *
   * `fieldGroup` follows the same rule in the other direction: **omitting it widens the check**,
   * because a rule that declares field groups matches anyway when none was asked for. So it is
   * passed wherever the write belongs to a known group. Core and file writes do not name theirs
   * yet, so field-group scoping is only partly enforced — a gap, not a decision.
   */
  private authorize(
    caller: Caller,
    permission: string,
    scope?: AssetScope,
    fieldGroup?: string,
  ): void {
    const decision = canEnforce(caller.policy, permission, {
      channelId: caller.channelId,
      ...defined({ categoryPath: scope?.categoryPath, ownerId: scope?.ownerId, fieldGroup }),
    });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  /**
   * Authorize a write that spans SEVERAL field groups.
   *
   * Every group, not any: a patch touching `title` and `expiresAt` is a core write and a rights
   * write, and holding one is not holding the other. Checking them together — say by asking once
   * with whichever group happened to be first — would let a grant on the cheap half carry the
   * expensive one.
   *
   * An empty set falls back to the group-less check. That is not a loophole: it means the write
   * touches nothing this module has classified, and the broad question is the honest one to ask
   * rather than inventing a group to satisfy.
   */
  private authorizeGroups(
    caller: Caller,
    permission: string,
    scope: AssetScope | undefined,
    groups: readonly string[],
  ): void {
    if (groups.length === 0) {
      this.authorize(caller, permission, scope);
      return;
    }
    for (const group of groups) this.authorize(caller, permission, scope, group);
  }

  /**
   * Run a command that has no client-supplied base again on a {@link StaleWrite} (#385): it read
   * the asset, another writer committed it first, and the command is re-applied to what is stored
   * now — re-read, re-authorized, re-validated. A PATCH carries no `If-Match`; its meaning is "these
   * fields, on the asset as it is", so an editor is not refused because a rendition landed at the
   * same moment. Bounded: a row that keeps moving under three attempts is a 409.
   *
   * Consumers do NOT come through here — a consumer's StaleWrite goes to the broker, which
   * redelivers, and the redelivery reads afresh.
   */
  private async onCurrent<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof StaleWrite) || attempt >= attempts) throw err;
      }
    }
  }

  /** Write the record, its event and its audit delta in ONE transaction. */
  private async commit(
    caller: Caller,
    asset: Asset,
    before: Asset | undefined,
    eventType: string,
    payload: Record<string, unknown>,
    search?: SearchSources,
  ): Promise<void> {
    return this.commitWith(caller, asset, before, { type: eventType, payload }, undefined, search);
  }

  /**
   * The same unit of work, with an extra write joining it.
   *
   * `also` runs on the SAME tx handle, which is the whole point — a caller that reached for the
   * store instead would land in a different transaction and lose the atomicity silently.
   */
  private async commitWith(
    caller: Caller,
    asset: Asset,
    before: Asset | undefined,
    // The domain event, when the mutation has one to announce; or just the name of the operation,
    // for a mutation that does not (an internal lifecycle step, a rendition attach). Either way
    // the audit record is written — AGENTS.md §5.6: every mutating action, with a delta.
    event: ({ type: string; payload: Record<string, unknown> } | { action: string }) & {
      /**
       * Changes the record diff cannot see. `extended` and `tags` live in their own tables, so a
       * write to either changes nothing on the Asset row but `version` — the caller, which holds
       * both states, supplies the field-level entry itself.
       */
      delta?: Delta;
    },
    also?: (tx: AssetTx) => Promise<void>,
    search?: SearchSources,
  ): Promise<void> {
    const domain =
      'type' in event
        ? this.eventRecord(caller, asset.channelId, event.type, event.payload)
        : undefined;
    // EP-19.2. In the SAME transaction as the row and the domain event: an audit record that could
    // commit without its change, or a change without its record, is the dual-write drift the outbox
    // exists to prevent, and it is worse here because the record is what compliance reads.
    const audit = this.auditRecord(
      caller,
      asset,
      before,
      'type' in event ? event.type : event.action,
      event.delta,
    );
    // Computed BEFORE the transaction opens, from what is about to be written rather than from
    // what is stored — the whole point is that a tag or a document being changed by this very call
    // has to be findable the moment it commits. Paths that change no searchable text pass nothing,
    // and skip the write rather than rewriting identical rows.
    const terms = search ? termsFor(asset, search) : undefined;

    // Nothing is read back inside this block on purpose. On sqlite an uncommitted write is visible
    // to the same connection; on Postgres it is not visible outside the transaction's own client —
    // so a read here would work in tests and return stale data in production.
    await this.options.store.transaction(async (tx) => {
      // Compare-and-set on the version this mutation was computed from (#385): a new asset is
      // inserted, an existing one replaced only if nobody committed it in between.
      await tx.put(asset, before?.version);
      await also?.(tx);
      if (terms) await tx.indexTerms(asset.id, asset.channelId, terms);
      // Domain event first, audit second: the relay publishes in outbox order, and a consumer that
      // reacts to the change should see the change before the record of it.
      if (domain) await tx.enqueue(domain);
      await tx.enqueue(audit);
    });
    // AFTER the commit, never before: an eviction before it would let a concurrent read refill
    // the cache with the row about to be replaced.
    await this.evictCached(asset.id);
  }

  /**
   * The `audit.recorded` event for one mutation (EP-19.2).
   *
   * `revision` is the asset's own `version`: it is bumped on every write, so it is exactly the
   * monotonic per-entity counter the contract asks for, and the sink's history aligns with the
   * number a client already sees on the record. `actor` and `correlationId` ride on the envelope,
   * as they do for every event.
   */
  private auditRecord(
    caller: Caller,
    asset: Asset,
    before: Asset | undefined,
    action: string,
    sideTables: Delta = {},
  ): { id: string; message: { id: string; subject: string; body: Envelope } } {
    const payload: EventPayloads['audit.recorded'] = {
      entityType: 'asset',
      entityId: asset.id,
      revision: asset.version,
      action,
      origin: { service: 'mam' },
      delta: {
        ...delta(
          before as unknown as Record<string, unknown> | undefined,
          asset as unknown as Record<string, unknown>,
        ),
        ...sideTables,
      },
    };
    return this.eventRecord(caller, asset.channelId, 'audit.recorded', payload);
  }

  /**
   * Validate a payload and wrap it in an addressed envelope, ready for the outbox.
   *
   * Validated before it is stored, not on the way out: an invalid payload in the outbox is a poison
   * message that fails every drain forever, and the transaction that could have rejected it has
   * long since committed.
   *
   * Separate from {@link commitWith} because one unit of work can carry more than one event — a tag
   * write announces the asset change AND every vocabulary term it minted, and all of them have to
   * commit with the rows they describe.
   */
  private eventRecord(
    caller: Caller,
    channelId: string,
    eventType: string,
    // `object`, not `Record<string, unknown>`: a generated payload type (EventPayloads[...]) is an
    // interface, and an interface has no implicit index signature. Same reasoning as buildEnvelope.
    payload: object,
  ): { id: string; message: { id: string; subject: string; body: Envelope } } {
    const check = validatePayload(eventType, payload);
    if (!check.valid) {
      throw new ValidationError(
        `${eventType} payload does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }

    const envelope: Envelope = buildEnvelope({
      type: eventType,
      channelId,
      // Validated against its schema two lines up, so the widening is earned rather than assumed.
      payload: payload as Record<string, unknown>,
      actor: { kind: caller.actorKind ?? 'user', id: caller.userId },
      ...defined({ correlationId: caller.correlationId, causationId: caller.causationId }),
    });

    return {
      id: envelope.messageId,
      message: {
        id: envelope.messageId,
        subject: subjectFor(channelId, eventType),
        body: envelope,
        // The trace context is captured HERE, where the event is created inside the request — not
        // where it is published. The outbox relay publishes minutes later on a timer with no
        // ambient context at all, so instrumenting `broker.publish()` would attach nothing and the
        // consumer would start a fresh trace. That is the difference between "an event happened"
        // and "this event happened BECAUSE of that request" (EP-13.3).
        ...defined({ headers: traceHeaders() }),
      },
    };
  }

  /**
   * Build the event payload for a lifecycle transition.
   *
   * Each of these contracts requires more than the asset id — an approval names its approver, a
   * rejection states its reason, an expiry records when. That is deliberate on the contract's
   * part: these are the events a compliance record is reconstructed from, and "asset 42 was
   * rejected" with no author and no cause is not a record of anything.
   */
  private payloadFor(
    caller: Caller,
    eventType: string,
    asset: Asset,
    options: { reason?: string; retainUntil?: string },
  ): Record<string, unknown> {
    const at = asset.updatedAt;
    switch (eventType) {
      case 'asset.approved':
        return {
          assetId: asset.id,
          approver: caller.userId,
          approvedAt: at,
          ...defined({ expiresAt: asset.expiresAt }),
        };
      case 'asset.rejected':
        return {
          assetId: asset.id,
          reason: options.reason,
          rejectedBy: caller.userId,
          rejectedAt: at,
          ...defined({ retainUntil: asset.retainUntil }),
        };
      case 'asset.expired':
        // `expirySource` records where `expiresAt` came from — a per-asset value or the category
        // default snapshotted at approval (FR-TAX-7, EP-28.2).
        return { assetId: asset.id, expiredAt: at, expirySource: asset.expirySource ?? 'asset' };
      default:
        return { assetId: asset.id };
    }
  }
}

/**
 * The only fields a metadata update may touch.
 *
 * Deliberately an explicit list rather than a denylist: a denylist has to be updated every time a
 * field is added to `Asset`, and the failure mode of forgetting is that the new field becomes
 * writable by anyone with `asset:write` — including, one day, another field that matters as much
 * as `state`.
 */
const UPDATABLE_FIELDS = [
  'title',
  'description',
  'categoryId',
  'structureId',
  'genre',
  'supplyType',
  'productionGroup',
  'productionDate',
  'episodeNo',
  'durationSec',
  'allowedBroadcastCount',
  'expiresAt',
] as const satisfies readonly (keyof UpdateAssetInput)[];

function pickUpdatable(patch: UpdateAssetInput): UpdateAssetInput {
  const out: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] !== undefined) out[field] = patch[field];
  }
  return out as UpdateAssetInput;
}

/**
 * Drop undefined entries.
 *
 * `exactOptionalPropertyTypes` is on, so `{ a: undefined }` is not the same as `{}` — and on the
 * wire an explicit null is noise every consumer has to handle.
 */
/**
 * The ambient trace context as message headers, or undefined when nothing is being traced.
 *
 * Undefined rather than `{}` so an untraced deployment's messages are byte-identical to what they
 * were before tracing existed — an empty headers object would change every event envelope on the
 * wire for services that never turn tracing on.
 */
function traceHeaders(): Record<string, string> | undefined {
  const traceparent = currentTraceparent();
  return traceparent === undefined ? undefined : { traceparent };
}

function defined<T extends Record<string, unknown>>(
  source: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  // The return type strips `undefined` from the VALUES, not just the keys. `Partial<T>` would
  // leave `string | undefined`, which under exactOptionalPropertyTypes is not assignable to an
  // optional `string` — the very distinction this helper exists to preserve.
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * The live part of a tree: neither deprecated nor below something deprecated. A deprecated branch
 * disappears from pickers as a whole, though its descendants keep their own state — restoring the
 * branch restores them (data-model.md §2.6).
 */
function live(all: readonly Category[]): Category[] {
  const dead = all.filter((c) => c.deprecatedAt).map((c) => c.path);
  return all.filter((c) => !dead.some((path) => within(c.path, path)));
}

function trimmedLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v.trim()]));
}
