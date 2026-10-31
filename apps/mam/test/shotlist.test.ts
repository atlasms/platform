// EP-27.3 — the shot list: time-coded segments on an asset, audited. The store's ordering and
// replacement are the conformance suite's; here, what the service promises around them — the
// `shotlist` field group, validation by path, a change being an asset revision with its delta, a
// re-sent list changing nothing, and the route refusing an absent list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { buildMamApp, MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CHANNEL = 'ch12';

const grant = (writeGroups: string[]): Rule[] => [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: writeGroups,
  },
];
/** The Editor writes `core`, `taxonomy`, `cast` and `shotlist` (authorization-model §9). */
const EDITOR = grant(['core', 'taxonomy', 'cast', 'shotlist']);
/** The Librarian writes `files` and `rights` — not the shot list. */
const LIBRARIAN = grant(['files', 'rights']);

function harness() {
  const store = sqliteAssetStore();
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const service = new MamService({ store });
  const caller = (rules: Rule[] = EDITOR): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({ subjectId: 'user-1', permVersion: 1, rules }),
  });
  let seen = 0;
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    const fresh = broker.published.slice(seen).map((m) => m.body as Envelope);
    seen = broker.published.length;
    return fresh;
  };
  return { service, caller, drain };
}

const NEW_ASSET = {
  title: 'Match highlights',
  mediaType: 'video',
  fileType: 'mxf',
  durationSec: 90,
};

test('a shot list is set in timeline order, kept by id, and every change is an audited asset revision', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await drain();

  const first = await service.setShotlist(caller(), asset.id, [
    { startMs: 60_000, endMs: 75_000, description: 'The winning goal' },
    { startMs: 2_000, endMs: 9_500, description: '  Kick-off  ' },
  ]);
  assert.deepEqual(
    first.items.map((i) => [i.startMs, i.description]),
    [
      [2_000, 'Kick-off'],
      [60_000, 'The winning goal'],
    ],
  );
  const sent = await drain();
  const updated = sent.find((e) => e.type === 'asset.updated');
  assert.deepEqual((updated?.payload as unknown as EventPayloads['asset.updated']).changedFields, [
    'shotlist',
  ]);
  const audit = sent.find((e) => e.type === 'audit.recorded');
  assert.ok(validatePayload('audit.recorded', audit?.payload).valid);
  const delta = (audit?.payload as unknown as EventPayloads['audit.recorded']).delta;
  assert.deepEqual(delta['shotlist']?.before, []);
  assert.equal((delta['shotlist']?.after as unknown[]).length, 2);
  assert.equal((await service.get(caller(), asset.id)).version, asset.version + 1);

  // An edit keeps a shot's id; the same list again is nothing — no revision, no event.
  const [kickoff, goal] = first.items;
  const edited = await service.setShotlist(caller(), asset.id, [
    { ...kickoff!, description: 'Kick-off, home side' },
    goal!,
  ]);
  assert.equal(edited.items[0]?.id, kickoff!.id);
  await drain();
  const again = await service.setShotlist(caller(), asset.id, edited.items);
  assert.deepEqual(again.items, edited.items);
  assert.deepEqual(await drain(), [], 'a re-sent list emits nothing');
  assert.deepEqual((await service.shotlist(caller(), asset.id)).items, edited.items);
});

test('validated whole: every problem at its path — and nothing past the end of the media', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await assert.rejects(
    service.setShotlist(caller(), asset.id, [
      { startMs: 5_000, endMs: 4_000, description: 'backwards' },
      { startMs: 0, endMs: 95_000, description: 'too long' },
      { startMs: 1.5, endMs: 2_000, description: '' },
      { id: 'not-a-ulid', startMs: 0, endMs: 1, description: 'x', colour: 'red' },
    ]),
    (err: Error & { details?: { problems?: { path: string }[] } }) => {
      assert.deepEqual(
        err.details?.problems?.map((p) => p.path),
        [
          'items/0/endMs',
          'items/1/endMs',
          'items/2/startMs',
          'items/2/description',
          'items/3/colour',
          'items/3/id',
        ],
      );
      return true;
    },
  );
  assert.deepEqual((await service.shotlist(caller(), asset.id)).items, [], 'nothing was written');
});

test('the shot list is the `shotlist` field group: a Librarian reads it but may not write it', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  await assert.rejects(
    service.setShotlist(caller(LIBRARIAN), asset.id, [{ startMs: 0, endMs: 1, description: 'x' }]),
    (err: Error & { status?: number }) => err.status === 403,
  );
  assert.deepEqual((await service.shotlist(caller(LIBRARIAN), asset.id)).items, []);
});

test('over HTTP: PUT replaces, GET reads, and an absent list is refused rather than read as "clear"', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  const app = await buildMamApp({ service, policyFor: () => caller().policy });
  const headers = { 'x-atlas-user': 'user-1', 'x-atlas-channel': CHANNEL };
  const url = `/api/v1/assets/${asset.id}/shotlist`;

  assert.equal((await app.inject({ method: 'PUT', url, headers, payload: {} })).statusCode, 422);
  const put = await app.inject({
    method: 'PUT',
    url,
    headers,
    payload: { items: [{ startMs: 0, endMs: 3_000, description: 'Opening titles' }] },
  });
  assert.equal(put.statusCode, 200, put.body);
  const got = await app.inject({ method: 'GET', url, headers });
  assert.equal(got.statusCode, 200);
  const body = got.json<{ assetId: string; items: { description: string }[] }>();
  assert.deepEqual(
    [body.assetId, body.items.map((i) => i.description)],
    [asset.id, ['Opening titles']],
  );
  await app.close();
});
