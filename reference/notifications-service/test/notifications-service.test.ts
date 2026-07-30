import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../messaging/src/index.ts';
import { buildEnvelope, ulid, subjectFor } from '../../contracts/src/index.ts';
import { NotificationsService, NotificationsStore } from '../src/index.ts';

function setup() {
  const broker = new InMemoryBroker();
  const store = new NotificationsStore();
  const svc = new NotificationsService(broker, store);
  svc.start();
  const pub = (type: string, payload: any) => {
    const env = buildEnvelope({ type, channelId: 'ch12', payload });
    return broker.publish({ id: env.messageId, subject: subjectFor('ch12', type), body: env });
  };
  return {
    svc,
    taskCreated: (assignee: string, assetId: string) => pub('workflow.task.created', { taskId: ulid(), assignee, assetId, kind: 'approve' }),
    expired: (assetId: string, priorApprover?: string) => pub('asset.expired', { assetId, expiredAt: new Date().toISOString(), ...(priorApprover ? { priorApprover } : {}) }),
  };
}

test('workflow.task.created delivers a task to the assignee inbox', async () => {
  const s = setup();
  const A = ulid();
  await s.taskCreated('user-2', A);
  const inbox = s.svc.getInbox('user-2');
  assert.equal(inbox.tasks.length, 1);
  assert.equal(inbox.tasks[0].assetId, A);
  assert.equal(inbox.tasks[0].state, 'open');
});

test('asset.expired raises a re-review-due notification for the prior approver', async () => {
  const s = setup();
  const A = ulid();
  await s.expired(A, 'user-1');
  const inbox = s.svc.getInbox('user-1');
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0].type, 're-review-due');
  assert.equal(inbox.unreadCount, 1);
});

test('preference opt-out suppresses a notification', async () => {
  const s = setup();
  const A = ulid();
  s.svc.setPreference('user-1', 're-review-due', false);
  await s.expired(A, 'user-1');
  assert.equal(s.svc.getInbox('user-1').notifications.length, 0);
});

test('markRead clears the unread count; completeTask closes a task', async () => {
  const s = setup();
  const A = ulid();
  await s.taskCreated('user-2', A);
  await s.expired(A, 'user-2');
  let inbox = s.svc.getInbox('user-2');
  assert.equal(inbox.unreadCount, 1);
  s.svc.markRead('user-2', inbox.notifications[0].id);
  s.svc.completeTask('user-2', inbox.tasks[0].taskId);
  inbox = s.svc.getInbox('user-2');
  assert.equal(inbox.unreadCount, 0);
  assert.equal(inbox.tasks[0].state, 'done');
});

test('asset.expired with no prior approver raises nothing', async () => {
  const s = setup();
  await s.expired(ulid());
  assert.equal(s.svc.getInbox('user-1').notifications.length, 0);
});
