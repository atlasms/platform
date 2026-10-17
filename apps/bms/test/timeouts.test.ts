// EP-22.9 — what happens when a waiting step runs out of time, or its workflow fails around it
// (decided 2026-10-17): a waiting step's timeout goes to its `onError`; its task is CANCELLED (and
// its awaits closed, so a late answer moves nothing); a run nothing catches raises an alert and is
// listed under `?state=failed`. Through the in-process runner, against the real runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message } from '@atlas/messaging';
import {
  BmsRuntime,
  BmsService,
  buildBmsApp,
  CompletionRouter,
  INTERNAL_HEADERS,
  inProcessRunner,
  sqliteWorkflowStore,
  type Instance,
} from '../src/index.ts';
import { policyOf } from './helpers.ts';

const CH = 'ch12';

async function harness() {
  const store = sqliteWorkflowStore();
  const failed: Instance[] = [];
  const runner = inProcessRunner(new BmsRuntime({ store, onFailed: (i) => failed.push(i) }));
  const service = new BmsService({ store, runner });
  const router = new CompletionRouter({ store, runner });
  const app = await buildBmsApp({
    service,
    policyFor: () => policyOf(['workflow:admin', 'workflow:act', 'asset:write']),
  });
  const headers = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  };
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const published = async (type: string): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope).filter((e) => e.type === type);
  };
  const publish = async (definition: object): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: definition,
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json<{ id: string }>();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${id}/publish?revision=1`,
      headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    return id;
  };
  const start = async (payload: Record<string, unknown>): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/instances', headers, payload });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<{ id: string }>().id;
  };
  return { app, headers, store, runner, router, publish, start, published, failed };
}

const linear = (name: string, steps: object[], extra: object[] = [], transitions?: object[]) => {
  const all = [{ id: 's_start', kind: 'start' }, ...steps, { id: 's_end', kind: 'end' }];
  return {
    name,
    vars: [
      { name: 'assetId', type: 'string' },
      { name: 'verdict', type: 'string' },
    ],
    steps: [...all, ...extra],
    transitions:
      transitions ??
      all.slice(0, -1).map((s, i) => ({
        id: `t${i}`,
        from: (s as { id: string }).id,
        to: (all[i + 1] as { id: string }).id,
      })),
  };
};

function event(type: string, payload: Record<string, unknown>, correlationId?: string): Message {
  const e = buildEnvelope({
    type,
    channelId: CH,
    payload,
    actor: { kind: 'service', id: 'x' },
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
  return { id: e.messageId, subject: subjectFor(CH, type), body: e };
}

test('a human step that times out goes to its onError path — and its task is cancelled, a late answer moving nothing', async () => {
  const h = await harness();
  const workflowId = await h.publish(
    linear(
      'Review in time',
      [
        {
          id: 's_review',
          kind: 'human-task',
          timeout: 'PT1S',
          onError: { transitionTo: 's_late' },
          config: {
            taskType: 'approve',
            assignee: { role: 'editor' },
            reviewPointId: 'pre-schedule',
            output: { 'vars.verdict': '= incoming.outcome' },
          },
        },
      ],
      [{ id: 's_late', kind: 'end', config: { status: 'late' } }],
      [
        { id: 't0', from: 's_start', to: 's_review' },
        { id: 't1', from: 's_review', to: 's_end' },
      ],
    ),
  );
  const assetId = ulid();
  const id = await h.start({ workflowId, assetId });
  const result = await h.runner.settled(id);
  assert.deepEqual(
    [result.state, result.endStepId, result.status],
    ['completed', 's_late', 'late'],
  );

  const [task] = await h.published('workflow.task.created');
  const taskId = (task!.payload as { taskId: string }).taskId;
  const [cancelled] = await h.published('workflow.task.resolved');
  assert.deepEqual(
    { ...(cancelled!.payload as Record<string, unknown>), at: undefined },
    {
      taskId,
      workflowInstanceId: id,
      state: 'cancelled',
      reason: 'timeout',
      assetId,
      at: undefined,
    },
  );
  // Late: a verdict at its point, and Notifications' `done`, both find the step closed.
  assert.equal(
    await h.router.routeEvent(
      event('asset.approved', { assetId, approver: 'rev-1', reviewPointId: 'pre-schedule' }),
    ),
    'ignored',
  );
  const done = event('task.updated', { id: taskId, state: 'done', at: new Date().toISOString() });
  assert.equal(await h.router.routeTask(done), 'duplicate');
  assert.equal((await h.published('workflow.task.resolved')).length, 1, 'cancelled once');
  const history = await h.store.history(id);
  assert.ok(history.some((e) => e.stepId === 's_review' && e.event === 'failed'));
});

test('a wait-event that times out with no error path fails the run: alerted, listed as failed, its wait closed', async () => {
  const h = await harness();
  const workflowId = await h.publish(
    linear('Wait in time', [
      {
        id: 's_ready',
        kind: 'wait-event',
        timeout: 'PT1S',
        config: { event: 'asset.ready', correlate: '= incoming.assetId = vars.assetId' },
      },
    ]),
  );
  const assetId = ulid();
  const id = await h.start({ workflowId, vars: { assetId } });
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'failed');
  assert.match(result.error ?? '', /s_ready.*timed out/);

  const [alert] = await h.published('alert.raised');
  const a = alert!.payload as Record<string, unknown>;
  assert.deepEqual(
    [a['source'], a['kind'], a['severity'], a['subjectRef']],
    ['bms', 'workflow-failed', 'warning', { entityType: 'workflowInstance', entityId: id }],
  );
  assert.match(String(a['message']), /workflow "Wait in time" \(v1\) failed: .*timed out/);
  assert.deepEqual(
    h.failed.map((i) => i.id),
    [id],
    'counted',
  );

  const listed = await h.app.inject({
    method: 'GET',
    url: '/api/v1/instances?state=failed',
    headers: h.headers,
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(
    listed.json<{ items: Instance[] }>().items.map((i) => i.id),
    [id],
  );
  const bad = await h.app.inject({
    method: 'GET',
    url: '/api/v1/instances?state=lost',
    headers: h.headers,
  });
  assert.equal(bad.statusCode, 422);
  // The wait is closed: the asset becoming ready later moves nothing.
  assert.equal(await h.router.routeEvent(event('asset.ready', { assetId })), 'ignored');
});

test('a workflow failing while a task is open on another branch cancels the task — reason workflow-ended', async () => {
  const h = await harness();
  const workflowId = await h.publish({
    name: 'Parallel',
    vars: [{ name: 'assetId', type: 'string' }],
    steps: [
      { id: 's_start', kind: 'start' },
      { id: 's_split', kind: 'parallel', config: { mode: 'split' } },
      {
        id: 's_task',
        kind: 'human-task',
        config: { taskType: 'review', assignee: { role: 'editor' } },
      },
      {
        id: 's_tx',
        kind: 'command',
        config: {
          action: 'transcode',
          request: {
            event: 'transcode.job.create',
            input: {
              assetId: '= vars.assetId',
              presetIds: '= ["nope"]',
              'inputFile.kind': '= "original"',
            },
          },
          await: { event: 'transcode.completed' },
        },
      },
      { id: 's_join', kind: 'parallel', config: { mode: 'join' } },
      { id: 's_end', kind: 'end' },
    ],
    transitions: [
      { id: 't0', from: 's_start', to: 's_split' },
      { id: 't1', from: 's_split', to: 's_task' },
      { id: 't2', from: 's_split', to: 's_tx' },
      { id: 't3', from: 's_task', to: 's_join' },
      { id: 't4', from: 's_tx', to: 's_join' },
      { id: 't5', from: 's_join', to: 's_end' },
    ],
  });
  const id = await h.start({ workflowId, vars: { assetId: ulid() } });
  // MTS refuses the command; the run fails with the task still open.
  let command: Envelope | undefined;
  for (const deadline = Date.now() + 2000; !command && Date.now() < deadline;) {
    [command] = await h.published('transcode.job.create');
    if (!command) await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(
    await h.router.route(
      event(
        'transcode.failed',
        { assetId: ulid(), error: { code: 'COMMAND_REFUSED', message: 'unknown preset(s): nope' } },
        command!.correlationId!,
      ),
    ),
    'delivered',
  );
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'failed');
  const [cancelled] = await h.published('workflow.task.resolved');
  assert.deepEqual(
    [
      (cancelled!.payload as { state?: string }).state,
      (cancelled!.payload as { reason?: string }).reason,
    ],
    ['cancelled', 'workflow-ended'],
  );
});

test('publish refuses a retry on a step that is not a command', async () => {
  const h = await harness();
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers: h.headers,
    payload: linear('Retrying a person', [
      {
        id: 's_task',
        kind: 'human-task',
        retry: { maxAttempts: 3 },
        config: { taskType: 'review', assignee: { role: 'editor' } },
      },
    ]),
  });
  const { id } = created.json<{ id: string }>();
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${id}/publish?revision=1`,
    headers: h.headers,
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.body, /RETRY_NOT_COMMAND/);
});
