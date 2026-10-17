// EP-22.6 — a step that waits for an EVENT nobody sent BMS as an answer: a wait-event step keyed by
// its `correlate`, and a review step resolved by MAM's verdict (decided 2026-10-16: the verdict, not
// the task, moves the workflow; a verdict naming no review point resolves every review step waiting
// on the asset). End to end through the in-process runner, the router fed the envelopes MAM sends.

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
} from '../src/index.ts';
import { policyOf } from './helpers.ts';

const CH = 'ch12';

async function harness() {
  const store = sqliteWorkflowStore();
  const runner = inProcessRunner(new BmsRuntime({ store }));
  const service = new BmsService({ store, runner });
  const router = new CompletionRouter({ store, runner });
  const app = await buildBmsApp({
    service,
    policyFor: () => policyOf(['workflow:admin', 'workflow:act']),
  });
  const headers = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  };
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);

  /** What BMS has put on the bus of one type, waiting until there are `n`. */
  const sent = async (type: string, n = 1): Promise<Envelope[]> => {
    const deadline = Date.now() + 2000;
    for (;;) {
      await relay.drain();
      const found = broker.published.map((m) => m.body as Envelope).filter((e) => e.type === type);
      if (found.length >= n) return found;
      if (Date.now() > deadline) throw new Error(`fewer than ${n} ${type} after 2s`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** Wait until the instance waits in a step. */
  const waiting = async (id: string, stepId: string): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (!(await store.instance(id))?.currentSteps.includes(stepId)) {
      if (Date.now() > deadline) throw new Error(`instance never waited in ${stepId}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const publish = async (definition: Record<string, unknown>): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: definition,
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json<{ id: string }>();
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${id}/publish?revision=1`,
      headers,
    });
    assert.equal(published.statusCode, 200, published.body);
    return id;
  };
  const start = async (payload: Record<string, unknown>): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/instances', headers, payload });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<{ id: string }>().id;
  };
  return { store, runner, router, publish, start, sent, waiting };
}

/** An event as MAM publishes it. */
function event(type: string, payload: Record<string, unknown>, channelId = CH): Message {
  const e = buildEnvelope({ type, channelId, payload, actor: { kind: 'user', id: 'rev-1' } });
  return { id: e.messageId, subject: subjectFor(channelId, type), body: e };
}
const ready = (assetId: string, channelId = CH): Message =>
  event('asset.ready', { assetId }, channelId);
const approved = (assetId: string, reviewPointId?: string): Message =>
  event('asset.approved', {
    assetId,
    approver: 'rev-1',
    approvedAt: new Date().toISOString(),
    ...(reviewPointId !== undefined ? { reviewPointId } : {}),
  });
const rejected = (assetId: string, reviewPointId?: string): Message =>
  event('asset.rejected', {
    assetId,
    reason: 'soft focus',
    rejectedBy: 'rev-2',
    ...(reviewPointId !== undefined ? { reviewPointId } : {}),
  });

// --- wait-event --------------------------------------------------------------------------------

const AWAIT_READY = {
  name: 'Await ready',
  vars: [
    { name: 'assetId', type: 'string' },
    { name: 'readyAsset', type: 'string' },
  ],
  steps: [
    { id: 's_start', kind: 'start' },
    {
      id: 's_wait',
      kind: 'wait-event',
      config: {
        event: 'asset.ready',
        correlate: '= incoming.assetId = vars.assetId',
        output: { 'vars.readyAsset': '= incoming.assetId' },
      },
    },
    { id: 's_end', kind: 'end' },
  ],
  transitions: [
    { id: 't1', from: 's_start', to: 's_wait' },
    { id: 't2', from: 's_wait', to: 's_end' },
  ],
};

test('a wait-event step is found by its keys: another asset, another channel are not it', async () => {
  const h = await harness();
  const workflowId = await h.publish(AWAIT_READY);
  const assetId = ulid();
  const id = await h.start({ workflowId, vars: { assetId } });
  const other = await h.start({ workflowId, vars: { assetId: ulid() } });
  await h.waiting(id, 's_wait');
  await h.waiting(other, 's_wait');

  assert.equal(await h.router.routeEvent(ready(ulid())), 'ignored');
  assert.equal(await h.router.routeEvent(ready(assetId, 'ch99')), 'ignored');
  assert.equal((await h.store.instance(id))?.state, 'waiting');

  const msg = ready(assetId);
  assert.equal(await h.router.routeEvent(msg), 'delivered');
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'completed');
  assert.equal(result.vars['readyAsset'], assetId, 'the event reached the output mapping');
  // Answered once: a redelivery finds nothing open — and the other instance still waits.
  assert.equal(await h.router.routeEvent(msg), 'ignored');
  assert.equal((await h.store.instance(other))?.state, 'waiting');
  // An event type no workflow may wait for is nobody's here.
  assert.equal(await h.router.routeEvent(event('asset.created', { assetId })), 'ignored');
});

test('every instance waiting on the same keys gets the event', async () => {
  const h = await harness();
  const workflowId = await h.publish(AWAIT_READY);
  const assetId = ulid();
  const a = await h.start({ workflowId, vars: { assetId } });
  const b = await h.start({ workflowId, vars: { assetId } });
  await h.waiting(a, 's_wait');
  await h.waiting(b, 's_wait');
  assert.equal(await h.router.routeEvent(ready(assetId)), 'delivered');
  assert.equal((await h.runner.settled(a)).state, 'completed');
  assert.equal((await h.runner.settled(b)).state, 'completed');
});

test('a key that evaluated to null matches nothing', async () => {
  const h = await harness();
  const id = await h.start({ workflowId: await h.publish(AWAIT_READY) }); // no vars.assetId
  await h.waiting(id, 's_wait');
  assert.equal(await h.router.routeEvent(ready(ulid())), 'ignored');
});

// --- the review step -------------------------------------------------------------------------------

/** A review point's verdict var — a var name has no hyphen. */
const v = (point: string): string => `verdict_${point.replace(/-/g, '_')}`;

const review = (points: string[]) => ({
  name: 'Two-point review',
  vars: points.map((p) => ({ name: v(p), type: 'string' })),
  steps: [
    { id: 's_start', kind: 'start' },
    ...points.map((p) => ({
      id: `s_${p}`,
      kind: 'human-task',
      config: {
        taskType: 'approve',
        assignee: { role: 'editor' },
        reviewPointId: p,
        output: { [`vars.${v(p)}`]: '= incoming.outcome' },
      },
    })),
    { id: 's_end', kind: 'end' },
  ],
  transitions: [
    ...['s_start', ...points.map((p) => `s_${p}`)].map((from, i, all) => ({
      id: `t${i}`,
      from,
      to: all[i + 1] ?? 's_end',
    })),
  ],
});

test('a review step: the task names its point, and MAM’s verdict AT that point resolves it — the task closed with it', async () => {
  const h = await harness();
  const workflowId = await h.publish(review(['post-ingest', 'pre-schedule']));
  const assetId = ulid();
  const id = await h.start({ workflowId, assetId });

  const [first] = await h.sent('workflow.task.created');
  const task = first!.payload as { taskId: string; reviewPointId?: string; assetId?: string };
  assert.equal(task.reviewPointId, 'post-ingest');
  assert.equal(task.assetId, assetId);
  await h.waiting(id, 's_post-ingest');

  // A verdict at ANOTHER point, or on another asset, is not this step's.
  assert.equal(await h.router.routeEvent(approved(assetId, 'rights-check')), 'ignored');
  assert.equal(await h.router.routeEvent(approved(ulid(), 'post-ingest')), 'ignored');

  const verdict = approved(assetId, 'post-ingest');
  assert.equal(await h.router.routeEvent(verdict), 'delivered');
  // The task is closed with the verdict, caused by it…
  const [resolved] = await h.sent('workflow.task.resolved');
  assert.deepEqual(
    {
      ...(resolved!.payload as Record<string, unknown>),
      at: undefined,
    },
    {
      taskId: task.taskId,
      workflowInstanceId: id,
      outcome: 'approved',
      by: 'rev-1',
      assetId,
      reviewPointId: 'post-ingest',
      at: undefined,
    },
  );
  assert.equal(resolved!.causationId, (verdict.body as Envelope).messageId);
  // …so Notifications' `done` for it, when it comes, finds the step already answered.
  const done = buildEnvelope({
    type: 'task.updated',
    channelId: CH,
    payload: { id: task.taskId, state: 'done', outcome: 'approved', at: new Date().toISOString() },
    actor: { kind: 'service', id: 'notifications' },
  });
  assert.equal(
    await h.router.routeTask({ id: done.messageId, subject: 's', body: done }),
    'duplicate',
  );
  // The other verdict row of the same step is answered too: a late rejection moves nothing.
  assert.equal(await h.router.routeEvent(rejected(assetId, 'post-ingest')), 'ignored');

  // The second point: its own task, its own verdict.
  const [, second] = await h.sent('workflow.task.created', 2);
  assert.equal((second!.payload as { reviewPointId?: string }).reviewPointId, 'pre-schedule');
  await h.waiting(id, 's_pre-schedule');
  assert.equal(await h.router.routeEvent(rejected(assetId, 'pre-schedule')), 'delivered');
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'completed');
  assert.deepEqual(
    [result.vars[v('post-ingest')], result.vars[v('pre-schedule')]],
    ['approved', 'rejected'],
  );
});

test('a verdict naming NO review point resolves the review step waiting on the asset', async () => {
  const h = await harness();
  const workflowId = await h.publish(review(['manual']));
  const assetId = ulid();
  const id = await h.start({ workflowId, assetId });
  await h.waiting(id, 's_manual');
  assert.equal(await h.router.routeEvent(rejected(assetId)), 'delivered');
  const result = await h.runner.settled(id);
  assert.equal(result.vars[v('manual')], 'rejected');
  const [resolved] = await h.sent('workflow.task.resolved');
  const p = resolved!.payload as { by?: string; reviewPointId?: string };
  assert.equal(p.by, 'rev-2');
  assert.equal(p.reviewPointId, undefined);
});

test('a review step on an instance with no asset fails, naming why', async () => {
  const h = await harness();
  const id = await h.start({ workflowId: await h.publish(review(['manual'])) });
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'failed');
  assert.match(result.error ?? '', /no asset to review/);
});

test('a verdict for an instance that has ended is orphaned — and its task is still closed', async () => {
  const h = await harness();
  const workflowId = await h.publish(review(['manual']));
  const assetId = ulid();
  const id = await h.start({ workflowId, assetId });
  await h.waiting(id, 's_manual');
  // The instance is gone from the runner (Temporal has nothing to signal).
  const store = h.store;
  const awaits = await store.openEventAwaits(CH, 'asset.approved', assetId);
  assert.equal(awaits.length, 1);
  const lonely = new CompletionRouter({
    store,
    runner: inProcessRunner(new BmsRuntime({ store })),
  });
  assert.equal(await lonely.routeEvent(approved(assetId)), 'orphaned');
  assert.equal((await h.sent('workflow.task.resolved')).length, 1);
});
