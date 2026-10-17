// EP-25.2 — what people do with tasks, through the routes (notifications.yaml), with the decisions
// of 2026-10-16 as the assertions: claim first, first claim wins; `task:assign` to hand work out,
// `task:admin` to cancel or reassign; a workflow's task is never cancelled by hand; participants are
// recorded on the task, every action audited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { compile, type EffectivePolicy } from '@atlas/policy';
import {
  buildNotificationsApp,
  fakePrincipals,
  INTERNAL_HEADERS,
  NotificationsService,
  sqliteInboxStore,
  TaskActions,
  type Task,
} from '../src/index.ts';

const CH = 'ch12';

const policyOf = (userId: string, permissions: string[]): EffectivePolicy =>
  compile({
    subjectId: userId,
    permVersion: 1,
    rules: permissions.length > 0 ? [{ id: 'r', permissions }] : [],
    roles: [],
    groups: [],
  });

async function harness() {
  const store = sqliteInboxStore();
  const principals = fakePrincipals({
    ana: [{ kind: 'role', id: 'editor' }],
    ben: [{ kind: 'role', id: 'editor' }],
    cat: [{ kind: 'group', id: 'g-desk' }],
  });
  const grants: Record<string, string[]> = {
    boss: ['task:assign', 'task:admin'],
    ana: ['task:assign'],
  };
  const service = new NotificationsService({ store, principals });
  const app = await buildNotificationsApp({
    service,
    tasks: new TaskActions({ store, principals }),
    policyFor: (userId) => policyOf(userId, grants[userId] ?? []),
  });
  const as = (userId: string) => ({
    [INTERNAL_HEADERS.user]: userId,
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  });
  const call = (userId: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: as(userId),
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const outbox = new SqliteOutboxStore(store.db);
  const audits = async (taskId: string) =>
    (await outbox.listUnsent(1000))
      .map((r) => r.message.body as Envelope)
      .filter(
        (e) =>
          e.type === 'audit.recorded' && (e.payload as { entityId: string }).entityId === taskId,
      )
      .map(
        (e) => e.payload as { action: string; revision: number; delta: Record<string, unknown> },
      );
  /** A workflow's task, as BMS sends it. */
  const workflowTask = async (
    assignee: string,
    assigneeKind: 'user' | 'role',
    review?: { reviewPointId: string },
  ) => {
    const taskId = ulid();
    const envelope = buildEnvelope({
      type: 'workflow.task.created',
      channelId: CH,
      payload: {
        taskId,
        workflowInstanceId: ulid(),
        assignee,
        assigneeKind,
        kind: review ? 'approve' : 'review',
        ...(review ?? {}),
      },
      actor: { kind: 'service', id: 'bms' },
    });
    await service.consumeTaskCreated({
      id: envelope.messageId,
      subject: subjectFor(CH, 'workflow.task.created'),
      body: envelope,
    });
    return taskId;
  };
  /** BMS closing a workflow's task with a review verdict (EP-22.6). */
  const resolve = async (taskId: string, outcome: string, by: string, channelId = CH) => {
    const envelope = buildEnvelope({
      type: 'workflow.task.resolved',
      channelId,
      payload: {
        taskId,
        workflowInstanceId: ulid(),
        outcome,
        by,
        reviewPointId: 'pre-schedule',
        at: new Date().toISOString(),
      },
      actor: { kind: 'service', id: 'bms' },
    });
    const msg = {
      id: envelope.messageId,
      subject: subjectFor(channelId, 'workflow.task.resolved'),
      body: envelope,
    };
    return { msg, outcome: await service.consumeTaskResolved(msg) };
  };
  return { app, call, audits, workflowTask, principals, resolve, service, outbox };
}

test('assigning by hand takes task:assign; the creator and a named assignee are its participants', async () => {
  const h = await harness();
  const refused = await h.call('ben', 'POST', '/api/v1/tasks', {
    assignee: 'cat',
    assigneeKind: 'user',
  });
  assert.equal(refused.statusCode, 403);

  const res = await h.call('ana', 'POST', '/api/v1/tasks', {
    assignee: 'cat',
    assigneeKind: 'user',
    kind: 'review',
    title: 'Check the captions',
    subjectRef: { entityType: 'asset', entityId: ulid() },
  });
  assert.equal(res.statusCode, 201, res.body);
  const task = res.json<Task>();
  assert.deepEqual(
    [task.assignee, task.state, task.version, task.createdBy, task.participants],
    ['cat', 'open', 1, 'ana', ['ana', 'cat']],
  );
  assert.deepEqual(
    (await h.audits(task.id)).map((a) => a.action),
    ['task.created'],
  );
  const bad = await h.call('ana', 'POST', '/api/v1/tasks', { assignee: 'x', assigneeKind: 'team' });
  assert.equal(bad.statusCode, 422);
});

test('claim first: a role task is claimed by a holder, first claim wins, and only then is it acted on', async () => {
  const h = await harness();
  const id = await h.workflowTask('editor', 'role');

  // Not completable or forwardable before a claim — not even by a holder.
  assert.equal(
    (await h.call('ana', 'POST', `/api/v1/tasks/${id}/complete`, { outcome: 'ok' })).statusCode,
    409,
  );
  // Not claimable by someone who does not hold the role.
  assert.equal((await h.call('cat', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 403);

  const claimed = await h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`);
  assert.equal(claimed.statusCode, 200, claimed.body);
  const task = claimed.json<Task>();
  assert.deepEqual([task.assignee, task.assigneeKind, task.version], ['ana', 'user', 2]);
  assert.ok(task.participants.includes('ana'));

  // The second holder is too late; the first claiming again gets the same task back.
  assert.equal((await h.call('ben', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 409);
  assert.equal((await h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 200);

  // Only the holder completes it.
  assert.equal((await h.call('ben', 'POST', `/api/v1/tasks/${id}/complete`)).statusCode, 403);
  const done = await h.call('ana', 'POST', `/api/v1/tasks/${id}/complete`, { outcome: 'approved' });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(
    [done.json<Task>().state, done.json<Task>().outcome, done.json<Task>().closedBy],
    ['done', 'approved', 'ana'],
  );
  // Closed for good.
  assert.equal((await h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 409);

  const audits = await h.audits(id);
  assert.deepEqual(
    audits.map((a) => [a.action, a.revision]),
    [
      ['task.created', 1],
      ['task.claimed', 2],
      ['task.completed', 3],
    ],
  );
  // The participants ride in the deltas — what the log reads to let them see the history.
  assert.deepEqual(audits[1]?.delta['participants'], { before: [], after: ['ana'] });
});

test('two claims at once: exactly one wins (compare-and-set on the version)', async () => {
  const h = await harness();
  const id = await h.workflowTask('editor', 'role');
  const [a, b] = await Promise.all([
    h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`),
    h.call('ben', 'POST', `/api/v1/tasks/${id}/claim`),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('forward: the holder hands it on; task:admin reassigns anything; each recipient a participant', async () => {
  const h = await harness();
  const id = await h.workflowTask('ana', 'user');
  assert.equal(
    (
      await h.call('ben', 'POST', `/api/v1/tasks/${id}/forward`, {
        assignee: 'ben',
        assigneeKind: 'user',
      })
    ).statusCode,
    403,
    'not yours to forward',
  );
  const fwd = await h.call('ana', 'POST', `/api/v1/tasks/${id}/forward`, {
    assignee: 'g-desk',
    assigneeKind: 'group',
  });
  assert.equal(fwd.statusCode, 200, fwd.body);
  assert.deepEqual([fwd.json<Task>().assignee, fwd.json<Task>().assigneeKind], ['g-desk', 'group']);
  // Cat is in the group: she claims it.
  assert.equal((await h.call('cat', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 200);

  // task:admin reassigns a task that is not theirs — to a user, who joins the participants.
  const re = await h.call('boss', 'POST', `/api/v1/tasks/${id}/forward`, {
    assignee: 'ben',
    assigneeKind: 'user',
  });
  assert.equal(re.statusCode, 200, re.body);
  assert.deepEqual(re.json<Task>().participants.sort(), ['ana', 'ben', 'boss', 'cat']);
});

test('cancel takes task:admin, and a workflow’s task is never cancelled by hand', async () => {
  const h = await harness();
  const manual = (
    await h.call('ana', 'POST', '/api/v1/tasks', { assignee: 'cat', assigneeKind: 'user' })
  ).json<Task>().id;
  assert.equal((await h.call('ana', 'POST', `/api/v1/tasks/${manual}/cancel`)).statusCode, 403);
  const cancelled = await h.call('boss', 'POST', `/api/v1/tasks/${manual}/cancel`);
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json<Task>().state, 'cancelled');

  const fromWorkflow = await h.workflowTask('cat', 'user');
  assert.equal(
    (await h.call('boss', 'POST', `/api/v1/tasks/${fromWorkflow}/cancel`)).statusCode,
    409,
  );
});

test('reading one task: a participant, a holder of its role, task:admin — anyone else gets nothing', async () => {
  const h = await harness();
  const id = await h.workflowTask('editor', 'role');
  assert.equal((await h.call('ana', 'GET', `/api/v1/tasks/${id}`)).statusCode, 200, 'a holder');
  assert.equal((await h.call('boss', 'GET', `/api/v1/tasks/${id}`)).statusCode, 200, 'task:admin');
  assert.equal((await h.call('cat', 'GET', `/api/v1/tasks/${id}`)).statusCode, 404, 'a stranger');
  assert.equal((await h.call('ana', 'GET', `/api/v1/tasks/${ulid()}`)).statusCode, 404);
});

test('IAM away: a role task cannot be claimed (503), and nothing is written', async () => {
  const h = await harness();
  const id = await h.workflowTask('editor', 'role');
  h.principals.down = true;
  assert.equal((await h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 503);
  assert.deepEqual(
    (await h.audits(id)).map((a) => a.action),
    ['task.created'],
  );
});

test('a review task (EP-22.6): never completed here — the verdict in MAM closes it, through BMS', async () => {
  const h = await harness();
  const id = await h.workflowTask('editor', 'role', { reviewPointId: 'pre-schedule' });
  const read = await h.call('ana', 'GET', `/api/v1/tasks/${id}`);
  assert.equal(read.json<Task>().reviewPointId, 'pre-schedule', 'the point to name in MAM');

  // Claimed, it is still not completable by hand: the verdict is MAM's.
  assert.equal((await h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 200);
  const refused = await h.call('ana', 'POST', `/api/v1/tasks/${id}/complete`, {
    outcome: 'approved',
  });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json<{ detail: string }>().detail, /review point "pre-schedule"/);

  // Another channel's resolution is not this task's.
  assert.equal((await h.resolve(id, 'approved', 'ana', 'ch99')).outcome, 'skipped');
  const { msg, outcome } = await h.resolve(id, 'rejected', 'rev-1');
  assert.equal(outcome, 'applied');
  const task = (await h.call('ana', 'GET', `/api/v1/tasks/${id}`)).json<Task>();
  assert.deepEqual([task.state, task.outcome, task.closedBy], ['done', 'rejected', 'rev-1']);
  assert.ok(task.participants.includes('rev-1'), 'who gave the verdict acted on it');
  // Redelivered, or resolved again: nothing more.
  assert.equal(await h.service.consumeTaskResolved(msg), 'duplicate');

  const audits = await h.audits(id);
  assert.deepEqual(
    audits.map((a) => [a.action, a.revision]),
    [
      ['task.created', 1],
      ['task.claimed', 2],
      ['task.resolved', 3],
    ],
  );
  const updated = (await h.outbox.listUnsent(1000))
    .map((r) => r.message.body as Envelope)
    .filter((e) => e.type === 'task.updated')
    .map((e) => e.payload as { state: string; outcome?: string; at: string });
  assert.deepEqual(updated.at(-1), {
    id,
    state: 'done',
    by: 'rev-1',
    outcome: 'rejected',
    at: updated.at(-1)?.at,
  });
});

test('a resolution for a task not here yet is thrown to the broker — its creation may be behind', async () => {
  const h = await harness();
  await assert.rejects(h.resolve(ulid(), 'approved', 'rev-1'), /not here yet/);
});

test('a workflow task CANCELLED by BMS (EP-22.9): its step timed out — closed, audited, never completable after', async () => {
  const h = await harness();
  const id = await h.workflowTask('editor', 'role');
  const envelope = buildEnvelope({
    type: 'workflow.task.resolved',
    channelId: CH,
    payload: {
      taskId: id,
      workflowInstanceId: ulid(),
      state: 'cancelled',
      reason: 'timeout',
      at: new Date().toISOString(),
    },
    actor: { kind: 'service', id: 'bms' },
  });
  const msg = { id: envelope.messageId, subject: 's', body: envelope };
  assert.equal(await h.service.consumeTaskResolved(msg), 'applied');
  const task = (await h.call('boss', 'GET', `/api/v1/tasks/${id}`)).json<Task>();
  assert.deepEqual([task.state, task.outcome, task.closedBy], ['cancelled', undefined, 'bms']);
  assert.equal((await h.call('ana', 'POST', `/api/v1/tasks/${id}/claim`)).statusCode, 409);
  const audits = await h.audits(id);
  assert.deepEqual(audits.at(-1)?.action, 'task.cancelled');
  const updated = (await h.outbox.listUnsent(1000))
    .map((r) => r.message.body as Envelope)
    .filter((e) => e.type === 'task.updated')
    .map((e) => (e.payload as { state: string }).state);
  assert.deepEqual(updated, ['cancelled']);
});
