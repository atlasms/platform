// Instances from the wire (bms.yaml): start a published version, watch it wait, signal it, see it
// end — run by the in-process runner, the same interpreter and runtime Temporal drives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import type { Envelope } from '@atlas/contracts';
import {
  BmsRuntime,
  BmsService,
  buildBmsApp,
  INTERNAL_HEADERS,
  inProcessRunner,
  sqliteWorkflowStore,
  type InstanceRunner,
} from '../src/index.ts';
import { policyOf } from './helpers.ts';

async function harness(options: { permissions?: string[]; runner?: 'none' | 'broken' } = {}) {
  const store = sqliteWorkflowStore();
  const runtime = new BmsRuntime({ store });
  const inproc = inProcessRunner(runtime);
  const broken: InstanceRunner = {
    start: async () => {
      throw new Error('ECONNREFUSED temporal:7233');
    },
    signal: async () => {
      throw new Error('ECONNREFUSED temporal:7233');
    },
  };
  const service = new BmsService({
    store,
    ...(options.runner === 'none' ? {} : { runner: options.runner === 'broken' ? broken : inproc }),
  });
  const app = await buildBmsApp({
    service,
    policyFor: () => policyOf(options.permissions ?? ['workflow:admin', 'workflow:act']),
  });
  const headers = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: 'ch12',
    'content-type': 'application/json',
  };
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const events = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };
  /** A published workflow: start → wait for an approval → branch → end. */
  const publishApproval = async (): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: {
        name: 'Approval',
        vars: [{ name: 'verdict', type: 'string' }],
        steps: [
          { id: 's_start', kind: 'start' },
          {
            id: 's_wait',
            kind: 'wait-event',
            config: {
              event: 'asset.approved',
              correlate: '= true',
              output: { 'vars.verdict': '= incoming.verdict' },
            },
          },
          { id: 's_gate', kind: 'branch' },
          { id: 's_ok', kind: 'end', config: { status: 'approved' } },
          { id: 's_no', kind: 'end', config: { status: 'rejected' } },
        ],
        transitions: [
          { id: 't1', from: 's_start', to: 's_wait' },
          { id: 't2', from: 's_wait', to: 's_gate' },
          { id: 't3', from: 's_gate', to: 's_ok', when: '= vars.verdict = "approved"' },
          { id: 't4', from: 's_gate', to: 's_no', isDefault: true },
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
  return { app, headers, inproc, events, publishApproval };
}

test('start → wait → signal → end: the mirror follows, every step in the history', async () => {
  const { app, headers, inproc, events, publishApproval } = await harness();
  const workflowId = await publishApproval();
  const started = await app.inject({
    method: 'POST',
    url: '/api/v1/instances',
    headers,
    payload: { workflowId },
  });
  assert.equal(started.statusCode, 201, started.body);
  const { id, version } = started.json<{ id: string; version: number }>();
  assert.equal(version, 1, 'pinned to the published version');

  // It reaches the wait and stays there.
  const deadline = Date.now() + 2000;
  let instance = { state: '', currentSteps: [] as string[] };
  while (Date.now() < deadline) {
    instance = (
      await app.inject({ method: 'GET', url: `/api/v1/instances/${id}`, headers })
    ).json();
    if (instance.state === 'waiting') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(instance.state, 'waiting');
  assert.deepEqual(instance.currentSteps, ['s_wait']);

  const signalled = await app.inject({
    method: 'POST',
    url: `/api/v1/instances/${id}/signal`,
    headers,
    payload: { stepId: 's_wait', payload: { verdict: 'approved' } },
  });
  assert.equal(signalled.statusCode, 202);
  const result = await inproc.settled(id);
  assert.equal(result.endStepId, 's_ok', 'the branch read the signalled payload');

  const done = (await app.inject({ method: 'GET', url: `/api/v1/instances/${id}`, headers })).json<{
    state: string;
    history: { seq: number; stepId: string; event: string }[];
  }>();
  assert.equal(done.state, 'completed');
  assert.deepEqual(
    done.history.map((h) => h.seq),
    done.history.map((_, i) => i + 1),
    'the history is gapless, in order',
  );
  assert.ok(done.history.some((h) => h.stepId === 's_wait' && h.event === 'awaiting'));

  const types = (await events()).map((e) => e.type);
  assert.ok(types.includes('workflow.completed'));
  const audits = (await events()).filter(
    (e) =>
      e.type === 'audit.recorded' &&
      (e.payload as { entityType: string }).entityType === 'workflow-instance',
  );
  assert.deepEqual(
    audits.map((e) => (e.payload as { action: string }).action),
    ['workflow-instance.started', 'workflow-instance.completed'],
  );
  await app.close();
});

test('only a published version starts; a signal to an ended instance is refused', async () => {
  const { app, headers, inproc, publishApproval } = await harness();
  const draftOnly = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers,
    payload: { name: 'Draft', steps: [{ id: 's', kind: 'start' }], transitions: [] },
  });
  const never = await app.inject({
    method: 'POST',
    url: '/api/v1/instances',
    headers,
    payload: { workflowId: draftOnly.json<{ id: string }>().id },
  });
  assert.equal(never.statusCode, 409);

  const workflowId = await publishApproval();
  const { id } = (
    await app.inject({ method: 'POST', url: '/api/v1/instances', headers, payload: { workflowId } })
  ).json<{ id: string }>();
  await new Promise((r) => setTimeout(r, 50));
  await app.inject({
    method: 'POST',
    url: `/api/v1/instances/${id}/signal`,
    headers,
    payload: { stepId: 's_wait', payload: { verdict: 'no' } },
  });
  assert.equal((await inproc.settled(id)).endStepId, 's_no');
  const late = await app.inject({
    method: 'POST',
    url: `/api/v1/instances/${id}/signal`,
    headers,
    payload: { stepId: 's_wait' },
  });
  assert.equal(late.statusCode, 409);
  await app.close();
});

test('the runtime away: 503, and the row says it never ran — never a running row nobody runs', async () => {
  const { app, headers, publishApproval } = await harness({ runner: 'broken' });
  const workflowId = await publishApproval();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/instances',
    headers,
    payload: { workflowId },
  });
  assert.equal(res.statusCode, 503);
  const list = (await app.inject({ method: 'GET', url: '/api/v1/instances', headers })).json<{
    items: { state: string; error?: string }[];
  }>();
  assert.equal(list.items[0]?.state, 'failed');
  assert.match(list.items[0]?.error ?? '', /never started/);
  await app.close();
});

test('authorization: starting and signalling take workflow:act; reading takes any workflow grant', async () => {
  const author = await harness({ permissions: ['workflow:admin'] });
  const workflowId = await author.publishApproval();
  const start = await author.app.inject({
    method: 'POST',
    url: '/api/v1/instances',
    headers: author.headers,
    payload: { workflowId },
  });
  assert.equal(start.statusCode, 403, 'authoring a flow is not running it');
  const list = await author.app.inject({
    method: 'GET',
    url: '/api/v1/instances',
    headers: author.headers,
  });
  assert.equal(list.statusCode, 200);
  await author.app.close();

  const nobody = await harness({ permissions: ['asset:read'] });
  const refused = await nobody.app.inject({
    method: 'GET',
    url: '/api/v1/instances',
    headers: nobody.headers,
  });
  assert.equal(refused.statusCode, 403);
  await nobody.app.close();
});
