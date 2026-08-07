// #233 — listing, and the two authorization bugs it used to have.
//
// `list()` asked the STRICT evaluator once with no category and then returned the channel
// unfiltered. That is wrong in both directions at once, and each half hid the other: a
// category-scoped reader was denied outright, so nobody ever reached the unfiltered return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Rule } from '@atlas/policy';
import { buildMamApp, MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CHANNEL = 'ch12';

const FULL: Rule[] = [
  { id: 'r', permissions: ['asset:read', 'asset:write'], scope: { channelIds: [CHANNEL] } },
];

/** The grant that used to be refused outright: read, but only inside one category subtree. */
const NEWS_ONLY: Rule[] = [
  {
    id: 'r',
    permissions: ['asset:read'],
    scope: { channelIds: [CHANNEL], categoryPaths: ['/news/'] },
  },
];

function harness() {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const caller = (rules: Rule[] = FULL, over: Partial<Caller> = {}): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({ subjectId: over.userId ?? 'user-1', permVersion: 1, rules }),
    ...over,
  });
  return { store, service, caller };
}

const NEW_ASSET = { title: 'Clip', mediaType: 'video', fileType: 'mxf' };

async function seed(
  service: MamService,
  caller: Caller,
  specs: readonly { title: string; categoryId?: string }[],
): Promise<void> {
  for (const spec of specs) {
    await service.create(caller, {
      ...NEW_ASSET,
      title: spec.title,
      ...(spec.categoryId === undefined ? {} : { categoryId: spec.categoryId }),
    });
  }
}

const titles = (page: { items: { title: string }[] }): string[] => page.items.map((a) => a.title);

// =============================================================================
// The bug, both halves
// =============================================================================

test('SECURITY: a category-scoped reader gets their assets, not a 403', async () => {
  // Half one. `canEnforce` cannot satisfy `categoryPaths: ['/news/']` from a check that names no
  // category, so this caller used to be refused entirely — a correctly configured operator grant
  // that made the service unusable.
  const { service, caller, store } = harness();
  await seed(service, caller(), [
    { title: 'News item', categoryId: '/news/' },
    { title: 'Sports item', categoryId: '/sports/' },
  ]);

  const reader = new MamService({ store });
  const page = await reader.list(caller(NEWS_ONLY, { userId: 'user-2' }));

  assert.deepEqual(titles(page), ['News item']);
});

test('SECURITY: a scoped reader does NOT see the rest of the channel', async () => {
  // Half two. Even a caller who passed the broad check received every row, because the filter was
  // never applied to the results — the check and the query disagreed about what was being asked.
  const { service, caller, store } = harness();
  await seed(service, caller(), [
    { title: 'News A', categoryId: '/news/' },
    { title: 'Sports A', categoryId: '/sports/' },
    { title: 'News B', categoryId: '/news/' },
    { title: 'Uncategorised' },
  ]);

  const reader = new MamService({ store });
  const page = await reader.list(caller(NEWS_ONLY, { userId: 'user-2' }));

  assert.deepEqual(titles(page).sort(), ['News A', 'News B']);
});

test('a caller with no read grant at all is still refused', async () => {
  const { service, caller } = harness();
  await assert.rejects(
    service.list(
      caller([{ id: 'w', permissions: ['asset:write'], scope: { channelIds: [CHANNEL] } }]),
    ),
    /asset:read/,
  );
});

test('SECURITY: listing is still a tenant boundary', async () => {
  const { service, caller, store } = harness();
  await seed(service, caller(), [{ title: 'Ours' }]);

  const other = new MamService({ store });
  const outsider: Caller = {
    userId: 'user-9',
    channelId: 'ch99',
    // Deliberately UNSCOPED, so only the channel filter can stop this.
    policy: compile({
      subjectId: 'user-9',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['asset:read'] }],
    }),
  };

  assert.deepEqual(titles(await other.list(outsider)), []);
});

// =============================================================================
// Pagination
// =============================================================================

test('pages tile the channel exactly — no gaps, no repeats', async () => {
  const { service, caller } = harness();
  await seed(
    service,
    caller(),
    Array.from({ length: 7 }, (_, i) => ({ title: `Clip ${i}` })),
  );

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await service.list(caller(), {
      limit: 3,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages++;
    seen.push(...titles(page));
    cursor = page.nextCursor;
    if (cursor === undefined) break;
    assert.ok(pages < 10, 'must terminate');
  }

  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7, 'an inclusive cursor would repeat a row per page');
});

test('nextCursor is absent once the channel is exhausted', async () => {
  const { service, caller } = harness();
  await seed(service, caller(), [{ title: 'Only' }]);

  const page = await service.list(caller(), { limit: 10 });
  assert.deepEqual(titles(page), ['Only']);
  assert.equal(page.nextCursor, undefined);
});

test('the cursor advances past assets the caller may NOT read', async () => {
  // The subtle one. If the cursor only advanced on a returned row, a page full of unreadable
  // assets would return the same cursor forever and the client would loop. If it advanced to the
  // end of the store's page regardless, rows the loop never reached would be skipped.
  const { service, caller, store } = harness();
  await seed(service, caller(), [
    { title: 'Sports 1', categoryId: '/sports/' },
    { title: 'Sports 2', categoryId: '/sports/' },
    { title: 'News 1', categoryId: '/news/' },
    { title: 'Sports 3', categoryId: '/sports/' },
    { title: 'News 2', categoryId: '/news/' },
  ]);

  const reader = new MamService({ store });
  const who = caller(NEWS_ONLY, { userId: 'user-2' });

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await reader.list(who, { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    seen.push(...titles(page));
    cursor = page.nextCursor;
    if (cursor === undefined) break;
  }

  assert.deepEqual(seen.sort(), ['News 1', 'News 2'], 'both, each once, despite the gaps');
});

test('limit is honoured and capped', async () => {
  const { service, caller } = harness();
  await seed(
    service,
    caller(),
    Array.from({ length: 5 }, (_, i) => ({ title: `Clip ${i}` })),
  );

  assert.equal((await service.list(caller(), { limit: 2 })).items.length, 2);
  assert.equal((await service.list(caller(), { limit: 1_000_000 })).items.length, 5);
});

// =============================================================================
// HTTP
// =============================================================================

test('over HTTP: the listing is an object with a cursor, not a bare array', async () => {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const app = buildMamApp({
    service,
    policyFor: () => compile({ subjectId: 'user-1', permVersion: 1, rules: FULL }),
  });
  const headers = {
    'x-atlas-user': 'user-1',
    'x-atlas-channel': CHANNEL,
    'content-type': 'application/json',
  };

  for (let i = 0; i < 3; i++) {
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers,
      payload: { ...NEW_ASSET, title: `Clip ${i}` },
    });
  }

  const first = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=2', headers });
  assert.equal(first.statusCode, 200, first.body);
  const firstPage = first.json();
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor, 'more to come');

  const second = await app.inject({
    method: 'GET',
    url: `/api/v1/assets?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    headers,
  });
  const secondPage = second.json();
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, undefined);

  const bad = await app.inject({ method: 'GET', url: '/api/v1/assets?limit=lots', headers });
  assert.equal(bad.statusCode, 422, bad.body);
});
