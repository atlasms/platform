import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../messaging/src/index.ts';
import { buildEnvelope, ulid, subjectFor, type Envelope } from '../../contracts/src/index.ts';
import { MamService, AssetStore } from '../../mam-service/src/index.ts';
import { SchedulingService, SchedulingStore } from '../src/index.ts';

// Two real services on one broker: MAM (system of record) and Scheduling (playout gate). This proves
// the event backbone works across services and that the review lifecycle actually gates air.
function world() {
  const broker = new InMemoryBroker();
  const mam = new MamService(broker, new AssetStore());
  const sched = new SchedulingService(broker, new SchedulingStore());
  mam.start(); sched.start();

  const pubToMam = (type: string, payload: any, correlationId?: string) => {
    const env = buildEnvelope({ type, channelId: 'ch12', correlationId, payload });
    return { env, done: broker.publish({ id: env.messageId, subject: subjectFor('ch12', type), body: env }) };
  };
  const ingest = (assetId: string) => pubToMam('ingest.accepted', { assetId, checksum: { algorithm: 'sha256', value: 'a' }, source: 's', path: '/in/x.mxf', technicalMetadata: { container: 'mxf' } });
  const transcode = (assetId: string) => pubToMam('transcode.completed', { assetId, renditions: [{ kind: 'broadcast', path: '/r/x.mp4', checksum: { algorithm: 'sha256', value: 'b' } }] });
  return { broker, mam, sched, ingest, transcode };
}

test('MAM -> Scheduling: approve makes an asset air-able; expire pulls it (end to end)', async () => {
  const w = world();
  const A = ulid();

  // ingest -> create -> transcode -> ready (MAM), events flow over the broker
  await w.ingest(A).done; await w.mam.drain();
  await w.transcode(A).done; await w.mam.drain();
  assert.equal(w.mam.getAsset(A)!.state, 'ready');

  // approve in MAM -> asset.approved -> Scheduling registers it as schedulable
  await w.mam.approve(A, 'user-1', { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await w.mam.drain();

  const sched = await w.sched.createSchedule('ch12');
  await w.sched.addItem(sched.id, A, new Date().toISOString(), 30); // allowed only because MAM approved it
  let res = await w.sched.sendToAir(sched.id);
  assert.equal(res.exported.length, 1);          // on air
  assert.equal(res.blocked.length, 0);

  // MAM's scheduler expires it -> asset.expired -> Scheduling drops it from the air path
  await w.mam.expire(A, { priorApprover: 'user-1' });
  await w.mam.drain();
  assert.equal(w.mam.getAsset(A)!.state, 'expired');
  assert.equal(w.sched.getSchedule(sched.id)!.items[0].flagged, 'asset-expired');

  res = await w.sched.sendToAir(sched.id);
  assert.equal(res.exported.length, 0);          // the review lifecycle gated air, across two services
  assert.equal(res.blocked[0].reason, 'not-approved');
});
