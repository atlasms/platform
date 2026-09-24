// The shape every Atlas service shares, asserted. These tests come with the scaffold and stay:
// they are what "compliant" means, and a service that breaks one has drifted from the other four.
// The scaffold's example route is gone; the cases that used it now drive `GET /api/v1/jobs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUlid, ulid } from '@atlas/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '@atlas/policy';
import { HealthRegistry, type AccessRecord } from '@atlas/service-kit';
import {
  buildMtsApp,
  fakeTranscoder,
  INTERNAL_HEADERS,
  MtsService,
  sqliteJobStore,
} from '../src/index.ts';

async function harness(health = new HealthRegistry()) {
  const logs: AccessRecord[] = [];
  const errors: { correlationId: string; url: string }[] = [];
  const service = new MtsService({
    store: sqliteJobStore(),
    transcoder: fakeTranscoder(),
    workRoot: mkdtempSync(join(tmpdir(), 'mts-app-')),
  });
  const app = await buildMtsApp({
    service,
    policyFor: (userId) =>
      compile({
        subjectId: userId,
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['asset:read', 'asset:write'] }],
      }),
    health,
    onAccessLog: (r) => logs.push(r),
    onError: (_err, ctx) => errors.push(ctx),
  });
  return { app, logs, errors };
}

test('an EMPTY body with a JSON content type is not an error', async () => {
  // Fastify's default parser refuses it, which turned every body-less request a client sent with
  // `content-type: application/json` into a 500. The scaffold's parser treats it as no body.
  const { app } = await harness();
  const res = await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('health routes need no caller, and readiness reflects a critical failure', async () => {
  const health = new HealthRegistry().register('iam', () => false, { critical: true });
  const { app } = await harness(health);

  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  const ready = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 503, 'a critical dependency down must fail readiness');
  assert.equal(ready.json().status, 'not_ready');
  await app.close();
});

test('/metrics is scrapeable and carries the golden signals for this service', async () => {
  const { app } = await harness();
  await app.inject({ method: 'GET', url: '/healthz' });
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /atlas_http_requests_total\{[^}]*service="mts"/);
  await app.close();
});

test('a correlation id is a ULID, adopted only when the caller sent a well-formed one', async () => {
  // Behind the gateway the id is not echoed (the gateway does that); it is observable in the
  // access record every non-2xx produces, which is where a forged one would have landed.
  const { app, logs } = await harness();
  const url = '/api/v1/jobs'; // 401 without a caller, so it is always logged

  const mine = ulid();
  await app.inject({ method: 'GET', url, headers: { [INTERNAL_HEADERS.correlation]: mine } });
  assert.equal(logs[0]?.requestId, mine, 'a well-formed id is adopted');

  const forged = 'not-a-ulid-' + 'x'.repeat(100);
  await app.inject({ method: 'GET', url, headers: { [INTERNAL_HEADERS.correlation]: forged } });
  assert.ok(isUlid(logs[1]?.requestId ?? ''), 'a malformed id is replaced with a minted ULID');
  assert.notEqual(logs[1]?.requestId, forged);
  await app.close();
});

test('an unauthenticated call is the platform problem document, and is access-logged', async () => {
  const { app, logs } = await harness();
  const res = await app.inject({ method: 'GET', url: '/api/v1/jobs' });

  assert.equal(res.statusCode, 401);
  const problem = res.json<{
    code: string;
    status: number;
    message: string;
    correlationId: string;
  }>();
  assert.equal(problem.code, 'UNAUTHORIZED');
  assert.equal(problem.status, 401);
  assert.ok(isUlid(problem.correlationId), 'every problem carries the request id');

  // Non-2xx is always logged (the default policy), with the route TEMPLATE and the same id.
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.status, 401);
  assert.equal(logs[0]?.requestId, problem.correlationId);
  assert.equal(logs[0]?.route, '/api/v1/jobs');
  await app.close();
});

test('the caller is whoever the gateway says, and nothing else', async () => {
  const { app, logs } = await harness();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/jobs',
    headers: { [INTERNAL_HEADERS.user]: 'user-1', [INTERNAL_HEADERS.channel]: 'ch12' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [], 'a channel with no jobs yet');
  // A fast 200 is NOT logged by default — the golden signals already describe it (#245).
  assert.equal(logs.length, 0);
  await app.close();
});

test('a 5xx is logged where it is raised, with the correlation id, and stays opaque to the caller', async () => {
  const { app, errors } = await harness();
  app.get('/boom', async () => {
    throw new Error('the database said something unrepeatable');
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(res.statusCode, 500);
  // RFC 9457 (EP-04.6): the problem media type, the RFC members, and the platform keys kept.
  assert.match(res.headers['content-type'] as string, /^application\/problem\+json/);
  const problem = res.json<{
    type: string;
    title: string;
    detail: string;
    code: string;
    message: string;
    correlationId: string;
  }>();
  assert.equal(problem.type, 'https://atlas.example/problems/internal');
  assert.equal(problem.title, 'Internal error');
  assert.equal(problem.code, 'INTERNAL');
  assert.equal(problem.message, 'Internal error', 'the caller never sees the internals');
  assert.equal(problem.detail, problem.message);
  assert.equal(errors.length, 1, 'but the operator does');
  assert.equal(errors[0]?.correlationId, problem.correlationId);
  await app.close();
});
