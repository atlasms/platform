// The authoring API from the wire (bms.yaml): every route, its authorization, publish's gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '@atlas/contracts';
import { BmsService, buildBmsApp, INTERNAL_HEADERS, sqliteWorkflowStore } from '../src/index.ts';
import { presetInput } from '../src/store-conformance.ts';
import { policyOf } from './helpers.ts';

// asset:write: the canonical preset transcodes, and its publisher vouches for that (decided 2026-10-16).
async function harness(permissions = ['workflow:admin', 'asset:write']) {
  const app = await buildBmsApp({
    service: new BmsService({ store: sqliteWorkflowStore() }),
    policyFor: (userId) => (userId === 'nobody' ? undefined : policyOf(permissions)),
  });
  const as = (user = 'user-1', channel = 'ch12') => ({
    [INTERNAL_HEADERS.user]: user,
    [INTERNAL_HEADERS.channel]: channel,
    'content-type': 'application/json',
  });
  return { app, as };
}

const canonical = presetInput('canonical-ingest-to-air.workflow.json');

test('create → read → publish → read the version, over HTTP', async () => {
  const { app, as } = await harness();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers: as(),
    payload: canonical,
  });
  assert.equal(created.statusCode, 201);
  const w = created.json<{ id: string; revision: number; draftVersion: number }>();
  assert.equal(w.draftVersion, 1);

  const got = await app.inject({ method: 'GET', url: `/api/v1/workflows/${w.id}`, headers: as() });
  assert.equal(got.statusCode, 200);
  assert.equal(
    got.json<{ draft: { steps: unknown[] } }>().draft.steps.length,
    canonical.steps.length,
  );

  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${w.id}/publish?revision=1`,
    headers: as(),
  });
  assert.equal(published.statusCode, 200, published.body);
  assert.deepEqual(
    (({ version, revision }) => ({ version, revision }))(
      published.json<{ version: number; revision: number }>(),
    ),
    { version: 1, revision: 2 },
  );

  const v1 = await app.inject({
    method: 'GET',
    url: `/api/v1/workflows/${w.id}/versions/1`,
    headers: as(),
  });
  assert.equal(v1.json<{ status: string }>().status, 'published');

  const list = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: as() });
  assert.deepEqual(
    list.json<{ items: { id: string }[] }>().items.map((x) => x.id),
    [w.id],
  );
  await app.close();
});

test('an invalid draft SAVES, and publish refuses it with the issues — the draft stays a draft', async () => {
  const { app, as } = await harness();
  const w = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers: as(),
      payload: canonical,
    })
  ).json<{ id: string }>();
  const broken = {
    ...canonical,
    transitions: canonical.transitions.map((t) =>
      t.id === 't_ok' ? { ...t, when: '= for x in vars.xs return x' } : t,
    ),
  };
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/v1/workflows/${w.id}/draft?revision=1`,
    headers: as(),
    payload: broken,
  });
  assert.equal(saved.statusCode, 200, 'a draft is work in progress');

  const live = await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${w.id}/validate`,
    headers: as(),
  });
  const result = live.json<{ valid: boolean; issues: { code: string; transitionId?: string }[] }>();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.code === 'FEEL_SUBSET' && i.transitionId === 't_ok'));

  const refused = await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${w.id}/publish?revision=2`,
    headers: as(),
  });
  assert.equal(refused.statusCode, 422);
  const problem = refused.json<{ code: string; details: { issues: { code: string }[] } }>();
  assert.equal(problem.code, 'VALIDATION');
  assert.ok(problem.details.issues.some((i) => i.code === 'FEEL_SUBSET'));
  const after = (
    await app.inject({ method: 'GET', url: `/api/v1/workflows/${w.id}`, headers: as() })
  ).json<{ latestVersion: number; draftVersion: number }>();
  assert.deepEqual([after.latestVersion, after.draftVersion], [0, 1]);
  await app.close();
});

test('validate with a body judges that graph and saves nothing', async () => {
  const { app, as } = await harness();
  const w = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers: as(),
      payload: canonical,
    })
  ).json<{ id: string; revision: number }>();
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${w.id}/validate`,
    headers: as(),
    payload: { ...canonical, steps: canonical.steps.filter((s) => s.kind !== 'end') },
  });
  assert.equal(res.json<{ valid: boolean }>().valid, false);
  const after = (
    await app.inject({ method: 'GET', url: `/api/v1/workflows/${w.id}`, headers: as() })
  ).json<{ revision: number }>();
  assert.equal(after.revision, w.revision);
  await app.close();
});

test('a sub-flow must name a PUBLISHED workflow of this channel', async () => {
  const { app, as } = await harness();
  const child = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers: as(),
      payload: presetInput('simple-approval.workflow.json'),
    })
  ).json<{ id: string }>();
  const parent = {
    name: 'Parent',
    steps: [
      { id: 's_start', kind: 'start' },
      { id: 's_child', kind: 'sub-flow', config: { workflowId: child.id } },
      { id: 's_end', kind: 'end' },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: 's_child' },
      { id: 't2', from: 's_child', to: 's_end' },
    ],
  };
  const p = (
    await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: as(), payload: parent })
  ).json<{ id: string }>();
  const codes = async () =>
    (await app.inject({ method: 'POST', url: `/api/v1/workflows/${p.id}/validate`, headers: as() }))
      .json<{ issues: { code: string }[] }>()
      .issues.map((i) => i.code);
  assert.ok((await codes()).includes('SUBFLOW_UNPUBLISHED'));
  await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${child.id}/publish?revision=1`,
    headers: as(),
  });
  assert.ok(!(await codes()).some((c) => c.startsWith('SUBFLOW')));

  const ghost = {
    ...parent,
    steps: parent.steps.map((s) =>
      s.id === 's_child' ? { ...s, config: { workflowId: ulid() } } : s,
    ),
  };
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/workflows/${p.id}/validate`,
    headers: as(),
    payload: ghost,
  });
  assert.ok(
    res.json<{ issues: { code: string }[] }>().issues.some((i) => i.code === 'SUBFLOW_UNKNOWN'),
  );
  await app.close();
});

test('authorization: read takes workflow:read or :admin, every write takes :admin', async () => {
  const reader = await harness(['workflow:read']);
  const list = await reader.app.inject({
    method: 'GET',
    url: '/api/v1/workflows',
    headers: reader.as(),
  });
  assert.equal(list.statusCode, 200);
  const write = await reader.app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers: reader.as(),
    payload: canonical,
  });
  assert.equal(write.statusCode, 403);
  await reader.app.close();

  const actor = await harness(['workflow:act']);
  const refused = await actor.app.inject({
    method: 'GET',
    url: '/api/v1/workflows',
    headers: actor.as(),
  });
  assert.equal(refused.statusCode, 403, 'acting in a workflow is not reading definitions');
  await actor.app.close();

  const { app, as } = await harness();
  const noPolicy = await app.inject({
    method: 'GET',
    url: '/api/v1/workflows',
    headers: as('nobody'),
  });
  assert.equal(noPolicy.statusCode, 401, 'no policy is never an empty one');
  await app.close();
});

test('the wire refuses what cannot be a graph, and a write without ?revision=', async () => {
  const { app, as } = await harness();
  const bad = await app.inject({
    method: 'POST',
    url: '/api/v1/workflows',
    headers: as(),
    payload: { name: 'x', steps: 'nope', transitions: [] },
  });
  assert.equal(bad.statusCode, 422);
  const w = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers: as(),
      payload: canonical,
    })
  ).json<{ id: string }>();
  const noRevision = await app.inject({
    method: 'PUT',
    url: `/api/v1/workflows/${w.id}/draft`,
    headers: as(),
    payload: canonical,
  });
  assert.equal(noRevision.statusCode, 422);
  const stale = await app.inject({
    method: 'PUT',
    url: `/api/v1/workflows/${w.id}/draft?revision=7`,
    headers: as(),
    payload: canonical,
  });
  assert.equal(stale.statusCode, 409);
  await app.close();
});

test('the palette (EP-23.1): every step kind with a self-contained config schema, for whoever authors workflows', async () => {
  const { app, as } = await harness();
  const res = await app.inject({ method: 'GET', url: '/api/v1/workflows/palette', headers: as() });
  assert.equal(res.statusCode, 200, res.body);
  const entries = res.json<{ kind: string; configSchema: object; choices?: object }[]>();
  assert.equal(entries.length, 9);
  assert.ok(!res.body.includes('$ref'));
  assert.ok(entries.find((e) => e.kind === 'command')?.choices, 'the commands a step may issue');
  // A reader does not author: the palette is the designer's.
  const reader = await harness(['workflow:read']);
  const refused = await reader.app.inject({
    method: 'GET',
    url: '/api/v1/workflows/palette',
    headers: reader.as(),
  });
  assert.equal(refused.statusCode, 403);
});
