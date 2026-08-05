// EP-13.4 — the smoke suite, run against a DEPLOYED environment.
//
//   kubectl apply -k infra/k8s/overlays/dev
//   npm run smoke                                  # defaults to the kind NodePort
//   ATLAS_BASE_URL=https://atlas.example npm run smoke
//
// Deliberately outside the workspace and outside `nx`, so no CI job can pick it up by accident:
// every other test in this repository runs with no infrastructure at all, and that property is
// worth protecting. This one asserts the opposite — that a real deployment answers.
//
// Plain .mjs, no TypeScript and no @atlas/* imports: a smoke test that shares code with the thing
// it is testing can pass because both sides are wrong in the same way. It talks HTTP and nothing
// else, exactly like a real client.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.ATLAS_BASE_URL ?? 'http://localhost:30080';
const TIMEOUT = Number(process.env.ATLAS_SMOKE_TIMEOUT_MS ?? 10_000);

async function get(path, init = {}) {
  const response = await fetch(new URL(path, BASE), {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

const json = (result) => {
  try {
    return JSON.parse(result.text);
  } catch {
    assert.fail(`expected JSON, got: ${result.text.slice(0, 200)}`);
  }
};

test(`smoke: ${BASE} is reachable and live`, async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200, `gateway not live: ${res.text}`);
  assert.equal(json(res).status, 'ok');
});

test('smoke: the gateway is READY, meaning its dependencies answer', async () => {
  // Liveness only proves the process is up. Readiness is the one that proves the deployment is
  // wired together — for the gateway that means it can reach IAM, without which no token can be
  // verified and the whole surface is useless.
  const res = await get('/readyz');
  assert.equal(res.status, 200, `gateway not ready: ${res.text}`);

  const body = json(res);
  assert.equal(body.status, 'ready');
  const iam = body.checks?.find((c) => c.name === 'iam');
  assert.ok(iam, `no IAM check in readiness report: ${res.text}`);
  assert.equal(iam.ok, true, 'the gateway cannot reach IAM');
});

test('smoke: a request through the gateway reaches IAM in another pod', async () => {
  // Deliberately wrong credentials: this asserts the PATH works, not that a password does. A 401
  // from IAM's own error taxonomy proves the request crossed the service boundary — a routing or
  // DNS failure would surface as 404 or 502 instead.
  const res = await get('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-test', password: 'deliberately-wrong' }),
  });

  assert.equal(res.status, 401, `expected IAM to answer with 401, got ${res.status}: ${res.text}`);
  const body = json(res);
  assert.equal(body.code, 'UNAUTHORIZED');
  assert.ok(body.correlationId, 'IAM must return a correlation id');
});

test('smoke: a real token is minted and then VERIFIED against IAM’s remote JWKS', async () => {
  // The most valuable assertion in this file. It is the only one that exercises the gateway
  // fetching IAM's JWKS and verifying a signature — a path that stayed silently broken through a
  // healthy-looking deployment, because health checks and public routes never touch it.
  //
  // Requires the dev seed account; skipped rather than failed elsewhere, since a real environment
  // has no such user by design.
  const login = await get('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ATLAS_SMOKE_USER ?? 'dev',
      password: process.env.ATLAS_SMOKE_PASSWORD ?? 'dev-password',
    }),
  });

  if (login.status === 401) {
    console.log('    (no seed account in this environment — skipping the authenticated path)');
    return;
  }
  assert.equal(login.status, 200, `login failed: ${login.text}`);

  const token = json(login).accessToken;
  assert.ok(token, 'no accessToken in the login response');

  const authed = await get('/api/v1/users/me/effective-permissions', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authed.status, 200, `a valid token was refused: ${authed.text}`);
  assert.ok(json(authed).subjectId, 'the effective policy must name its subject');

  // The same route without a token, and with a syntactically broken one, must both be refused —
  // otherwise "it returned 200" proves nothing about verification.
  const anonymous = await get('/api/v1/users/me/effective-permissions');
  assert.equal(anonymous.status, 401, 'a protected route answered without a token');

  const garbage = await get('/api/v1/users/me/effective-permissions', {
    headers: { authorization: 'Bearer not.a.token' },
  });
  assert.equal(garbage.status, 401, 'a malformed token was accepted');
});

test('smoke: every response carries a correlation id', async () => {
  const res = await get('/healthz');
  const id = res.headers.get('x-correlation-id');
  assert.ok(id, 'no x-correlation-id header');

  // An id supplied by the caller must be adopted, not replaced — that is what lets a trace span a
  // client, the gateway and every service behind it.
  const supplied = await get('/healthz', { headers: { 'x-correlation-id': 'smoke-trace-1' } });
  assert.equal(supplied.headers.get('x-correlation-id'), 'smoke-trace-1');
});

test('smoke: an unrouted path is a clean problem document, not a stack trace', async () => {
  const res = await get('/definitely-not-a-route');
  assert.equal(res.status, 404);

  const body = json(res);
  assert.equal(body.code, 'NOT_FOUND');
  assert.ok(body.correlationId, 'even a 404 must be traceable');
  assert.doesNotMatch(res.text, /\s+at\s+.*\(/, 'a stack trace must never reach a client');
});

test('smoke: /metrics is scrapeable and reports golden signals', async () => {
  const res = await get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(res.text, /# TYPE atlas_http_requests_total counter/);
  assert.match(res.text, /atlas_http_requests_total\{service="api-gateway"/);
});

test('smoke: metric labels carry no identifiers', async () => {
  // Cardinality is the thing that kills a metrics store, and a deployed environment is where a
  // route template regression would actually show up.
  await get('/api/v1/assets/01H2XKZQ4E5N6P7R8S9T0V1W2X');
  const res = await get('/metrics');

  assert.doesNotMatch(res.text, /01H2XKZQ/, 'a resource id leaked into a metric label');
});
