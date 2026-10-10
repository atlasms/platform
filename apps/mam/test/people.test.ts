// EP-28.5 — the people register and cast & crew: a person is a name and an optional image; a cast
// entry is a person in a cast-role term, whose class (on-screen / crew) belongs to the role; cast
// inherits PER ROLE — an asset naming anyone for a role replaces that role's defaults only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, type Envelope } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CH = 'ch12';
const ALL: Rule[] = [
  {
    id: 'all',
    permissions: [
      'taxonomy:read',
      'taxonomy:admin',
      'asset:read',
      'asset:write',
      'people:read',
      'people:admin',
    ],
    scope: { channelIds: [CH] },
  },
];

function harness() {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const caller = (rules: Rule[] = ALL): Caller => ({
    userId: 'u1',
    channelId: CH,
    policy: compile({ subjectId: 'u1', permVersion: 1, rules }),
  });
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  return { store, service, caller, drain };
}

async function roles(h: ReturnType<typeof harness>) {
  const role = async (key: string, roleClass: 'on-screen' | 'crew') =>
    (await h.service.createTerm(h.caller(), 'cast-role', { key, labels: { en: key }, roleClass }))
      .id;
  return {
    producer: await role('producer', 'crew'),
    director: await role('director', 'crew'),
    presenter: await role('presenter', 'on-screen'),
  };
}

test('a person is a name and an optional image — nothing else; deprecated, never deleted; audited', async () => {
  const h = harness();
  const ana = await h.service.createPerson(h.caller(), { name: ' Ana Silva ', imageRef: 'img-1' });
  assert.deepEqual([ana.name, ana.imageRef, ana.version], ['Ana Silva', 'img-1', 1]);
  await assert.rejects(
    h.service.createPerson(h.caller(), { name: 'Bo', email: 'bo@example.com' } as never),
    /a person is a name and an image only/,
  );
  await assert.rejects(h.service.createPerson(h.caller(), {}), /name is required/);

  const gone = await h.service.updatePerson(h.caller(), ana.id, ana.version, { deprecated: true });
  assert.ok(gone.deprecatedAt);
  assert.deepEqual(await h.service.people(h.caller()), []);
  assert.equal((await h.service.people(h.caller(), { includeDeprecated: true })).length, 1);
  await assert.rejects(
    h.service.updatePerson(h.caller(), ana.id, ana.version, { name: 'Stale' }),
    /changed since version 1/,
  );

  const events = await h.drain();
  assert.deepEqual(
    events.map((e) => e.type),
    ['person.created', 'audit.recorded', 'audit.recorded'],
  );
  for (const e of events) assert.ok(validatePayload(e.type, e.payload).valid, e.type);

  const reader: Rule[] = [{ id: 'r', permissions: ['people:read'], scope: { channelIds: [CH] } }];
  await assert.rejects(h.service.createPerson(h.caller(reader), { name: 'X' }), /people:admin/);
  await assert.rejects(h.service.people(h.caller([])), /people:read|no rule/);
});

test('a cast role carries its class: required on a cast-role term, refused on any other', async () => {
  const h = harness();
  await assert.rejects(
    h.service.createTerm(h.caller(), 'cast-role', { key: 'guest', labels: { en: 'Guest' } }),
    /roleClass is required for a cast role/,
  );
  await assert.rejects(
    h.service.createTerm(h.caller(), 'genre', {
      key: 'drama',
      labels: { en: 'Drama' },
      roleClass: 'crew',
    }),
    /only a cast-role term has a roleClass/,
  );
  await assert.rejects(
    h.service.createTerm(h.caller(), 'cast-role', {
      key: 'guest',
      labels: { en: 'Guest' },
      roleClass: 'audience' as never,
    }),
    /roleClass must be one of on-screen, crew/,
  );
  const guest = await h.service.createTerm(h.caller(), 'cast-role', {
    key: 'guest',
    labels: { en: 'Guest' },
    roleClass: 'on-screen',
  });
  assert.equal(guest.roleClass, 'on-screen');
});

test('cast inherits PER ROLE: the category’s producer reaches every episode; an episode’s own director replaces the director only', async () => {
  const h = harness();
  const R = await roles(h);
  const p = async (name: string) => (await h.service.createPerson(h.caller(), { name })).id;
  const [prod, dir1, dir2, host] = [
    await p('Prod'),
    await p('Dir One'),
    await p('Dir Two'),
    await p('Host'),
  ];

  const show = await h.service.createCategory(h.caller(), {
    key: 'show',
    labels: { en: 'Show' },
    mediaAddable: false,
    defaults: {
      cast: [
        { personId: prod, roleId: R.producer },
        { personId: dir1, roleId: R.director },
      ],
    },
  });
  const season = await h.service.createCategory(h.caller(), {
    parentId: show.id,
    key: 'season-1',
    labels: { en: 'S1' },
    defaults: { cast: [{ personId: host, roleId: R.presenter }] },
  });
  // The season sets only the presenter: producer and director come from the show.
  const seasonInherits = await h.service.categoryInherited(h.caller(), season.id);
  assert.deepEqual(
    seasonInherits.defaults.cast?.map((e) => [e.personId, e.roleId, e.from.path]),
    [
      [prod, R.producer, '/show/'],
      [dir1, R.director, '/show/'],
    ],
  );

  const episode = await h.service.create(h.caller(), {
    title: 'Episode 1',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: season.id,
    cast: [{ personId: dir2, roleId: R.director }],
  });
  const got = await h.service.inherited(h.caller(), episode.id);
  assert.deepEqual(
    got.defaults.cast?.map((e) => [e.personId, e.roleId]),
    [
      [host, R.presenter],
      [prod, R.producer],
    ],
    'the director is the episode’s own; the rest are inherited, nearest first',
  );
  // FR-PPL-4: found by person — the producer it only inherits, and the director it names.
  const byPerson = async (personId: string) =>
    (await h.service.advancedSearch(h.caller(), { facets: { person: [personId] } })).items.map(
      (a) => a.id,
    );
  assert.deepEqual(await byPerson(prod), [episode.id]);
  assert.deepEqual(await byPerson(dir2), [episode.id]);
  assert.deepEqual(await byPerson(dir1), [], 'the episode replaced the show’s director');
  // `inherit: ['cast']` gives every role back to the category.
  const back = await h.service.update(h.caller(), episode.id, { inherit: ['cast'] });
  assert.equal(back.cast, undefined);
  assert.equal((await h.service.inherited(h.caller(), episode.id)).defaults.cast?.length, 3);
});

test('a cast entry names a live person of the channel and a live cast-role term — a 422 otherwise', async () => {
  const h = harness();
  const R = await roles(h);
  const genre = await h.service.createTerm(h.caller(), 'genre', {
    key: 'news',
    labels: { en: 'News' },
  });
  const ana = await h.service.createPerson(h.caller(), { name: 'Ana' });
  const asset = (cast: unknown) =>
    h.service.create(h.caller(), {
      title: 'Clip',
      mediaType: 'video',
      fileType: 'mxf',
      cast,
    } as never);
  await assert.rejects(
    asset([{ personId: 'nobody', roleId: R.director }]),
    /cast\[0\]\.personId names no person of this channel/,
  );
  await assert.rejects(
    asset([{ personId: ana.id, roleId: genre.id }]),
    /cast\[0\]\.roleId must name a term of the cast-role vocabulary/,
  );
  await assert.rejects(
    asset([
      { personId: ana.id, roleId: R.director },
      { personId: ana.id, roleId: R.director },
    ]),
    /repeats a person in the same role/,
  );
  await assert.rejects(asset([{ personId: ana.id }]), /must be \{ personId, roleId \}/);
  const ok = await asset([
    { personId: ana.id, roleId: R.director },
    { personId: ana.id, roleId: R.presenter },
  ]);
  assert.equal(ok.cast?.length, 2, 'one person in two roles is two entries');
  // Cast is its own field group: a writer without `cast` cannot set it.
  const noCast: Rule[] = [
    {
      id: 'core',
      permissions: ['asset:read', 'asset:write'],
      scope: { channelIds: [CH] },
      fieldGroups: ['core'],
    },
  ];
  await assert.rejects(
    h.service.update(h.caller(noCast), ok.id, { cast: [] }),
    /cast|asset:write|Forbidden/i,
  );
});
