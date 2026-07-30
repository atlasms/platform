import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../messaging/src/index.ts';
import { buildEnvelope, ulid, subjectFor, type Envelope } from '../../contracts/src/index.ts';
import { Conflict } from '../../service-kit/src/index.ts';
import { SchedulingService, SchedulingStore } from '../src/index.ts';

function setup() {
  const broker = new InMemoryBroker();
  const store = new SchedulingStore();
  const svc = new SchedulingService(broker, store);
  svc.start();
  const pub = (type: string, payload: any) => {
    const env = buildEnvelope({ type, channelId: 'ch12', payload });
    return broker.publish({ id: env.messageId, subject: subjectFor('ch12', type), body: env });
  };
  return {
    svc, store,
    approve: (assetId: string, expiresAt?: string) => pub('asset.approved', { assetId, approver: 'u', approvedAt: new Date().toISOString(), ...(expiresAt ? { expiresAt } : {}) }),
    expire: (assetId: string) => pub('asset.expired', { assetId, expiredAt: new Date().toISOString() }),
    del: (assetId: string) => pub('asset.deleted', { assetId, reason: 'manual' }),
    replace: (oldId: string, newId: string) => pub('asset.replaced', { oldId, newId }),
  };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

test('approved asset becomes schedulable and exports at send-to-air', async () => {
  const s = setup();
  const A = ulid();
  await s.approve(A, future());
  const sched = await s.svc.createSchedule('ch12');
  await s.svc.addItem(sched.id, A, new Date().toISOString(), 30);
  const res = await s.svc.sendToAir(sched.id, { destination: '\\\\mcr\\in' });
  assert.equal(res.exported.length, 1);
  assert.equal(res.blocked.length, 0);
  assert.match(res.playlist, new RegExp(A));
  assert.equal(s.svc.getSchedule(sched.id)!.state, 'sent');
});

test('cannot schedule an asset that is not approved', async () => {
  const s = setup();
  const sched = await s.svc.createSchedule('ch12');
  await assert.rejects(s.svc.addItem(sched.id, ulid(), new Date().toISOString(), 30), Conflict);
});

test('asset.expired flags scheduled items and blocks them at export (flag-not-drop)', async () => {
  const s = setup();
  const A = ulid();
  await s.approve(A, future());
  const sched = await s.svc.createSchedule('ch12');
  await s.svc.addItem(sched.id, A, new Date().toISOString(), 30);
  await s.expire(A);
  assert.equal(s.svc.getSchedule(sched.id)!.items[0].flagged, 'asset-expired'); // still present, flagged
  const res = await s.svc.sendToAir(sched.id);
  assert.equal(res.exported.length, 0);
  assert.equal(res.blocked[0].reason, 'not-approved'); // removed from schedulable registry
});

test('export-time guard blocks an approval that lapsed between scheduling and send-to-air', async () => {
  const s = setup();
  const A = ulid();
  await s.approve(A, past());                          // schedulable, but expiry already passed
  const sched = await s.svc.createSchedule('ch12');
  await s.svc.addItem(sched.id, A, new Date().toISOString(), 30); // allowed (still in the registry)
  const res = await s.svc.sendToAir(sched.id, { now: Date.now() });
  assert.equal(res.blocked[0].reason, 'expired');      // caught at serialization, no asset.expired needed
  assert.equal(res.exported.length, 0);
});

test('asset.replaced swaps item references and schedulability', async () => {
  const s = setup();
  const oldId = ulid(), newId = ulid();
  await s.approve(oldId, future());
  const sched = await s.svc.createSchedule('ch12');
  await s.svc.addItem(sched.id, oldId, new Date().toISOString(), 30);
  await s.replace(oldId, newId);
  assert.equal(s.svc.getSchedule(sched.id)!.items[0].assetId, newId);
  const res = await s.svc.sendToAir(sched.id);
  assert.equal(res.exported[0].assetId, newId);
});

test('asset.deleted drops item references', async () => {
  const s = setup();
  const A = ulid();
  await s.approve(A, future());
  const sched = await s.svc.createSchedule('ch12');
  await s.svc.addItem(sched.id, A, new Date().toISOString(), 30);
  await s.del(A);
  assert.equal(s.svc.getSchedule(sched.id)!.items.length, 0);
});
