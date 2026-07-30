import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../messaging/src/index.ts';
import { buildEnvelope, ulid, subjectFor } from '../../contracts/src/index.ts';
import { MamService, AssetStore } from '../../mam-service/src/index.ts';
import { SchedulingService, SchedulingStore } from '../../scheduling-service/src/index.ts';
import { NotificationsService, NotificationsStore } from '../src/index.ts';

// Three services on one broker. The headline: ONE asset.expired event fans out to TWO independent
// consumers — Scheduling pulls the item from air, Notifications raises a re-review notification.
test('fan-out: one asset.expired drives both Scheduling and Notifications', async () => {
  const broker = new InMemoryBroker();
  const mam = new MamService(broker, new AssetStore());
  const sched = new SchedulingService(broker, new SchedulingStore());
  const notif = new NotificationsService(broker, new NotificationsStore());
  mam.start(); sched.start(); notif.start();

  const pub = (type: string, payload: any) => {
    const env = buildEnvelope({ type, channelId: 'ch12', payload });
    return broker.publish({ id: env.messageId, subject: subjectFor('ch12', type), body: env });
  };
  const A = ulid();

  // ingest -> ready -> approve (MAM), which makes it schedulable (Scheduling)
  await pub('ingest.accepted', { assetId: A, checksum: { algorithm: 'sha256', value: 'a' }, source: 's', path: '/x.mxf', technicalMetadata: { container: 'mxf' } });
  await mam.drain();
  await pub('transcode.completed', { assetId: A, renditions: [{ kind: 'broadcast', path: '/r.mp4', checksum: { algorithm: 'sha256', value: 'b' } }] });
  await mam.drain();
  await mam.approve(A, 'user-1', { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await mam.drain();

  const s = await sched.createSchedule('ch12');
  await sched.addItem(s.id, A, new Date().toISOString(), 30);
  assert.equal((await sched.sendToAir(s.id)).exported.length, 1); // on air

  // A separate BMS task lands for user-2 (independent consumer path)
  await broker.publish({ id: ulid(), subject: subjectFor('ch12', 'workflow.task.created'), body: buildEnvelope({ type: 'workflow.task.created', channelId: 'ch12', payload: { taskId: ulid(), assignee: 'user-2', assetId: A, kind: 'review' } }) });

  // THE FAN-OUT: MAM expires A -> asset.expired -> Scheduling AND Notifications both react
  await mam.expire(A, { priorApprover: 'user-1' });
  await mam.drain();

  // Scheduling reaction: pulled from air
  assert.equal((await sched.sendToAir(s.id)).exported.length, 0);
  assert.equal(sched.getSchedule(s.id)!.items[0].flagged, 'asset-expired');

  // Notifications reaction: re-review notification to the prior approver
  const inbox1 = notif.getInbox('user-1');
  assert.equal(inbox1.notifications.some((n) => n.type === 're-review-due' && n.assetId === A), true);

  // And the independent task delivery
  assert.equal(notif.getInbox('user-2').tasks.length, 1);
});
