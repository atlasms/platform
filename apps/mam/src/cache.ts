// The read cache for hot assets (EP-17.7).
//
// Three read models are cached, each under the asset's id: the record, its extensible document
// and its tags. Not its files — `file.placed` changes a file row without touching the asset, so a
// cached file list has no invalidation signal another replica could act on, and files are read on
// entering an editor tab, not on every listing. What IS hot is the record: a search page reads one
// asset per hit, a dashboard or a media panel refreshes on every live event, and each of those is
// a primary-key lookup that this saves.
//
// A cache is only ever as good as its invalidation, so that is the design:
//
//   1. IN PROCESS, EXACT. Every mutation evicts the asset after its transaction commits. On the
//      replica that wrote, a read after the write sees the write.
//   2. ACROSS REPLICAS, BY THE MUTATION'S OWN ANNOUNCEMENT. Every asset mutation emits
//      `audit.recorded` for entity `asset` (AGENTS.md §5.6 — even the ones with no domain event),
//      and every MAM replica listens to that stream in broadcast mode and evicts the entity named.
//      That signal is chosen over the domain events precisely because it is the one that is
//      guaranteed to exist.
//   3. A TTL, AS THE BOUND. The announcement rides the outbox: with the broker down it arrives when
//      the broker returns. Until then another replica's cache is stale, and the TTL is the promise
//      of how stale at most. A reader who cannot accept even that says `Cache-Control: no-cache`
//      and reads through.
//
// Mutations never read from here. A write computes `version + 1` from what it read, and a stale
// base would be a lost update — so the service reads its base from the store, always.
//
// The port is async so a shared cache (Redis/Valkey: one hash per asset, `DEL` to evict) can stand
// in for the in-process one without the service changing. Nothing needs that today.

import type { Asset } from './asset.ts';
import type { ExtendedValues } from './store.ts';
import type { Tag } from './tag.ts';

/** What is cached per asset. `extended` is the RAW document — the schema join happens after. */
export interface CacheFamilies {
  asset: Asset;
  /** `null` is a cached "no document": an asset with nothing extended is the common case. */
  extended: ExtendedValues | null;
  tags: Tag[];
}

export type CacheFamily = keyof CacheFamilies;

export interface AssetCache {
  get<F extends CacheFamily>(assetId: string, family: F): Promise<CacheFamilies[F] | undefined>;
  set<F extends CacheFamily>(assetId: string, family: F, value: CacheFamilies[F]): Promise<void>;
  /** Forget everything about one asset — every family at once. */
  evict(assetId: string): Promise<void>;
  /** Forget everything. */
  clear(): Promise<void>;
}

export interface MemoryCacheOptions {
  /** Entries (asset × family) kept before the least recently used is dropped. Default 10 000. */
  maxEntries?: number;
  /** How long an entry is trusted. Default 10 s — see the file comment for what it bounds. */
  ttlMs?: number;
  now?: () => number;
}

export const DEFAULT_CACHE_MAX_ENTRIES = 10_000;
export const DEFAULT_CACHE_TTL_MS = 10_000;

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * The in-process cache: an LRU over a `Map` (insertion order IS recency once a hit re-inserts),
 * with a TTL checked on read. Expired entries are dropped on the read that finds them; the LRU
 * bound is what keeps the map from growing on a channel that is only ever read once.
 */
export class MemoryAssetCache implements AssetCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async get<F extends CacheFamily>(
    assetId: string,
    family: F,
  ): Promise<CacheFamilies[F] | undefined> {
    const key = keyOf(assetId, family);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to move it to the recent end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as CacheFamilies[F];
  }

  async set<F extends CacheFamily>(
    assetId: string,
    family: F,
    value: CacheFamilies[F],
  ): Promise<void> {
    const key = keyOf(assetId, family);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async evict(assetId: string): Promise<void> {
    for (const family of FAMILIES) this.entries.delete(keyOf(assetId, family));
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  /** How many entries are held — for tests and for a gauge. */
  get size(): number {
    return this.entries.size;
  }
}

const FAMILIES: readonly CacheFamily[] = ['asset', 'extended', 'tags'];

const keyOf = (assetId: string, family: CacheFamily): string => `${assetId}/${family}`;
