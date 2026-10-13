// A workflow's lifecycle and its catalog (EP-22.11, decided 2026-10-13), from the wire: draft →
// active (a first publish) ⇄ inactive → archived; only an active workflow starts or is in the
// catalog; deactivating and archiving are refused while an instance runs; every change to the
// catalog is a `workflow.changed`.

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
} from '../src/index.ts';
import { withState, type Workflow } from '../src/workflow.ts';
import { policyOf } from './helpers.ts';

async function harness() {
  const store = sqliteWorkflowStore();
  const runner = inProcessRunner(new BmsRuntime({ store }));
  const app = await buildBmsApp({
    service: new BmsService({ store, runner }),
    // `viewer` holds no workflow permission at all; everyone else may author and run.
    policyFor: (userId) =>
      userId === 'viewer' ? policyOf(['asset:read']) : policyOf(['workflow:admin', 'workflow:act']),
  });
  const as = (user = 'author') => ({
    [INTERNAL_HEADERS.user]: user,
    [INTERNAL_HEADERS.channel]: 'ch12',
    'content-type': 'application/json',
  });
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const changes = async (): Promise<string[]> => {
    await relay.drain();
    return broker.published
      .map((m) => m.body as Envelope)
      .filter((e) => e.type === 'workflow.changed')
      .map(
        (e) =>
          `${(e.payload as { change: string; state: string }).change}:${(e.payload as { state: string }).state}`,
      );
  };
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, user?: string) =>
    app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
  /** A one-wait workflow: a started instance stays running until it is signalled. */
  const graph = {
    name: 'One wait',
    steps: [
      { id: 's_start', kind: 'start' },
      { id: 's_wait', kind: 'wait-event', config: { event: 'x', correlate: '= true' } },
      { id: 's_end', kind: 'end' },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: 's_wait' },
      { id: 't2', from: 's_wait', to: 's_end' },
    ],
  };
  return { app, call, changes, runner, graph };
}

test('draft → active (first publish) → inactive → active → archived, each a workflow.changed', async () => {
  const { app, call, changes, graph } = await harness();
  const w = (await call('POST', '/api/v1/workflows', graph)).json<{ id: string; state: string }>();
  assert.equal(w.state, 'draft');

  const published = await call('POST', `/api/v1/workflows/${w.id}/publish?revision=1`);
  assert.equal(published.json<{ state: string }>().state, 'active', 'a first publish activates');

  const off = await call('POST', `/api/v1/workflows/${w.id}/deactivate?revision=2`);
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json<{ state: string }>().state, 'inactive');

  // A new version of an inactive workflow does not quietly reactivate it.
  await call('PUT', `/api/v1/workflows/${w.id}/draft?revision=3`, { ...graph, name: 'v2' });
  const v2 = await call('POST', `/api/v1/workflows/${w.id}/publish?revision=4`);
  assert.equal(v2.json<{ state: string; version: number }>().state, 'inactive');

  const on = await call('POST', `/api/v1/workflows/${w.id}/activate?revision=5`);
  assert.equal(on.json<{ state: string }>().state, 'active');
  const gone = await call('POST', `/api/v1/workflows/${w.id}/archive?revision=6`);
  assert.equal(gone.json<{ state: string }>().state, 'archived');

  // Archived is final.
  for (const [method, url] of [
    ['POST', `/api/v1/workflows/${w.id}/activate?revision=7`],
    ['PUT', `/api/v1/workflows/${w.id}/draft?revision=7`],
    ['POST', `/api/v1/workflows/${w.id}/archive?revision=7`],
  ] as const) {
    const res = await call(method, url, method === 'PUT' ? graph : undefined);
    assert.equal(res.statusCode, 409, `${method} ${url}: ${res.body}`);
  }

  assert.deepEqual(await changes(), [
    'published:active',
    'deactivated:inactive',
    'published:inactive',
    'activated:active',
    'archived:archived',
  ]);
  await app.close();
});

test('the catalog: every authenticated user, active workflows only, with their definitions, ETag 304', async () => {
  const { app, call, graph } = await harness();
  const active = (await call('POST', '/api/v1/workflows', { ...graph, name: 'Active' })).json<{
    id: string;
  }>();
  await call('POST', `/api/v1/workflows/${active.id}/publish?revision=1`);
  const paused = (await call('POST', '/api/v1/workflows', { ...graph, name: 'Paused' })).json<{
    id: string;
  }>();
  await call('POST', `/api/v1/workflows/${paused.id}/publish?revision=1`);
  await call('POST', `/api/v1/workflows/${paused.id}/deactivate?revision=2`);
  await call('POST', '/api/v1/workflows', { ...graph, name: 'Draft' });

  // A user with no workflow permission at all reads it — and is refused the management list.
  const res = await call('GET', '/api/v1/workflows/catalog', undefined, 'viewer');
  assert.equal(res.statusCode, 200, res.body);
  const catalog = res.json<{
    etag: string;
    items: { id: string; version: number; definition: { steps: unknown[] } }[];
  }>();
  assert.deepEqual(
    catalog.items.map((i) => i.id),
    [active.id],
  );
  assert.equal(catalog.items[0]?.definition.steps.length, 3);
  assert.equal(res.headers['etag'], catalog.etag);
  assert.equal((await call('GET', '/api/v1/workflows', undefined, 'viewer')).statusCode, 403);

  const again = await app.inject({
    method: 'GET',
    url: '/api/v1/workflows/catalog',
    headers: {
      ...{ [INTERNAL_HEADERS.user]: 'viewer', [INTERNAL_HEADERS.channel]: 'ch12' },
      'if-none-match': catalog.etag,
    },
  });
  assert.equal(again.statusCode, 304, 'nothing changed');

  await call('POST', `/api/v1/workflows/${paused.id}/activate?revision=3`);
  const after = await call('GET', '/api/v1/workflows/catalog', undefined, 'viewer');
  assert.notEqual(after.headers['etag'], catalog.etag, 'a change moves the ETag');
  assert.equal(after.json<{ items: unknown[] }>().items.length, 2);
  // Another channel's catalog is its own.
  const elsewhere = await app.inject({
    method: 'GET',
    url: '/api/v1/workflows/catalog',
    headers: { [INTERNAL_HEADERS.user]: 'viewer', [INTERNAL_HEADERS.channel]: 'ch99' },
  });
  assert.deepEqual(elsewhere.json<{ items: unknown[] }>().items, []);
  await app.close();
});

test('only an active workflow starts; deactivate and archive are refused while an instance runs', async () => {
  const { app, call, runner, graph } = await harness();
  const w = (await call('POST', '/api/v1/workflows', graph)).json<{ id: string }>();
  await call('POST', `/api/v1/workflows/${w.id}/publish?revision=1`);
  const started = await call('POST', '/api/v1/instances', { workflowId: w.id });
  assert.equal(started.statusCode, 201, started.body);
  const { id } = started.json<{ id: string }>();

  for (const action of ['deactivate', 'archive']) {
    const refused = await call('POST', `/api/v1/workflows/${w.id}/${action}?revision=2`);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json<{ details: { running: number } }>().details.running, 1);
  }

  // It ends; now the workflow may be deactivated — and then nothing starts from it.
  await new Promise((r) => setTimeout(r, 30));
  await call('POST', `/api/v1/instances/${id}/signal`, { stepId: 's_wait' });
  await runner.settled(id);
  const off = await call('POST', `/api/v1/workflows/${w.id}/deactivate?revision=2`);
  assert.equal(off.statusCode, 200, off.body);
  const refused = await call('POST', '/api/v1/instances', { workflowId: w.id });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json<{ message: string }>().message, /inactive/);
  await app.close();
});

test('a header written before EP-22.11 reads as active if it was ever published, draft if not', () => {
  const base = {
    id: 'X',
    channelId: 'ch12',
    name: 'n',
    revision: 1,
    createdBy: 'u',
    createdAt: '',
    updatedAt: '',
  };
  const old = (latestVersion: number) => ({ ...base, latestVersion }) as unknown as Workflow;
  assert.equal(withState(old(3)).state, 'active');
  assert.equal(withState(old(0)).state, 'draft');
  assert.equal(withState({ ...old(3), state: 'inactive' }).state, 'inactive');
});
