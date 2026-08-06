// EP-17.2 — extensible metadata, where it meets the rest of the service.
//
// The pure rules are covered in field-schema.test.ts. What matters here is the integration: that a
// required extended field actually STOPS an asset advancing, that a patch merges rather than
// replaces, and that none of it crosses a channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '@atlas/policy';
import { MamService, sqliteAssetStore, type Caller, type FieldSchema } from '../src/index.ts';

const CHANNEL = 'ch12';

function harness(
  permissions: string[] = ['asset:read', 'asset:write', 'asset:approve', 'taxonomy:admin'],
  vocabularies?: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const store = sqliteAssetStore();
  const service = new MamService({
    store,
    ...(vocabularies ? { vocabularies: () => vocabularies } : {}),
  });

  const caller = (over: Partial<Caller> = {}): Caller => {
    const userId = over.userId ?? 'user-1';
    const channelId = over.channelId ?? CHANNEL;
    return {
      userId,
      channelId,
      policy: compile({
        subjectId: userId,
        permVersion: 1,
        rules: [{ id: 'r', permissions, scope: { channelIds: [channelId] } }],
      }),
      ...over,
    };
  };

  return { service, caller, store };
}

const NEW_ASSET = {
  title: 'Match highlights',
  mediaType: 'video',
  fileType: 'mxf',
  categoryId: '/sports/football/',
};

const schema = (over: Partial<FieldSchema> = {}): FieldSchema => ({
  id: 'video-core',
  channelId: CHANNEL,
  mediaType: 'video',
  fields: [
    { name: 'competition', label: 'Competition', type: 'string' },
    { name: 'rating', label: 'Rating', type: 'number' },
  ],
  ...over,
});

// =============================================================================
// Reading and writing the document
// =============================================================================

test('an asset with no document yet still reports its fields', async () => {
  // The form has to render before anything has been typed into it.
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);

  const result = await service.extended(caller(), asset.id);
  assert.deepEqual(result.values, {});
  assert.deepEqual(
    result.fields.map((f) => f.name),
    ['competition', 'rating'],
  );
  assert.deepEqual(result.orphaned, []);
});

test('a patch MERGES; it does not replace the document', async () => {
  // A form that submits one section must not erase the others.
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);

  await service.updateExtended(caller(), asset.id, { competition: 'Premier League' });
  const after = await service.updateExtended(caller(), asset.id, { rating: 4.5 });

  assert.deepEqual(after, { competition: 'Premier League', rating: 4.5 });
});

test('an explicit null clears a field; omitting it leaves the field alone', async () => {
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);

  await service.updateExtended(caller(), asset.id, { competition: 'FA Cup', rating: 3 });
  const cleared = await service.updateExtended(caller(), asset.id, { competition: null });

  assert.deepEqual(cleared, { rating: 3 });
});

test('the asset version moves with its document', async () => {
  // Otherwise a reader can see a version that does not match the metadata it is looking at.
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);
  assert.equal(asset.version, 1);

  await service.updateExtended(caller(), asset.id, { rating: 5 });
  assert.equal((await service.get(caller(), asset.id)).version, 2);
});

test('an invalid value is refused before anything is stored', async () => {
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);

  await assert.rejects(
    service.updateExtended(caller(), asset.id, { rating: 'five' }),
    (e: Error) => /rating/.test(e.message) && (e as { status?: number }).status === 422,
  );
  assert.deepEqual((await service.extended(caller(), asset.id)).values, {});
});

test('a field no schema defines is refused', async () => {
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);

  await assert.rejects(
    service.updateExtended(caller(), asset.id, { competetion: 'typo' }),
    /no field "competetion"/,
  );
});

// =============================================================================
// The gate — FR-MAM-2 meeting FR-MAM-5
// =============================================================================

test('EP-17.5: a REQUIRED extended field blocks markReady', async () => {
  // The whole point of letting an operator mark a field required. Without this it is a label on a
  // form, and an asset reaches air missing metadata someone declared mandatory.
  const { service, caller } = harness();
  await service.putSchema(
    caller(),
    schema({
      fields: [{ name: 'competition', label: 'Competition', type: 'string', required: true }],
    }),
  );

  const asset = await service.create(caller(), NEW_ASSET);
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');

  await assert.rejects(
    service.transition(caller(), asset.id, 'markReady'),
    (e: Error) =>
      /mandatory metadata missing: extended\.competition/.test(e.message) &&
      (e as { status?: number }).status === 409,
  );

  // Fill it in, and the same transition succeeds.
  await service.updateExtended(caller(), asset.id, { competition: 'Premier League' });
  assert.equal((await service.transition(caller(), asset.id, 'markReady')).state, 'ready');
});

test('DANGER: a core field cannot satisfy an extended requirement of the same name', async () => {
  // An operator may legitimately define an extended field called `title`. Flattened into one
  // namespace, the core title would satisfy the requirement — passing a check nobody met.
  const { service, caller } = harness();
  await service.putSchema(
    caller(),
    schema({
      fields: [{ name: 'title', label: 'On-screen title', type: 'string', required: true }],
    }),
  );

  const asset = await service.create(caller(), NEW_ASSET); // core title IS set
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');

  await assert.rejects(
    service.transition(caller(), asset.id, 'markReady'),
    /mandatory metadata missing: extended\.title/,
  );
});

test('an empty string does not satisfy a required field', async () => {
  const { service, caller } = harness();
  await service.putSchema(
    caller(),
    schema({
      fields: [{ name: 'competition', label: 'Competition', type: 'string', required: true }],
    }),
  );
  const asset = await service.create(caller(), NEW_ASSET);
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');
  await service.updateExtended(caller(), asset.id, { competition: '' });

  await assert.rejects(
    service.transition(caller(), asset.id, 'markReady'),
    /extended\.competition/,
  );
});

test('a schema scoped to another category does not gate this asset', async () => {
  const { service, caller } = harness();
  await service.putSchema(
    caller(),
    schema({
      id: 'news-only',
      categoryPath: '/news/',
      fields: [{ name: 'wire', label: 'Wire', type: 'string', required: true }],
    }),
  );

  const asset = await service.create(caller(), NEW_ASSET); // /sports/football/
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');

  assert.equal((await service.transition(caller(), asset.id, 'markReady')).state, 'ready');
});

// =============================================================================
// Vocabularies, orphans, authorization
// =============================================================================

test('DANGER: a vocabulary field is unwritable when its terms are not loaded', async () => {
  // Fails closed. Accepting a term nobody could check defeats the point of a controlled list, and
  // the value would sit in the document looking validated.
  const { service, caller } = harness();
  await service.putSchema(
    caller(),
    schema({
      fields: [{ name: 'genre', label: 'Genre', type: 'vocabulary', vocabulary: 'genres' }],
    }),
  );
  const asset = await service.create(caller(), NEW_ASSET);

  await assert.rejects(
    service.updateExtended(caller(), asset.id, { genre: 'drama' }),
    /not loaded/,
  );
});

test('a vocabulary field accepts a known term and refuses an unknown one', async () => {
  const vocabularies = new Map([['genres', new Set(['drama', 'news'])]]);
  const { service, caller } = harness(undefined, vocabularies);
  await service.putSchema(
    caller(),
    schema({
      fields: [{ name: 'genre', label: 'Genre', type: 'vocabulary', vocabulary: 'genres' }],
    }),
  );
  const asset = await service.create(caller(), NEW_ASSET);

  assert.deepEqual(await service.updateExtended(caller(), asset.id, { genre: 'drama' }), {
    genre: 'drama',
  });
  await assert.rejects(
    service.updateExtended(caller(), asset.id, { genre: 'sci-fi' }),
    /not a term/,
  );
});

test('removing a field from the schema orphans its data rather than destroying it', async () => {
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);
  await service.updateExtended(caller(), asset.id, { competition: 'FA Cup', rating: 4 });

  // The operator reorganises and drops `rating`.
  await service.putSchema(
    caller(),
    schema({ fields: [{ name: 'competition', label: 'Competition', type: 'string' }] }),
  );

  const after = await service.extended(caller(), asset.id);
  assert.deepEqual(after.orphaned, ['rating']);
  assert.equal(after.values['rating'], 4, 'the value must still be there');

  // And the asset stays editable — this is the trap that would otherwise appear later.
  assert.deepEqual(
    await service.updateExtended(caller(), asset.id, { competition: 'League Cup' }),
    {
      competition: 'League Cup',
      rating: 4,
    },
  );
});

test('SECURITY: writing a schema needs taxonomy:admin, not asset:write', async () => {
  // Editing a schema changes what every asset in its scope must carry. That is governance, not
  // editorial work, and someone who may retitle a clip is not thereby entitled to it.
  const { service, caller } = harness(['asset:read', 'asset:write']);
  await assert.rejects(service.putSchema(caller(), schema()), /no rule grants "taxonomy:admin"/);
});

test('SECURITY: a schema cannot be written into another channel', async () => {
  const { service, caller } = harness();
  await assert.rejects(
    service.putSchema(caller(), schema({ channelId: 'ch99' })),
    /cannot be written into another channel/,
  );
});

test('SECURITY: another channel’s document is NOT FOUND, not forbidden', async () => {
  const { service, caller } = harness();
  await service.putSchema(caller(), schema());
  const asset = await service.create(caller(), NEW_ASSET);

  await assert.rejects(
    service.extended(caller({ channelId: 'ch99' }), asset.id),
    (e: Error) => (e as { status?: number }).status === 404,
  );
});
