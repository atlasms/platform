// EP-22.4 — a command step issues the target's OWN command and the completion router brings the
// answer back to the step: end to end through the in-process runner (the interpreter and runtime
// Temporal drives), with MTS played by a function that answers the command it finds on the bus
// exactly as MTS does — under the command's correlation id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message } from '@atlas/messaging';
import {
  answerPatterns,
  BmsRuntime,
  BmsService,
  buildBmsApp,
  CompletionRouter,
  INTERNAL_HEADERS,
  inProcessRunner,
  sqliteWorkflowStore,
  startCompletionRouter,
} from '../src/index.ts';
import { compile, type Rule } from '@atlas/policy';
import { policyOf } from './helpers.ts';

const CH = 'ch12';

async function harness() {
  const store = sqliteWorkflowStore();
  const runtime = new BmsRuntime({ store });
  const runner = inProcessRunner(runtime);
  const service = new BmsService({ store, runner });
  const router = new CompletionRouter({ store, runner });
  const app = await buildBmsApp({
    service,
    // The publisher vouches for the transcode step's authority (decided 2026-10-16).
    policyFor: () => policyOf(['workflow:admin', 'workflow:act', 'asset:write']),
  });
  const headers = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  };
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);

  /** The commands BMS has put on the bus so far. */
  const commands = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published
      .map((m) => m.body as Envelope)
      .filter((e) => e.type === 'transcode.job.create');
  };
  /** Wait until the n-th command is on the bus. */
  const nthCommand = async (n: number): Promise<Envelope> => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const sent = await commands();
      if (sent.length >= n) return sent[n - 1]!;
      if (Date.now() > deadline) throw new Error(`no command #${n} after 2s`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  /** A published workflow: start → transcode (await its completion, retried once) → end. */
  const publish = async (): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: {
        name: 'Transcode',
        vars: [
          { name: 'assetId', type: 'string' },
          { name: 'renditions', type: 'array' },
        ],
        steps: [
          { id: 's_start', kind: 'start' },
          {
            id: 's_tx',
            kind: 'command',
            retry: { maxAttempts: 2 },
            config: {
              action: 'transcode',
              request: {
                event: 'transcode.job.create',
                input: {
                  assetId: '= vars.assetId',
                  presetIds: '= ["broadcast"]',
                  'inputFile.kind': '= "original"',
                },
              },
              await: {
                event: 'transcode.completed',
                output: { 'vars.renditions': '= incoming.renditions' },
              },
            },
          },
          { id: 's_end', kind: 'end', config: { status: 'done' } },
        ],
        transitions: [
          { id: 't1', from: 's_start', to: 's_tx' },
          { id: 't2', from: 's_tx', to: 's_end' },
        ],
      },
    });
    const { id } = created.json<{ id: string }>();
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${id}/publish?revision=1`,
      headers,
    });
    assert.equal(published.statusCode, 200, published.body);
    return id;
  };
  const start = async (workflowId: string, assetId: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/instances',
      headers,
      payload: { workflowId, vars: { assetId } },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<{ id: string }>().id;
  };
  return { app, headers, store, broker, runner, router, commands, nthCommand, publish, start };
}

/** MTS's answer to a command: the command's correlation id, caused by it — follow()'s rule. */
function answer(
  command: Envelope,
  type: 'transcode.completed' | 'transcode.failed',
  payload: Record<string, unknown>,
  channelId = command.channelId,
): Message {
  const envelope = buildEnvelope({
    type,
    channelId,
    payload,
    actor: { kind: 'service', id: 'mts' },
    ...(command.correlationId !== undefined ? { correlationId: command.correlationId } : {}),
    causationId: command.messageId,
  });
  return { id: envelope.messageId, subject: subjectFor(channelId, type), body: envelope };
}

const rendition = {
  kind: 'broadcast',
  path: 'assets/x/broadcast.mxf',
  checksum: { algorithm: 'sha256', value: 'ab' },
};

test('the command goes out as MTS’s own, and its answer completes the step with the output mapped', async () => {
  const h = await harness();
  const assetId = ulid();
  const id = await h.start(await h.publish(), assetId);

  const command = await h.nthCommand(1);
  assert.equal(command.channelId, CH);
  assert.deepEqual(command.payload, {
    assetId,
    presetIds: ['broadcast'],
    inputFile: { kind: 'original' },
  });
  const awaited = await h.store.commandAwait(command.correlationId!);
  assert.equal(awaited?.instanceId, id);
  assert.equal(awaited?.stepId, 's_tx');

  const done = answer(command, 'transcode.completed', { assetId, renditions: [rendition] });
  assert.equal(await h.router.route(done), 'delivered');
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'completed');
  assert.equal(result.endStepId, 's_end');
  assert.deepEqual(result.vars['renditions'], [rendition]);

  // The same answer redelivered — or delivered after its instance ended — completes nothing again.
  assert.equal(await h.router.route(done), 'duplicate');
  assert.equal((await h.store.commandAwait(command.correlationId!))?.answeredBy, done.id);
});

test("a failure fails the step and its retry issues a NEW command; the first attempt's late answer is not the second's", async () => {
  const h = await harness();
  const assetId = ulid();
  const id = await h.start(await h.publish(), assetId);

  const first = await h.nthCommand(1);
  const refused = answer(first, 'transcode.failed', {
    assetId,
    error: { code: 'COMMAND_REFUSED', message: 'unknown preset(s): broadcast' },
  });
  assert.equal(await h.router.route(refused), 'delivered');

  // retry.maxAttempts 2: the step issues the command again, under a correlation of its own.
  const second = await h.nthCommand(2);
  assert.notEqual(second.correlationId, first.correlationId);

  // A COMPLETION of the first attempt arriving now (it is not impossible: a refusal then a
  // success is two answers) must not complete the second attempt's wait.
  const late = answer(first, 'transcode.completed', { assetId, renditions: [rendition] });
  assert.equal(await h.router.route(late), 'duplicate', 'the first command was answered already');
  const instance = await h.store.instance(id);
  assert.equal(instance?.state, 'waiting');

  assert.equal(
    await h.router.route(
      answer(second, 'transcode.completed', { assetId, renditions: [rendition] }),
    ),
    'delivered',
  );
  assert.equal((await h.runner.settled(id)).state, 'completed');
  const history = await h.store.history(id);
  assert.equal(
    history.filter((e) => e.stepId === 's_tx' && e.event === 'awaiting').length,
    2,
    'the step waited once per attempt',
  );
});

test('a failure past the retries fails the instance with the target’s words', async () => {
  const h = await harness();
  const assetId = ulid();
  const id = await h.start(await h.publish(), assetId);
  for (const n of [1, 2]) {
    const command = await h.nthCommand(n);
    await h.router.route(
      answer(command, 'transcode.failed', {
        assetId,
        error: { code: 'TRANSCODE_REFUSED', message: `no picture (attempt ${n})` },
      }),
    );
  }
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'failed');
  assert.match(result.error ?? '', /TRANSCODE_REFUSED: no picture \(attempt 2\)/);
});

test('what is not an answer to a command BMS issued is ignored — and an ended instance’s answer is orphaned', async () => {
  const h = await harness();
  const assetId = ulid();
  const id = await h.start(await h.publish(), assetId);
  const command = await h.nthCommand(1);
  const payload = { assetId, renditions: [rendition] };

  // A transcode nobody in BMS asked for (MTS's own first renditions): no correlation it knows.
  const stranger = buildEnvelope({
    type: 'transcode.completed',
    channelId: CH,
    payload,
    actor: { kind: 'service', id: 'mts' },
  });
  const strangerMsg = { id: stranger.messageId, subject: 's', body: stranger };
  assert.equal(await h.router.route(strangerMsg), 'ignored');
  // Our correlation id from ANOTHER channel is not our answer.
  assert.equal(
    await h.router.route(answer(command, 'transcode.completed', payload, 'ch99')),
    'ignored',
  );
  // An event the command is not answered by.
  const other = buildEnvelope({
    type: 'asset.ready',
    channelId: CH,
    payload: { assetId },
    actor: { kind: 'service', id: 'mam' },
    correlationId: command.correlationId!,
  });
  assert.equal(await h.router.route({ id: other.messageId, subject: 's', body: other }), 'ignored');
  assert.equal((await h.store.instance(id))?.state, 'waiting');

  // The instance ends some other way (a person signals the step) before MTS answers.
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/instances/${id}/signal`,
    headers: h.headers,
    payload: { stepId: 's_tx', payload: { renditions: [] } },
  });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal((await h.runner.settled(id)).state, 'completed');
  const late = answer(command, 'transcode.completed', payload);
  // The in-process runner keeps an ended instance's inbox, so this is delivered to nobody who
  // waits; on Temporal it is InstanceNotRunning → orphaned. Either way it is answered once.
  assert.ok(['delivered', 'orphaned'].includes(await h.router.route(late)));
  assert.equal(await h.router.route(late), 'duplicate');

  // Not an envelope at all: thrown to the broker, which dead-letters it.
  await assert.rejects(h.router.route({ id: ulid(), subject: 's', body: { nope: 1 } }), /envelope/);
});

test('over the broker: one subscription per answer type, every channel', async () => {
  assert.deepEqual(answerPatterns(), [
    'atlas.*.transcode.completed',
    'atlas.*.transcode.failed',
    'atlas.*.task.updated',
    'atlas.*.asset.ready',
    'atlas.*.asset.approved',
    'atlas.*.asset.rejected',
  ]);
  const h = await harness();
  const outcomes: string[] = [];
  startCompletionRouter({
    broker: h.broker,
    router: h.router,
    onOutcome: (_subject, outcome) => outcomes.push(outcome),
  });
  const assetId = ulid();
  const id = await h.start(await h.publish(), assetId);
  const command = await h.nthCommand(1);
  const done = answer(command, 'transcode.completed', { assetId, renditions: [rendition] });
  await h.broker.publish(done);
  assert.equal((await h.runner.settled(id)).state, 'completed');
  assert.ok(outcomes.includes('delivered'));
});

test("a command step carries its PUBLISHER's authority: publishing or activating it needs the command's permission", async () => {
  const store = sqliteWorkflowStore();
  const service = new BmsService({ store });
  const as = (rules: Rule[]) => ({
    userId: 'admin-1',
    channelId: CH,
    policy: compile({ subjectId: 'admin-1', permVersion: 1, rules, roles: [], groups: [] }),
  });
  const admin = { id: 'a', permissions: ['workflow:admin'] };
  const definition = {
    name: 'Transcode',
    vars: [{ name: 'assetId', type: 'string' as const }],
    steps: [
      { id: 's_start', kind: 'start' as const },
      {
        id: 's_tx',
        kind: 'command' as const,
        config: {
          action: 'transcode',
          request: {
            event: 'transcode.job.create',
            input: {
              assetId: '= vars.assetId',
              presetIds: '= ["proxy"]',
              'inputFile.kind': '= "original"',
            },
          },
        },
      },
      { id: 's_end', kind: 'end' as const },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: 's_tx' },
      { id: 't2', from: 's_tx', to: 's_end' },
    ],
  };

  // workflow:admin alone: MTS would rewrite renditions with authority this person does not have.
  const w = await service.create(as([admin]), definition);
  await assert.rejects(service.publish(as([admin]), w.id, 1), (err: Error) => {
    assert.equal((err as { status?: number }).status, 403);
    assert.match(err.message, /s_tx.*asset:write on files/);
    return true;
  });
  // A grant narrowed to a category does not vouch: an instance may run on any asset.
  const narrowed = { id: 'n', permissions: ['asset:write'], scope: { categoryPaths: ['/news/'] } };
  await assert.rejects(service.publish(as([admin, narrowed]), w.id, 1), /asset:write/);

  const vouching = as([admin, { id: 'w', permissions: ['asset:write'] }]);
  const published = await service.publish(vouching, w.id, 1);
  assert.equal(published.state, 'active');

  // Activating makes it runnable again: the activator vouches too.
  const off = await service.deactivate(vouching, w.id, published.revision);
  await assert.rejects(service.activate(as([admin]), w.id, off.revision), /asset:write/);
  assert.equal((await service.activate(vouching, w.id, off.revision)).state, 'active');
});

// --- EP-25.8 / 22.5: a human step waits on ITS task, completed in Notifications ----------------------

test('a human step waits on its task; the task completed in Notifications completes it — outcome mapped', async () => {
  const h = await harness();
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers: h.headers,
    payload: {
      name: 'Review',
      vars: [{ name: 'verdict', type: 'string' }],
      steps: [
        { id: 's_start', kind: 'start' },
        {
          id: 's_review',
          kind: 'human-task',
          config: {
            taskType: 'approve',
            assignee: { role: 'editor' },
            output: { 'vars.verdict': '= incoming.outcome' },
          },
        },
        { id: 's_end', kind: 'end' },
      ],
      transitions: [
        { id: 't1', from: 's_start', to: 's_review' },
        { id: 't2', from: 's_review', to: 's_end' },
      ],
    },
  });
  const { id: workflowId } = created.json<{ id: string }>();
  const published = await h.app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${workflowId}/publish?revision=1`,
    headers: h.headers,
  });
  assert.equal(published.statusCode, 200, published.body);
  const started = await h.app.inject({
    method: 'POST',
    url: '/api/v1/instances',
    headers: h.headers,
    payload: { workflowId },
  });
  const id = started.json<{ id: string }>().id;

  // The task BMS asked for, as Notifications will see it.
  const deadline = Date.now() + 2000;
  let task: Envelope | undefined;
  for (;;) {
    await h.commands(); // drains the outbox onto the bus
    task = h.broker.published
      .map((m) => m.body as Envelope)
      .find((e) => e.type === 'workflow.task.created');
    if (task) break;
    if (Date.now() > deadline) throw new Error('no task');
    await new Promise((r) => setTimeout(r, 5));
  }
  const p = task.payload as { taskId: string; assignee: string; assigneeKind: string };
  assert.deepEqual([p.assigneeKind, p.assignee], ['role', 'editor']);

  const update = (state: string, extra: Record<string, unknown> = {}, channelId = CH): Message => {
    const e = buildEnvelope({
      type: 'task.updated',
      channelId,
      payload: { id: p.taskId, state, by: 'ana', at: new Date().toISOString(), ...extra },
      actor: { kind: 'user', id: 'ana' },
    });
    return { id: e.messageId, subject: subjectFor(channelId, 'task.updated'), body: e };
  };
  // A claim is not a completion; another channel's update is not ours.
  assert.equal(await h.router.routeTask(update('forwarded', { forwardedTo: 'ana' })), 'ignored');
  assert.equal(await h.router.routeTask(update('done', {}, 'ch99')), 'ignored');
  assert.equal((await h.store.instance(id))?.state, 'waiting');

  const done = update('done', { outcome: 'approved' });
  assert.equal(await h.router.routeTask(done), 'delivered');
  const result = await h.runner.settled(id);
  assert.equal(result.state, 'completed');
  assert.equal(result.vars['verdict'], 'approved', 'the outcome reached the output mapping');
  assert.equal(await h.router.routeTask(done), 'duplicate');
  // A task assigned by hand — no await in BMS — is nobody's here.
  const stranger = buildEnvelope({
    type: 'task.updated',
    channelId: CH,
    payload: { id: ulid(), state: 'done', at: new Date().toISOString() },
    actor: { kind: 'user', id: 'ana' },
  });
  assert.equal(
    await h.router.routeTask({ id: stranger.messageId, subject: 's', body: stranger }),
    'ignored',
  );
});
