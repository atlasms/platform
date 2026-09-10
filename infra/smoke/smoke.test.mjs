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

// A SECOND origin, because the socket does not go through the gateway: the gateway proxies with
// `fetch`, which cannot perform a protocol upgrade, so `/ws` is routed straight to the service.
// Production puts both behind one ingress and the browser sees one origin; kind has no ingress
// controller, hence the second NodePort.
const WS_BASE = process.env.ATLAS_WS_URL ?? 'ws://localhost:30081';

/** Poll until `condition` holds or the deadline passes. Returns whether it held. */
async function waitFor(condition, timeoutMs = TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

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

/**
 * Log in as the dev seed account and return a bearer token, or `undefined` where no such account
 * exists — a real environment has none by design, so those tests skip rather than fail.
 */
async function seedToken() {
  const login = await get('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ATLAS_SMOKE_USER ?? 'dev',
      password: process.env.ATLAS_SMOKE_PASSWORD ?? 'dev-password',
    }),
  });
  if (login.status === 401) return undefined;
  assert.equal(login.status, 200, `login failed: ${login.text}`);
  return json(login).accessToken;
}

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

// =============================================================================
// MAM — a domain service behind the gateway
// =============================================================================

test('smoke: MAM is routed, and refuses an unauthenticated caller', async () => {
  // 401 and not 404 is the assertion: 404 would mean the gateway has no route for /api/v1/assets,
  // which is indistinguishable from a working deployment if you only check that it isn't 200.
  const res = await get('/api/v1/assets');
  assert.equal(res.status, 401, `expected 401 from a routed but protected path: ${res.text}`);
  assert.equal(json(res).code, 'UNAUTHORIZED');
});

test('smoke: the full write path — gateway → MAM → Postgres → outbox', async () => {
  // This is the assertion that a domain service actually WORKS in the cluster: the token is
  // verified at the gateway, identity is forwarded as internal headers, MAM fetches the caller's
  // compiled policy from IAM, authorizes against it, and commits to a real database. Every one of
  // those hops is a separate pod.
  const token = await seedToken();
  if (!token) {
    console.log('    (no seed account in this environment — skipping the MAM path)');
    return;
  }
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const created = await get('/api/v1/assets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Smoke clip',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: 'cat-1',
    }),
  });
  assert.equal(created.status, 201, `create failed: ${created.text}`);

  const asset = json(created);
  assert.ok(asset.id, 'the created asset must have an id');
  assert.equal(asset.state, 'created');
  assert.ok(asset.channelId, 'the asset must be scoped to a channel');

  // Read it back in a SEPARATE request. Anything less would also pass against a service that
  // echoed the request body without persisting it.
  const fetched = await get(`/api/v1/assets/${asset.id}`, { headers: auth });
  assert.equal(fetched.status, 200, `read-back failed: ${fetched.text}`);
  assert.equal(json(fetched).title, 'Smoke clip');

  // The mandatory gate, enforced by the deployment and not just by a unit test: an asset with no
  // renditions cannot be marked ready, whatever its metadata says.
  await get(`/api/v1/assets/${asset.id}/process`, { method: 'POST', headers: auth });
  const ready = await get(`/api/v1/assets/${asset.id}/ready`, { method: 'POST', headers: auth });
  assert.equal(ready.status, 409, `expected the mandatory gate to refuse: ${ready.text}`);
  assert.match(json(ready).message, /rendition/i);
});

test('smoke: SECURITY — state cannot be set over the wire in a real deployment', async () => {
  // The type that omits `state` is erased at runtime; only the service's allowlist holds this
  // line, and it is worth asserting where the JSON actually crosses a network.
  const token = await seedToken();
  if (!token) return;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const created = await get('/api/v1/assets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'Tamper', mediaType: 'video', fileType: 'mxf' }),
  });
  assert.equal(created.status, 201, created.text);
  const { id, channelId } = json(created);

  const patched = await get(`/api/v1/assets/${id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ title: 'Renamed', state: 'approved', channelId: 'ch99', version: 999 }),
  });
  assert.equal(patched.status, 200, patched.text);

  const after = json(patched);
  assert.equal(after.title, 'Renamed');
  assert.equal(after.state, 'created', 'state was settable over the wire');
  assert.equal(after.channelId, channelId, 'channel was settable over the wire');
  assert.equal(after.version, 2, 'version must be the service’s, not the caller’s');
});

test('smoke: an unknown asset is a problem document, not a stack trace', async () => {
  const token = await seedToken();
  if (!token) return;

  const res = await get('/api/v1/assets/01H000000000000000000000', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
  assert.equal(json(res).code, 'NOT_FOUND');
  assert.doesNotMatch(res.text, /\s+at\s+.*\(/, 'a stack trace must never reach a client');
});

test('smoke: a correlation id survives the gateway → MAM hop', async () => {
  // One id across two pods is what makes a distributed trace readable. The service that answers is
  // not the one the client called, so this only holds if the header is forwarded and adopted.
  const token = await seedToken();
  if (!token) return;

  const res = await get('/api/v1/assets/01H000000000000000000000', {
    headers: { authorization: `Bearer ${token}`, 'x-correlation-id': 'smoke-mam-trace' },
  });
  assert.equal(json(res).correlationId, 'smoke-mam-trace');
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

test('smoke: EP-13.2 — a write becomes a live update on a real socket', async () => {
  // THE walking-skeleton assertion, and the one no unit test can make: a POST through the gateway
  // commits in MAM's transaction, lands in its outbox, is relayed to JetStream, is consumed by the
  // WebSocket service's bridge in a different pod, is permission-filtered per connection, and
  // arrives as a frame on a socket this test is holding open. Six processes.
  //
  // The socket does NOT go through the gateway — `fetch` cannot perform a protocol upgrade, so
  // `/ws` is routed straight to the service (an ingress path rule in production, the NodePort in
  // kind). That is why this reads a second base URL.
  const token = await seedToken();
  if (!token) {
    console.log('    (no seed account in this environment — skipping the live-update path)');
    return;
  }

  // The channel from the token's own claims, which is what a client does — the subscription has to
  // exist BEFORE the write, so there is nothing to read it off an asset from yet.
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.ok(claims.channelId, 'the access token must carry a channel');

  const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));

  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`no socket at ${WS_BASE}/ws`)), {
        once: true,
      });
      setTimeout(() => reject(new Error('socket did not open')), TIMEOUT).unref?.();
    });

    const pattern = `atlas.${claims.channelId}.asset.>`;
    socket.send(JSON.stringify({ type: 'subscribe', pattern }));
    await waitFor(() => frames.some((f) => f.type === 'subscribed' && f.subject === pattern));
    assert.ok(
      frames.some((f) => f.type === 'subscribed'),
      `subscribe was not confirmed: ${JSON.stringify(frames)}`,
    );

    const created = await get('/api/v1/assets', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Smoke live-update clip',
        mediaType: 'video',
        fileType: 'mxf',
        categoryId: 'cat-1',
      }),
    });
    assert.equal(created.status, 201, `create failed: ${created.text}`);
    const assetId = json(created).id;

    // Generous, and deliberately so: the relay polls on an interval (1s by default) and JetStream
    // delivery is asynchronous. A tight bound here would make this the flakiest test in the suite
    // for no extra assurance — it either arrives or the path is broken.
    const arrived = await waitFor(
      () =>
        frames.some(
          (f) => f.type === 'event' && f.subject.startsWith(`atlas.${claims.channelId}.asset.`),
        ),
      30_000,
    );
    assert.ok(
      arrived,
      `no event frame arrived within 30s for asset ${assetId}: ${JSON.stringify(frames)}`,
    );
  } finally {
    socket.close();
  }
});
