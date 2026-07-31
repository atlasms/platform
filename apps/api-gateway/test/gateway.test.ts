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
  const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const impl = (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    seen.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} });
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
