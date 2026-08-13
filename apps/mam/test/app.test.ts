import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type EffectivePolicy } from '@atlas/policy';
import { buildMamApp, MamService, sqliteAssetStore } from '../src/index.ts';

const CHANNEL = 'ch12';

function app(permissions = ['asset:read', 'asset:write', 'asset:approve']) {
  const service = new MamService({ store: sqliteAssetStore() });

  const policies = new Map<string, EffectivePolicy>([
    [
      'user-1',
      compile({
        subjectId: 'user-1',
        permVersion: 1,
        rules: [{ id: 'r', permissions, scope: { channelIds: [CHANNEL] } }],
      }),
    ],
  ]);

  return buildMamApp({ service, policyFor: (id) => policies.get(id) });
}

/** The header set the gateway establishes. MAM never sees a JWT. */
const identity = {
  'x-atlas-user': 'user-1',
  'x-atlas-channel': CHANNEL,
  'content-type': 'application/json',
};

test('health and metrics need no identity', async () => {
  const a = app();
  assert.equal((await a.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);

  const metrics = await a.inject({ method: 'GET', url: '/metrics' });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.body, /atlas_http_requests_total/);
});

test('SECURITY: without the gateway’s identity headers, everything is 401', async () => {
  // The service must never invent a default caller — that is how an unauthenticated request ends
  // up executing as somebody.
  const a = app();
  for (const url of ['/api/v1/assets', '/api/v1/assets/whatever']) {
    const res = await a.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, url);
  }
  const post = await a.inject({ method: 'POST', url: '/api/v1/assets', payload: { title: 'x' } });
  assert.equal(post.statusCode, 401);
});

test('create → read → patch over HTTP', async () => {
  const a = app();

  const created = await a.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: identity,
    payload: { title: 'Clip 42', mediaType: 'video', fileType: 'mxf' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const asset = created.json();
  assert.equal(asset.state, 'created');

  const fetched = await a.inject({
    method: 'GET',
    url: `/api/v1/assets/${asset.id}`,
    headers: identity,
  });
  assert.equal(fetched.statusCode, 200);

  const patched = await a.inject({
    method: 'PATCH',
    url: `/api/v1/assets/${asset.id}`,
    headers: identity,
    payload: { title: 'Clip 42 (revised)' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().title, 'Clip 42 (revised)');
});

test('SECURITY: a PATCH cannot set state, even though the wire accepts any JSON', async () => {
  // The TypeScript type omits `state`, but a type is erased at runtime. This is the assertion
  // that actually holds the line.
  const a = app();
  const created = await a.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: identity,
    payload: { title: 'Clip', mediaType: 'video', fileType: 'mxf' },
  });
  const { id } = created.json();

  const patched = await a.inject({
    method: 'PATCH',
    url: `/api/v1/assets/${id}`,
    headers: identity,
    payload: { title: 'Renamed', state: 'approved', channelId: 'ch99', version: 999 },
  });

  assert.equal(patched.statusCode, 200);
  const after = patched.json();
  assert.equal(after.state, 'created', 'state must not be settable over the wire');
  assert.equal(after.channelId, CHANNEL, 'channel must not be settable over the wire');
  assert.equal(after.version, 2, 'version is the service’s, not the caller’s');
});

test('an unknown asset is 404, and a bad transition is 409', async () => {
  const a = app();
  const missing = await a.inject({
    method: 'GET',
    url: '/api/v1/assets/01H000000000000000000000',
    headers: identity,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'NOT_FOUND');

  const created = await a.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: identity,
    payload: { title: 'Clip', mediaType: 'video', fileType: 'mxf' },
  });
  const { id } = created.json();

  const early = await a.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/approve`,
    headers: identity,
  });
  assert.equal(early.statusCode, 409, 'approving a freshly created asset must conflict');
  assert.match(early.json().message, /cannot approve/);
});

test('a rejection without a reason is 422', async () => {
  const a = app();
  const created = await a.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: identity,
    payload: { title: 'Clip', mediaType: 'video', fileType: 'mxf', categoryId: 'cat-1' },
  });
  const { id } = created.json();

  const rejected = await a.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/reject`,
    headers: identity,
    payload: {},
  });
  assert.equal(rejected.statusCode, 422);
  assert.match(rejected.json().message, /must state a reason/);
});

test('every response is traceable', async () => {
  const a = app();
  const res = await a.inject({
    method: 'GET',
    url: '/api/v1/assets/nope',
    headers: { ...identity, 'x-correlation-id': 'trace-me' },
  });
  assert.equal(res.json().correlationId, 'trace-me');
});

// --- EP-04.8: GET /reference, and its ETag ----------------------------------

test('GET /reference returns the snapshot with an ETag', async () => {
  const a = app(['asset:read', 'asset:write', 'taxonomy:read']);
  const res = await a.inject({ method: 'GET', url: '/api/v1/reference', headers: identity });

  assert.equal(res.statusCode, 200);
  assert.match(
    res.headers['etag'] as string,
    /^W\/"cv-\d+"$/,
    'a WEAK tag — the body is assembled',
  );
  assert.ok(typeof res.json<{ configVersion: number }>().configVersion === 'number');
});

test('DANGER: an unchanged snapshot revalidates to 304, and the 304 keeps the ETag', async () => {
  // A 304 without an ETag tells the client its cached entry has no validator, so the next request
  // is unconditional — the revalidation quietly stops working and every poll ships the snapshot.
  const a = app(['asset:read', 'asset:write', 'taxonomy:read']);
  const first = await a.inject({ method: 'GET', url: '/api/v1/reference', headers: identity });
  const etag = first.headers['etag'] as string;

  const second = await a.inject({
    method: 'GET',
    url: '/api/v1/reference',
    headers: { ...identity, 'if-none-match': etag },
  });

  assert.equal(second.statusCode, 304);
  assert.equal(second.body, '', 'the body is the saving');
  assert.equal(second.headers['etag'], etag);
});

test('a changed vocabulary breaks the revalidation, as it must', async () => {
  const a = app(['asset:read', 'asset:write', 'taxonomy:read']);
  const created = await a.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: identity,
    payload: { title: 'Clip', mediaType: 'video', fileType: 'mxf' },
  });
  const id = created.json<{ id: string }>().id;

  const before = await a.inject({ method: 'GET', url: '/api/v1/reference', headers: identity });
  const etag = before.headers['etag'] as string;

  await a.inject({
    method: 'PUT',
    url: `/api/v1/assets/${id}/tags`,
    headers: identity,
    payload: { tags: ['Freshly Minted'] },
  });

  const after = await a.inject({
    method: 'GET',
    url: '/api/v1/reference',
    headers: { ...identity, 'if-none-match': etag },
  });
  assert.equal(after.statusCode, 200, 'a stale validator must NOT produce a 304');
  assert.notEqual(after.headers['etag'], etag);
});

test('SECURITY: /reference needs taxonomy:read', async () => {
  const a = app(['asset:read']);
  const res = await a.inject({ method: 'GET', url: '/api/v1/reference', headers: identity });
  assert.equal(res.statusCode, 403);
});
