import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker, type Message } from '../../messaging/src/index.ts';
import { buildEnvelope, ulid, subjectFor, validateMessage, type Envelope } from '../../contracts/src/index.ts';
import { MamService, AssetStore } from '../src/index.ts';

function setup() {
  const broker = new InMemoryBroker();
  const store = new AssetStore();
  const svc = new MamService(broker, store);
  svc.start();
  const emitted: Envelope[] = [];
  broker.subscribe('atlas.*.asset.>', (m: Message) => { emitted.push(m.body as Envelope); }); // downstream spy (Scheduling/Notifications)

  const publish = (env: Envelope) => broker.publish({ id: env.messageId, subject: subjectFor(env.channelId, env.type), body: env });

  const ingest = (assetId: string, correlationId?: string) => {
    const env = buildEnvelope({
      type: 'ingest.accepted', channelId: 'ch12', correlationId,
      payload: { assetId, checksum: { algorithm: 'sha256', value: 'abc' }, source: 'watcher', path: '/in/clip.mxf',
        technicalMetadata: { container: 'mxf', durationSec: 12, width: 1920, height: 1080, aspectRatio: '16:9', audioChannels: 2 } },
    });
    return { env, done: publish(env) };
  };
  const transcode = (assetId: string, correlationId?: string) => {
    const env = buildEnvelope({
      type: 'transcode.completed', channelId: 'ch12', correlationId,
      payload: { assetId, jobId: ulid(), renditions: [{ kind: 'broadcast', path: '/r/bc.mp4', checksum: { algorithm: 'sha256', value: 'd' } }] },
    });
    return { env, done: publish(env) };
  };
  return { broker, store, svc, emitted, ingest, transcode };
}

const typesOf = (es: Envelope[]) => es.map((e) => e.type);

test('ingest.accepted -> asset created (processing) and asset.created emitted', async () => {
  const s = setup();
  const A = ulid();
  await s.ingest(A).done;
  await s.svc.drain();
  const asset = s.store.get(A)!;
  assert.equal(asset.state, 'processing');
  assert.equal(asset.core.title, 'clip.mxf');       // derived from ingest path
  assert.equal(asset.core.resolution, '1920x1080'); // derived from technicalMetadata
  const created = s.emitted.find((e) => e.type === 'asset.created')!;
  assert.ok(created);
  assert.equal(validateMessage(created).valid, true);
});

test('transcode.completed -> Ready and asset.ready emitted', async () => {
  const s = setup();
  const A = ulid();
  await s.ingest(A).done; await s.svc.drain();
  await s.transcode(A).done; await s.svc.drain();
  assert.equal(s.store.get(A)!.state, 'ready');
  assert.deepEqual(s.store.get(A)!.renditions[0].kind, 'broadcast');
  assert.ok(s.emitted.some((e) => e.type === 'asset.ready'));
});

test('approve -> Approved and a valid asset.approved with expiry', async () => {
  const s = setup();
  const A = ulid();
  await s.ingest(A).done; await s.svc.drain();
  await s.transcode(A).done; await s.svc.drain();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  await s.svc.approve(A, 'user-1', { expiresAt });
  await s.svc.drain();
  assert.equal(s.store.get(A)!.state, 'approved');
  const approved = s.emitted.find((e) => e.type === 'asset.approved')!;
  assert.equal(approved.payload.approver, 'user-1');
  assert.equal(approved.payload.expiresAt, expiresAt);
  assert.deepEqual(approved.actor, { kind: 'user', id: 'user-1' });
  assert.equal(validateMessage(approved).valid, true);
});

test('reject -> Rejected and a valid asset.rejected with retention', async () => {
  const s = setup();
  const A = ulid();
  await s.ingest(A).done; await s.svc.drain();
  await s.transcode(A).done; await s.svc.drain();
  const retainUntil = new Date(Date.now() + 2592000000).toISOString();
  await s.svc.reject(A, 'blurry', { rejectedBy: 'user-2', retainUntil });
  await s.svc.drain();
  assert.equal(s.store.get(A)!.state, 'rejected');
  const rejected = s.emitted.find((e) => e.type === 'asset.rejected')!;
  assert.equal(rejected.payload.reason, 'blurry');
  assert.equal(validateMessage(rejected).valid, true);
});

test('redelivered ingest is handled once (idempotent consumer)', async () => {
  const s = setup();
  const A = ulid();
  const first = s.ingest(A);
  await first.done; // first delivery settles before redelivery (real at-least-once is sequential per consumer)
  await s.broker.publish({ id: first.env.messageId, subject: subjectFor('ch12', first.env.type), body: first.env });
  await s.svc.drain();
  assert.equal(s.emitted.filter((e) => e.type === 'asset.created').length, 1);
  assert.equal(s.store.all().length, 1);
});

test('correlation threads through the flow (ingest -> created, transcode -> ready)', async () => {
  const s = setup();
  const A = ulid();
  const ing = s.ingest(A); await ing.done; await s.svc.drain();
  const tc = s.transcode(A, ing.env.messageId); await tc.done; await s.svc.drain(); // flow carries the correlation
  const created = s.emitted.find((e) => e.type === 'asset.created')!;
  const ready = s.emitted.find((e) => e.type === 'asset.ready')!;
  assert.equal(created.correlationId, ing.env.messageId); // opened from the ingest message
  assert.equal(created.causationId, ing.env.messageId);
  assert.equal(ready.correlationId, ing.env.messageId);   // threaded end to end
});

test('every emitted event validates against its contract', async () => {
  const s = setup();
  const A = ulid();
  await s.ingest(A).done; await s.svc.drain();
  await s.transcode(A).done; await s.svc.drain();
  await s.svc.approve(A, 'user-1'); await s.svc.drain();
  assert.ok(s.emitted.length >= 3);
  for (const e of s.emitted) assert.equal(validateMessage(e).valid, true, `${e.type} should be valid`);
  assert.deepEqual(new Set(typesOf(s.emitted)), new Set(['asset.created', 'asset.ready', 'asset.approved']));
});
