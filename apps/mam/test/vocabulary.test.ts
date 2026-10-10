// EP-28.3 — controlled vocabularies: stable id, mutable label; deprecate, never delete; merge as
// one audited write; a key for imports. And the media-default fields hold TERM ids, validated.

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
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const caller = (rules: Rule[] = ALL, channelId = CH): Caller => ({
    userId: 'u1',
    channelId,
    policy: compile({ subjectId: 'u1', permVersion: 1, rules }),
  });
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  return { store, service, caller, drain };
}

const asset = (extra: Record<string, unknown> = {}) => ({
  title: 'A clip',
  mediaType: 'video',
  fileType: 'mxf',
  ...extra,
});

test('a term: created with a key, renamed without touching what references it, deprecated not deleted', async () => {
  const h = harness();
  const drama = await h.service.createTerm(h.caller(), 'genre', {
    key: 'drama',
    labels: { en: 'Drama', ar: 'دراما' },
    external: { epg: 'DRAMA' },
  });
  const clip = await h.service.create(h.caller(), asset({ genre: drama.id }));
  const renamed = await h.service.updateTerm(h.caller(), 'genre', drama.id, drama.version, {
    labels: { en: 'Drama series' },
  });
  assert.equal(renamed.version, 2);
  assert.equal(
    (await h.service.get(h.caller(), clip.id)).genre,
    drama.id,
    'the asset holds the id',
  );

  const gone = await h.service.updateTerm(h.caller(), 'genre', drama.id, renamed.version, {
    deprecated: true,
  });
  assert.ok(gone.deprecatedAt);
  assert.deepEqual(await h.service.terms(h.caller(), 'genre'), [], 'out of the picker');
  assert.equal((await h.service.terms(h.caller(), 'genre', { includeDeprecated: true })).length, 1);
  assert.equal(
    (await h.service.term(h.caller(), 'genre', drama.id)).key,
    'drama',
    'still resolves',
  );
  // …and refused for a NEW write, while the asset that has it keeps it.
  await assert.rejects(
    h.service.create(h.caller(), asset({ genre: drama.id })),
    /genre: drama is deprecated/,
  );

  await assert.rejects(
    h.service.createTerm(h.caller(), 'genre', { key: 'drama', labels: { en: 'Again' } }),
    /already has a term with the key drama/,
  );
  await assert.rejects(
    h.service.updateTerm(h.caller(), 'genre', drama.id, gone.version, { key: 'other' }),
    /key cannot change/,
  );
  await assert.rejects(h.service.terms(h.caller(), 'colour'), /no vocabulary colour/);
});

test('a merge is ONE audited write: the term redirects to the survivor, and a write naming it is told which', async () => {
  const h = harness();
  const a = await h.service.createTerm(h.caller(), 'supply-type', {
    key: 'bought',
    labels: { en: 'Bought' },
  });
  const b = await h.service.createTerm(h.caller(), 'supply-type', {
    key: 'acquired',
    labels: { en: 'Acquired' },
  });
  await h.drain();
  const merged = await h.service.mergeTerm(h.caller(), 'supply-type', a.id, {
    into: b.id,
    version: a.version,
  });
  assert.equal(merged.replacedById, b.id);
  assert.ok(merged.deprecatedAt);
  const events = (await h.drain()).slice(-2);
  assert.deepEqual(
    events.map((e) => e.type),
    ['taxonomy.updated', 'audit.recorded'],
  );
  const announced = events[0]!.payload as unknown as EventPayloads['taxonomy.updated'];
  assert.deepEqual(
    [announced.kind, announced.action, announced.replacedById],
    ['supply-type', 'merged', b.id],
  );
  for (const e of events) assert.ok(validatePayload(e.type, e.payload).valid, e.type);
  const audit = events[1]!.payload as unknown as EventPayloads['audit.recorded'];
  assert.deepEqual([audit.entityType, audit.action], ['vocabulary-term', 'vocabulary-term.merged']);

  await assert.rejects(
    h.service.create(h.caller(), asset({ supplyType: a.id })),
    new RegExp(`supplyType: bought was merged into acquired \\(${b.id}\\)`),
  );
  await assert.rejects(
    h.service.mergeTerm(h.caller(), 'supply-type', b.id, { into: b.id, version: b.version }),
    /cannot be merged into itself/,
  );
  await assert.rejects(
    h.service.updateTerm(h.caller(), 'supply-type', a.id, merged.version, { deprecated: false }),
    /merged into another term — it cannot be restored/,
  );
});

test('the media-default fields must name a live term OF THEIR vocabulary in this channel — on assets and in category defaults', async () => {
  const h = harness();
  const structure = await h.service.createTerm(h.caller(), 'structure', {
    key: 'news',
    labels: { en: 'News' },
  });
  const genre = await h.service.createTerm(h.caller(), 'genre', {
    key: 'news',
    labels: { en: 'News' },
  });
  const ok = await h.service.create(
    h.caller(),
    asset({ structureId: structure.id, genre: genre.id }),
  );
  assert.equal(ok.structureId, structure.id);

  await assert.rejects(
    h.service.create(h.caller(), asset({ genre: structure.id })),
    /genre must name a term of the genre vocabulary/,
  );
  await assert.rejects(
    h.service.update(h.caller(), ok.id, { productionGroup: 'Studio A' }),
    /productionGroup must name a term of the production-group vocabulary/,
  );
  // Another channel's term is not this channel's.
  const elsewhere = await h.service.createTerm(
    h.caller([{ ...ALL[0]!, scope: { channelIds: ['ch99'] } }], 'ch99'),
    'genre',
    {
      key: 'news',
      labels: { en: 'News' },
    },
  );
  await assert.rejects(
    h.service.create(h.caller(), asset({ genre: elsewhere.id })),
    /genre must name a term of the genre vocabulary/,
  );
  // A category's defaults are held to the same rule.
  await assert.rejects(
    h.service.createCategory(h.caller(), {
      key: 'docs',
      labels: { en: 'Docs' },
      defaults: { genre: 'documentary' },
    }),
    /defaults\.genre must name a term of the genre vocabulary/,
  );
  const docs = await h.service.createCategory(h.caller(), {
    key: 'docs',
    labels: { en: 'Docs' },
    defaults: { genre: genre.id },
  });
  assert.equal(docs.defaults?.genre, genre.id);
});

test('editing a vocabulary is taxonomy:admin in the CHANNEL — a grant narrowed to a category subtree is refused', async () => {
  const h = harness();
  const subtree: Rule[] = [
    {
      id: 'sub',
      permissions: ['taxonomy:read', 'taxonomy:admin'],
      scope: { channelIds: [CH], categoryPaths: ['/news/'] },
    },
  ];
  await assert.rejects(
    h.service.createTerm(h.caller(subtree), 'genre', { key: 'drama', labels: { en: 'Drama' } }),
    /Forbidden|taxonomy:admin|not/i,
  );
  const reader: Rule[] = [{ id: 'r', permissions: ['taxonomy:read'], scope: { channelIds: [CH] } }];
  await assert.rejects(
    h.service.createTerm(h.caller(reader), 'genre', { key: 'drama', labels: { en: 'Drama' } }),
  );
  assert.deepEqual(await h.service.terms(h.caller(reader), 'genre'), []);
});

test('the reference snapshot carries each vocabulary’s LIVE terms', async () => {
  const h = harness();
  const live = await h.service.createTerm(h.caller(), 'classification', {
    key: 'current-affairs',
    labels: { en: 'Current affairs' },
  });
  const old = await h.service.createTerm(h.caller(), 'classification', {
    key: 'old',
    labels: { en: 'Old' },
  });
  await h.service.updateTerm(h.caller(), 'classification', old.id, old.version, {
    deprecated: true,
  });
  const snapshot = await h.service.referenceSnapshot(h.caller());
  assert.deepEqual(snapshot.vocabularies.classification, [
    {
      id: live.id,
      key: 'current-affairs',
      label: 'Current affairs',
      labels: { en: 'Current affairs' },
    },
  ]);
  assert.deepEqual(snapshot.vocabularies['cast-role'], []);
});
