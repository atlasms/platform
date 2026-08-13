// MAM's persistence port (EP-17.1).
//
// The service talks to THIS, never to a driver. Two adapters implement it — `node:sqlite` for
// tests and single-node dev, Postgres for deployment — and both are held to the same conformance
// suite below, so "it works on sqlite" is never the reason something ships.
//
// Everything is async. You can make a synchronous driver satisfy an async contract; you cannot do
// the reverse, and the production store is Postgres.

import type { OutboxRecord } from '@atlas/messaging';
import type { Asset } from './asset.ts';
import type { FieldSchema } from './field-schema.ts';
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

  /** One unit of work. Everything written inside commits together, or none of it does. */
  transaction<T>(fn: (tx: AssetTx) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** The write surface, reachable only from inside {@link AssetStore.transaction}. */
export interface AssetTx {
  put(asset: Asset): Promise<void>;
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
  /** Enqueue a domain event on the outbox — in THIS transaction, with the row it announces. */
  enqueue(record: OutboxRecord): Promise<void>;
}
