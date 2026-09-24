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
/** How long the FIRST request waits for the origin to start serving at all. See below. */
const REACHABLE_BUDGET = Number(process.env.ATLAS_SMOKE_REACHABLE_BUDGET_MS ?? 30_000);

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

/**
 * `get`, retried while the origin refuses the CONNECTION — the first request of the run only.
 *
 * Deliberately narrow: an HTTP response of any status ends the wait, because a service that
 * answers 503 is a service that is answering and that is the suite's business to judge. Only a
 * transport failure (connection refused, reset, DNS) is retried, and only until the budget runs
 * out, at which point the original error is thrown rather than swallowed into a timeout with no
 * cause. Here rather than in the workflow because `npm run smoke` straight after `npm run k8s:up`
 * has exactly the same race on a laptop.
 */
async function getWhenServing(path, init = {}, budgetMs = REACHABLE_BUDGET) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await get(path, init);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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
  // WAIT FOR THE ORIGIN ITSELF, not just for what it answers.
  //
  // The third test below absorbs the gap between "pod Ready" and "kube-proxy has programmed the
  // endpoint" for each upstream BEHIND the gateway. The same gap exists one hop earlier, between
  // the runner and the gateway's own Service, and nothing was absorbing it: `rollout status`
  // returns when the pod is Ready, and the NodePort starts serving a moment later.
  //
  // Measured on CI: the gateway rolled out at 18:29:54.756, this suite's first request left at
  // 18:29:55.168, and the six tests that run before the upstream gate all died on `fetch failed`
  // / ECONNRESET — 412ms of not-yet-serving, on a commit that changed nothing deployable. A
  // transport error is not an answer, so it is not a verdict either.
  const res = await getWhenServing('/healthz');
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

test('smoke: every PROXIED upstream answers through the gateway before anything depends on it', async () => {
  // "Deployment Available" and "reachable through the Service" are two different moments. The
  // workflow's `kubectl rollout status` returns at the first: the pod is Ready. The gateway's
  // `fetch` needs the second: the endpoints controller has added the pod and kube-proxy has
  // programmed it — a few hundred milliseconds to a couple of seconds later. In between, a request
  // to that Service is refused, and the gateway reports it as `502 upstream "mam" unreachable`.
  //
  // That window is exactly where this suite's first three MAM-bound requests landed on `main`
  // (MAM listening at :10.995, the suite's first request at :11.978), on a commit that changed
  // nothing deployable — three 502s, then every later MAM test green. Pods: 0 restarts.
  //
  // The gateway's own readiness (above) is IAM only, on purpose: MAM being down must not make the
  // gateway refuse traffic it can still serve. So the gate for "MAM is reachable through the
  // gateway" has to be here, and it has to be here rather than only in the workflow because
  // `npm run smoke` after `k8s:up` has the same race on a laptop.
  const token = await seedToken();
  if (!token) return;

  // One probe per proxied upstream. IAM is proven by /readyz and by the login above; the socket
  // service is its own origin and is proven by the EP-13.2 test. Adding a routed service means
  // adding its cheapest authenticated GET here.
  const upstreams = [
    ['mam', '/api/v1/assets?limit=1'],
    ['logging', '/api/v1/history/asset/01H000000000000000000000'],
    ['scheduling', '/api/v1/schedules?limit=1'],
    ['rim', '/api/v1/uploads/01H00000000000000000000000'],
    ['mts', '/api/v1/jobs?limit=1'],
  ];
  const budgetMs = Number(process.env.ATLAS_SMOKE_UPSTREAM_BUDGET_MS ?? 30_000);

  for (const [name, path] of upstreams) {
    const deadline = Date.now() + budgetMs;
    let last;
    for (;;) {
      last = await get(path, { headers: { authorization: `Bearer ${token}` } });
      // The gateway's OWN 404 — no route — is not the upstream answering, and no amount of waiting
      // changes it. Fail now and say what to do: EP-19.1 spent a run discovering that
      // apps/api-gateway/src/routing.ts is a fixture and main.ts is the table.
      if (last.status === 404 && /no route/.test(last.text)) {
        assert.fail(
          `the gateway has no route for ${path} — the production table is apps/api-gateway/src/main.ts, not routing.ts: ${last.text}`,
        );
      }
      if (last.status !== 502) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.notEqual(
      last.status,
      502,
      `upstream "${name}" never became reachable through the gateway within ${budgetMs}ms: ${last.text}`,
    );
  }
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

  // EP-17.7: the second read may be MAM's cache; a read that says `no-cache` is the store's, and
  // the header has to survive the gateway hop for that to be true in a deployment.
  const again = await get(`/api/v1/assets/${asset.id}`, { headers: auth });
  assert.equal(again.status, 200);
  const fresh = await get(`/api/v1/assets/${asset.id}`, {
    headers: { ...auth, 'cache-control': 'no-cache' },
  });
  assert.equal(fresh.status, 200, `no-cache read failed: ${fresh.text}`);
  assert.deepEqual(json(fresh), json(again), 'cached and fresh reads agree on an unchanged asset');

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

  // A ULID, because that is what the gateway adopts (EP-08.6) — a literal, since this file
  // deliberately imports nothing from the code it tests.
  const mine = '01SM0KEMAMTRACE00000000000';
  const res = await get('/api/v1/assets/01H000000000000000000000', {
    headers: { authorization: `Bearer ${token}`, 'x-correlation-id': mine },
  });
  assert.equal(json(res).correlationId, mine);
});

test('smoke: every response carries a correlation id', async () => {
  const res = await get('/healthz');
  const id = res.headers.get('x-correlation-id');
  assert.ok(id, 'no x-correlation-id header');

  // A well-formed id supplied by the caller must be adopted, not replaced — that is what lets a
  // trace span a client, the gateway and every service behind it.
  const mine = '01SM0KETRACE00000000000001';
  const supplied = await get('/healthz', { headers: { 'x-correlation-id': mine } });
  assert.equal(supplied.headers.get('x-correlation-id'), mine);

  // And a MALFORMED one must be replaced, not adopted (EP-08.6): this is the one internal header a
  // client can set, and it lands in every service's log line. Asserted here, against the deployed
  // gateway, because it is an edge property and the edge is what a smoke test is for.
  const forged = await get('/healthz', { headers: { 'x-correlation-id': 'smoke-trace-1' } });
  const issued = forged.headers.get('x-correlation-id');
  assert.ok(issued && issued !== 'smoke-trace-1', `a malformed id was adopted: ${issued}`);
  assert.match(issued, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'the replacement is a ULID');
});

test('smoke: an unrouted path is a clean problem document, not a stack trace', async () => {
  const res = await get('/definitely-not-a-route');
  assert.equal(res.status, 404);

  const body = json(res);
  assert.equal(body.code, 'NOT_FOUND');
  assert.ok(body.correlationId, 'even a 404 must be traceable');
  assert.doesNotMatch(res.text, /\s+at\s+.*\(/, 'a stack trace must never reach a client');

  // RFC 9457 (EP-04.6), on the deployed gateway: the problem media type, and the RFC members
  // derived from the platform's keys so a client may switch on either.
  assert.match(res.headers.get('content-type') ?? '', /^application\/problem\+json/);
  assert.equal(body.type, 'https://atlas.example/problems/not_found');
  assert.equal(body.status, 404);
  assert.equal(body.detail, body.message);
  assert.equal(body.instance, `urn:atlas:correlation:${body.correlationId}`);
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

test('smoke: EP-13.2 — a write becomes a live update on a real socket, and the socket answers a heartbeat', async () => {
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

    // EP-09.4: the client's heartbeat over the deployed server. A `ping` carries no pattern and
    // must be answered with `pong`, not "frame has no pattern" — this is what lets a page notice
    // a server that died with the TCP connection still open, and reconnect.
    socket.send(JSON.stringify({ type: 'ping' }));
    const ponged = await waitFor(() => frames.some((f) => f.type === 'pong'));
    assert.ok(ponged, `no pong for a ping: ${JSON.stringify(frames)}`);
  } finally {
    socket.close();
  }
});

test('smoke: EP-19.1 — a write is in the audit history, with its delta, through the whole spine', async () => {
  // The longest path in the platform, asserted on a live cluster: gateway → MAM → Postgres →
  // outbox → relay → JetStream → the sink → Postgres → gateway → this read. Every hop is async
  // past the outbox, so this polls; the budget is generous because it is the relay's tick plus
  // the sink's consumer, not because any of it should be slow.
  const token = await seedToken();
  if (!token) return;

  const created = await get('/api/v1/assets', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Audited clip',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: 'cat-1',
    }),
  });
  assert.equal(created.status, 201, `create failed: ${created.text}`);
  const asset = json(created);

  const deadline = Date.now() + 20_000;
  let history;
  for (;;) {
    const res = await get(`/api/v1/history/asset/${asset.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, `history read failed: ${res.text}`);
    history = json(res);
    if (history.revisions.length >= 1 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.equal(history.entityId, asset.id);
  assert.ok(history.revisions.length >= 1, 'the creation never reached the audit sink');
  const first = history.revisions[0];
  assert.equal(first.revision, 1);
  assert.equal(first.action, 'asset.created');
  assert.deepEqual(first.delta.title, { after: 'Audited clip' }, 'the delta carries the value');
  assert.ok(first.messageId, 'and links back to the envelope in the log');
});

test('smoke: EP-19.3 — the audit log browse finds a write by its correlation id', async () => {
  // The request view: everything one request caused, read back from the log. The create carries
  // its correlation id on the response; MAM wrote it into both envelopes — the domain event and
  // the audit record — and the browse filters on it. Permission-filtered: the seed user holds
  // asset:read, so both are visible.
  const token = await seedToken();
  if (!token) return;

  const created = await get('/api/v1/assets', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Browsed clip',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: 'cat-1',
    }),
  });
  assert.equal(created.status, 201, `create failed: ${created.text}`);
  const correlationId = created.headers.get('x-correlation-id');
  assert.ok(correlationId, 'the create carries its correlation id');

  // In the cluster this browse is answered by the OpenSearch index (EP-07.4): the sink appends to
  // Postgres, the projector copies the row into the index on its next tick, and only then does
  // the page show it. So this proves the projector end to end, not just the sink. A 503 is the
  // index saying "not yet" — retryable by definition — and is polled through like an empty page;
  // any other failure is a failure.
  const deadline = Date.now() + 20_000;
  let page;
  for (;;) {
    const res = await get(`/api/v1/logs?correlationId=${encodeURIComponent(correlationId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 503) assert.equal(res.status, 200, `browse failed: ${res.text}`);
    page = res.status === 200 ? json(res) : { items: [] };
    if (page.items.length >= 2 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const types = page.items.map((e) => e.type).sort();
  assert.deepEqual(types, ['asset.created', 'audit.recorded'], 'both envelopes the request caused');
  assert.ok(page.items.every((e) => e.correlationId === correlationId));
  assert.ok(
    page.items.every((e) => typeof e.hash === 'string' && e.hash.length === 64),
    'each is a link in the chain',
  );
});

test('smoke: EP-10.6 — a grant reaches the spine: permissions.changed and group.membership.changed are in the log', async () => {
  // IAM emits at last. An admin creates a group, puts the seeded user in it, and the events the
  // grant produced — in the SAME transaction as the membership row — travel outbox → broker → sink
  // and turn up in the audit log under the request's correlation id. This is the half of live
  // revocation that was missing: the consumers were built long before the producer.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const me = await get('/api/v1/users/me/effective-permissions', { headers });
  assert.equal(me.status, 200, `policy failed: ${me.text}`);
  const before = json(me).permVersion;

  // A role of this run's own, in the seeded channel. The starter roles are platform-wide, and
  // the seed account administers ONE channel by design (apps/iam/src/main.ts says why) — so a
  // channel role is what this caller may both carry and inspect.
  const roleId = `smoke-${Date.now().toString(36)}`;
  const role = await get('/api/v1/roles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: roleId, name: 'Smoke', rules: [] }),
  });
  assert.equal(role.status, 201, `role create failed: ${role.text}`);

  const group = await get('/api/v1/groups', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `smoke ${Date.now().toString(36)}`,
      roleIds: ['viewer', roleId],
    }),
  });
  assert.equal(group.status, 201, `group create failed: ${group.text}`);
  const groupId = json(group).id;

  const joined = await get(`/api/v1/groups/${groupId}/members`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userId: json(me).subjectId }),
  });
  assert.equal(joined.status, 204, `add member failed: ${joined.text}`);
  const correlationId = joined.headers.get('x-correlation-id');
  assert.ok(correlationId);

  const after = await get('/api/v1/users/me/effective-permissions', { headers });
  assert.equal(json(after).permVersion, before + 1, 'the membership bumped permVersion');

  const deadline = Date.now() + 20_000;
  let page;
  for (;;) {
    const res = await get(`/api/v1/logs?correlationId=${encodeURIComponent(correlationId)}`, {
      headers,
    });
    if (res.status !== 503) assert.equal(res.status, 200, `browse failed: ${res.text}`);
    page = res.status === 200 ? json(res) : { items: [] };
    if (page.items.length >= 3 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const types = page.items.map((e) => e.type).sort();
  assert.deepEqual(
    types,
    ['audit.recorded', 'group.membership.changed', 'permissions.changed'],
    'the three envelopes one grant produces',
  );
  const changed = page.items.find((e) => e.type === 'permissions.changed');
  assert.equal(changed.payload.permVersion, before + 1);

  // The same grant, read back from the other end: who holds the role now includes this group and,
  // through it, the seeded user. A join across assignments, groups and memberships, answered by
  // the deployment rather than by a unit test's double.
  const holders = await get(`/api/v1/roles/${roleId}/holders`, { headers });
  assert.equal(holders.status, 200, `holders failed: ${holders.text}`);
  const held = json(holders);
  assert.ok(
    held.groups.some((g) => g.id === groupId),
    'the group that carries the role is listed',
  );
  const reached = held.users.find((u) => u.id === json(me).subjectId);
  assert.ok(reached, 'the member the role now reaches is listed');
  assert.ok(
    (reached.viaGroupIds ?? []).includes(groupId),
    'and the row says which group it comes through',
  );

  // A PLATFORM-WIDE role's holders span every channel, so a channel administrator is refused
  // them — 404, the same answer as for a role that does not exist, because "which roles exist
  // elsewhere" is itself a leak. This caller carries `viewer` through the group it just made and
  // still may not see who else does. The seed grant is channel-scoped precisely so that this
  // boundary is testable in a real deployment rather than only against a double.
  const platformWide = await get('/api/v1/roles/viewer/holders', { headers });
  assert.equal(platformWide.status, 404, `expected the tenant boundary: ${platformWide.text}`);

  // Leave the seed user as it was found: the next run bumps from wherever it is, but a group per
  // run would accumulate.
  const left = await get(`/api/v1/groups/${groupId}`, { method: 'DELETE', headers });
  assert.equal(left.status, 204, `group delete failed: ${left.text}`);

  const afterLeaving = await get(`/api/v1/roles/${roleId}/holders`, { headers });
  assert.equal(afterLeaving.status, 200);
  assert.deepEqual(
    json(afterLeaving),
    { users: [], groups: [] },
    'the deleted group takes its holders with it',
  );

  // Which is also the precondition for deleting the role: nothing holds it now, so this is a 204
  // rather than the 409 it would have been a moment ago.
  const removed = await get(`/api/v1/roles/${roleId}`, { method: 'DELETE', headers });
  assert.equal(removed.status, 204, `role delete failed: ${removed.text}`);
});

test('smoke: EP-15.1 — a chunked upload through the gateway: parts out of order, resumed, assembled, hashed, audited', async () => {
  // The upload path on a live cluster: the server sizes the parts, a real 8 MiB part crosses
  // the gateway's per-prefix cap, a part is sent again as a resume would, the assembled file's
  // checksum is the checksum of the bytes this test sent, and the job it became is in the audit
  // history the sink projected. Four services and a volume.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const { createHash, randomBytes } = await import('node:crypto');
  const started = await get('/api/v1/uploads', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename: 'smoke.bin',
      sizeBytes: 1,
      contentType: 'application/octet-stream',
    }),
  });
  assert.equal(started.status, 201, `start failed: ${started.text}`);
  const probe = json(started);
  assert.ok(
    probe.partSizeBytes >= 1024 * 1024,
    `the server's part size is real: ${probe.partSizeBytes}`,
  );
  await get(`/api/v1/uploads/${probe.uploadId}`, { method: 'DELETE', headers });

  // One full part plus a remainder: the second part is the big one, sent first.
  const partSize = probe.partSizeBytes;
  const size = partSize + 12_345;
  const whole = randomBytes(size);
  const sha256 = createHash('sha256').update(whole).digest('hex');
  const upload = json(
    await get('/api/v1/uploads', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'smoke.bin', sizeBytes: size }),
    }),
  );
  assert.equal(upload.partCount, 2);

  const put = (n, bytes) =>
    get(`/api/v1/uploads/${upload.uploadId}/parts/${n}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    });
  const tail = await put(2, whole.subarray(partSize));
  assert.equal(tail.status, 204, `part 2 failed: ${tail.text}`);
  const status = await get(`/api/v1/uploads/${upload.uploadId}`, { headers });
  assert.deepEqual(json(status).received, [2], 'a resume sees what the server holds');
  const head = await put(1, whole.subarray(0, partSize));
  assert.equal(head.status, 204, `part 1 (the full-size one) failed: ${head.text}`);
  assert.equal(
    (await put(1, whole.subarray(0, partSize))).status,
    204,
    'sent again, as a resume would',
  );

  const done = await get(`/api/v1/uploads/${upload.uploadId}/complete`, {
    method: 'POST',
    headers,
  });
  assert.equal(done.status, 202, `complete failed: ${done.text}`);
  const job = json(done);
  assert.equal(job.state, 'detected');
  assert.equal(job.sizeBytes, size);
  assert.equal(job.checksum, sha256, 'the checksum is of the bytes this test sent');
  assert.equal(job.receivedPath, undefined, 'a disk path does not cross the wire');

  // The job's creation is in the audit history, projected from audit.recorded through the spine.
  const deadline = Date.now() + 20_000;
  let history;
  for (;;) {
    const res = await get(`/api/v1/history/ingest/${job.id}`, { headers });
    assert.equal(res.status, 200, `history read failed: ${res.text}`);
    history = json(res);
    if (history.revisions.length >= 1 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(history.revisions.length >= 1, 'the ingest job reached the audit history');
  assert.equal(history.revisions[0].action, 'ingest.detected');
  assert.deepEqual(history.revisions[0].delta.checksum, { after: sha256 });
});

/**
 * A real media file with no tools: `seconds` of 8 kHz mono 16-bit silence in a WAV — 44 bytes of
 * header and the samples. ffprobe reads it (EP-15.4), so an upload of it gets past the probe and
 * into the acceptance rules, where the tests want it.
 */
function silentWav(seconds) {
  const sampleRate = 8000;
  const pcm = Buffer.alloc(sampleRate * 2 * seconds);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

test('smoke: EP-15.3/15.6 — an acceptance rule holds an upload; the queue lists it; an operator releases it; every step audited', async () => {
  // The whole ingest loop on a live cluster: a rule set written through the gateway, an upload
  // that fails it, the verdict committed after the request by the validation that follows,
  // the review queue listing it with the rule's reason, the operator override, and the audit
  // history holding all three revisions. The rule set is removed at the end whatever happens,
  // so the next run — and the EP-15.1 test's upload — starts from no rules.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const created = await get('/api/v1/acceptance-rules', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'smoke: no stubs',
      scope: { sourceKind: 'upload' },
      rules: [
        { kind: 'minSizeBytes', onFail: 'quarantine', bytes: 1024 * 1024, label: 'smoke minimum' },
      ],
    }),
  });
  assert.equal(created.status, 201, `rule set failed: ${created.text}`);
  const ruleSet = json(created);
  try {
    // Real media (the probe reads it, EP-15.4) that is far too small for the rule.
    const stub = silentWav(1);
    const upload = json(
      await get('/api/v1/uploads', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: 'smoke-stub.wav', sizeBytes: stub.length }),
      }),
    );
    const put = await get(`/api/v1/uploads/${upload.uploadId}/parts/1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: stub,
    });
    assert.equal(put.status, 204, `part failed: ${put.text}`);
    const done = await get(`/api/v1/uploads/${upload.uploadId}/complete`, {
      method: 'POST',
      headers,
    });
    assert.equal(done.status, 202, `complete failed: ${done.text}`);
    const job = json(done);
    assert.equal(job.state, 'detected', 'the request answers before the rules run');

    // The verdict follows the request; poll the job until it has one.
    const deadline = Date.now() + 20_000;
    let held;
    for (;;) {
      const res = await get(`/api/v1/ingest/${job.id}`, { headers });
      assert.equal(res.status, 200, `job read failed: ${res.text}`);
      held = json(res);
      if ((held.state !== 'detected' && held.state !== 'validating') || Date.now() > deadline)
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(held.state, 'quarantined', `the rule held it: ${JSON.stringify(held)}`);
    assert.equal(held.ruleId, ruleSet.rules[0].id);
    assert.equal(held.ruleSetId, ruleSet.id);
    assert.match(held.reason, /under the minimum/);
    assert.match(held.reason, /smoke minimum/);
    assert.equal(held.receivedPath, undefined, 'a disk path does not cross the wire');

    // The review queue: newest first, filtered to what needs a person.
    const queue = json(await get('/api/v1/ingest/queue?state=quarantined&limit=50', { headers }));
    assert.ok(Array.isArray(queue.items), 'the queue is a page');
    assert.ok(
      queue.items.some((j) => j.id === job.id),
      'the held job is in the review queue',
    );

    // The operator override.
    const accepted = await get(`/api/v1/ingest/${job.id}/accept`, { method: 'POST', headers });
    assert.equal(accepted.status, 200, `accept failed: ${accepted.text}`);
    assert.equal(json(accepted).state, 'accepted');
    assert.equal(json(accepted).reason, undefined, 'the reason moves to the history');
    assert.equal(
      (await get(`/api/v1/ingest/${job.id}/accept`, { method: 'POST', headers })).status,
      409,
    );

    // Three revisions in the audit history: detected, held by the rule, released by the operator.
    const historyDeadline = Date.now() + 20_000;
    let history;
    for (;;) {
      const res = await get(`/api/v1/history/ingest/${job.id}`, { headers });
      assert.equal(res.status, 200, `history read failed: ${res.text}`);
      history = json(res);
      if (history.revisions.length >= 4 || Date.now() > historyDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.deepEqual(
      history.revisions.slice(0, 4).map((r) => [r.revision, r.action]),
      [
        [1, 'ingest.detected'],
        [2, 'ingest.validating'],
        [3, 'ingest.rejected'],
        [4, 'ingest.accept'],
      ],
    );
    assert.deepEqual(history.revisions[2].delta.state, {
      before: 'validating',
      after: 'quarantined',
    });
    assert.equal(
      history.revisions[3].delta.reason?.before,
      held.reason,
      'the history keeps why it was held',
    );
  } finally {
    const removed = await get(`/api/v1/acceptance-rules/${ruleSet.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(removed.status, 204, `rule set cleanup failed: ${removed.text}`);
  }
});

test('smoke: EP-15.4 — the probe reads a real file: a WAV is accepted with its technical metadata, random bytes are held', async () => {
  // ffprobe in RIM's image (Dockerfile, APK_PACKAGES=ffmpeg), on a live cluster. The WAV is
  // built here — 44 bytes of header and a second of silence — so the runner needs no tools; the
  // job it becomes carries what the probe read, and bytes that are not media are quarantined
  // with the probe's own reason rather than passed.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const { randomBytes } = await import('node:crypto');

  const wav = silentWav(1);

  const send = async (filename, bytes) => {
    const upload = json(
      await get('/api/v1/uploads', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename, sizeBytes: bytes.length }),
      }),
    );
    const put = await get(`/api/v1/uploads/${upload.uploadId}/parts/1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    assert.equal(put.status, 204, `part failed: ${put.text}`);
    const done = await get(`/api/v1/uploads/${upload.uploadId}/complete`, {
      method: 'POST',
      headers,
    });
    assert.equal(done.status, 202, `complete failed: ${done.text}`);
    return json(done);
  };
  const settled = async (id) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await get(`/api/v1/ingest/${id}`, { headers });
      assert.equal(res.status, 200, `job read failed: ${res.text}`);
      const job = json(res);
      if ((job.state !== 'detected' && job.state !== 'validating') || Date.now() > deadline)
        return job;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const tone = await settled((await send('smoke-silence.wav', wav)).id);
  assert.equal(tone.state, 'accepted', `the WAV: ${JSON.stringify(tone)}`);
  assert.equal(tone.technicalMetadata?.container, 'wav');
  assert.equal(tone.technicalMetadata?.audioCodec, 'pcm_s16le');
  assert.equal(tone.technicalMetadata?.audioChannels, 1);
  assert.ok(
    Math.abs(tone.technicalMetadata?.durationSec - 1) < 0.05,
    `duration ${tone.technicalMetadata?.durationSec}`,
  );
  assert.equal(tone.technicalMetadata?.videoCodec, undefined, 'no picture in a WAV');

  const junk = await settled((await send('smoke-noise.mxf', randomBytes(4096))).id);
  assert.equal(junk.state, 'quarantined', `random bytes: ${JSON.stringify(junk)}`);
  assert.match(junk.reason, /could not be probed/);
  assert.equal(junk.technicalMetadata, undefined);

  // The history shows the step: detected → validating → the verdict.
  const deadline = Date.now() + 20_000;
  let history;
  for (;;) {
    history = json(await get(`/api/v1/history/ingest/${tone.id}`, { headers }));
    if (history.revisions.length >= 3 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(
    history.revisions.slice(0, 3).map((r) => [r.revision, r.action]),
    [
      [1, 'ingest.detected'],
      [2, 'ingest.validating'],
      [3, 'ingest.validated'],
    ],
  );
  assert.equal(
    history.revisions[2].delta.technicalMetadata?.after?.audioCodec,
    'pcm_s16le',
    'what the probe read is in the trail',
  );
});

test('smoke: EP-19.4 — the retention policy is governance: the defaults until set, replaced whole, and audited into the log it governs', async () => {
  // Through the gateway to the logging service: the policy in force for the seed channel, a
  // replacement with legal hold, and the keeper's own mutation read back from the audit history
  // — appended directly, in the transaction of the change, not via the broker. The policy is
  // put back to the defaults' values at the end so the trim behaves the same on the next run.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const before = await get('/api/v1/retention-policies', { headers });
  assert.equal(before.status, 200, `read failed: ${before.text}`);
  const inForce = json(before);
  assert.equal(inForce.channelId, 'ch12');
  assert.ok(inForce.hotDays >= 1);
  assert.equal(typeof inForce.defaults, 'boolean');

  const put = await get('/api/v1/retention-policies', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ hotDays: 45, coldDays: 3650, legalHold: true }),
  });
  assert.equal(put.status, 200, `write failed: ${put.text}`);
  const policy = json(put);
  assert.equal(policy.hotDays, 45);
  assert.equal(policy.legalHold, true);
  assert.equal(policy.defaults, false);
  assert.equal(policy.version, inForce.version + 1);

  const after = json(await get('/api/v1/retention-policies', { headers }));
  assert.equal(after.version, policy.version, 'replaced whole, and read back');
  assert.equal(after.legalHold, true);

  const history = json(await get('/api/v1/history/retention-policy/ch12', { headers }));
  const latest = history.revisions.find((r) => r.revision === policy.version);
  assert.ok(latest, `revision ${policy.version} in the audit history: ${JSON.stringify(history)}`);
  assert.equal(latest.action, 'retention-policy.updated');
  assert.deepEqual(latest.delta.legalHold, {
    ...(inForce.defaults ? {} : { before: inForce.legalHold }),
    after: true,
  });

  const reset = await get('/api/v1/retention-policies', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      hotDays: inForce.hotDays,
      coldDays: inForce.coldDays,
      legalHold: false,
    }),
  });
  assert.equal(reset.status, 200, `reset failed: ${reset.text}`);
});

test('smoke: EP-18 — a program table is written thinly, read back in reel order, and audited', async () => {
  // Scheduling on a live cluster: create the day, save a reel through the thin write path — with
  // an overlap the backend must NOT refuse (data-model §3.4) — read it back in reel order through
  // the gateway, and find the writes in the audit history the sink projected from
  // audit.recorded. Three services, one spine.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // A unique broadcast day per run: one schedule per channel per day, and the cluster may not be
  // fresh when this runs locally.
  const day = new Date(Date.now() + Math.floor(Math.random() * 365) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const created = await get('/api/v1/schedules', {
    method: 'POST',
    headers,
    body: JSON.stringify({ broadcastDate: day, timezone: 'Europe/London', notes: 'smoke' }),
  });
  assert.equal(created.status, 201, `create failed: ${created.text}`);
  const schedule = json(created);
  assert.equal(schedule.state, 'draft');

  const t0 = Date.parse(`${day}T06:00:00.000Z`);
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  // A ULID literal (26 Crockford chars): the reel checks the shape, not that MAM knows the id.
  const media = () => '01H00000000000000000000000';
  const saved = await get(`/api/v1/schedules/${schedule.id}/items`, {
    method: 'PUT',
    headers,
    body: JSON.stringify([
      {
        seq: 0,
        start: at(0),
        durationSec: 1800,
        itemType: 'title',
        fixed: true,
        description: 'opening',
      },
      { seq: 1, start: at(30), durationSec: 1800, itemType: 'media', mediaId: media() },
      { seq: 2, start: at(50), durationSec: 600, itemType: 'media', mediaId: media() }, // overlaps seq 1
      { seq: 3, start: at(60), durationSec: 3600, itemType: 'live', description: 'studio' },
    ]),
  });
  assert.equal(saved.status, 200, `reel save failed: ${saved.text}`);
  const reel = json(saved);
  assert.deepEqual(
    reel.map((i) => i.seq),
    [0, 1, 2, 3],
    'the overlap was stored, not refused',
  );
  assert.equal(reel[0].end, at(30), 'end is computed by the service');

  const read = await get(`/api/v1/schedules/${schedule.id}`, { headers });
  assert.equal(read.status, 200);
  assert.equal(json(read).items.length, 4);
  assert.equal(json(read).version, 2, 'a reel write bumps the schedule version');

  // And the audit: two revisions (create, reel), projected by the sink, read through the gateway.
  const deadline = Date.now() + 20_000;
  let history;
  for (;;) {
    const res = await get(`/api/v1/history/schedule/${schedule.id}`, { headers });
    assert.equal(res.status, 200, `history read failed: ${res.text}`);
    history = json(res);
    if (history.revisions.length >= 2 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(
    history.revisions.map((r) => [r.revision, r.action]),
    [
      [1, 'schedule.created'],
      [2, 'schedule.updated'],
    ],
    'the sink saw both writes',
  );
  assert.ok(history.revisions[1].delta.items, 'the reel change rode in the delta');
});

test('smoke: EP-16 — a real transcode: enqueued through the gateway, run by FFmpeg, announced, and mirrored into the asset’s files by MAM', async () => {
  // The path the FileRef mirror (EP-17.8) had never run on in a deployment, because nothing
  // produced `transcode.completed`: an asset in MAM, a job in MTS over its sample clip (the dev
  // overlay renders one into MTS's work area, since until HSM nothing can hand MTS an input), the
  // worker leasing it and running the real FFmpeg in the real image, the event crossing the
  // broker, and MAM's consumer turning it into file rows with the checksums MTS computed.
  const token = await seedToken();
  if (!token) return;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const created = await get('/api/v1/assets', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Smoke transcode', mediaType: 'video', fileType: 'mp4' }),
  });
  assert.equal(created.status, 201, `asset create failed: ${created.text}`);
  const assetId = json(created).id;

  // Refused before anything is written: a path outside the work root, and one that is not there.
  const outside = await get('/api/v1/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ assetId, presetIds: ['proxy'], inputPath: '../../etc/passwd' }),
  });
  assert.equal(outside.status, 422, `expected the work-root refusal: ${outside.text}`);
  const missing = await get('/api/v1/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ assetId, presetIds: ['proxy'], inputPath: 'samples/not-there.mp4' }),
  });
  assert.equal(missing.status, 422, `expected the missing-input refusal: ${missing.text}`);

  const enqueued = await get('/api/v1/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      assetId,
      presetIds: ['proxy', 'thumbnail'],
      inputPath: 'samples/smoke.mp4',
    }),
  });
  assert.equal(enqueued.status, 202, `enqueue failed: ${enqueued.text}`);
  const jobId = json(enqueued).id;

  // The worker polls its table once a second; a 3-second 320×240 clip encodes in well under that
  // on any runner. The budget is for a slow node, not a slow encoder.
  const deadline = Date.now() + 60_000;
  let job;
  for (;;) {
    const res = await get(`/api/v1/jobs/${jobId}`, { headers });
    assert.equal(res.status, 200, `job read failed: ${res.text}`);
    job = json(res);
    if (['completed', 'dead-letter'].includes(job.state) || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(job.state, 'completed', `the job did not complete: ${JSON.stringify(job)}`);
  assert.deepEqual(
    job.renditions.map((r) => r.kind),
    ['proxy', 'thumbnail'],
  );
  for (const r of job.renditions) {
    assert.equal(r.checksum.algorithm, 'sha256');
    assert.match(r.checksum.value, /^[0-9a-f]{64}$/);
    assert.ok(r.sizeBytes > 0, `${r.kind} is not empty`);
  }

  // MAM's side of it, over the broker: the renditions are the asset's files now, with the SAME
  // checksums — the mirror copies what the producer computed rather than inventing its own.
  const mirrorDeadline = Date.now() + 30_000;
  let files = [];
  for (;;) {
    const res = await get(`/api/v1/assets/${assetId}/files`, { headers });
    assert.equal(res.status, 200, `files read failed: ${res.text}`);
    files = json(res);
    if (files.length >= 2 || Date.now() > mirrorDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const byKind = Object.fromEntries(files.map((f) => [f.kind, f]));
  for (const r of job.renditions) {
    assert.ok(byKind[r.kind], `MAM has no ${r.kind} file for the asset: ${JSON.stringify(files)}`);
    assert.equal(
      byKind[r.kind].checksum.value,
      r.checksum.value,
      `${r.kind} checksum carried over`,
    );
  }

  // And the asset knows it has renditions — the mirror's bump, from the same event.
  const asset = await get(`/api/v1/assets/${assetId}`, {
    headers: { ...headers, 'cache-control': 'no-cache' },
  });
  assert.equal(json(asset).hasRenditions, true);
});

test('smoke: the state-counts aggregate answers, and is not read as an asset id', async () => {
  // Two things no unit test covers. The gateway routes `/api/v1/assets` by PREFIX, so this reaches
  // MAM only if that still holds for a deeper path; and `/assets/counts` must resolve to the static
  // route rather than being captured by `/assets/:id`, which is a property of Fastify's router and
  // therefore exactly the kind of thing that changes underneath you.
  const token = await seedToken();
  if (!token) {
    console.log('    (no seed account in this environment — skipping the counts path)');
    return;
  }

  const res = await get('/api/v1/assets/counts', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `counts failed: ${res.text}`);

  const body = json(res);
  assert.ok(body.counts, 'the response must carry a counts object');
  // A 404 problem document would also be JSON, so assert the SHAPE rather than the status alone:
  // being answered by `/assets/:id` with "asset not found" is the failure this guards.
  for (const [state, n] of Object.entries(body.counts)) {
    assert.equal(typeof n, 'number', `count for "${state}" must be a number, got ${typeof n}`);
    assert.ok(Number.isInteger(n) && n >= 0, `count for "${state}" must be a non-negative integer`);
  }
});
