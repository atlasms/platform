// EP-17.4 — search where it meets the rest of the service.
//
// The tokenizer is covered in search.test.ts and the SQL in the conformance suite. What matters
// here is that the index is maintained by every write that changes searchable text, that a hit is
// authorized individually, and that neither crosses a channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Rule } from '@atlas/policy';
import {
  buildMamApp,
  MamService,
  sqliteAssetStore,
  type Asset,
  type Caller,
} from '../src/index.ts';

const CHANNEL = 'ch12';

const EDITOR: Rule[] = [
  {
    id: 'read',
    permissions: ['asset:read', 'taxonomy:read', 'taxonomy:admin'],
    scope: { channelIds: [CHANNEL] },
  },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
  },
];

function harness(rules: Rule[] = EDITOR) {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const caller = (over: Partial<Caller> = {}): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({ subjectId: over.userId ?? 'user-1', permVersion: 1, rules }),
    ...over,
  });
  return { store, service, caller };
}

const NEW_ASSET = { title: 'Match highlights', mediaType: 'video', fileType: 'mxf' };

const titles = (assets: readonly Asset[]): string[] => assets.map((a) => a.title);

// =============================================================================
// The index is maintained by the writes that change searchable text
// =============================================================================

test('a new asset is findable by its title immediately', async () => {
  const { service, caller } = harness();
  await service.create(caller(), NEW_ASSET);

  assert.deepEqual(titles(await service.search(caller(), 'highlights ')), ['Match highlights']);
});

test('a renamed asset stops answering to its OLD title', async () => {
  // The quiet failure: an asset that keeps matching a word nobody can see on it any more.
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  await service.update(caller(), asset.id, { title: 'Cup final' });

  assert.deepEqual(await service.search(caller(), 'highlights '), []);
  assert.deepEqual(titles(await service.search(caller(), 'final ')), ['Cup final']);
});

test('a rename does NOT strip the tag terms off the index', async () => {
  // `update` does not touch tags, so it must read them rather than assume the sources are empty.
  // Assuming would silently make every tagged asset unsearchable by its tags after any edit.
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['uefa']);

  await service.update(caller(), asset.id, { title: 'Cup final' });

  assert.deepEqual(titles(await service.search(caller(), 'uefa ')), ['Cup final']);
});

test('a tag is searchable the moment it commits', async () => {
  // The index is written from the labels being STORED, not from a read of the set being replaced.
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  await service.setTags(caller(), asset.id, ['Champions', 'League']);

  assert.deepEqual(titles(await service.search(caller(), 'champions ')), ['Match highlights']);
  assert.deepEqual(await service.search(caller(), 'nonexistent '), []);

  // …and removing it removes the term.
  await service.setTags(caller(), asset.id, []);
  assert.deepEqual(await service.search(caller(), 'champions '), []);
  assert.deepEqual(
    titles(await service.search(caller(), 'highlights ')),
    ['Match highlights'],
    'the title terms must survive a tag change',
  );
});

test('extended text is searchable; numbers and booleans are not', async () => {
  const { service, caller } = harness();
  await service.putSchema(caller(), {
    id: 'video-core',
    channelId: CHANNEL,
    mediaType: 'video',
    fields: [
      { name: 'competition', label: 'Competition', type: 'string' },
      { name: 'rating', label: 'Rating', type: 'number' },
      { name: 'live', label: 'Live', type: 'boolean' },
    ],
  });
  const asset = await service.create(caller(), NEW_ASSET);
  await service.updateExtended(caller(), asset.id, {
    competition: 'Bundesliga',
    rating: 4.5,
    live: true,
  });

  assert.deepEqual(titles(await service.search(caller(), 'bundesliga ')), ['Match highlights']);
  // `true` and `4.5` are tokens nobody searches for, and indexing them fills the index with noise.
  assert.deepEqual(await service.search(caller(), 'true '), []);
});

test('search-as-you-type: a half-typed word matches, a finished one does not over-match', async () => {
  const { service, caller } = harness();
  await service.create(caller(), { ...NEW_ASSET, title: 'Football final' });

  assert.equal((await service.search(caller(), 'foot')).length, 1, 'still typing');
  assert.equal((await service.search(caller(), 'foot ')).length, 0, 'finished word, exact match');
  assert.equal((await service.search(caller(), 'football ')).length, 1);
});

test('every query term must match, not just one', async () => {
  const { service, caller } = harness();
  await service.create(caller(), { ...NEW_ASSET, title: 'Cup final' });
  await service.create(caller(), { ...NEW_ASSET, title: 'Cup draw' });

  assert.deepEqual(titles(await service.search(caller(), 'cup final ')), ['Cup final']);
  assert.equal((await service.search(caller(), 'cup ')).length, 2);
});

test('an empty or unmatchable query returns nothing, never the whole channel', async () => {
  const { service, caller } = harness();
  await service.create(caller(), NEW_ASSET);

  for (const q of ['', '   ', '!!!']) {
    assert.deepEqual(await service.search(caller(), q), [], JSON.stringify(q));
  }
});

test('limit is honoured and capped', async () => {
  const { service, caller } = harness();
  for (let i = 0; i < 6; i++) await service.create(caller(), { ...NEW_ASSET, title: `Clip ${i}` });

  assert.equal((await service.search(caller(), 'clip ', { limit: 2 })).length, 2);
  assert.equal((await service.search(caller(), 'clip ')).length, 6);
  // A caller asking for a million gets the cap, not a million.
  assert.equal((await service.search(caller(), 'clip ', { limit: 1_000_000 })).length, 6);
});

// =============================================================================
// Authorization
// =============================================================================

test('SECURITY: a hit the caller may not READ is filtered out', async () => {
  // A read grant scoped to a category subtree makes "may this user see it" a per-asset question.
  // Answering it once for the channel would turn search into a way to enumerate titles the caller
  // cannot open — the records stay closed, but the index leaks what is in them.
  const { service, caller, store } = harness();
  await service.create(caller(), { ...NEW_ASSET, title: 'Sports secret', categoryId: '/sports/' });
  await service.create(caller(), { ...NEW_ASSET, title: 'News secret', categoryId: '/news/' });

  const newsOnly = new MamService({ store });
  const restricted: Caller = {
    userId: 'user-2',
    channelId: CHANNEL,
    policy: compile({
      subjectId: 'user-2',
      permVersion: 1,
      rules: [
        {
          id: 'r',
          permissions: ['asset:read'],
          scope: { channelIds: [CHANNEL], categoryPaths: ['/news/'] },
        },
      ],
    }),
  };

  assert.deepEqual(titles(await newsOnly.search(restricted, 'secret ')), ['News secret']);
});

test('SECURITY: search cannot cross a channel', async () => {
  const { service, caller, store } = harness();
  await service.create(caller(), { ...NEW_ASSET, title: 'Confidential' });

  const other = new MamService({ store });
  const outsider: Caller = {
    userId: 'user-9',
    channelId: 'ch99',
    policy: compile({
      subjectId: 'user-9',
      permVersion: 1,
      // Deliberately UNSCOPED, so the only thing that can stop this is the channel filter.
      rules: [{ id: 'r', permissions: ['asset:read'] }],
    }),
  };

  assert.deepEqual(await other.search(outsider, 'confidential '), []);
});

test('searching needs asset:read', async () => {
  const { service, caller } = harness([
    { id: 'r', permissions: ['asset:write'], scope: { channelIds: [CHANNEL] } },
  ]);
  await assert.rejects(service.search(caller(), 'anything '), /asset:read/);
});

// =============================================================================
// Rebuilding
// =============================================================================

test('reindex rebuilds the index from the assets themselves', async () => {
  // The index cannot drift — it commits with its row — but it CAN go stale when the tokenizer
  // changes. Simulated here by emptying the index behind the service's back.
  const { service, caller, store } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['uefa']);

  store.db.exec('DELETE FROM asset_search');
  assert.deepEqual(await service.search(caller(), 'highlights '), [], 'index really is empty');

  const { indexed } = await service.reindex(caller());
  assert.equal(indexed, 1);

  assert.deepEqual(titles(await service.search(caller(), 'highlights ')), ['Match highlights']);
  assert.deepEqual(
    titles(await service.search(caller(), 'uefa ')),
    ['Match highlights'],
    'tags have to come back too, or a rebuild silently narrows the index',
  );
});

test('reindex is taxonomy:admin, not asset:read', async () => {
  // Rebuilding a large channel is expensive. Anyone who can search should not be able to start one.
  const { service, caller } = harness([
    { id: 'r', permissions: ['asset:read', 'asset:write'], scope: { channelIds: [CHANNEL] } },
  ]);
  await assert.rejects(service.reindex(caller()), /taxonomy:admin/);
});

test('reindex only touches the caller’s channel', async () => {
  const { service, caller, store } = harness();
  const mine = await service.create(caller(), NEW_ASSET);

  // Another channel's asset, indexed and then left alone by the rebuild.
  await store.transaction(async (tx) => {
    await tx.put({ ...mine, id: 'OTHER', channelId: 'ch99', title: 'Theirs' });
    await tx.indexTerms('OTHER', 'ch99', ['theirs']);
  });

  const { indexed } = await service.reindex(caller());
  assert.equal(indexed, 1, 'only this channel');
  assert.equal((await store.search('ch99', { exact: ['theirs'] }, 10)).length, 1, 'left intact');
});

// =============================================================================
// HTTP
// =============================================================================

test('over HTTP: GET /search, with q required and limit validated', async () => {
  const service = new MamService({ store: sqliteAssetStore() });
  const app = buildMamApp({
    service,
    policyFor: () => compile({ subjectId: 'user-1', permVersion: 1, rules: EDITOR }),
  });
  const headers = {
    'x-atlas-user': 'user-1',
    'x-atlas-channel': CHANNEL,
    'content-type': 'application/json',
  };

  await app.inject({ method: 'POST', url: '/api/v1/assets', headers, payload: NEW_ASSET });

  const hit = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=highlights%20',
    headers,
  });
  assert.equal(hit.statusCode, 200, hit.body);
  assert.deepEqual(titles(hit.json()), ['Match highlights']);

  // An empty search box must not become an unpaginated dump of the channel.
  for (const url of ['/api/v1/search', '/api/v1/search?q=', '/api/v1/search?q=%20']) {
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 422, url);
  }

  const badLimit = await app.inject({
    method: 'GET',
    url: '/api/v1/search?q=highlights&limit=lots',
    headers,
  });
  assert.equal(badLimit.statusCode, 422, badLimit.body);
});

test('over HTTP: search needs the gateway’s identity headers', async () => {
  const app = buildMamApp({
    service: new MamService({ store: sqliteAssetStore() }),
    policyFor: () => compile({ subjectId: 'user-1', permVersion: 1, rules: EDITOR }),
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/search?q=x' })).statusCode, 401);
});
