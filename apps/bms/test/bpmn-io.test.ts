// BPMN 2.0 in and out over the wire (EP-23.8; bms.yaml importWorkflow/exportWorkflow, DSL §11).

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BmsService, buildBmsApp, INTERNAL_HEADERS, sqliteWorkflowStore } from '../src/index.ts';
import { presetInput } from '../src/store-conformance.ts';
import { policyOf } from './helpers.ts';

const golden = readFileSync(
  new URL(
    '../../../docs/architecture/workflows/fixtures/canonical-ingest-to-air.bpmn',
    import.meta.url,
  ),
  'utf8',
);
const canonical = presetInput('canonical-ingest-to-air.workflow.json');

async function harness() {
  const store = sqliteWorkflowStore();
  const service = new BmsService({ store });
  const policies: Record<string, string[]> = {
    admin: ['workflow:admin', 'asset:write'],
    reader: ['workflow:read'],
  };
  const app = await buildBmsApp({
    service,
    policyFor: (userId) => policyOf(policies[userId] ?? []),
  });
  const as = (user = 'admin', channel = 'ch12', type = 'application/json') => ({
    [INTERNAL_HEADERS.user]: user,
    [INTERNAL_HEADERS.channel]: channel,
    'content-type': type,
  });
  const xml = (user = 'admin', channel = 'ch12') => as(user, channel, 'application/xml');
  const create = async () =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/workflows',
        headers: as(),
        payload: canonical,
      })
    ).json<{ id: string; revision: number }>();
  return { app, as, xml, create };
}

type View = {
  id: string;
  channelId: string;
  name: string;
  state: string;
  draftVersion?: number;
  draft: { steps: { id: string; position?: unknown }[]; transitions: unknown[] };
};
const sorted = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));

test('export a draft, import the file: a NEW workflow with the same graph, layout and all', async () => {
  const { app, as, xml, create } = await harness();
  const w = await create();
  const exported = await app.inject({
    method: 'GET',
    url: `/api/v1/workflows/${w.id}/export`,
    headers: as(),
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(String(exported.headers['content-type']), /^application\/xml/);
  assert.match(exported.body, /<bpmndi:BPMNShape /);
  assert.match(exported.body, new RegExp(`<bpmn:process id="wf_${w.id}"`));

  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows/import',
    headers: xml(),
    payload: exported.body,
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const copy = imported.json<View>();
  assert.notEqual(copy.id, w.id, 'a new workflow — never the file’s id');
  assert.equal(copy.channelId, 'ch12');
  assert.equal(copy.state, 'draft');
  assert.equal(copy.name, canonical.name);
  assert.deepEqual(sorted(copy.draft.steps), sorted(canonical.steps));
  assert.deepEqual(copy.draft.transitions.length, canonical.transitions.length);

  // The imported draft is a draft like any other: publish judges it, and it passes.
  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${copy.id}/publish?revision=1`,
    headers: as(),
  });
  assert.equal(published.statusCode, 200, published.body);
  await app.close();
});

test('a modeler’s file imports — the golden fixture, positions read from its DI', async () => {
  const { app, xml } = await harness();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows/import',
    headers: xml(),
    payload: golden,
  });
  assert.equal(res.statusCode, 201, res.body);
  const view = res.json<View>();
  assert.ok(
    view.draft.steps.every((s) => s.position),
    'every step placed',
  );
  assert.deepEqual(sorted(view.draft.steps), sorted(canonical.steps));
  await app.close();
});

test('export picks the version named, else the open draft, else the latest published', async () => {
  const { app, as, create } = await harness();
  const w = await create();
  await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${w.id}/publish?revision=1`,
    headers: as(),
  });
  const renamed = { ...canonical, name: 'Second draft' };
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/v1/workflows/${w.id}/draft?revision=2`,
    headers: as(),
    payload: renamed,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const get = (q = '') =>
    app.inject({ method: 'GET', url: `/api/v1/workflows/${w.id}/export${q}`, headers: as() });
  assert.match((await get()).body, /name="Second draft"/);
  assert.match((await get('?version=1')).body, new RegExp(`name="${canonical.name}"`));
  assert.equal((await get('?version=9')).statusCode, 404);
  assert.equal((await get('?version=0')).statusCode, 422);
  assert.equal((await get('?format=xpdl')).statusCode, 422);
  await app.close();
});

test('outside the subset is a 422 naming each construct; not BPMN is MALFORMED_XML; JSON is refused', async () => {
  const { app, as, xml } = await harness();
  const file = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="x" id="d">
  <bpmn:process id="p"><bpmn:inclusiveGateway id="ig"/><bpmn:scriptTask id="sc"/></bpmn:process>
</bpmn:definitions>`;
  const refused = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows/import',
    headers: xml(),
    payload: file,
  });
  assert.equal(refused.statusCode, 422);
  assert.match(String(refused.headers['content-type']), /^application\/problem\+json/);
  const problem = refused.json<{
    code: string;
    details: { code: string; unsupported: { elementId: string; elementType: string }[] };
  }>();
  assert.equal(problem.code, 'VALIDATION');
  assert.equal(problem.details.code, 'UNSUPPORTED_BPMN');
  assert.deepEqual(problem.details.unsupported.map((u) => u.elementId).sort(), ['ig', 'sc']);

  const garbage = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows/import',
    headers: { ...xml(), 'content-type': 'text/xml' },
    payload: 'not xml at all',
  });
  assert.equal(garbage.statusCode, 422);
  assert.equal(garbage.json<{ details: { code: string } }>().details.code, 'MALFORMED_XML');

  const json = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows/import',
    headers: as(),
    payload: canonical,
  });
  assert.equal(json.statusCode, 422);

  const list = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: as() });
  assert.deepEqual(list.json<{ items: unknown[] }>().items, [], 'nothing refused was stored');
  await app.close();
});

test('authorization: a reader exports and cannot import; another channel’s workflow is not found', async () => {
  const { app, as, xml, create } = await harness();
  const w = await create();
  const read = await app.inject({
    method: 'GET',
    url: `/api/v1/workflows/${w.id}/export`,
    headers: as('reader'),
  });
  assert.equal(read.statusCode, 200);
  const write = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows/import',
    headers: xml('reader'),
    payload: golden,
  });
  assert.equal(write.statusCode, 403);
  const elsewhere = await app.inject({
    method: 'GET',
    url: `/api/v1/workflows/${w.id}/export`,
    headers: as('admin', 'ch99'),
  });
  assert.equal(elsewhere.statusCode, 404);
  const nobody = await app.inject({
    method: 'GET',
    url: `/api/v1/workflows/${w.id}/export`,
    headers: as('stranger'),
  });
  assert.equal(nobody.statusCode, 403);
  await app.close();
});
