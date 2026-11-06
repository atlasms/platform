// EP-27.5 — field provenance (FR-MAM-8, mam.md §13u). The rule is pure (provenance.ts): a derived
// value is applied only where nothing ranked higher set the field, and is otherwise HELD beside
// it. Here, the rule — and what the service builds on it: a person's create and edit stamp their
// fields, ingest stamps the probe's, MTS's measured duration fills a gap or is held beside a
// person's number, and a held value is taken by a PATCH or dismissed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid, validatePayload, type Envelope } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay, type Message } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import {
  buildMamApp,
  MamService,
  sqliteAssetStore,
  type Asset,
  type Caller,
} from '../src/index.ts';
import { deriveInto, dismissDerived, userWrote } from '../src/provenance.ts';

const CHANNEL = 'ch12';
const AT = '2026-11-06T12:00:00.000Z';

const base: Asset = {
  id: ulid(),
  channelId: CHANNEL,
  title: 'Bulletin',
  mediaType: 'video',
  fileType: 'mxf',
  state: 'created',
  version: 1,
  hasRenditions: false,
  createdBy: 'user-1',
  createdAt: AT,
  updatedAt: AT,
};
const MEASURE = { source: 'technical', by: 'mts', at: AT } as const;
const AI = { source: 'ai', by: 'ai', at: AT, confidence: 0.82 } as const;

test('the rule: a derived value fills an empty field, and is held beside one a person set', () => {
  const filled = deriveInto(base, { durationSec: 92.04 }, MEASURE);
  assert.deepEqual([filled.applied, filled.held], [['durationSec'], []]);
  assert.equal(filled.asset.durationSec, 92.04);
  assert.deepEqual(filled.asset.provenance?.['durationSec'], MEASURE);

  const typed = userWrote({ ...base, durationSec: 90 }, ['durationSec'], 'user-1', AT);
  const held = deriveInto(typed, { durationSec: 92.04 }, MEASURE);
  assert.deepEqual([held.applied, held.held], [[], ['durationSec']]);
  assert.equal(held.asset.durationSec, 90, 'never written over what a person entered');
  assert.deepEqual(held.asset.derived?.['durationSec'], { value: 92.04, ...MEASURE });
  assert.equal(held.asset.provenance?.['durationSec']?.source, 'user');

  // The same value again holds nothing new; a person's own number proposed back holds nothing.
  assert.deepEqual(deriveInto(held.asset, { durationSec: 92.04 }, MEASURE).held, []);
  assert.deepEqual(deriveInto(typed, { durationSec: 90 }, MEASURE).held, []);
});

test('the rule: technical outranks AI, a field set before EP-27.5 ranks as a person’s, and AI never writes a mandatory field', () => {
  const guessed = deriveInto(base, { description: 'A guess' }, AI).asset;
  const measured = deriveInto(guessed, { description: 'Measured' }, MEASURE);
  assert.deepEqual(measured.applied, ['description'], 'a measurement replaces an AI guess');
  assert.deepEqual(
    deriveInto(measured.asset, { description: 'Another guess' }, AI).held,
    ['description'],
    'an AI guess does not replace a measurement',
  );

  const legacy = { ...base, description: 'Written before provenance existed' };
  assert.deepEqual(deriveInto(legacy, { description: 'x' }, MEASURE).held, ['description']);

  const untitled = base; // no category: the field is empty
  const ai = deriveInto(untitled, { categoryId: 'cat-1', episodeNo: 3 }, AI, [
    'title',
    'mediaType',
    'categoryId',
  ]);
  assert.deepEqual([ai.applied, ai.held], [['episodeNo'], ['categoryId']]);
  assert.equal(ai.asset.categoryId, undefined, 'FR-AI-3: a suggestion, even for an empty field');
});

test('the rule: a person’s write settles what was held; dismissing drops it; empty maps leave the record', () => {
  const typed = userWrote({ ...base, durationSec: 90 }, ['durationSec'], 'user-1', AT);
  const held = deriveInto(typed, { durationSec: 92.04 }, MEASURE).asset;
  const taken = userWrote({ ...held, durationSec: 92.04 }, ['durationSec'], 'user-2', AT);
  assert.equal(taken.derived, undefined);
  assert.deepEqual(taken.provenance?.['durationSec'], { source: 'user', by: 'user-2', at: AT });

  assert.equal(dismissDerived(typed, 'durationSec'), undefined, 'nothing held, nothing to drop');
  assert.equal(dismissDerived(held, 'durationSec')?.derived, undefined);

  const inherited = userWrote(taken, [], 'user-2', AT, ['durationSec']);
  assert.equal(inherited.provenance, undefined, 'a field the asset stops setting is nobody’s');
});

// --- the service ------------------------------------------------------------------------------

const EDITOR: Rule[] = [
  { id: 'r', permissions: ['asset:read', 'asset:write'], scope: { channelIds: [CHANNEL] } },
];
const READER: Rule[] = [{ id: 'r', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } }];

function harness() {
  const store = sqliteAssetStore();
  const bus = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), bus);
  const service = new MamService({ store, now: () => new Date(AT) });
  const caller = (rules: Rule[] = EDITOR, userId = 'user-1'): Caller => ({
    userId,
    channelId: CHANNEL,
    policy: compile({ subjectId: userId, permVersion: 1, rules }),
  });
  let seen = 0;
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    const fresh = bus.published.slice(seen).map((m) => m.body as Envelope);
    seen = bus.published.length;
    return fresh;
  };
  return { store, service, caller, drain };
}

function transcoded(assetId: string, durationSec: number, jobId = ulid()): Message {
  const envelope = buildEnvelope({
    type: 'transcode.completed',
    channelId: CHANNEL,
    payload: {
      assetId,
      jobId,
      renditions: [
        { kind: 'thumbnail', path: '/t.jpg', checksum: { algorithm: 'sha256', value: 't' } },
        {
          kind: 'proxy',
          path: '/p.mp4',
          checksum: { algorithm: 'sha256', value: 'p' },
          durationSec,
        },
      ],
    },
    actor: { kind: 'service', id: 'mts' },
  });
  return {
    id: envelope.messageId,
    subject: `atlas.${CHANNEL}.transcode.completed`,
    body: envelope,
  };
}

test('a person’s create stamps their fields; ingest stamps the file’s and the probe’s', async () => {
  const { service, caller } = harness();
  const made = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    episodeNo: 4,
  });
  assert.deepEqual(Object.keys(made.provenance ?? {}).sort(), [
    'episodeNo',
    'fileType',
    'mediaType',
    'title',
  ]);
  assert.deepEqual(made.provenance?.['title'], { source: 'user', by: 'user-1', at: AT });

  const assetId = ulid();
  const jobId = assetId;
  const envelope = buildEnvelope({
    type: 'ingest.accepted',
    channelId: CHANNEL,
    payload: {
      assetId,
      ingestJobId: jobId,
      source: 'upload',
      path: `${CHANNEL}/${assetId}/original/b1`,
      checksum: { algorithm: 'sha256', value: 'abc' },
      filename: 'Evening News.mov',
      title: 'Evening News',
      mediaType: 'video',
      fileType: 'mov',
      createdBy: 'user-7',
      technicalMetadata: { durationSec: 42 },
    },
    actor: { kind: 'service', id: 'rim' },
  });
  await service.createFromIngest({
    id: envelope.messageId,
    subject: `atlas.${CHANNEL}.ingest.accepted`,
    body: envelope,
  });
  const ingested = await service.get(caller(), assetId);
  const stamp = { source: 'technical', by: 'rim', at: AT, jobId };
  assert.deepEqual(ingested.provenance, {
    title: stamp,
    mediaType: stamp,
    fileType: stamp,
    durationSec: stamp,
  });

  // An editor's retitle makes the title theirs; the probe still owns the rest.
  const retitled = await service.update(caller(), assetId, { title: 'Evening News, 6 pm' });
  assert.equal(retitled.provenance?.['title']?.source, 'user');
  assert.equal(retitled.provenance?.['durationSec']?.source, 'technical');
});

test('MTS’s measured duration fills an asset that has none — announced as a technical change', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await drain();

  const jobId = ulid();
  assert.equal(await service.mirrorTranscode(transcoded(asset.id, 92.04, jobId)), 'applied');
  const after = await service.get(caller(), asset.id);
  assert.equal(after.durationSec, 92.04);
  assert.deepEqual(after.provenance?.['durationSec'], {
    source: 'technical',
    by: 'mts',
    at: AT,
    jobId,
  });
  assert.equal(
    after.version,
    asset.version + 1,
    'one revision for the renditions and the duration',
  );
  const sent = await drain();
  const updated = sent.find((e) => e.type === 'asset.updated');
  assert.deepEqual(updated?.payload, {
    assetId: asset.id,
    changedFields: ['durationSec'],
    source: 'technical',
  });
  const audit = sent.find(
    (e) => e.type === 'audit.recorded' && e.payload['entityType'] === 'asset',
  );
  assert.ok(validatePayload('audit.recorded', audit?.payload).valid);
  assert.deepEqual((audit?.payload['delta'] as Record<string, unknown>)['durationSec'], {
    after: 92.04,
  });

  // A second transcode does not second-guess the measurement it made: no revision.
  await service.mirrorTranscode(transcoded(asset.id, 92.08));
  assert.equal((await service.get(caller(), asset.id)).version, after.version);
});

test('a duration a person typed is never overwritten: the measure is held, then taken by a PATCH — or dismissed', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    durationSec: 90,
  });
  await drain();

  await service.mirrorTranscode(transcoded(asset.id, 92.04));
  const held = await service.get(caller(), asset.id);
  assert.equal(held.durationSec, 90);
  assert.equal(held.derived?.['durationSec']?.value, 92.04);
  const sent = await drain();
  assert.deepEqual(sent.find((e) => e.type === 'asset.updated')?.payload['changedFields'], [
    'derived.durationSec',
  ]);

  // Taking it is an ordinary edit, which settles it.
  const taken = await service.update(caller(), asset.id, { durationSec: 92.04 });
  assert.equal(taken.derived, undefined);
  assert.equal(taken.provenance?.['durationSec']?.source, 'user');

  // Measured again differently: held again; dismissing drops it, and a reader may not.
  await service.mirrorTranscode(transcoded(asset.id, 95));
  await assert.rejects(
    service.dismissDerived(caller(READER, 'user-9'), asset.id, 'durationSec'),
    (err: Error & { status?: number }) => err.status === 403,
  );
  const dismissed = await service.dismissDerived(caller(), asset.id, 'durationSec');
  assert.equal(dismissed.derived, undefined);
  assert.equal(dismissed.durationSec, 92.04);
  await assert.rejects(
    service.dismissDerived(caller(), asset.id, 'durationSec'),
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test('a duration set before EP-27.5 (no provenance) is not prompted against', async () => {
  const { service, caller, store } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    durationSec: 90,
  });
  const legacy = { ...(await store.get(asset.id))! };
  delete legacy.provenance;
  await store.transaction((tx) => tx.put({ ...legacy, version: 2 }, 1));

  await service.mirrorTranscode(transcoded(asset.id, 92.04));
  const after = await service.get(caller(), asset.id);
  assert.deepEqual([after.durationSec, after.derived], [90, undefined]);
});

test('over HTTP: DELETE /assets/{id}/derived/{field} drops the held value; an unknown field is a 404', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    durationSec: 90,
  });
  await service.mirrorTranscode(transcoded(asset.id, 92.04));
  const app = await buildMamApp({ service, policyFor: () => caller().policy });
  const headers = { 'x-atlas-user': 'user-1', 'x-atlas-channel': CHANNEL };
  const url = (field: string) => `/api/v1/assets/${asset.id}/derived/${field}`;

  assert.equal(
    (await app.inject({ method: 'DELETE', url: url('state'), headers })).statusCode,
    404,
  );
  const res = await app.inject({ method: 'DELETE', url: url('durationSec'), headers });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<Asset>().derived, undefined);
  await app.close();
});
