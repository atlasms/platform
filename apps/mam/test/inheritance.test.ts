// EP-28.2 — live per-field inheritance: a category inherits from its ancestors, media from its
// category; the nearest level that sets a value wins; nothing is copied, so an edit high in the
// tree is at once the value everywhere below that has not set its own. The default expiry is the
// exception: snapshotted at approval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Rule } from '@atlas/policy';
import {
  addDuration,
  expiryFrom,
  MamService,
  parseDuration,
  sqliteAssetStore,
  type Caller,
} from '../src/index.ts';

const CH = 'ch12';
const ALL: Rule[] = [
  {
    id: 'all',
    permissions: ['taxonomy:read', 'taxonomy:admin', 'asset:read', 'asset:write', 'asset:approve'],
    scope: { channelIds: [CH] },
  },
];

function harness(options: { mandatory?: string[]; now?: () => Date } = {}) {
  const store = sqliteAssetStore();
  const service = new MamService({
    store,
    ...(options.mandatory ? { mandatoryFieldsFor: () => options.mandatory! } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const caller = (rules: Rule[] = ALL): Caller => ({
    userId: 'u1',
    channelId: CH,
    policy: compile({ subjectId: 'u1', permVersion: 1, rules }),
  });
  return { store, service, caller };
}

/**
 * The terms the defaults name (EP-28.3: the media-default fields hold vocabulary TERM ids). Made by
 * `tree`, which every test calls first.
 */
let T: Record<
  'drama' | 'period' | 'comedy' | 'thriller' | 'soap' | 'commissioned' | 'acquired' | 'studioA',
  string
>;

async function terms(h: ReturnType<typeof harness>) {
  const make = async (vocabulary: string, key: string) =>
    (await h.service.createTerm(h.caller(), vocabulary, { key, labels: { en: key } })).id;
  T = {
    drama: await make('genre', 'drama'),
    period: await make('genre', 'period-drama'),
    comedy: await make('genre', 'comedy'),
    thriller: await make('genre', 'thriller'),
    soap: await make('genre', 'soap'),
    commissioned: await make('supply-type', 'commissioned'),
    acquired: await make('supply-type', 'acquired'),
    studioA: await make('production-group', 'studio-a'),
  };
}

/** drama (genre, review, keep, expiry) › series (supply type) › season (production group). */
async function tree(h: ReturnType<typeof harness>) {
  await terms(h);
  const drama = await h.service.createCategory(h.caller(), {
    key: 'drama',
    labels: { en: 'Drama' },
    mediaAddable: false,
    defaults: { genre: T.drama, supplyType: T.commissioned },
    reviewNeeded: true,
    keepDuration: 'P30D',
    defaultExpiry: 'P1Y',
  });
  const series = await h.service.createCategory(h.caller(), {
    parentId: drama.id,
    key: 'the-series',
    labels: { en: 'The Series' },
    mediaAddable: false,
    defaults: { supplyType: T.acquired },
  });
  const season = await h.service.createCategory(h.caller(), {
    parentId: series.id,
    key: 'season-1',
    labels: { en: 'Season 1' },
    defaults: { productionGroup: T.studioA },
  });
  return { drama, series, season };
}

test('a category inherits each field from its NEAREST ancestor that sets it, and names where from', async () => {
  const h = harness();
  const { drama, series, season } = await tree(h);
  const got = await h.service.categoryInherited(h.caller(), season.id);
  assert.deepEqual(got.defaults, {
    genre: { value: T.drama, from: { categoryId: drama.id, path: '/drama/' } },
    // The series overrides the department: the nearest wins.
    supplyType: { value: T.acquired, from: { categoryId: series.id, path: '/drama/the-series/' } },
  });
  assert.ok(!('productionGroup' in got.defaults), 'set on the node: not inherited');
  assert.deepEqual(got.policies.reviewNeeded, {
    value: true,
    from: { categoryId: drama.id, path: '/drama/' },
  });
  assert.equal(got.policies.defaultExpiry?.value, 'P1Y');
  // The root inherits nothing.
  assert.deepEqual(await h.service.categoryInherited(h.caller(), drama.id), {
    categoryId: drama.id,
    defaults: {},
    policies: {},
  });
});

test('an asset inherits what it does not set — live: a category edit is at once the asset’s value', async () => {
  const h = harness();
  const { drama, season } = await tree(h);
  const asset = await h.service.create(h.caller(), {
    title: 'Episode 1',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
    productionDate: '2026-05-01',
  });
  let got = await h.service.inherited(h.caller(), asset.id);
  assert.deepEqual(
    Object.fromEntries(Object.entries(got.defaults).map(([f, v]) => [f, [v.value, v.from.path]])),
    {
      genre: [T.drama, '/drama/'],
      supplyType: [T.acquired, '/drama/the-series/'],
      productionGroup: [T.studioA, '/drama/the-series/season-1/'],
    },
  );
  assert.equal(got.defaults.productionDate, undefined, 'the asset sets it');

  // The department changes its genre: the asset reads the new one, with nothing rewritten.
  await h.service.updateCategory(h.caller(), drama.id, drama.version, {
    defaults: { genre: T.period },
  });
  got = await h.service.inherited(h.caller(), asset.id);
  assert.equal(got.defaults.genre?.value, T.period);
  assert.equal((await h.service.get(h.caller(), asset.id)).version, 1, 'the asset was not touched');
});

test('the asset’s own value overrides; `inherit` resets it to the category’s — and both are revisions', async () => {
  const h = harness();
  const { season } = await tree(h);
  const asset = await h.service.create(h.caller(), {
    title: 'Episode 2',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
  });
  const own = await h.service.update(h.caller(), asset.id, { genre: T.comedy });
  assert.equal(own.genre, T.comedy);
  assert.equal((await h.service.inherited(h.caller(), asset.id)).defaults.genre, undefined);

  const reset = await h.service.update(h.caller(), asset.id, { inherit: ['genre'] });
  assert.equal(reset.genre, undefined);
  assert.equal(reset.version, own.version + 1);
  assert.equal((await h.service.inherited(h.caller(), asset.id)).defaults.genre?.value, T.drama);
  // Inheriting what it already inherits is not a change.
  assert.equal(
    (await h.service.update(h.caller(), asset.id, { inherit: ['genre'] })).version,
    reset.version,
  );
  await assert.rejects(
    h.service.update(h.caller(), asset.id, { genre: 'x', inherit: ['genre'] }),
    /set and inherited at once/,
  );
  await assert.rejects(
    h.service.update(h.caller(), asset.id, { inherit: ['title'] }),
    /inherit must list fields among/,
  );
  await assert.rejects(
    h.service.update(h.caller(), asset.id, { productionDate: '1 May' }),
    /productionDate must be a date/,
  );
});

test('a category’s defaults MERGE on update; `inherit` takes a default or a policy off the node', async () => {
  const h = harness();
  const { series } = await tree(h);
  const merged = await h.service.updateCategory(h.caller(), series.id, series.version, {
    defaults: { genre: T.thriller },
  });
  assert.deepEqual(merged.defaults, { supplyType: T.acquired, genre: T.thriller });
  const off = await h.service.updateCategory(h.caller(), series.id, merged.version, {
    inherit: ['supplyType', 'genre'],
    reviewNeeded: false,
  });
  assert.equal(off.defaults, undefined);
  assert.equal(off.reviewNeeded, false, 'a node may set a policy to false: that is a value');
  const back = await h.service.updateCategory(h.caller(), series.id, off.version, {
    inherit: ['reviewNeeded'],
  });
  assert.equal(back.reviewNeeded, undefined);
  await assert.rejects(
    h.service.updateCategory(h.caller(), series.id, back.version, { keepDuration: '30 days' }),
    /keepDuration must be an ISO-8601 duration/,
  );
  await assert.rejects(
    h.service.updateCategory(h.caller(), series.id, back.version, {
      defaults: { colour: 'red' } as never,
    }),
    /defaults may set .* not colour/,
  );
});

test('defaults need the `defaults` group, policies the `policies` group — holding one is not holding the other', async () => {
  const h = harness();
  const { season } = await tree(h);
  const coreOnly: Rule[] = [
    {
      id: 'defaults',
      permissions: ['taxonomy:read', 'taxonomy:admin'],
      scope: { channelIds: [CH] },
      fieldGroups: ['defaults'],
    },
  ];
  const ok = await h.service.updateCategory(h.caller(coreOnly), season.id, season.version, {
    defaults: { genre: T.soap },
  });
  assert.equal(ok.defaults?.genre, T.soap);
  await assert.rejects(
    h.service.updateCategory(h.caller(coreOnly), season.id, ok.version, { reviewNeeded: false }),
    /policies|taxonomy:admin/,
  );
  await assert.rejects(
    h.service.updateCategory(h.caller(coreOnly), season.id, ok.version, {
      inherit: ['defaultExpiry'],
    }),
    /policies|taxonomy:admin/,
  );
  // …nor a label: that is `core`.
  await assert.rejects(
    h.service.updateCategory(h.caller(coreOnly), season.id, ok.version, {
      labels: { en: 'Renamed' },
    }),
    /core|taxonomy:admin/,
  );
});

test('the mandatory-metadata gate counts an inherited value as present', async () => {
  const h = harness({ mandatory: ['genre'] });
  const { season } = await tree(h);
  const asset = await h.service.create(h.caller(), {
    title: 'Episode 3',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
  });
  const ctx = await h.service.contextFor(await h.service.get(h.caller(), asset.id));
  assert.ok(ctx.mandatoryFields.includes('genre'));
  assert.ok(ctx.presentFields.includes('genre'), 'the department supplies it');
});

test('approval snapshots the category’s default expiry — a later edit to it changes nothing approved', async () => {
  const at = new Date('2026-03-31T10:00:00.000Z');
  const h = harness({ now: () => at });
  const { drama, season } = await tree(h);
  const asset = await h.service.create(h.caller(), {
    title: 'Episode 4',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
  });
  await h.service.attachRenditions(h.caller(), asset.id);
  await h.service.transition(h.caller(), asset.id, 'startProcessing');
  await h.service.transition(h.caller(), asset.id, 'markReady');
  const approved = await h.service.transition(h.caller(), asset.id, 'approve');
  assert.equal(approved.expiresAt, '2027-03-31T10:00:00.000Z', 'P1Y from approval');
  assert.equal(approved.expirySource, 'category');

  await h.service.updateCategory(h.caller(), drama.id, drama.version, { defaultExpiry: 'P1M' });
  assert.equal((await h.service.get(h.caller(), asset.id)).expiresAt, approved.expiresAt);

  // An expiry given at approval, or the asset's own, wins over the default.
  const other = await h.service.create(h.caller(), {
    title: 'Episode 5',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  await h.service.attachRenditions(h.caller(), other.id);
  await h.service.transition(h.caller(), other.id, 'startProcessing');
  await h.service.transition(h.caller(), other.id, 'markReady');
  const own = await h.service.transition(h.caller(), other.id, 'approve');
  assert.deepEqual([own.expiresAt, own.expirySource], ['2030-01-01T00:00:00.000Z', undefined]);
});

test('durations: calendar years and months clamp to the month’s end; the rest is exact time', () => {
  assert.deepEqual(parseDuration('P1Y2M3W4DT5H6M7S'), {
    years: 1,
    months: 2,
    weeks: 3,
    days: 4,
    hours: 5,
    minutes: 6,
    seconds: 7,
  });
  for (const bad of ['P', 'PT', '30D', 'P1.5D', '-P1D', 'P1DT']) {
    assert.equal(parseDuration(bad), undefined, bad);
  }
  const d = (text: string) => parseDuration(text)!;
  assert.equal(addDuration('2026-01-31T00:00:00.000Z', d('P1M')), '2026-02-28T00:00:00.000Z');
  assert.equal(addDuration('2024-02-29T12:00:00.000Z', d('P1Y')), '2025-02-28T12:00:00.000Z');
  assert.equal(addDuration('2026-03-01T00:00:00.000Z', d('P1W1DT1H')), '2026-03-09T01:00:00.000Z');
  assert.equal(
    expiryFrom('2027-01-01T00:00:00+02:00', '2026-01-01T00:00:00.000Z'),
    '2026-12-31T22:00:00.000Z',
  );
  assert.equal(expiryFrom('tomorrow', '2026-01-01T00:00:00.000Z'), undefined);
});

test('EP-28.4: list defaults — an asset with no list inherits the nearest category’s; its own list, even empty, replaces it whole', async () => {
  const h = harness();
  const { drama, season } = await tree(h);
  const term = async (vocabulary: string, key: string) =>
    (await h.service.createTerm(h.caller(), vocabulary, { key, labels: { en: key } })).id;
  const [war, love] = [await term('subject', 'war'), await term('subject', 'love')];
  const fiction = await term('classification', 'fiction');
  const dept = await h.service.updateCategory(h.caller(), drama.id, drama.version, {
    defaults: {
      subjectIds: [war],
      classificationIds: [fiction],
      tags: [' Period ', 'period', 'BBC'],
    },
  });
  assert.deepEqual(dept.defaults?.tags, ['BBC', 'Period'], 'cleaned and de-duplicated, as minted');
  // The merge keeps the scalars it was not given.
  assert.equal(dept.defaults?.genre, T.drama);

  const asset = await h.service.create(h.caller(), {
    title: 'Episode 6',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
  });
  let got = await h.service.inherited(h.caller(), asset.id);
  assert.deepEqual(
    [
      got.defaults.subjectIds?.value,
      got.defaults.classificationIds?.value,
      got.defaults.tags?.value,
    ],
    [[war], [fiction], ['BBC', 'Period']],
  );
  assert.equal(got.defaults.subjectIds?.from.path, '/drama/');

  // Its own list REPLACES — and an empty one is a choice, not "inherit".
  const own = await h.service.update(h.caller(), asset.id, {
    subjectIds: [love],
    classificationIds: [],
  });
  assert.deepEqual([own.subjectIds, own.classificationIds], [[love], []]);
  got = await h.service.inherited(h.caller(), asset.id);
  assert.equal(got.defaults.subjectIds, undefined);
  assert.equal(got.defaults.classificationIds, undefined);
  // The same list again is no change; `inherit` hands it back.
  assert.equal(
    (await h.service.update(h.caller(), asset.id, { subjectIds: [love] })).version,
    own.version,
  );
  const back = await h.service.update(h.caller(), asset.id, { inherit: ['classificationIds'] });
  assert.equal(back.classificationIds, undefined);
  assert.deepEqual(
    (await h.service.inherited(h.caller(), asset.id)).defaults.classificationIds?.value,
    [fiction],
  );

  // Tags are the asset's own resource: tagged, it no longer inherits the category's.
  await h.service.setTags(h.caller(), asset.id, ['finale']);
  assert.equal((await h.service.inherited(h.caller(), asset.id)).defaults.tags, undefined);

  // Every id must be a live term of the list's vocabulary; a list is distinct ids.
  await assert.rejects(
    h.service.update(h.caller(), asset.id, { subjectIds: [fiction] }),
    /subjectIds must name a term of the subject vocabulary/,
  );
  await assert.rejects(
    h.service.update(h.caller(), asset.id, { subjectIds: [war, war] }),
    /subjectIds must be a list of distinct term ids/,
  );
  await assert.rejects(
    h.service.updateCategory(h.caller(), season.id, season.version, {
      defaults: { tags: ['ok', ''] },
    }),
    /defaults\.tags: a tag must not be blank/,
  );
});
