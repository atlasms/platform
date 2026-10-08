// #260 — categories as an entity: a tree per channel whose paths are built from immutable keys,
// moved as an audited operation, and resolved to that path for every authorization check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CH = 'ch12';
const ALL: Rule[] = [
  {
    id: 'all',
    permissions: ['taxonomy:read', 'taxonomy:admin', 'asset:read', 'asset:write'],
    scope: { channelIds: [CH] },
  },
];

function harness() {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), new InMemoryBroker());
  const broker = (relay as unknown as { broker: InMemoryBroker }).broker;
  const caller = (rules: Rule[] = ALL, userId = 'u1'): Caller => ({
    userId,
    channelId: CH,
    policy: compile({ subjectId: userId, permVersion: 1, rules }),
  });
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  return { store, service, caller, drain };
}

const label = (en: string) => ({ en });

async function tree(h: ReturnType<typeof harness>) {
  const sports = await h.service.createCategory(h.caller(), {
    key: 'sports',
    labels: label('Sports'),
    kind: 'department',
    mediaAddable: false,
  });
  const football = await h.service.createCategory(h.caller(), {
    parentId: sports.id,
    key: 'football',
    labels: { en: 'Football', ar: 'كرة القدم' },
  });
  const highlights = await h.service.createCategory(h.caller(), {
    parentId: football.id,
    key: 'highlights',
    labels: label('Highlights'),
  });
  const news = await h.service.createCategory(h.caller(), { key: 'news', labels: label('News') });
  return { sports, football, highlights, news };
}

test('a tree: paths are built from keys; a key is unique among siblings; the shape is refused at the edge', async () => {
  const h = harness();
  const { sports, football, highlights } = await tree(h);
  assert.deepEqual(
    [sports.path, football.path, highlights.path, highlights.depth],
    ['/sports/', '/sports/football/', '/sports/football/highlights/', 3],
  );
  assert.equal(football.parentId, sports.id);
  assert.deepEqual(
    (await h.service.categories(h.caller())).map((c) => c.path),
    ['/news/', '/sports/', '/sports/football/', '/sports/football/highlights/'],
  );
  await assert.rejects(
    h.service.createCategory(h.caller(), {
      parentId: sports.id,
      key: 'football',
      labels: label('Again'),
    }),
    /already exists at \/sports\/football\//,
  );
  await assert.rejects(
    h.service.createCategory(h.caller(), { key: 'Not A Key', labels: {} }),
    /key must be lower-case.*; labels must map/,
  );
  await assert.rejects(
    h.service.createCategory(h.caller(), { parentId: 'nope', key: 'x', labels: label('X') }),
    /no category nope/,
  );
});

test('every write is a revision: the row, taxonomy.updated and an audit delta, each valid against its schema', async () => {
  const h = harness();
  const { football } = await tree(h);
  const renamed = await h.service.updateCategory(h.caller(), football.id, football.version, {
    labels: { en: 'Association football', ar: 'كرة القدم' },
  });
  assert.equal(renamed.version, 2);
  assert.equal(renamed.path, football.path, 'a label is not part of the path');
  const events = await h.drain();
  for (const e of events) assert.ok(validatePayload(e.type, e.payload).valid, e.type);
  const audits = events
    .filter((e) => e.type === 'audit.recorded')
    .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
    .filter((a) => a.entityId === football.id);
  assert.deepEqual(
    audits.map((a) => [a.entityType, a.revision, a.action]),
    [
      ['category', 1, 'category.created'],
      ['category', 2, 'category.updated'],
    ],
  );
  assert.deepEqual((audits[1]!.delta as Record<string, unknown>)['labels'], {
    before: { en: 'Football', ar: 'كرة القدم' },
    after: { en: 'Association football', ar: 'كرة القدم' },
  });
  const updated = events.filter((e) => e.type === 'taxonomy.updated').at(-1)!
    .payload as unknown as EventPayloads['taxonomy.updated'];
  assert.deepEqual(
    [updated.kind, updated.action, updated.path],
    ['category', 'updated', '/sports/football/'],
  );
});

test('the key and the parent cannot change by PATCH; a stale version is a conflict', async () => {
  const h = harness();
  const { football } = await tree(h);
  await assert.rejects(
    h.service.updateCategory(h.caller(), football.id, 1, { key: 'soccer' } as never),
    /key cannot change/,
  );
  await assert.rejects(
    h.service.updateCategory(h.caller(), football.id, 1, { parentId: 'x' } as never),
    /use move/,
  );
  await h.service.updateCategory(h.caller(), football.id, 1, { sortOrder: 5 });
  await assert.rejects(
    h.service.updateCategory(h.caller(), football.id, 1, { sortOrder: 6 }),
    /changed since version 1/,
  );
});

test('an asset’s categoryId is validated: an unknown, a non-addable or a deprecated branch is a 422', async () => {
  const h = harness();
  const { sports, football, highlights } = await tree(h);
  const asset = { title: 'Goal', mediaType: 'video', fileType: 'mxf' };
  await assert.rejects(
    h.service.create(h.caller(), { ...asset, categoryId: 'nope' }),
    /names no category of this channel/,
  );
  await assert.rejects(
    h.service.create(h.caller(), { ...asset, categoryId: sports.id }),
    /cannot be added directly to \/sports\//,
  );
  const ok = await h.service.create(h.caller(), { ...asset, categoryId: highlights.id });
  assert.equal(ok.categoryId, highlights.id);

  // Deprecating a branch takes the whole branch out of pickers and out of reach of new media,
  // without rewriting the nodes below it; restoring it brings them back.
  const deprecated = await h.service.updateCategory(h.caller(), football.id, football.version, {
    deprecated: true,
  });
  assert.ok(deprecated.deprecatedAt);
  assert.deepEqual(
    (await h.service.categories(h.caller())).map((c) => c.path),
    ['/news/', '/sports/'],
  );
  assert.equal((await h.service.categories(h.caller(), { includeDeprecated: true })).length, 4);
  await assert.rejects(
    h.service.create(h.caller(), { ...asset, categoryId: highlights.id }),
    /\/sports\/football\/highlights\/ is deprecated/,
  );
  await h.service.updateCategory(h.caller(), football.id, deprecated.version, {
    deprecated: false,
  });
  await h.service.create(h.caller(), { ...asset, categoryId: highlights.id });
});

test('SECURITY: a category-scoped grant is checked against the category’s REAL path — before #260 it matched nothing', async () => {
  const h = harness();
  const { highlights, news } = await tree(h);
  const goal = await h.service.create(h.caller(), {
    title: 'Goal',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: highlights.id,
  });
  const bulletin = await h.service.create(h.caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: news.id,
  });
  const sportsReader = h.caller(
    [
      {
        id: 'r',
        permissions: ['asset:read'],
        scope: { channelIds: [CH], categoryPaths: ['/sports/'] },
      },
    ],
    'reader',
  );
  assert.equal((await h.service.get(sportsReader, goal.id)).id, goal.id);
  await assert.rejects(h.service.get(sportsReader, bulletin.id), /asset:read/);
  assert.deepEqual(
    (await h.service.list(sportsReader)).items.map((a) => a.id),
    [goal.id],
  );

  // A writer scoped to /news/ files nothing under /sports/, by create or by edit.
  const newsWriter = h.caller(
    [
      {
        id: 'w',
        permissions: ['asset:read', 'asset:write'],
        scope: { channelIds: [CH], categoryPaths: ['/news/'] },
      },
    ],
    'writer',
  );
  await assert.rejects(
    h.service.create(newsWriter, {
      title: 'x',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: highlights.id,
    }),
    /asset:write/,
  );
  await assert.rejects(
    h.service.update(newsWriter, bulletin.id, { categoryId: highlights.id }),
    /asset:write/,
  );
  const mine = await h.service.create(newsWriter, {
    title: 'Mine',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: news.id,
  });
  assert.equal(mine.categoryId, news.id);
});

test('a MOVE rewrites the subtree in one transaction, every node audited — and grants follow the position', async () => {
  const h = harness();
  const { sports, football, highlights, news } = await tree(h);
  const goal = await h.service.create(h.caller(), {
    title: 'Goal',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: highlights.id,
  });
  await h.drain();

  const movedFootball = await h.service.moveCategory(h.caller(), football.id, {
    parentId: news.id,
    version: football.version,
  });
  assert.deepEqual(
    [movedFootball.path, movedFootball.parentId, movedFootball.version],
    ['/news/football/', news.id, 2],
  );
  const after = await h.service.categories(h.caller());
  assert.deepEqual(after.find((c) => c.id === highlights.id)?.path, '/news/football/highlights/');
  const events = await h.drain();
  assert.deepEqual(
    events
      .filter((e) => e.type === 'audit.recorded')
      .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
      .filter((a) => a.action === 'category.moved')
      .map((a) => a.entityId)
      .sort(),
    [football.id, highlights.id].sort(),
    'the moved node and its descendant, each a revision',
  );
  const movedEvents = events.filter(
    (e) =>
      e.type === 'taxonomy.updated' &&
      (e.payload as unknown as EventPayloads['taxonomy.updated']).action === 'moved',
  );
  assert.equal(movedEvents.length, 1, 'one announcement for the move');

  // The same asset, the same categoryId — now under /news/, so the sports reader lost it.
  const sportsReader = h.caller(
    [
      {
        id: 'r',
        permissions: ['asset:read'],
        scope: { channelIds: [CH], categoryPaths: ['/sports/'] },
      },
    ],
    'reader',
  );
  await assert.rejects(h.service.get(sportsReader, goal.id), /asset:read/);

  // Refusals: under itself or a descendant; onto a key already taken; without admin over BOTH.
  await assert.rejects(
    h.service.moveCategory(h.caller(), news.id, { parentId: highlights.id, version: news.version }),
    /under itself or one of its descendants/,
  );
  const otherFootball = await h.service.createCategory(h.caller(), {
    parentId: sports.id,
    key: 'football',
    labels: label('Football again'),
  });
  await assert.rejects(
    h.service.moveCategory(h.caller(), otherFootball.id, { parentId: news.id, version: 1 }),
    /already exists at \/news\/football\//,
  );
  const sportsAdmin = h.caller(
    [
      {
        id: 'a',
        permissions: ['taxonomy:read', 'taxonomy:admin'],
        scope: { channelIds: [CH], categoryPaths: ['/sports/'] },
      },
    ],
    'sports-admin',
  );
  await assert.rejects(
    h.service.moveCategory(sportsAdmin, otherFootball.id, { parentId: null, version: 1 }),
    /taxonomy:admin/,
    'the root is outside /sports/',
  );
  await assert.rejects(
    h.service.createCategory(sportsAdmin, { key: 'weather', labels: label('Weather') }),
    /taxonomy:admin/,
  );
  const tennis = await h.service.createCategory(sportsAdmin, {
    parentId: sports.id,
    key: 'tennis',
    labels: label('Tennis'),
  });
  assert.equal(tennis.path, '/sports/tennis/');
});

test('the browse tree: a category, or a category and everything below it', async () => {
  const h = harness();
  const { football, highlights, news } = await tree(h);
  const make = (categoryId: string) =>
    h.service.create(h.caller(), { title: 't', mediaType: 'video', fileType: 'mxf', categoryId });
  const a = await make(football.id);
  const b = await make(highlights.id);
  await make(news.id);
  const only = await h.service.list(h.caller(), { categoryId: football.id });
  assert.deepEqual(
    only.items.map((x) => x.id),
    [a.id],
  );
  const below = await h.service.list(h.caller(), { categoryId: football.id, subtree: true });
  assert.deepEqual(below.items.map((x) => x.id).sort(), [a.id, b.id].sort());
});

test('the reference snapshot carries the LIVE tree; reading it needs taxonomy:read', async () => {
  const h = harness();
  const { football } = await tree(h);
  await h.service.updateCategory(h.caller(), football.id, football.version, { deprecated: true });
  const snapshot = await h.service.referenceSnapshot(h.caller());
  assert.deepEqual(
    snapshot.vocabularies.category.map((c) => [c.path, c.label]),
    [
      ['/news/', 'News'],
      ['/sports/', 'Sports'],
    ],
  );
  await assert.rejects(
    h.service.categories(
      h.caller([{ id: 'r', permissions: ['asset:read'], scope: { channelIds: [CH] } }]),
    ),
    /taxonomy:read/,
  );
});
