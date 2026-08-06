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

/** The extensible per-asset document (EP-17.2). Shape is whatever the FieldSchema defines. */
export type ExtendedValues = Record<string, unknown>;

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
  listByChannel(channelId: string): Promise<Asset[]>;

  /**
   * The extensible document for an asset, or `undefined` when it has none yet.
   *
   * A separate read from {@link get} rather than part of the asset: it is a document that can grow
   * without bound, and most reads — a listing, a lifecycle check on the core state — do not want it.
   */
  extended(assetId: string): Promise<ExtendedValues | undefined>;

  /** Every FieldSchema in one channel. Small, operator-managed, and read on nearly every write. */
  schemas(channelId: string): Promise<FieldSchema[]>;

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
  /** Enqueue a domain event on the outbox — in THIS transaction, with the row it announces. */
  enqueue(record: OutboxRecord): Promise<void>;
}
