// The FileRef mirror (EP-17.8): MAM's first broker consumer. What MTS and HSM announce becomes
// the asset's files — once per message, replaced per (kind, variant), audited per row, in one
// transaction with the seen-mark — and what cannot be applied is refused, not skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay, type Message } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import {
  buildMamApp,
  MamService,
  sqliteAssetStore,
  startFileMirror,
  type Caller,
  type FileRef,
} from '../src/index.ts';

const CHANNEL = 'ch12';
const CORRELATION = ulid();
/** A well-formed id no asset has. */
const UNKNOWN = ulid();

function harness() {
  const store = sqliteAssetStore();
  const outbox = new SqliteOutboxStore(store.db);
  const bus = new InMemoryBroker();
  const relay = new OutboxRelay(outbox, bus);
  const service = new MamService({ store, now: () => new Date('2026-09-21T12:00:00.000Z') });
  const caller = (over: Partial<Caller> = {}): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({
      subjectId: 'user-1',
      permVersion: 1,
      rules: [
        {
          id: 'r',
          permissions: ['asset:read', 'asset:write'],
          scope: { channelIds: [over.channelId ?? CHANNEL] },
        },
      ],
    }),
    ...over,
  });
  // Only what THIS drain published: the bus keeps everything, the assertions want the delta.
  let seen = 0;
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    const fresh = bus.published.slice(seen).map((m) => m.body as Envelope);
    seen = bus.published.length;
    return fresh;
  };
  return { store, service, caller, drain, bus };
}

const rendition = (kind: 'proxy' | 'thumbnail' | 'original', path = `/online/${kind}.bin`) => ({
  kind,
  path,
  checksum: { algorithm: 'sha256', value: `${kind}-hash` },
  sizeBytes: 1024,
});

/** An MTS message, the way the broker would hand it over. */
function transcodeMessage(
  assetId: string,
  renditions = [rendition('proxy'), rendition('thumbnail')],
): Message {
  const envelope = buildEnvelope({
    type: 'transcode.completed',
    channelId: CHANNEL,
    payload: { assetId, renditions },
    actor: { kind: 'service', id: 'mts' },
    correlationId: CORRELATION,
  });
  return {
    id: envelope.messageId,
    subject: `atlas.${CHANNEL}.transcode.completed`,
    body: envelope,
  };
}

function placedMessage(payload: EventPayloads['file.placed'], channelId = CHANNEL): Message {
  const envelope = buildEnvelope({
    type: 'file.placed',
    channelId,
    payload,
    actor: { kind: 'service', id: 'hsm' },
  });
  return { id: envelope.messageId, subject: `atlas.${channelId}.file.placed`, body: envelope };
}

test('transcode.completed: every rendition becomes a FileRef, the asset has renditions, and the seen-mark makes a redelivery a duplicate', async () => {
  const { service, caller, drain, store } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await drain();
  const msg = transcodeMessage(asset.id);

  assert.equal(await service.mirrorTranscode(msg), 'applied');
  const files = await service.files(caller(), asset.id);
  assert.deepEqual(
    files.map((f) => [f.kind, f.storage.tier, f.storage.status, f.checksum.value, f.version]),
    [
      ['proxy', 'online', 'available', 'proxy-hash', 1],
      ['thumbnail', 'online', 'available', 'thumbnail-hash', 1],
    ],
  );
  assert.ok(files.every((f) => f.sourceMessageId === msg.id && f.channelId === CHANNEL));
  const after = await store.get(asset.id);
  assert.equal(after?.hasRenditions, true);
  assert.equal(after?.version, 2);

  // One record per mutation (EP-19.2): the asset's, and one per file, all by the service.
  const events = await drain();
  const audits = events
    .filter((e) => e.type === 'audit.recorded')
    .map((e) => e.payload as unknown as EventPayloads['audit.recorded']);
  assert.deepEqual(
    audits.map((a) => [a.entityType, a.revision, a.action]),
    [
      ['asset', 2, 'asset.attachRenditions'],
      ['file', 1, 'transcode.completed'],
      ['file', 1, 'transcode.completed'],
    ],
  );
  for (const e of events) {
    assert.ok(validatePayload(e.type, e.payload).valid, e.type);
    assert.deepEqual(e.actor, { kind: 'service', id: 'mam' });
    assert.equal(e.correlationId, CORRELATION, 'the cause is carried');
  }

  // Redelivered — JetStream does that — and nothing happens twice.
  assert.equal(await service.mirrorTranscode(msg), 'duplicate');
  assert.equal((await store.get(asset.id))?.version, 2);
  assert.equal((await drain()).length, 0);
});

test('a second transcode.completed REPLACES a kind (MTS re-ran) — same id, next version, the delta says what moved', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await service.mirrorTranscode(transcodeMessage(asset.id));
  const [first] = await service.files(caller(), asset.id);
  await drain();

  await service.mirrorTranscode(
    transcodeMessage(asset.id, [rendition('proxy', '/online/proxy-v2.bin')]),
  );
  const files = await service.files(caller(), asset.id);
  assert.equal(files.length, 2, 'the thumbnail stays');
  const proxy = files.find((f) => f.kind === 'proxy')!;
  assert.equal(proxy.id, first!.id, 'the row keeps its identity');
  assert.equal(proxy.version, 2);
  assert.equal(proxy.storage.path, '/online/proxy-v2.bin');
  const audit = (await drain())
    .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
    .find((a) => a.entityType === 'file');
  assert.deepEqual((audit!.delta as Record<string, unknown>)['storage'], {
    before: { path: '/online/proxy.bin', tier: 'online', status: 'available' },
    after: { path: '/online/proxy-v2.bin', tier: 'online', status: 'available' },
  });
});

test('file.placed: a new row for a file nothing announced (the original), then the ledger moving it to another tier', async () => {
  const { service, caller, drain, store } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await drain();

  const placed = await service.mirrorPlacement(
    placedMessage({
      assetId: asset.id,
      renditionKind: 'original',
      tier: 'online',
      path: '/online/bulletin.mxf',
      checksum: { algorithm: 'sha256', value: 'orig' },
    }),
  );
  assert.equal(placed, 'applied');
  let [original] = await service.files(caller(), asset.id);
  assert.equal(original?.kind, 'original');
  assert.equal(original?.storage.tier, 'online');
  assert.equal(original?.checksum.value, 'orig');
  assert.equal(
    (await store.get(asset.id))?.version,
    1,
    'the asset row is not a placement’s business',
  );

  await service.mirrorPlacement(
    placedMessage({
      assetId: asset.id,
      renditionKind: 'original',
      tier: 'near-line',
      path: '/nearline/bulletin.mxf',
    }),
  );
  [original] = await service.files(caller(), asset.id);
  assert.equal(original?.storage.tier, 'near-line');
  assert.equal(original?.storage.path, '/nearline/bulletin.mxf');
  assert.equal(original?.checksum.value, 'orig', 'no checksum sent: the row keeps what it had');
  assert.equal(original?.version, 2);
  const audits = (await drain()).map(
    (e) => e.payload as unknown as EventPayloads['audit.recorded'],
  );
  assert.deepEqual(
    audits.map((a) => [a.entityType, a.revision, a.action]),
    [
      ['file', 1, 'file.placed'],
      ['file', 2, 'file.placed'],
    ],
  );
});

test('refused, not skipped: an unknown asset, another channel’s asset, the wrong event type, a payload off its schema', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await drain();

  await assert.rejects(service.mirrorTranscode(transcodeMessage(UNKNOWN)), /no asset/);
  await assert.rejects(
    service.mirrorPlacement(
      placedMessage({ assetId: asset.id, tier: 'online', path: '/x' }, 'ch99'),
    ),
    /no asset .* in channel ch99/,
  );
  await assert.rejects(
    service.mirrorPlacement(transcodeMessage(asset.id)),
    /is a transcode.completed, not a file.placed/,
  );
  const bad = transcodeMessage(asset.id);
  (bad.body as { payload: Record<string, unknown> }).payload = {
    assetId: asset.id,
    renditions: [],
  };
  await assert.rejects(service.mirrorTranscode(bad), /does not match its schema/);
  await assert.rejects(
    service.mirrorTranscode({ id: 'x', subject: 's', body: { not: 'an envelope' } }),
    /not an envelope/,
  );
  assert.deepEqual(await service.files(caller(), asset.id), [], 'nothing was applied');
});

test('the subscription: both subjects are consumed off the broker, duplicates reported, refusals thrown to the broker', async () => {
  const { service, caller, drain, bus } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await drain();
  const applied: string[] = [];
  const duplicates: string[] = [];
  const errors: string[] = [];
  const subs = startFileMirror({
    broker: bus,
    service,
    onApplied: (s) => applied.push(s),
    onDuplicate: (s) => duplicates.push(s),
    onError: (err) => errors.push((err as Error).message),
    // One attempt, so a refusal is one error here; the real broker retries, then dead-letters.
    maxAttempts: 1,
  });

  const t = transcodeMessage(asset.id);
  await bus.publish(t);
  await bus.publish(t);
  await bus.publish(
    placedMessage({ assetId: asset.id, renditionKind: 'original', tier: 'online', path: '/o' }),
  );
  await bus.publish(transcodeMessage(UNKNOWN)).catch(() => undefined);

  assert.deepEqual(applied, [
    `atlas.${CHANNEL}.transcode.completed`,
    `atlas.${CHANNEL}.file.placed`,
  ]);
  assert.deepEqual(duplicates, [`atlas.${CHANNEL}.transcode.completed`]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /no asset/);
  assert.equal((await service.files(caller(), asset.id)).length, 3);
  for (const s of subs) s.unsubscribe();
});

test('GET /assets/{id}/files: asset:read on the files group; another channel’s asset is 404', async () => {
  const { service, caller, store } = harness();
  const asset = await service.create(caller(), {
    title: 'Bulletin',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await service.mirrorTranscode(transcodeMessage(asset.id));

  const policies = new Map([
    [
      'reader',
      compile({
        subjectId: 'reader',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['asset:read'] }],
      }),
    ],
    [
      'narrow',
      compile({
        subjectId: 'narrow',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['asset:read'], fieldGroups: ['core'] }],
      }),
    ],
  ]);
  const app = buildMamApp({ service, policyFor: (id) => policies.get(id) });
  const headers = (user: string, channel = CHANNEL) => ({
    'x-atlas-user': user,
    'x-atlas-channel': channel,
  });

  const ok = await app.inject({
    method: 'GET',
    url: `/api/v1/assets/${asset.id}/files`,
    headers: headers('reader'),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const files = ok.json<FileRef[]>();
  assert.deepEqual(
    files.map((f) => f.kind),
    ['proxy', 'thumbnail'],
  );

  const narrow = await app.inject({
    method: 'GET',
    url: `/api/v1/assets/${asset.id}/files`,
    headers: headers('narrow'),
  });
  assert.equal(narrow.statusCode, 403, 'the files group is not the core group');

  const elsewhere = await app.inject({
    method: 'GET',
    url: `/api/v1/assets/${asset.id}/files`,
    headers: headers('reader', 'ch99'),
  });
  assert.equal(elsewhere.statusCode, 404);
  await app.close();
  await store.close();
});
