// EP-22.7 — the canonical ingest-to-air preset driven end to end, and what it needed (decided
// 2026-10-17): a start TRIGGER (`ingest.accepted` starts every matching active workflow of its
// channel, once per event, as BMS) and the event BUFFER (a step that starts waiting takes the
// earliest matching event since its instance started, so a verdict or a `ready` that came first is
// not missed). Through the in-process runner; MTS and MAM are played by the envelopes they send.

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
  TriggerStarter,
} from '../src/index.ts';
import { presetInput } from '../src/store-conformance.ts';
import { policyOf } from './helpers.ts';

const CH = 'ch12';

async function harness() {
  const store = sqliteWorkflowStore();
  const runner = inProcessRunner(new BmsRuntime({ store }));
  const service = new BmsService({ store, runner });
  const router = new CompletionRouter({ store, runner });
  const triggers = new TriggerStarter({ store, service, runner });
  const app = await buildBmsApp({
    service,
    // The transcode step's authority, vouched for by its publisher (bms.md §13d).
    policyFor: () => policyOf(['workflow:admin', 'workflow:act', 'asset:write']),
  });
  const headers = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  };
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
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
  const waiting = async (id: string, stepId: string): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (!(await store.instance(id))?.currentSteps.includes(stepId)) {
      if (Date.now() > deadline) throw new Error(`instance never waited in ${stepId}`);
      await new Promise((r) => setTimeout(r, 5));
    }
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
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${id}/publish?revision=1`,
      headers,
    });
    assert.equal(published.statusCode, 200, published.body);
    return id;
  };
  return { store, runner, router, triggers, publish, sent, waiting, app, headers };
}

function event(type: string, payload: Record<string, unknown>, extra: Partial<Envelope> = {}) {
  const e = buildEnvelope({
    type,
    channelId: extra.channelId ?? CH,
    payload,
    actor: { kind: 'service', id: 'x' },
    ...(extra.correlationId !== undefined ? { correlationId: extra.correlationId } : {}),
    ...(extra.causationId !== undefined ? { causationId: extra.causationId } : {}),
  });
  return { id: e.messageId, subject: subjectFor(e.channelId, type), body: e } as Message;
}
const accepted = (assetId: string, more: Record<string, unknown> = {}) =>
  event('ingest.accepted', {
    assetId,
    checksum: { algorithm: 'sha256', value: 'ab' },
    mediaType: 'video',
    ...more,
  });
const ready = (assetId: string) => event('asset.ready', { assetId });
const approved = (assetId: string, reviewPointId?: string) =>
  event('asset.approved', {
    assetId,
    approver: 'rev-1',
    ...(reviewPointId !== undefined ? { reviewPointId } : {}),
  });

/** start (on ingest.accepted) → [a short timer] → wait asset.ready → review → end. */
const flow = (options: { filter?: string; settle?: boolean; points?: string[] } = {}) => ({
  name: 'On ingest',
  vars: [
    { name: 'assetId', type: 'string' },
    ...(options.points ?? ['pre-schedule']).map((p) => ({ name: v(p), type: 'string' })),
  ],
  steps: [
    {
      id: 's_start',
      kind: 'start',
      config: {
        trigger: {
          event: 'ingest.accepted',
          ...(options.filter !== undefined ? { filter: options.filter } : {}),
          output: { 'vars.assetId': '= incoming.assetId' },
        },
      },
    },
    ...(options.settle
      ? [{ id: 's_settle', kind: 'timer', config: { mode: 'duration', value: 'PT1S' } }]
      : []),
    {
      id: 's_ready',
      kind: 'wait-event',
      config: { event: 'asset.ready', correlate: '= incoming.assetId = vars.assetId' },
    },
    ...(options.points ?? ['pre-schedule']).map((p) => ({
      id: `s_${v(p)}`,
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
  transitions: (() => {
    const ids = [
      's_start',
      ...(options.settle ? ['s_settle'] : []),
      's_ready',
      ...(options.points ?? ['pre-schedule']).map((p) => `s_${v(p)}`),
      's_end',
    ];
    return ids.slice(0, -1).map((from, i) => ({ id: `t${i}`, from, to: ids[i + 1]! }));
  })(),
});
const v = (point: string): string => `verdict_${point.replace(/-/g, '_')}`;

test('a trigger starts every matching ACTIVE workflow of the channel, once per event, as BMS', async () => {
  const h = await harness();
  const video = await h.publish(flow({ filter: '= incoming.mediaType = "video"' }));
  const any = await h.publish(flow());
  // A draft, never published, starts nothing.
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers: h.headers,
    payload: flow(),
  });

  const audio = accepted(ulid(), { mediaType: 'audio' });
  const first = await h.triggers.handle(audio);
  assert.deepEqual(first.filtered, [video], 'the filter said no');
  assert.equal(first.started.length, 1);

  const assetId = ulid();
  const msg = accepted(assetId);
  const out = await h.triggers.handle(msg);
  assert.equal(out.started.length, 2);
  const instances = await Promise.all(out.started.map((id) => h.store.instance(id)));
  for (const i of instances) {
    assert.equal(i?.startedBy, 'bms');
    assert.deepEqual(i?.triggeredBy, {
      event: 'ingest.accepted',
      messageId: (msg.body as Envelope).messageId,
    });
    assert.equal(i?.assetId, assetId, 'the event’s asset is the instance’s');
  }
  assert.deepEqual(instances.map((i) => i?.workflowId).sort(), [video, any].sort());
  // Redelivered: the same instances, asked again — never a second one.
  const again = await h.triggers.handle(msg);
  assert.deepEqual(again.started.sort(), out.started.sort());
  assert.equal(
    (await h.store.instances(CH, { limit: 50 })).filter((i) => i.assetId === assetId).length,
    2,
  );
  // trigger.output put the asset in vars: the wait is keyed on it.
  await h.waiting(out.started[0]!, 's_ready');
  assert.equal(await h.router.routeEvent(ready(assetId)), 'delivered');
});

test('another channel’s event starts nothing here; an inactive workflow is not started', async () => {
  const h = await harness();
  const id = await h.publish(flow());
  await h.app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${id}/deactivate?revision=2`,
    headers: h.headers,
  });
  assert.deepEqual((await h.triggers.handle(accepted(ulid()))).started, []);
  const other = event(
    'ingest.accepted',
    { assetId: ulid(), checksum: { algorithm: 'sha256', value: 'ab' } },
    { channelId: 'ch99' },
  );
  assert.deepEqual((await h.triggers.handle(other)).started, []);
});

test('the buffer: an asset.ready published while the instance was busy is taken when it waits — one from before it started is not', async () => {
  const h = await harness();
  await h.publish(flow({ settle: true }));
  const assetId = ulid();
  // Before the instance exists: never this instance's.
  await h.router.routeEvent(ready(assetId));
  const [id] = (await h.triggers.handle(accepted(assetId))).started;
  await h.waiting(id!, 's_settle');
  assert.equal(await h.router.routeEvent(ready(assetId)), 'ignored', 'nobody waits yet: buffered');
  // Past the timer the wait takes it at once, and the review is next.
  await h.waiting(id!, 's_verdict_pre_schedule');
  const history = await h.store.history(id!);
  assert.ok(history.some((e) => e.stepId === 's_ready' && e.event === 'completed'));
});

test('the buffer: a verdict given before the review step is reached resolves it — and closes its task', async () => {
  const h = await harness();
  await h.publish(flow({ points: ['post-ingest'] }));
  const assetId = ulid();
  const [id] = (await h.triggers.handle(accepted(assetId))).started;
  await h.waiting(id!, 's_ready');
  // MAM approves the asset by itself at ready (a category that needs no review) — no point named.
  await h.router.routeEvent(ready(assetId));
  await h.router.routeEvent(approved(assetId));
  const result = await h.runner.settled(id!);
  assert.equal(result.state, 'completed');
  assert.equal(result.vars[v('post-ingest')], 'approved');
  const [created] = await h.sent('workflow.task.created');
  const [resolved] = await h.sent('workflow.task.resolved');
  assert.equal(
    (resolved!.payload as { taskId: string }).taskId,
    (created!.payload as { taskId: string }).taskId,
  );
});

test('an event moves an instance once: the verdict that resolved one review point is not taken by the next', async () => {
  const h = await harness();
  await h.publish(flow({ points: ['first', 'second'] }));
  const assetId = ulid();
  const [id] = (await h.triggers.handle(accepted(assetId))).started;
  await h.waiting(id!, 's_ready');
  await h.router.routeEvent(ready(assetId));
  await h.waiting(id!, 's_verdict_first');
  assert.equal(await h.router.routeEvent(approved(assetId)), 'delivered'); // names no point
  await h.waiting(id!, 's_verdict_second');
  assert.equal((await h.store.instance(id!))?.state, 'waiting', 'the second point still waits');
  assert.equal(await h.router.routeEvent(approved(assetId, 'second')), 'delivered');
  assert.equal((await h.runner.settled(id!)).state, 'completed');
});

// --- the canonical preset, end to end -------------------------------------------------------------

test('the canonical preset: ingest → transcode → ready → review → schedulable, started by its trigger', async () => {
  const h = await harness();
  await h.publish(presetInput('canonical-ingest-to-air.workflow.json'));
  const assetId = ulid();
  const ingest = accepted(assetId);
  const [id] = (await h.triggers.handle(ingest)).started;
  assert.ok(id, 'the preset started on ingest.accepted');

  // BMS issues MTS's own command, for the asset the trigger named.
  const [command] = await h.sent('transcode.job.create');
  assert.deepEqual(command!.payload, {
    assetId,
    presetIds: ['broadcast'],
    inputFile: { kind: 'original' },
  });
  const rendition = {
    kind: 'broadcast',
    path: `assets/${assetId}/broadcast.mxf`,
    checksum: { algorithm: 'sha256', value: 'cd' },
  };
  // An editor marks the asset ready while the broadcast transcode is still running: buffered.
  assert.equal(await h.router.routeEvent(ready(assetId)), 'ignored');
  const done = event(
    'transcode.completed',
    { assetId, renditions: [rendition] },
    { correlationId: command!.correlationId!, causationId: command!.messageId },
  );
  assert.equal(await h.router.route(done), 'delivered');

  // …so the wait passes at once, to the review at its point.
  const [task] = await h.sent('workflow.task.created');
  assert.equal((task!.payload as { reviewPointId?: string }).reviewPointId, 'pre-schedule');
  assert.equal(await h.router.routeEvent(approved(assetId, 'pre-schedule')), 'delivered');
  const result = await h.runner.settled(id!);
  assert.equal(result.state, 'completed');
  assert.equal(result.endStepId, 's_end_ok');
  assert.equal(result.status, 'approved', 'schedulable');
  assert.deepEqual(result.vars['renditions'], [rendition]);
  assert.equal(result.vars['verdict'], 'approved');
});

test('the canonical preset: a rejection takes the rejected end', async () => {
  const h = await harness();
  await h.publish(presetInput('canonical-ingest-to-air.workflow.json'));
  const assetId = ulid();
  const [id] = (await h.triggers.handle(accepted(assetId))).started;
  const [command] = await h.sent('transcode.job.create');
  await h.router.route(
    event(
      'transcode.completed',
      {
        assetId,
        renditions: [
          { kind: 'broadcast', path: 'b.mxf', checksum: { algorithm: 'sha256', value: 'ab' } },
        ],
      },
      { correlationId: command!.correlationId!, causationId: command!.messageId },
    ),
  );
  await h.waiting(id!, 's_wait_ready');
  await h.router.routeEvent(ready(assetId));
  await h.waiting(id!, 's_review');
  await h.router.routeEvent(
    event('asset.rejected', {
      assetId,
      reason: 'soft',
      rejectedBy: 'rev-2',
      reviewPointId: 'pre-schedule',
    }),
  );
  const result = await h.runner.settled(id!);
  assert.equal(result.endStepId, 's_end_rej');
  assert.equal(result.status, 'rejected');
});
