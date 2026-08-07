// EP-08.3 — rate limiting and request-size limits (#96).
//
// The half of the brute-force story that deliberately stayed OUT of IAM: #240 keys a strict policy
// on the account, this keys a loose one on the source address. The loose/strict split is the whole
// design, and the reason for it is in rate-limit.ts — a facility shares one public address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestKey } from '@atlas/service-kit';
import {
  buildGateway,
  clientAddress,
  RateLimiter,
  type GatewayOptions,
  type RateLimitPolicy,
  type RoutingTable,
} from '../src/index.ts';

// =============================================================================
// The bucket
// =============================================================================

/** A limiter on a clock the test owns, so nothing here depends on wall time. */
function limiter(policy: RateLimitPolicy, maxKeys?: number) {
  let clock = 1_000_000;
  const rl = new RateLimiter(policy, {
    now: () => clock,
    ...(maxKeys !== undefined ? { maxKeys } : {}),
  });
  return { rl, advance: (ms: number) => (clock += ms) };
}

test('the bucket allows exactly its limit, then refuses', () => {
  const { rl } = limiter({ limit: 3, windowMs: 1_000 });
  assert.deepEqual(
    [rl.check('a').allowed, rl.check('a').allowed, rl.check('a').allowed],
    [true, true, true],
  );

  const refused = rl.check('a');
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterMs > 0, 'and says when to come back');
});

test('tokens refill continuously rather than all at once', () => {
  // The reason for a token bucket over a fixed window: a fixed window lets a client spend its whole
  // allowance in the last millisecond of one window and again in the first of the next — twice the
  // intended rate at exactly the moment a burst hurts.
  const { rl, advance } = limiter({ limit: 10, windowMs: 1_000 });
  for (let i = 0; i < 10; i += 1) assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);

  advance(100); // a tenth of the window == one token
  assert.equal(rl.check('a').allowed, true, 'one token, one request');
  assert.equal(rl.check('a').allowed, false, 'and no more');
});

test('a bucket refills to the limit and no further', () => {
  // Otherwise an idle client accrues an unbounded allowance and returns with a burst that is
  // limited by how long it waited rather than by the policy.
  const { rl, advance } = limiter({ limit: 5, windowMs: 1_000 });
  rl.check('a');
  advance(10 * 60_000);

  for (let i = 0; i < 5; i += 1) assert.equal(rl.check('a').allowed, true, `burst ${i}`);
  assert.equal(rl.check('a').allowed, false, 'ten idle minutes still buys exactly five');
});

test('keys are independent', () => {
  const { rl } = limiter({ limit: 1, windowMs: 1_000 });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  assert.equal(rl.check('b').allowed, true, 'one noisy client does not spend anyone else’s budget');
});

test('a nonsense policy is refused at construction, not at the first request', () => {
  // A zero limit refuses everything forever. Failing here means a bad config kills a deploy that
  // is rolling out; failing at the first request means it takes the platform off the air.
  assert.throws(() => new RateLimiter({ limit: 0, windowMs: 1_000 }), /invalid rate-limit policy/);
  assert.throws(() => new RateLimiter({ limit: 5, windowMs: 0 }), /invalid rate-limit policy/);
});

test('DANGER: the key table is bounded, and idle keys are reclaimed', () => {
  // The key is a source address, and an attacker picks how many of those to present. An unbounded
  // map is memory whose size the ATTACKER chooses — a denial of service against the component whose
  // job is preventing one. Same trap as #240's failure tracking.
  const { rl, advance } = limiter({ limit: 2, windowMs: 1_000 }, 100);

  for (let i = 0; i < 500; i += 1) rl.check(`addr-${i}`);
  assert.ok(rl.size <= 100, `tracked ${rl.size} keys against a cap of 100`);

  // Those keys are idle now, so they refill to full — and a full bucket is indistinguishable from
  // a key never seen, which is what makes reclaiming them lossless rather than a lost limit.
  advance(10_000);
  const fresh = rl.check('someone-new');
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.untracked, undefined, 'there was room again without failing open');
});

test('SECURITY: a full table fails OPEN, and says so', () => {
  // Failing closed would let an attacker who fills the table deny service to everybody else —
  // turning the protection into the attack. Keys already tracked stay limited; only new ones slip
  // through, and `untracked` exists so that is counted rather than silent.
  const { rl } = limiter({ limit: 1, windowMs: 60_000 }, 3);
  for (const k of ['a', 'b', 'c']) assert.equal(rl.check(k).allowed, true);

  // Every bucket is now empty, so none can be reclaimed.
  const overflow = rl.check('d');
  assert.equal(overflow.allowed, true, 'the newcomer is served');
  assert.equal(overflow.untracked, true, 'and the gap is reported');

  assert.equal(rl.check('a').allowed, false, 'while the tracked keys are still limited');
});

// =============================================================================
// The key
// =============================================================================

test('SECURITY: x-forwarded-for is ignored unless a proxy is trusted', () => {
  // THE trap. When the gateway is the edge — which it is today, NodePort with no ingress in
  // infra/k8s/base — this header is attacker-controlled. Honouring it lets a client choose its own
  // rate-limit key and rotate it per request, which is exactly as good as having no limiter.
  const req = { ip: '10.0.0.9', headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } };
  assert.equal(clientAddress(req, false), '10.0.0.9', 'the socket address wins by default');
  assert.equal(clientAddress(req, true), '1.2.3.4', 'and the header only once opted in');

  assert.equal(
    clientAddress({ ip: '10.0.0.9', headers: { 'x-forwarded-for': '' } }, true),
    '10.0.0.9',
    'an empty header falls back rather than keying every client on ""',
  );
});

// =============================================================================
// Through the gateway
// =============================================================================

const UPSTREAM = 'http://mam:3000';

async function gateway(over: Partial<GatewayOptions> = {}) {
  const key = await generateTestKey();
  const routes: RoutingTable = [
    { service: 'iam', origin: 'http://iam:3000', prefix: '/auth', public: true },
    { service: 'mam', origin: UPSTREAM, prefix: '/api/v1/assets' },
  ];
  const app = buildGateway({
    jwks: key.jwks,
    routes,
    fetchImpl: async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ...over,
  });
  return { app, key };
}

test('a flood from one address is cut off with 429 and Retry-After', async () => {
  const { app } = await gateway({ rateLimit: { limit: 3, windowMs: 60_000 } });
  const hit = () => app.inject({ method: 'POST', url: '/auth/login', payload: {} });

  for (let i = 0; i < 3; i += 1) assert.equal((await hit()).statusCode, 200, `request ${i}`);

  const refused = await hit();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json<{ code: string }>().code, 'RATE_LIMITED');
  assert.ok(
    Number(refused.headers['retry-after']) >= 1,
    'Retry-After is present and never 0 — zero is an invitation to spin',
  );
});

test('SECURITY: the address limit applies BEFORE the token is verified', async () => {
  // Checking after authentication would leave an unlimited supply of garbage-token requests, each
  // costing a signature verification, never reaching a limit. That is the cheapest denial of
  // service available against a JWT gateway.
  const { app } = await gateway({ rateLimit: { limit: 2, windowMs: 60_000 } });
  const junk = () =>
    app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: { authorization: 'Bearer not-a-real-token' },
    });

  assert.equal((await junk()).statusCode, 401, 'rejected on its merits while budget remains');
  assert.equal((await junk()).statusCode, 401);
  assert.equal((await junk()).statusCode, 429, 'then refused before the verification is attempted');
});

test('the per-principal quota is separate from the address quota', async () => {
  // §10's "per-principal quotas". A generous address budget must not let ONE user consume it all.
  const { app, key } = await gateway({
    rateLimit: { limit: 1000, windowMs: 60_000 },
    principalRateLimit: { limit: 2, windowMs: 60_000 },
  });
  const token = await key.sign({ sub: 'user-1', permissions: [], permVersion: 1 });
  const as = (t: string) =>
    app.inject({ method: 'GET', url: '/api/v1/assets', headers: { authorization: `Bearer ${t}` } });

  assert.equal((await as(token)).statusCode, 200);
  assert.equal((await as(token)).statusCode, 200);
  const refused = await as(token);
  assert.equal(refused.statusCode, 429);
  assert.match(refused.json<{ message: string }>().message, /principal/);

  // A different subject has its own budget, with plenty of address allowance left.
  const other = await key.sign({ sub: 'user-2', permissions: [], permVersion: 1 });
  assert.equal((await as(other)).statusCode, 200, 'one greedy user does not starve another');
});

test('a per-route policy overrides the default', async () => {
  const { app } = await gateway({
    rateLimit: { limit: 100, windowMs: 60_000 },
    routes: [
      { service: 'iam', origin: 'http://iam:3000', prefix: '/auth', public: true },
      {
        service: 'mam',
        origin: UPSTREAM,
        prefix: '/api/v1/assets',
        public: true,
        rateLimit: { limit: 1, windowMs: 60_000 },
      },
    ],
  });

  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/assets' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/assets' })).statusCode, 429);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/auth/login', payload: {} })).statusCode,
    200,
    'the tight route did not spend the other route’s budget',
  );
});

test('probes and the scraper are never rate limited', async () => {
  // A liveness probe throttled into failure restarts a healthy pod, and a throttled /metrics makes
  // the platform look down at exactly the moment somebody is investigating why it is busy.
  //
  // They are exempt STRUCTURALLY rather than by an exemption list: the limiter lives in the proxy
  // handler, and these are the gateway's own routes. Pinned anyway, because moving the check to an
  // onRequest hook — the obvious refactor — would silently start throttling all three.
  const { app } = await gateway({ rateLimit: { limit: 1, windowMs: 60_000 } });
  await app.inject({ method: 'POST', url: '/auth/login', payload: {} }); // spend the budget

  for (const url of ['/healthz', '/readyz', '/metrics']) {
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'GET', url });
      assert.notEqual(res.statusCode, 429, `${url} was throttled`);
    }
  }
});

test('rejections are counted, by which limit fired', async () => {
  // api-gateway.md §12 names "rate-limit rejections" as a signal the gateway owes an operator.
  // BOTH scopes are driven here, because a counter that only ever reports one of its label values
  // is indistinguishable from one whose other branch was never wired up.
  const { app, key } = await gateway({
    // Roomy enough that the address limit cannot fire first and mask the principal one...
    rateLimit: { limit: 1_000, windowMs: 60_000 },
    principalRateLimit: { limit: 1, windowMs: 60_000 },
    routes: [
      // ...except on this route, which is tight and public, so it exercises the address scope
      // without a token in the way.
      {
        service: 'iam',
        origin: 'http://iam:3000',
        prefix: '/auth',
        public: true,
        rateLimit: { limit: 1, windowMs: 60_000 },
      },
      { service: 'mam', origin: UPSTREAM, prefix: '/api/v1/assets' },
    ],
  });
  const token = await key.sign({ sub: 'user-1', permissions: [], permVersion: 1 });
  const authed = () =>
    app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: { authorization: `Bearer ${token}` },
    });

  assert.equal((await authed()).statusCode, 200);
  assert.equal((await authed()).statusCode, 429, 'principal limit');
  assert.equal((await authed()).statusCode, 429);

  assert.equal(
    (await app.inject({ method: 'POST', url: '/auth/login', payload: {} })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/auth/login', payload: {} })).statusCode,
    429,
    'address limit',
  );

  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  assert.match(body, /atlas_gateway_rate_limited_total\{scope="address"\} 1\n/);
  assert.match(body, /atlas_gateway_rate_limited_total\{scope="principal"\} 2\n/);
});

// =============================================================================
// Request-size limits
// =============================================================================

test('an oversized body is 413, not 500', async () => {
  // This was ALREADY broken before any cap was configurable: Fastify enforces its own 1 MB default
  // and raises FST_ERR_CTP_BODY_TOO_LARGE, but toProblem only knows the Atlas taxonomy and mapped
  // it to INTERNAL/500 — telling the caller the server had failed, and putting a 5xx on the
  // error-rate dashboard for what is squarely a client error.
  const { app } = await gateway({ bodyLimit: 128 });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: 'x'.repeat(4096),
  });

  assert.equal(res.statusCode, 413);
  const problem = res.json<{ code: string; correlationId?: string }>();
  assert.equal(problem.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(problem.correlationId, 'and it is a real problem document, correlation id and all');
});

test('a body within the cap still proxies byte-for-byte', async () => {
  // The cap must not disturb the property the gateway exists to keep: what the upstream receives is
  // what the client sent. A re-serializing proxy breaks any signature or checksum.
  let seen: string | undefined;
  const { app } = await gateway({
    bodyLimit: 4096,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      seen = Buffer.from(init?.body as Uint8Array).toString('utf8');
      return new Response('{}', { status: 200 });
    },
  });

  const payload = JSON.stringify({ note: 'sent  exactly   like   this' });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'content-type': 'application/json' },
    payload,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(seen, payload);
});
