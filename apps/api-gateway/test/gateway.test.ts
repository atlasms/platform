import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestKey, HealthRegistry } from '@atlas/service-kit';
import { isUlid } from '@atlas/contracts';
import { buildGateway, INTERNAL_HEADERS, matchRoute, type AccessLogRecord } from '../src/index.ts';

// Headless throughout: app.inject() means no ports, no sockets, no flakiness.
const routes = [
  { service: 'iam', origin: 'http://iam:3000', prefix: '/auth', public: true },
  { service: 'mam', origin: 'http://mam:3000', prefix: '/api/v1/assets' },
  { service: 'mam-v', origin: 'http://mamv:3000', prefix: '/api/v1/assets/versions' },
];

/** Records what the gateway sent upstream so the forwarded identity can be asserted. */
function captureUpstream(status = 200, body: unknown = { ok: true }) {
  const seen: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
  }> = [];
  const impl = (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: Buffer },
  ) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    return {
      status,
      ok: status < 400,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

async function gatewayWith(over: Partial<Parameters<typeof buildGateway>[0]> = {}) {
  const key = await generateTestKey();
  const { impl, seen } = captureUpstream();
  const logs: AccessLogRecord[] = [];
  const app = buildGateway({
    jwks: key.jwks,
    routes,
    fetchImpl: impl,
    onAccessLog: (r) => logs.push(r),
    ...over,
  });
  return { app, key, seen, logs };
}

// --- EP-08.1 routing -------------------------------------------------------
test('longest-prefix wins regardless of declaration order', () => {
  assert.equal(matchRoute(routes, '/api/v1/assets/123')?.service, 'mam');
  assert.equal(matchRoute(routes, '/api/v1/assets/versions/9')?.service, 'mam-v');
  assert.equal(matchRoute(routes, '/auth/login')?.service, 'iam');
  assert.equal(matchRoute(routes, '/nope'), undefined);
});

test('an unrouted path is a clean 404 problem, not a stack trace', async () => {
  const { app } = await gatewayWith();
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});

test('an unreachable upstream is a 502 naming the service, not a mystery 500', async () => {
  const failing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const { app } = await gatewayWith({ fetchImpl: failing });

  const key = await generateTestKey();
  const token = await key.sign({ sub: 'u' });
  const res = await buildGateway({ jwks: key.jwks, routes, fetchImpl: failing }).inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().message, /upstream "mam" unreachable/);
  void app;
});

// --- EP-08.2 authentication ------------------------------------------------
test('a protected route without a token is 401', async () => {
  const { app } = await gatewayWith();
  const res = await app.inject({ method: 'GET', url: '/api/v1/assets' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'UNAUTHORIZED');
});

test('a public route is reachable with no token at all', async () => {
  const { app, seen } = await gatewayWith();
  const res = await app.inject({ method: 'POST', url: '/auth/login' });
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0]?.url, 'http://iam:3000/auth/login');
  // A public route must not forward an identity it never established.
  assert.equal(seen[0]?.headers[INTERNAL_HEADERS.user], undefined);
});

test('a valid token is proxied with the internal identity header set', async () => {
  const { app, key, seen } = await gatewayWith();
  const token = await key.sign({
    sub: 'user-42',
    channelId: 'ch12',
    permissions: ['asset:read', 'asset:write'],
    permVersion: 7,
  });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/assets?q=x',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  const h = seen[0]!.headers;
  assert.equal(seen[0]?.url, 'http://mam:3000/api/v1/assets?q=x', 'query string is preserved');
  assert.equal(h[INTERNAL_HEADERS.user], 'user-42');
  assert.equal(h[INTERNAL_HEADERS.channel], 'ch12');
  assert.equal(h[INTERNAL_HEADERS.scopes], 'asset:read asset:write');
  assert.equal(h[INTERNAL_HEADERS.permVersion], '7');
});

test('SECURITY: the raw Authorization header is NOT forwarded upstream', async () => {
  const { app, key, seen } = await gatewayWith();
  const token = await key.sign({ sub: 'u' });
  await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}` },
  });
  // Downstream trusts the internal header set the gateway establishes; re-parsing the JWT in
  // every service would be duplicated trust and a second place to get verification wrong.
  assert.equal(seen[0]?.headers['authorization'], undefined);
});

test('a token signed by an unknown key is refused', async () => {
  const { app } = await gatewayWith();
  const other = await generateTestKey('other-kid');
  const token = await other.sign({ sub: 'u' });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
});

test('a token below minPermVersion is refused — revocation beats token TTL', async () => {
  const { app, key } = await gatewayWith({ minPermVersion: 5 });

  const stale = await key.sign({ sub: 'u', permVersion: 4 });
  const staleRes = await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${stale}` },
  });
  assert.equal(staleRes.statusCode, 401);
  assert.match(staleRes.json().message, /stale permission version/);

  const fresh = await key.sign({ sub: 'u', permVersion: 5 });
  const freshRes = await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${fresh}` },
  });
  assert.equal(freshRes.statusCode, 200);
});

// --- EP-08.4 correlation ---------------------------------------------------
test('a correlation id is issued when absent and echoed back', async () => {
  const { app, seen } = await gatewayWith();
  const res = await app.inject({ method: 'POST', url: '/auth/login' });

  const echoed = res.headers[INTERNAL_HEADERS.correlation] as string;
  assert.ok(isUlid(echoed), 'issued id should be a ULID');
  assert.equal(seen[0]?.headers[INTERNAL_HEADERS.correlation], echoed, 'same id goes upstream');
});

test('an inbound correlation id is adopted, not replaced', async () => {
  const { app, seen } = await gatewayWith();
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { [INTERNAL_HEADERS.correlation]: 'corr-from-studio' },
  });
  assert.equal(res.headers[INTERNAL_HEADERS.correlation], 'corr-from-studio');
  assert.equal(seen[0]?.headers[INTERNAL_HEADERS.correlation], 'corr-from-studio');
});

test('even a 404 carries a correlation id — an unroutable request is still traceable', async () => {
  const { app } = await gatewayWith();
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.ok(isUlid(res.headers[INTERNAL_HEADERS.correlation] as string));
});

// --- EP-08.6 access logging ------------------------------------------------
test('every response is logged, including failures, with the subject when known', async () => {
  const { app, key, logs } = await gatewayWith();

  await app.inject({ method: 'GET', url: '/nope' }); // 404, anonymous
  await app.inject({ method: 'GET', url: '/api/v1/assets' }); // 401, anonymous

  const token = await key.sign({ sub: 'user-42' });
  await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(logs.length, 3);
  assert.deepEqual(
    logs.map((l) => l.status),
    [404, 401, 200],
  );
  assert.equal(logs[0]?.userId, undefined);
  assert.equal(logs[2]?.userId, 'user-42');
  assert.ok(logs.every((l) => isUlid(l.requestId) || l.requestId.length > 0));
  assert.ok(logs.every((l) => typeof l.latencyMs === 'number' && l.latencyMs >= 0));
});

// --- health ---------------------------------------------------------------
test('health routes need no token and readiness reflects a critical failure', async () => {
  const health = new HealthRegistry().register('broker', () => false, { critical: true });
  const { app } = await gatewayWith({ health });

  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);

  const ready = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 503, 'a critical dependency down must fail readiness');
  assert.equal(ready.json().status, 'not_ready');
});

// --- EP-12.2 golden signals ------------------------------------------------
test('/metrics is unauthenticated and exposes golden signals in Prometheus format', async () => {
  // A scraper is infrastructure, not a user; and metrics carry only route templates, methods and
  // status classes — no tenant data — so there is nothing here to protect behind a token.
  const { app, key } = await gatewayWith();
  const token = await key.sign({ sub: 'user-42', channelId: 'ch12', permissions: [] });

  await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}` },
  });
  await app.inject({ method: 'GET', url: '/nope' });

  const res = await app.inject({ method: 'GET', url: '/metrics' });

  assert.equal(res.statusCode, 200, 'no token required');
  assert.match(res.headers['content-type'] ?? '', /text\/plain/);
  assert.match(res.body, /# TYPE atlas_http_requests_total counter/);
  assert.match(res.body, /atlas_http_requests_total\{service="api-gateway".*status="2xx"\} 1/);
  assert.match(res.body, /# TYPE atlas_http_request_duration_seconds histogram/);
  assert.match(res.body, /atlas_http_request_duration_seconds_bucket\{.*le="\+Inf"\}/);
});

test('CARDINALITY: a per-asset URL does not mint a time series per asset', async () => {
  // The gateway proxies /api/v1/assets/<ULID>. Recording req.url would put that id in a label and
  // kill the metrics store on a busy channel; the route template is what gets recorded.
  const { app, key } = await gatewayWith();
  const token = await key.sign({ sub: 'user-42', channelId: 'ch12', permissions: [] });

  for (const id of [
    '01H2XKZQ4E5N6P7R8S9T0V1W2X',
    '01H2XKZQ4E5N6P7R8S9T0V1W2Y',
    '01H2XKZQ4E5N6P7R8S9T0V1W2Z',
  ]) {
    await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  const series = body.split('\n').filter((l) => l.startsWith('atlas_http_requests_total{'));

  assert.equal(series.length, 1, `expected one series, got:\n${series.join('\n')}`);
  assert.match(series[0] ?? '', / 3$/, 'all three requests land on the same series');
  assert.doesNotMatch(body, /01H2XKZQ/, 'no asset id may appear in a label');
});

test('a 5xx from upstream is counted as an error, not lost', async () => {
  const { impl } = captureUpstream(503, { down: true });
  const { app, key } = await gatewayWith({ fetchImpl: impl });
  const token = await key.sign({ sub: 'user-42', channelId: 'ch12', permissions: [] });

  await app.inject({
    method: 'GET',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}` },
  });

  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  assert.match(body, /atlas_http_requests_total\{.*status="5xx"\} 1/);
});

// --- the gateway forwards BYTES, it does not parse them ---------------------

test('DANGER: a POST with a JSON content type and an EMPTY body is proxied, not 500', async () => {
  // Fastify's default JSON parser rejects an empty body outright. A lifecycle transition
  // legitimately has nothing to say — `POST /assets/{id}/approve` with no body is the normal case,
  // and it is exactly what a generated client sends. Parsing here turned that into a 500 from the
  // GATEWAY, one millisecond in, before the request ever reached the service that owns it.
  const { impl, seen } = captureUpstream();
  const { app, key } = await gatewayWith({ fetchImpl: impl });
  const token = await key.sign({ sub: 'user-42', channelId: 'ch12', permissions: [] });

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets/01H2XKZQ4E5N6P7R8S9T0V1W2X/approve',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: '',
  });

  assert.equal(res.statusCode, 200, `gateway refused an empty JSON body: ${res.body}`);
  assert.equal(seen.length, 1, 'the request never reached the upstream');
  assert.equal(seen[0]?.body, undefined, 'an empty body must not be forwarded as one');
});

test('a body is forwarded byte-for-byte, not re-serialized', async () => {
  // Re-serializing changes key order and whitespace. Any upstream that verifies a signature or a
  // checksum over the raw body would then reject a request the client signed correctly.
  const { impl, seen } = captureUpstream();
  const { app, key } = await gatewayWith({ fetchImpl: impl });
  const token = await key.sign({ sub: 'user-42', channelId: 'ch12', permissions: [] });
  const payload = '{"z":1,  "a":  2}';

  await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload,
  });

  assert.equal(seen[0]?.body?.toString('utf8'), payload);
});

test('a non-JSON body is proxied rather than refused', async () => {
  // The gateway carries every service's API, and not all of them are JSON — file upload is the
  // obvious one. A gateway that can only parse JSON can only proxy JSON.
  const { impl, seen } = captureUpstream();
  const { app, key } = await gatewayWith({ fetchImpl: impl });
  const token = await key.sign({ sub: 'user-42', channelId: 'ch12', permissions: [] });

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: Buffer.from([0x00, 0x01, 0x02, 0xff]),
  });

  assert.equal(res.statusCode, 200, `gateway refused a binary body: ${res.body}`);
  assert.deepEqual([...(seen[0]?.body ?? [])], [0x00, 0x01, 0x02, 0xff]);
});
