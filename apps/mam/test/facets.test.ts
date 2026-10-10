// EP-28.6 — faceted search over PROJECTED effective values: an asset is found by what it inherits,
// a category change re-projects its subtree, AND across facets and OR within one, every hit
// authorized and the counts only over what the caller may read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope } from '@atlas/contracts';
import { InMemoryBroker } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { MamService, sqliteAssetStore, startFacetProjector, type Caller } from '../src/index.ts';

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
  const caller = (rules: Rule[] = ALL): Caller => ({
    userId: 'u1',
    channelId: CH,
    policy: compile({ subjectId: 'u1', permVersion: 1, rules }),
  });
  return { store, service, caller };
}

async function fixture(h: ReturnType<typeof harness>) {
  const term = async (vocabulary: string, key: string) =>
    (await h.service.createTerm(h.caller(), vocabulary, { key, labels: { en: key } })).id;
  const T = {
    drama: await term('genre', 'drama'),
    news: await term('genre', 'news'),
    war: await term('subject', 'war'),
    love: await term('subject', 'love'),
  };
  const drama = await h.service.createCategory(h.caller(), {
    key: 'drama',
    labels: { en: 'Drama' },
    mediaAddable: false,
    defaults: { genre: T.drama, subjectIds: [T.war], tags: ['Period'] },
  });
  const season = await h.service.createCategory(h.caller(), {
    parentId: drama.id,
    key: 'season-1',
    labels: { en: 'S1' },
  });
  const news = await h.service.createCategory(h.caller(), {
    key: 'news',
    labels: { en: 'News' },
    defaults: { genre: T.news },
  });
  const make = (title: string, categoryId: string, extra: Record<string, unknown> = {}) =>
    h.service.create(h.caller(), {
      title,
      mediaType: 'video',
      fileType: 'mxf',
      categoryId,
      ...extra,
    } as never);
  const ep1 = await make('Episode one', season.id);
  const ep2 = await make('Episode two', season.id, { subjectIds: [T.love] });
  const bulletin = await make('Evening bulletin', news.id);
  return { T, drama, season, news, ep1, ep2, bulletin };
}

const ids = (r: { items: { id: string }[] }) => r.items.map((a) => a.id).sort();

test('an asset is found by what it INHERITS — the category chain, the defaults, the tags — and by what it sets', async () => {
  const h = harness();
  const { T, drama, ep1, ep2, bulletin } = await fixture(h);
  const search = (facets: Record<string, string[]>, q?: string) =>
    h.service.advancedSearch(h.caller(), { facets, ...(q ? { q } : {}) });

  assert.deepEqual(ids(await search({ genre: [T.drama] })), [ep1.id, ep2.id].sort());
  // The department's id finds everything below it: the chain is projected.
  assert.deepEqual(ids(await search({ category: [drama.id] })), [ep1.id, ep2.id].sort());
  // ep2's own subject list REPLACES the inherited one.
  assert.deepEqual(ids(await search({ subject: [T.war] })), [ep1.id]);
  assert.deepEqual(ids(await search({ subject: [T.love] })), [ep2.id]);
  // Tags by their folded form, inherited by the untagged.
  assert.deepEqual(ids(await search({ tag: ['PERIOD'] })), [ep1.id, ep2.id].sort());
  // OR within a facet, AND across facets.
  assert.deepEqual(
    ids(await search({ genre: [T.drama, T.news] })),
    [ep1.id, ep2.id, bulletin.id].sort(),
  );
  assert.deepEqual(ids(await search({ genre: [T.drama, T.news], subject: [T.love] })), [ep2.id]);
  // Free text narrows.
  assert.deepEqual(ids(await search({ genre: [T.drama] }, 'one')), [ep1.id]);
  // The counts are over the page.
  const page = await search({ category: [drama.id] });
  assert.deepEqual(page.facets['subject'], { [T.war]: 1, [T.love]: 1 });
  assert.equal(page.facets['genre']?.[T.drama], 2);

  await assert.rejects(search({ colour: ['red'] }), /no facet colour/);
});

test('a category change re-projects its subtree — through the consumer of taxonomy.updated', async () => {
  const h = harness();
  const { T, drama, ep1, ep2 } = await fixture(h);
  const broker = new InMemoryBroker();
  startFacetProjector({ broker, service: h.service });

  const updated = await h.service.updateCategory(h.caller(), drama.id, drama.version, {
    defaults: { genre: T.news },
  });
  // Before the event arrives the projection still says drama…
  assert.deepEqual(
    ids(
      await h.service.advancedSearch(h.caller(), {
        facets: { genre: [T.news], category: [drama.id] },
      }),
    ),
    [],
  );
  await broker.publish({
    subject: `atlas.${CH}.taxonomy.updated`,
    id: `m-${Date.now()}`,
    body: buildEnvelope({
      type: 'taxonomy.updated',
      channelId: CH,
      payload: { kind: 'category', action: 'updated', id: updated.id },
    }),
  });
  // …and after it, the whole subtree carries the department's new genre.
  assert.deepEqual(
    ids(
      await h.service.advancedSearch(h.caller(), {
        facets: { genre: [T.news], category: [drama.id] },
      }),
    ),
    [ep1.id, ep2.id].sort(),
  );
});

test('every hit is authorized: a reader narrowed to /news/ finds only news, and counts only what it may read', async () => {
  const h = harness();
  const { T, bulletin } = await fixture(h);
  const newsOnly: Rule[] = [
    {
      id: 'news',
      permissions: ['asset:read'],
      scope: { channelIds: [CH], categoryPaths: ['/news/'] },
    },
  ];
  const r = await h.service.advancedSearch(h.caller(newsOnly), {
    facets: { genre: [T.drama, T.news] },
  });
  assert.deepEqual(ids(r), [bulletin.id]);
  assert.deepEqual(r.facets['genre'], { [T.news]: 1 });
});
