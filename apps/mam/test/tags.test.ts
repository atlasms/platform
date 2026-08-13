// EP-17.3 — tags where they meet the rest of the service.
//
// The folding rules are covered in tag.test.ts and the storage guarantees in the conformance suite.
// What matters here is the integration: that a tag write is authorized on the *taxonomy* field
// group, that minting a term announces itself, that re-submitting the same set does nothing, and
// that none of it crosses a channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, type Envelope } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { buildMamApp, MamService, sqliteAssetStore, type Caller, type Tag } from '../src/index.ts';

const CHANNEL = 'ch12';

const EDITOR: Rule[] = [
  { id: 'read', permissions: ['asset:read', 'taxonomy:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
  },
];

/** The Librarian's grant from the starter roles: files and rights, deliberately not taxonomy. */
const LIBRARIAN: Rule[] = [
  { id: 'read', permissions: ['asset:read', 'taxonomy:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['files', 'rights'],
  },
];

function harness(rules: Rule[] = EDITOR) {
  const store = sqliteAssetStore();
  // The relay reads the same database the service writes to, so what it drains is what the domain
  // transaction actually committed — not a copy handed to it.
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);

  const service = new MamService({ store });
  const caller = (over: Partial<Caller> = {}): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({ subjectId: over.userId ?? 'user-1', permVersion: 1, rules }),
    ...over,
  });

  // `broker.published` accumulates for the life of the test, so the cursor is what makes "what did
  // THIS call emit" answerable — and asserting on a suffix is the only way to prove that a no-op
  // emitted nothing.
  let seen = 0;
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    const fresh = broker.published.slice(seen).map((m) => m.body as Envelope);
    seen = broker.published.length;
    return fresh;
  };

  return { store, service, caller, drain };
}

const NEW_ASSET = { title: 'Match highlights', mediaType: 'video', fileType: 'mxf' };

const labels = (tags: readonly Tag[]): string[] => tags.map((t) => t.label);

// =============================================================================
// The happy path
// =============================================================================

test('tags are set, read back, and folded into one term per keyword', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  const set = await service.setTags(caller(), asset.id, ['Football', 'UEFA', 'football']);
  assert.deepEqual(labels(set), ['Football', 'UEFA'], 'the duplicate folded into the first');

  assert.deepEqual(labels(await service.tags(caller(), asset.id)), ['Football', 'UEFA']);
});

test('a tag minted on one asset is REUSED by the next, with the same id', async () => {
  // Two assets carrying `football` must carry the *same* tag, or a facet count is wrong and a
  // rename would only reach half the catalogue.
  const { service, caller } = harness();
  const first = await service.create(caller(), NEW_ASSET);
  const second = await service.create(caller(), NEW_ASSET);

  const a = await service.setTags(caller(), first.id, ['Football']);
  const b = await service.setTags(caller(), second.id, ['FOOTBALL']);

  assert.equal(a[0]?.id, b[0]?.id);
  assert.equal(b[0]?.label, 'Football', 'the first spelling stays the display label');
  assert.equal((await service.listTags(caller())).length, 1);
});

test('setting tags bumps the version and emits asset.updated with changedFields ["tags"]', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await drain(); // discard asset.created

  await service.setTags(caller(), asset.id, ['football']);

  const emitted = await drain();
  const updated = emitted.find((e) => e.type === 'asset.updated');
  assert.ok(updated, 'an asset whose classification changed must announce it');
  assert.deepEqual((updated.payload as { changedFields: string[] }).changedFields, ['tags']);
  assert.equal((await service.get(caller(), asset.id)).version, 2);
});

test('minting a term emits taxonomy.updated; reusing one does not', async () => {
  // Search and Studio learn that a new keyword exists from this event. Emitting it again for a tag
  // that already existed would make "a new tag appeared" untrustworthy.
  const { service, caller, drain } = harness();
  const first = await service.create(caller(), NEW_ASSET);
  const second = await service.create(caller(), NEW_ASSET);
  await drain();

  await service.setTags(caller(), first.id, ['football', 'rugby']);
  const minted = (await drain()).filter((e) => e.type === 'taxonomy.updated');
  assert.deepEqual(
    minted.map((e) => (e.payload as { label: string }).label),
    ['football', 'rugby'],
  );
  assert.deepEqual(
    minted.map((e) => (e.payload as { kind: string; action: string }).action),
    ['created', 'created'],
  );

  await service.setTags(caller(), second.id, ['football']);
  assert.deepEqual(
    (await drain()).filter((e) => e.type === 'taxonomy.updated'),
    [],
    'reusing an existing tag mints nothing and must announce nothing',
  );
});

test('every emitted payload validates against its shipped schema', async () => {
  // The service validates on the way in, so an invalid payload throws rather than reaching the
  // outbox. This asserts the taxonomy.updated shape is one the contract actually accepts.
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['football']);

  for (const e of await drain()) {
    const check = validatePayload(e.type, e.payload);
    assert.ok(check.valid, `${e.type}: ${JSON.stringify(check.errors)}`);
  }
});

// =============================================================================
// Doing nothing, correctly
// =============================================================================

test('re-submitting the same set is a NO-OP — no version bump, no event', async () => {
  // A tag input that PUTs on every change submits the unchanged set constantly. Bumping the version
  // each time would fabricate a change history and wake every consumer for nothing.
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['football', 'rugby']);
  const before = await service.get(caller(), asset.id);
  await drain();

  // Different order, different casing — the same SET.
  const again = await service.setTags(caller(), asset.id, ['RUGBY', 'Football']);

  assert.deepEqual(labels(again), ['football', 'rugby']);
  assert.equal((await service.get(caller(), asset.id)).version, before.version);
  assert.deepEqual(await drain(), []);
});

test('clearing tags IS a change, and is not confused with re-submitting nothing', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['football']);
  await drain();

  assert.deepEqual(await service.setTags(caller(), asset.id, []), []);
  assert.equal(
    (await drain()).filter((e) => e.type === 'asset.updated').length,
    1,
    'removing the last tag is an update like any other',
  );

  await drain();
  await service.setTags(caller(), asset.id, []);
  assert.deepEqual(await drain(), [], 'but clearing an already-empty set is not');
});

test('an untagged asset reads as an empty list, never an error', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  assert.deepEqual(await service.tags(caller(), asset.id), []);
});

// =============================================================================
// Authorization
// =============================================================================

test('SECURITY: tagging is authorized on the TAXONOMY field group', async () => {
  // A Librarian may write files and rights. The starter roles do not give them taxonomy, and until
  // this story MAM never asked for a field group at all — so the grant reached everything.
  const editor = harness(EDITOR);
  const asset = await editor.service.create(editor.caller(), NEW_ASSET);

  const librarian = new MamService({ store: editor.store });
  const asLibrarian: Caller = {
    userId: 'user-2',
    channelId: CHANNEL,
    policy: compile({ subjectId: 'user-2', permVersion: 1, rules: LIBRARIAN }),
  };

  await assert.rejects(
    librarian.setTags(asLibrarian, asset.id, ['football']),
    /field group "taxonomy"/,
  );

  // The refusal has to come from the GROUP and nothing else, so the same caller must still be able
  // to make a write in a group they DO hold. Without this the test would keep passing if the
  // channel scope, the permission or the policy compile broke instead.
  //
  // This used to assert a group-less core write, which worked only because `update` named no group
  // — #225 fixed that, so the control had to become a write the Librarian genuinely holds. `rights`
  // is theirs; `taxonomy` is not, and that is the whole distinction under test.
  assert.equal(
    (await librarian.update(asLibrarian, asset.id, { expiresAt: '2027-01-01T00:00:00.000Z' }))
      .expiresAt,
    '2027-01-01T00:00:00.000Z',
  );

  // …and reading the catalogue and the tag cloud is still theirs.
  assert.deepEqual(await librarian.tags(asLibrarian, asset.id), []);
  assert.deepEqual(await librarian.listTags(asLibrarian), []);
});

test('SECURITY: a tag write cannot cross a channel', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  const outsider: Caller = {
    userId: 'user-9',
    channelId: 'ch99',
    policy: compile({
      subjectId: 'user-9',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['asset:read', 'asset:write', 'taxonomy:read'] }],
    }),
  };

  // NOT FOUND, not FORBIDDEN — "you may not touch this" would confirm the asset exists.
  await assert.rejects(service.setTags(outsider, asset.id, ['x']), /no asset/);
  await assert.rejects(service.tags(outsider, asset.id), /no asset/);
});

test('SECURITY: the tag cloud is per channel', async () => {
  const { service, caller, store } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['confidential-project']);

  const other = new MamService({ store });
  const theirs = await other.listTags({
    userId: 'user-9',
    channelId: 'ch99',
    policy: compile({
      subjectId: 'user-9',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['taxonomy:read'], scope: { channelIds: ['ch99'] } }],
    }),
  });
  assert.deepEqual(theirs, [], "another tenant's keywords must not appear in this autocomplete");
});

test('listing the tag cloud needs taxonomy:read, not taxonomy:admin', async () => {
  // Gating autocomplete behind admin would defeat free-form tagging for every editor it exists for.
  const { service, caller } = harness([
    { id: 'r', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  ]);
  await assert.rejects(service.listTags(caller()), /taxonomy:read/);
});

// =============================================================================
// Validation, and the HTTP surface
// =============================================================================

test('an invalid tag is a 422 and NOTHING is written', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await service.setTags(caller(), asset.id, ['keep-me']);
  const before = await service.get(caller(), asset.id);
  await drain();

  await assert.rejects(service.setTags(caller(), asset.id, ['ok', '   ']), /blank/);

  assert.deepEqual(labels(await service.tags(caller(), asset.id)), ['keep-me']);
  assert.equal((await service.get(caller(), asset.id)).version, before.version);
  assert.deepEqual(await drain(), []);
});

test('over HTTP: PUT replaces, GET reads back, and a missing array is refused', async () => {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const app = buildMamApp({
    service,
    policyFor: () => compile({ subjectId: 'user-1', permVersion: 1, rules: EDITOR }),
  });
  const headers = {
    'x-atlas-user': 'user-1',
    'x-atlas-channel': CHANNEL,
    'content-type': 'application/json',
  };

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers,
    payload: NEW_ASSET,
  });
  const id = created.json().id as string;

  const put = await app.inject({
    method: 'PUT',
    url: `/api/v1/assets/${id}/tags`,
    headers,
    payload: { tags: ['Football', 'UEFA'] },
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(labels(put.json()), ['Football', 'UEFA']);

  const read = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/tags`, headers });
  assert.deepEqual(labels(read.json()), ['Football', 'UEFA']);

  const cloud = await app.inject({ method: 'GET', url: '/api/v1/tags', headers });
  assert.deepEqual(labels(cloud.json()), ['Football', 'UEFA']);

  // An empty body must not be read as "remove them all" — that is how a client bug silently strips
  // an asset's keywords.
  const empty = await app.inject({ method: 'PUT', url: `/api/v1/assets/${id}/tags`, headers });
  assert.equal(empty.statusCode, 422, empty.body);
  assert.deepEqual(labels(read.json()), ['Football', 'UEFA']);

  // Clearing still has to be expressible — explicitly.
  const cleared = await app.inject({
    method: 'PUT',
    url: `/api/v1/assets/${id}/tags`,
    headers,
    payload: { tags: [] },
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json(), []);
});

test('over HTTP: tags need the gateway’s identity headers like everything else', async () => {
  const app = buildMamApp({
    service: new MamService({ store: sqliteAssetStore() }),
    policyFor: () => compile({ subjectId: 'user-1', permVersion: 1, rules: EDITOR }),
  });
  for (const url of ['/api/v1/tags', '/api/v1/assets/whatever/tags']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
});

// =============================================================================
// EP-04.8 — the versioned reference snapshot
// =============================================================================

/** taxonomy:read deliberately absent — the snapshot IS the tag vocabulary. */
const NO_TAXONOMY: Rule[] = [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  { id: 'write', permissions: ['asset:write'], scope: { channelIds: [CHANNEL] } },
];

const OTHER_CHANNEL: Rule[] = [
  { id: 'read', permissions: ['asset:read', 'taxonomy:read'], scope: { channelIds: ['ch99'] } },
];

test('the reference snapshot carries the channel tag vocabulary and a version', async () => {
  const { service, caller, store } = harness();
  const who = caller();
  const asset = await service.create(who, NEW_ASSET);
  await service.setTags(who, asset.id, ['Football', 'Highlights']);

  const snapshot = await service.referenceSnapshot(who);
  assert.ok(snapshot.configVersion >= 1);
  assert.deepEqual(
    snapshot.vocabularies.tag.map((t) => t.label).sort(),
    ['Football', 'Highlights'],
    'the vocabulary IS the tag list',
  );
  // `key` is the NORMALIZED form: a snapshot validates ("is this a known tag?") as well as renders,
  // and those want different strings.
  assert.deepEqual(snapshot.vocabularies.tag.map((t) => t.key).sort(), ['football', 'highlights']);
  assert.equal(await store.configVersion(), snapshot.configVersion);
});

test('DANGER: the version moves when the vocabulary does', async () => {
  // The whole caching contract. If a tag can be minted without the version moving, every holder
  // revalidates to 304 forever and never sees the new term — and validation then rejects a tag a
  // user just created.
  const { service, caller } = harness();
  const who = caller();
  const asset = await service.create(who, NEW_ASSET);

  const before = (await service.referenceSnapshot(who)).configVersion;
  await service.setTags(who, asset.id, ['Brand New Tag']);
  const after = (await service.referenceSnapshot(who)).configVersion;

  assert.ok(after > before, `version did not move: ${before} -> ${after}`);
});

test('the version is MONOTONIC, never a content hash', async () => {
  // §5's convergence story is "holders refresh when they see a HIGHER version", so the number has
  // to carry ordering. A content hash revalidates correctly and breaks that — and reverting to an
  // earlier vocabulary would reuse an earlier value.
  const { service, caller } = harness();
  const who = caller();
  const asset = await service.create(who, NEW_ASSET);

  const versions: number[] = [];
  for (const label of ['one', 'two', 'three', 'two']) {
    await service.setTags(who, asset.id, [label]);
    versions.push((await service.referenceSnapshot(who)).configVersion);
  }

  for (let i = 1; i < versions.length; i += 1) {
    assert.ok(
      (versions[i] as number) > (versions[i - 1] as number),
      `not monotonic at ${i}: ${versions.join(', ')}`,
    );
  }
});

test('SECURITY: the snapshot needs taxonomy:read, like the tag list it contains', async () => {
  // Serving it more freely would hand out under one name exactly what is guarded under another.
  const { service, caller } = harness(NO_TAXONOMY);
  await assert.rejects(service.referenceSnapshot(caller()), /taxonomy/);
});

test('SECURITY: the snapshot is one channel, not the deployment', async () => {
  const { service, caller, store } = harness();
  const who = caller();
  const asset = await service.create(who, NEW_ASSET);
  await service.setTags(who, asset.id, ['MineOnly']);

  // A caller in a different channel, holding a grant scoped to THAT channel.
  const other = new MamService({ store });
  const snapshot = await other.referenceSnapshot({
    userId: 'user-3',
    channelId: 'ch99',
    policy: compile({ subjectId: 'user-3', permVersion: 1, rules: OTHER_CHANNEL }),
  });
  assert.deepEqual(snapshot.vocabularies.tag, [], 'another channel sees none of it');
  assert.ok(snapshot.configVersion >= 1, 'but the version is deployment-wide');
});
