// The read cache for hot assets (EP-17.7): what is answered from memory, what is never answered
// from memory, and how a cached answer is forgotten — on this replica after every commit, on
// every replica by the audit record the commit announced, and on request by `no-cache`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import {
  assetOf,
  buildMamApp,
  MamService,
  MemoryAssetCache,
  sqliteAssetStore,
  startCacheInvalidation,
  type Asset,
  type AssetStore,
  type Caller,
  type CacheFamily,
  type CacheOutcome,
} from '../src/index.ts';

const CHANNEL = 'ch12';

/** A store that counts what it is asked, so a hit is a read the store never saw. */
function counting(store: AssetStore): AssetStore & { reads: Record<string, number> } {
  const reads: Record<string, number> = { get: 0, extended: 0, tagsOf: 0 };
  return {
    ...store,
    reads,
    get: (id) => {
      reads['get'] = (reads['get'] ?? 0) + 1;
      return store.get(id);
    },
    extended: (id) => {
      reads['extended'] = (reads['extended'] ?? 0) + 1;
      return store.extended(id);
    },
    tagsOf: (id) => {
      reads['tagsOf'] = (reads['tagsOf'] ?? 0) + 1;
      return store.tagsOf(id);
    },
    transaction: (fn) => store.transaction(fn),
  };
}

function harness(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const raw = sqliteAssetStore();
  const store = counting(raw);
  const outbox = new SqliteOutboxStore(raw.db);
  const bus = new InMemoryBroker();
  const relay = new OutboxRelay(outbox, bus);
  const cache = new MemoryAssetCache(options);
  const outcomes: Array<[CacheFamily, CacheOutcome]> = [];
  const service = new MamService({
    store,
    cache,
    onCacheRead: (family, outcome) => outcomes.push([family, outcome]),
    now: () => new Date('2026-09-21T12:00:00.000Z'),
  });
  const caller = (over: Partial<Caller> = {}): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({
      subjectId: 'user-1',
      permVersion: 1,
      rules: [
        {
          id: 'r',
          permissions: ['asset:read', 'asset:write'],
          scope: { channelIds: [over.channelId ?? CHANNEL] },
        },
      ],
    }),
    ...over,
  });
  const create = (title = 'Bulletin'): Promise<Asset> =>
    service.create(caller(), { title, mediaType: 'video', fileType: 'mxf' });
  return { store, cache, service, caller, create, bus, relay, outcomes };
}

test('MemoryAssetCache: a family per asset, LRU-bounded, expiring on the clock, forgotten as a whole', async () => {
  let now = 1_000;
  const cache = new MemoryAssetCache({ maxEntries: 3, ttlMs: 100, now: () => now });
  const asset = { id: 'a' } as Asset;
  await cache.set('a', 'asset', asset);
  await cache.set('a', 'tags', []);
  await cache.set('b', 'asset', { id: 'b' } as Asset);
  assert.equal(cache.size, 3);
  assert.equal(await cache.get('a', 'asset'), asset);

  // A fourth entry drops the least recently USED — `a/tags`, since `a/asset` was just read.
  await cache.set('c', 'asset', { id: 'c' } as Asset);
  assert.equal(cache.size, 3);
  assert.equal(await cache.get('a', 'tags'), undefined);
  assert.equal(await cache.get('a', 'asset'), asset);

  // Expiry is checked on the read, by the injected clock.
  now += 101;
  assert.equal(await cache.get('a', 'asset'), undefined);
  assert.equal(cache.size, 2);

  // Eviction is per asset, every family at once.
  await cache.set('b', 'tags', []);
  await cache.set('b', 'extended', null);
  await cache.evict('b');
  assert.equal(await cache.get('b', 'asset'), undefined);
  assert.equal(await cache.get('b', 'extended'), undefined);
  assert.equal(cache.size, 1);
  await cache.clear();
  assert.equal(cache.size, 0);
});

test('a second read is a hit the store never sees; a miss is not cached; the record, the document and the tags each have a family', async () => {
  const { store, service, caller, create, outcomes } = harness();
  const asset = await create();
  store.reads['get'] = 0;

  assert.deepEqual(await service.get(caller(), asset.id), asset);
  assert.deepEqual(await service.get(caller(), asset.id), asset);
  assert.equal(store.reads['get'], 1, 'one store read for two gets');
  assert.deepEqual(outcomes.splice(0), [
    ['asset', 'miss'],
    ['asset', 'hit'],
  ]);

  // An unknown id: NOT FOUND every time, and every time from the store.
  const unknown = ulid();
  await assert.rejects(service.get(caller(), unknown), /no asset/);
  await assert.rejects(service.get(caller(), unknown), /no asset/);
  assert.equal(store.reads['get'], 3);

  // The document ("no document" is a cached answer too) and the tags.
  await service.extended(caller(), asset.id);
  await service.extended(caller(), asset.id);
  assert.equal(store.reads['extended'], 1);
  await service.tags(caller(), asset.id);
  await service.tags(caller(), asset.id);
  assert.equal(store.reads['tagsOf'], 1);
  assert.deepEqual(
    outcomes.filter(([f]) => f !== 'asset'),
    [
      ['extended', 'miss'],
      ['extended', 'hit'],
      ['tags', 'miss'],
      ['tags', 'hit'],
    ],
  );
});

test('every mutation reads its base from the STORE and forgets the asset after it commits', async () => {
  const { store, service, caller, create } = harness();
  const asset = await create();
  await service.get(caller(), asset.id); // cached at version 1
  store.reads['get'] = 0;

  const updated = await service.update(caller(), asset.id, { title: 'Evening bulletin' });
  assert.equal(updated.version, 2);
  assert.equal(store.reads['get'], 1, 'the base of the write came from the store');

  // The read after the write sees the write — and is a miss, since the commit evicted.
  const after = await service.get(caller(), asset.id);
  assert.equal(after.title, 'Evening bulletin');
  assert.equal(store.reads['get'], 2);

  // The side tables too: a tag write bumps the record and forgets its cached tags.
  await service.tags(caller(), asset.id);
  await service.setTags(caller(), asset.id, ['news']);
  assert.deepEqual(
    (await service.tags(caller(), asset.id)).map((t) => t.label),
    ['news'],
  );
  assert.equal((await service.get(caller(), asset.id)).version, 3);

  // And the document.
  await service.extended(caller(), asset.id);
  await service.putSchema(caller({ policy: taxonomyAdmin() }), {
    id: 'video-core',
    channelId: CHANNEL,
    mediaType: 'video',
    fields: [{ name: 'producer', label: 'Producer', type: 'string' }],
  });
  await service.updateExtended(caller(), asset.id, { producer: 'Ana' });
  assert.deepEqual((await service.extended(caller(), asset.id)).values, { producer: 'Ana' });
});

test('a stale entry on THIS replica cannot poison a write: the version base is the store’s', async () => {
  const { store, cache, service, caller, create } = harness();
  const asset = await create();
  // Another replica wrote version 5 behind our back; our cache still says version 1.
  await cache.set(asset.id, 'asset', asset);
  await store.transaction(async (tx) => tx.put({ ...asset, title: 'Elsewhere', version: 5 }));

  const written = await service.update(caller(), asset.id, { title: 'Ours' });
  assert.equal(written.version, 6, 'built on the stored version, not the cached one');
});

test('the audit record another replica published evicts here — MAM’s own, for an asset; nothing else', async () => {
  const { cache, service, caller, create, bus, relay } = harness();
  const evicted: string[] = [];
  startCacheInvalidation({ broker: bus, service, onEvict: (id) => evicted.push(id) });

  const asset = await create();
  await relay.drain(); // asset.created + audit.recorded → the broadcast evicts (a no-op here)
  assert.deepEqual(evicted, [asset.id]);

  // A second replica's write: the row moves under us and its record arrives on the bus.
  await service.get(caller(), asset.id);
  assert.ok(await cache.get(asset.id, 'asset'));
  await service.update(caller(), asset.id, { title: 'From replica two' });
  // (the local commit evicted; refill to simulate the OTHER replica's stale entry)
  await cache.set(asset.id, 'asset', asset);
  await relay.drain();
  assert.deepEqual(evicted, [asset.id, asset.id]);
  assert.equal(await cache.get(asset.id, 'asset'), undefined, 'the record evicted it');

  // What is not an asset record of MAM's evicts nothing.
  const body = (over: Record<string, unknown>) => ({
    type: 'audit.recorded',
    payload: {
      entityType: 'asset',
      entityId: 'x',
      revision: 1,
      action: 'asset.updated',
      origin: { service: 'mam' },
      delta: {},
      ...over,
    },
  });
  assert.equal(assetOf({ id: '1', subject: 's', body: body({}) }), 'x');
  assert.equal(assetOf({ id: '1', subject: 's', body: body({ entityType: 'file' }) }), undefined);
  assert.equal(
    assetOf({ id: '1', subject: 's', body: body({ origin: { service: 'scheduling' } }) }),
    undefined,
  );
  assert.equal(assetOf({ id: '1', subject: 's', body: { type: 'asset.updated' } }), undefined);
  assert.equal(assetOf({ id: '1', subject: 's', body: null }), undefined);
  assert.equal(assetOf({ id: '1', subject: 's', body: 'text' }), undefined);
});

test('search reads its hits through the cache', async () => {
  const { store, service, caller, create } = harness();
  const a = await create('Morning bulletin');
  const b = await create('Evening bulletin');
  store.reads['get'] = 0;

  const first = await service.search(caller(), 'bulletin');
  assert.deepEqual(first.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.equal(store.reads['get'], 2);
  await service.search(caller(), 'bulletin');
  assert.equal(store.reads['get'], 2, 'the second page of hits came from the cache');
});

test('HTTP: `Cache-Control: no-cache` reads through, and says so in the outcome', async () => {
  const { store, service, caller, create, outcomes } = harness();
  const asset = await create();
  const app = buildMamApp({ service, policyFor: () => caller().policy });
  const headers = (extra: Record<string, string> = {}) => ({
    'x-atlas-user': 'user-1',
    'x-atlas-channel': CHANNEL,
    ...extra,
  });
  const url = `/api/v1/assets/${asset.id}`;
  store.reads['get'] = 0;
  outcomes.splice(0);

  assert.equal((await app.inject({ method: 'GET', url, headers: headers() })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url, headers: headers() })).statusCode, 200);
  assert.equal(store.reads['get'], 1);

  const fresh = await app.inject({
    method: 'GET',
    url,
    headers: headers({ 'cache-control': 'no-cache' }),
  });
  assert.equal(fresh.statusCode, 200);
  assert.equal(store.reads['get'], 2, 'no-cache went to the store');
  assert.deepEqual(outcomes.at(-1), ['asset', 'bypass']);

  // `max-age=0` is not `no-cache`; a header that merely contains the letters is not either.
  await app.inject({ method: 'GET', url, headers: headers({ 'cache-control': 'max-age=0' }) });
  await app.inject({ method: 'GET', url, headers: headers({ 'cache-control': 'x-no-cache' }) });
  assert.equal(store.reads['get'], 2);

  // The document and the tags routes honour it too.
  await app.inject({ method: 'GET', url: `${url}/extended`, headers: headers() });
  await app.inject({
    method: 'GET',
    url: `${url}/extended`,
    headers: headers({ 'cache-control': 'no-store' }),
  });
  assert.equal(store.reads['extended'], 2);
  await app.inject({ method: 'GET', url: `${url}/tags`, headers: headers() });
  await app.inject({
    method: 'GET',
    url: `${url}/tags`,
    headers: headers({ 'cache-control': 'no-cache' }),
  });
  assert.equal(store.reads['tagsOf'], 2);
});

test('without a cache, every read is a store read and no outcome is reported', async () => {
  const raw = sqliteAssetStore();
  const store = counting(raw);
  const outcomes: unknown[] = [];
  const service = new MamService({ store, onCacheRead: (f, o) => outcomes.push([f, o]) });
  const c: Caller = {
    userId: 'u',
    channelId: CHANNEL,
    policy: compile({
      subjectId: 'u',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['asset:read', 'asset:write'] }],
    }),
  };
  const asset = await service.create(c, { title: 'T', mediaType: 'video', fileType: 'mxf' });
  store.reads['get'] = 0;
  await service.get(c, asset.id);
  await service.get(c, asset.id);
  assert.equal(store.reads['get'], 2);
  assert.deepEqual(outcomes, []);
});

const taxonomyAdmin = () =>
  compile({
    subjectId: 'user-1',
    permVersion: 1,
    rules: [{ id: 'r', permissions: ['asset:read', 'asset:write', 'taxonomy:admin'] }],
  });
