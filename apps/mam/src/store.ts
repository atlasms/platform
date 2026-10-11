// MAM's persistence port (EP-17.1).
//
// The service talks to THIS, never to a driver. Two adapters implement it — `node:sqlite` for
// tests and single-node dev, Postgres for deployment — and both are held to the same conformance
// suite below, so "it works on sqlite" is never the reason something ships.
//
// Everything is async. You can make a synchronous driver satisfy an async contract; you cannot do
// the reverse, and the production store is Postgres.

import type { OutboxRecord } from '@atlas/messaging';
import { Conflict } from '@atlas/service-kit';
import type { Asset } from './asset.ts';
import type { Category } from './category.ts';
import type { Person } from './person.ts';
import type { VocabularyTerm } from './vocabulary.ts';
import type { FieldSchema } from './field-schema.ts';
import type { FileRef } from './file.ts';
import type { ParsedQuery, SearchHit } from './search.ts';
import type { Tag, TagCandidate } from './tag.ts';

/** The extensible per-asset document (EP-17.2). Shape is whatever the FieldSchema defines. */
export type ExtendedValues = Record<string, unknown>;

/**
 * One page of a channel listing.
 *
 * **Keyset, not offset.** `after` is the last id already seen, and the next page starts strictly
 * beyond it. `OFFSET n` would be simpler and wrong: ids are ULIDs, so an asset created while a user
 * is paging shifts every subsequent row and the reader silently sees one twice or misses one
 * entirely. A keyset cursor is stable under concurrent inserts and is an index range rather than a
 * scan-and-discard, which is the difference that matters at NFR-CAP-1's five million assets.
 *
 * Omitting `limit` returns the whole channel. That form exists for internal walks — a reindex — and
 * must never serve a request.
 */
export interface ListOptions {
  limit?: number;
  after?: string;
  /**
   * Which end of the catalogue to read from. Default `asc` — oldest first, unchanged.
   *
   * `desc` exists because "recent" is the first thing any media panel shows, and sorting a PAGE
   * client-side cannot produce it: page one of an ascending list is the oldest assets in the
   * channel, so a "Recent" heading over it would be exactly wrong at any real catalogue size.
   *
   * The cursor comparison flips with it — `id < after` rather than `id > after` — because a keyset
   * cursor only means "the next page" relative to the order it was produced in.
   */
  order?: 'asc' | 'desc';
  /**
   * Only assets whose `categoryId` is one of these (#260) — the Media panel's browse tree. The
   * service expands "this category and below" into the ids; the store only matches.
   */
  categoryIds?: readonly string[];
}

/**
 * Reads are plain methods; writes only exist inside a transaction.
 *
 * That asymmetry is deliberate — there is no `put` on this interface, so a write that skips the
 * unit of work (and therefore the outbox's atomicity) cannot be expressed.
 */
export interface AssetStore {
  get(id: string): Promise<Asset | undefined>;

  /**
   * Every asset in ONE channel.
   *
   * The tenant filter is a parameter rather than the caller's job, because a filter applied after
   * loading is a filter that can be forgotten — and forgetting it here means one channel reading
   * another's catalogue. It also keeps the scan proportional to the tenant instead of the table.
   */
  listByChannel(channelId: string, options?: ListOptions): Promise<Asset[]>;

  /**
   * How many assets are in each lifecycle state, for ONE channel.
   *
   * A dedicated aggregate rather than something the caller derives from {@link listByChannel},
   * because a count derived from a page is a count of that page. Studio's dashboard did exactly
   * that — it paged the catalogue to a 1000-asset cap and labelled the result "System State", so
   * the number was right until a channel got big enough for it to matter and then quietly wrong.
   *
   * Returns only states that HAVE assets. Zero-filling belongs to the caller, which knows the set
   * of states it wants to render; a store that invents rows for states nothing is in would be
   * asserting something about the lifecycle it has no business knowing.
   *
   * Both adapters index `(channel_id, state)`, so this is an index-only aggregate rather than a
   * scan — which is the difference between a dashboard widget and a reason not to have one.
   */
  countByState(channelId: string): Promise<Record<string, number>>;

  /**
   * The extensible document for an asset, or `undefined` when it has none yet.
   *
   * A separate read from {@link get} rather than part of the asset: it is a document that can grow
   * without bound, and most reads — a listing, a lifecycle check on the core state — do not want it.
   */
  extended(assetId: string): Promise<ExtendedValues | undefined>;

  /** Every FieldSchema in one channel. Small, operator-managed, and read on nearly every write. */
  schemas(channelId: string): Promise<FieldSchema[]>;

  /**
   * MAM's reference-data version, for `GET /reference` (EP-04.8).
   *
   * MONOTONIC, per configuration-and-reference-data.md §5 — not a content hash. A hash revalidates
   * correctly but carries no ordering, and §5's convergence story is "holders refresh when they see
   * a HIGHER version".
   */
  configVersion(): Promise<number>;

  /** The tags on one asset, ordered by normalized label (EP-17.3). */
  tagsOf(assetId: string): Promise<Tag[]>;

  /**
   * Every tag minted in one channel — the tag cloud, and what an autocomplete offers.
   *
   * Channel-scoped for the same reason {@link listByChannel} is: a suggestion list built from the
   * whole table would leak one tenant's vocabulary into another's editor, which is a slower and
   * more embarrassing version of leaking their catalogue.
   */
  listTags(channelId: string): Promise<Tag[]>;

  /**
   * Assets in one channel matching every term of `query` (EP-17.4).
   *
   * **AND semantics**: an asset must carry every exact term, and — when the query ends mid-word —
   * at least one term with that prefix. OR would return the whole library for any two-word query,
   * which is not what typing two words means.
   *
   * Returns ids and scores, not assets. The caller still has to authorize each hit: a read grant
   * scoped to a category subtree makes "may this user see it" a per-asset question, and answering
   * it in SQL would put the policy evaluator in the database.
   */
  search(channelId: string, query: ParsedQuery, limit: number): Promise<SearchHit[]>;
  /**
   * Faceted search (EP-28.6): the channel's asset ids carrying, for EVERY filter, at least one of its
   * values — AND across facets, OR within one — newest first, at most `limit`. `within` narrows to
   * those ids (a text search's hits). The facets are the PROJECTED effective values (inherited
   * included), written with the asset and re-projected when a category changes.
   */
  facetSearch(
    channelId: string,
    filters: readonly FacetFilter[],
    limit: number,
    within?: readonly string[],
  ): Promise<string[]>;
  /** The projected facets of these assets — what a results page counts. */
  facetsOf(assetIds: readonly string[]): Promise<FacetValue[]>;

  /** The asset's files as last mirrored from HSM/MTS (EP-17.8), by kind then variant. */
  filesOf(assetId: string): Promise<FileRef[]>;

  /** A channel's whole category tree, deprecated nodes included, in path order (#260). */
  categories(channelId: string): Promise<Category[]>;
  category(id: string): Promise<Category | undefined>;
  /**
   * The paths of these categories, by id — what MAM authorizes a category-scoped grant against
   * (an id with no category is simply absent: fail closed). One query for a whole page.
   */
  categoryPaths(ids: readonly string[]): Promise<Map<string, string>>;

  /** A vocabulary's terms in a channel, deprecated and merged included, by sortOrder then key. */
  terms(channelId: string, vocabulary: string): Promise<VocabularyTerm[]>;
  term(id: string): Promise<VocabularyTerm | undefined>;

  /** The channel's people register, deprecated included, by name (EP-28.5). */
  people(channelId: string): Promise<Person[]>;
  person(id: string): Promise<Person | undefined>;

  /** One unit of work. Everything written inside commits together, or none of it does. */
  transaction<T>(fn: (tx: AssetTx) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * A write whose base is no longer the stored row: another writer committed the asset first (#385).
 * A 409 if it reaches a client; a consumer throws it to the broker, which redelivers; a command
 * with no client-supplied base re-reads and re-applies (`MamService` retries it, bounded).
 */
export class StaleWrite extends Conflict {
  constructor(id: string, ifVersion: number | undefined) {
    super(
      ifVersion === undefined
        ? `asset ${id} already exists`
        : `asset ${id} changed since version ${ifVersion} was read`,
    );
  }
}

/** A category write whose base is no longer the stored row. */
export class StaleCategory extends Conflict {
  constructor(id: string, ifVersion: number | undefined) {
    super(
      ifVersion === undefined
        ? `category ${id} already exists`
        : `category ${id} changed since version ${ifVersion} was read — reload it`,
    );
  }
}

/** The channel already has a category at this path: a sibling with the same key. */
export class CategoryPathTaken extends Conflict {
  constructor(path: string) {
    super(`a category already exists at ${path} — a key is unique among its siblings`);
  }
}

/** One projected facet value of an asset (EP-28.6). */
export interface FacetValue {
  assetId: string;
  facet: string;
  value: string;
}

/** A search filter: the asset must carry one of `values` under `facet`. */
export interface FacetFilter {
  facet: string;
  values: readonly string[];
}

/** A vocabulary term write whose base is no longer the stored row (EP-28.3). */
export class StaleTerm extends Conflict {
  constructor(id: string, ifVersion: number | undefined) {
    super(
      ifVersion === undefined
        ? `term ${id} already exists`
        : `term ${id} changed since version ${ifVersion} was read — reload it`,
    );
  }
}

/** A person write whose base is no longer the stored row (EP-28.5). */
export class StalePerson extends Conflict {
  constructor(id: string, ifVersion: number | undefined) {
    super(
      ifVersion === undefined
        ? `person ${id} already exists`
        : `person ${id} changed since version ${ifVersion} was read — reload it`,
    );
  }
}

/** The vocabulary already has a term with this key in the channel. */
export class TermKeyTaken extends Conflict {
  constructor(vocabulary: string, key: string) {
    super(`${vocabulary} already has a term with the key ${key} — a key is unique per vocabulary`);
  }
}

/** The write surface, reachable only from inside {@link AssetStore.transaction}. */
export interface AssetTx {
  /**
   * Write the asset — COMPARE-AND-SET on its version (#385). With `ifVersion`, the stored row is
   * replaced only if its version is still `ifVersion`; without it, the asset is new and is
   * inserted. Anything else is a {@link StaleWrite}, and the transaction must not commit.
   *
   * It used to be a blind upsert: every mutation read the row, computed the next one and wrote it
   * whole, so two concurrent writers — the rendition mirror and an editor's PATCH — each wrote
   * over the other's base. One change was lost, and both committed the same revision, so the audit
   * sink refused the second record. The sqlite double serializes transactions on its one
   * connection and could never show it; the conformance suite races two writers on Postgres.
   */
  put(asset: Asset, ifVersion?: number): Promise<void>;
  /**
   * Write a category — compare-and-set like `put`: with `ifVersion` only over that version
   * (otherwise a {@link StaleCategory}), without it a new category is inserted. A path already
   * taken in the channel — a sibling with the same key — is a {@link CategoryPathTaken}.
   */
  putCategory(category: Category, ifVersion?: number): Promise<void>;
  /**
   * Write a vocabulary term — compare-and-set like `putCategory` ({@link StaleTerm}); a key taken
   * in the vocabulary and channel is a {@link TermKeyTaken}. Bumps the reference snapshot.
   */
  putTerm(term: VocabularyTerm, ifVersion?: number): Promise<void>;
  /** Write a person — compare-and-set like the rest ({@link StalePerson}). */
  putPerson(person: Person, ifVersion?: number): Promise<void>;
  /**
   * Replace an asset's extensible document.
   *
   * Whole-document, not a merge: the merge happens in the service, where the schema is known and a
   * cleared field can be told apart from an untouched one. A store that merged would have no way
   * to express "remove this value".
   */
  putExtended(assetId: string, channelId: string, values: ExtendedValues): Promise<void>;
  putSchema(schema: FieldSchema): Promise<void>;
  /**
   * Replace an asset's tag set, minting any label the channel has not seen (EP-17.3).
   *
   * Whole-set, like {@link putExtended} — a tag input hands back the final list, and add/remove
   * pairs would need a client to have read the current set first without anything guaranteeing it
   * still holds.
   *
   * Returns the **resolved** tags: a candidate whose label already exists comes back with the id it
   * already had, not the one offered. Mint-or-reuse has to happen here, inside the transaction,
   * because two editors tagging different assets `football` at the same moment is the ordinary case
   * — a read-then-insert in the service would race and the unique index would reject the loser.
   */
  setTags(assetId: string, channelId: string, tags: readonly TagCandidate[]): Promise<Tag[]>;
  /**
   * Replace an asset's search terms (EP-17.4).
   *
   * In the transaction with the row it describes, which is what makes the index unable to drift.
   * The doc's design feeds a SEPARATE store (OpenSearch) through the outbox because dual writes
   * desynchronise; an index living in this database has no such window, so committing together is
   * strictly stronger than the projection it stands in for.
   */
  indexTerms(assetId: string, channelId: string, terms: readonly string[]): Promise<void>;
  /** Replace an asset's projected facets (EP-28.6) — whole, like its terms. */
  indexFacets(
    assetId: string,
    channelId: string,
    facets: readonly { facet: string; value: string }[],
  ): Promise<void>;
  /** Enqueue a domain event on the outbox — in THIS transaction, with the row it announces. */
  enqueue(record: OutboxRecord): Promise<void>;
  /**
   * Claim a broker message id IN this transaction (EP-03.3) — `false` means it was already
   * consumed and nothing must be done. The claim commits with the effect or rolls back with it.
   */
  markSeen(messageId: string): Promise<boolean>;
  /** Write a file row, replacing the one with the same (asset, kind, variant). */
  putFile(file: FileRef): Promise<void>;
}
