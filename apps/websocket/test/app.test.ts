// EP-13.2 — the `/ws` endpoint.
//
// The registry, the eligibility rules and the bridge already have their own tests. What is untested
// until here is the SEAM: does a real socket get authenticated before it opens, does a frame off
// the wire reach the registry, and does a refusal look like a refusal to the client rather than
// like an outage. Those are the parts a library with no entry point could not have.
//
// `app.injectWS()` drives a real upgrade through the real plugin without binding a port.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, type EffectivePolicy } from '@atlas/policy';
import { generateTestKey, type TestKey } from '@atlas/service-kit';
import { buildWebsocketApp, ConnectionRegistry, type ConnectionRecord } from '../src/index.ts';

const ISSUER = 'atlas-iam';
const AUDIENCE = 'atlas';

const policyFor = (channelId = 'ch12'): EffectivePolicy =>
  compile({
    subjectId: 'user-1',
    permVersion: 1,
    rules: [{ id: 'r1', permissions: ['asset:read'], scope: { channelIds: [channelId] } }],
  });

interface Harness {
  app: Awaited<ReturnType<typeof buildWebsocketApp>>;
  registry: ConnectionRegistry;
  key: TestKey;
  log: ConnectionRecord[];
}

async function harness(
  overrides: {
    policyFor?: (userId: string) => EffectivePolicy | undefined;
  } = {},
): Promise<Harness> {
  const key = await generateTestKey();
  const registry = new ConnectionRegistry();
  const log: ConnectionRecord[] = [];
  const app = await buildWebsocketApp({
    registry,
    jwks: key.jwks,
    policyFor: overrides.policyFor ?? (() => policyFor()),
    issuer: ISSUER,
    audience: AUDIENCE,
    // Off: a live interval would keep the test process pinging a socket nobody is reading.
    heartbeatIntervalMs: 0,
    onConnectionLog: (record) => log.push(record),
  });
  await app.ready();
  return { app, registry, key, log };
}

const token = (key: TestKey, claims: Record<string, unknown> = {}): Promise<string> =>
  key.sign(
    { sub: 'user-1', channelId: 'ch12', permissions: ['asset:read'], ...claims },
    { issuer: ISSUER, audience: AUDIENCE },
  );

/**
 * Wait for a condition, polling.
 *
 * Not a fixed sleep: a close handshake takes as long as it takes, and a sleep long enough to be
 * reliable on a loaded CI runner is a sleep every developer pays on every run. This fails on the
 * deadline with the same assertion the caller would have written anyway.
 */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Resolves with the next frame the server sends. */
const nextFrame = (socket: { once: (e: string, cb: (data: unknown) => void) => void }) =>
  new Promise<Record<string, unknown>>((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
  });

test('an upgrade without a token is refused as HTTP 401, not as a closed socket', async () => {
  const { app } = await harness();

  // The distinction is the whole point of authenticating in preValidation. A client that gets a
  // closed socket cannot tell "your token expired" from "the service is down", and Studio's
  // reconnect loop would back off against a permanent failure forever.
  const response = await app.inject({ method: 'GET', url: '/ws' });
  assert.equal(response.statusCode, 401);
  assert.match(response.json<{ error: string }>().error, /access token/);

  await app.close();
});

test('a token signed by the wrong key is refused', async () => {
  const { app } = await harness();
  const stranger = await generateTestKey();
  const forged = await stranger.sign(
    { sub: 'user-1', channelId: 'ch12' },
    { issuer: ISSUER, audience: AUDIENCE },
  );

  const response = await app.inject({ method: 'GET', url: `/ws?token=${forged}` });
  assert.equal(response.statusCode, 401);

  await app.close();
});

test('a valid token without a channel claim is refused — nothing here is channel-less', async () => {
  const { app, key } = await harness();
  const noChannel = await key.sign({ sub: 'user-1' }, { issuer: ISSUER, audience: AUDIENCE });

  const response = await app.inject({ method: 'GET', url: `/ws?token=${noChannel}` });
  assert.equal(response.statusCode, 401);
  assert.match(response.json<{ error: string }>().error, /subject or channel/);

  await app.close();
});

test('FAILS CLOSED: an unresolvable policy refuses the connection', async () => {
  // The tempting alternative is to admit the socket with no rules and let eligibility sort it out.
  // It cannot: `can()` is lenient, so a rule-less policy meeting an incomplete context reads as
  // "any". An IAM outage must cost connections, never widen them.
  const { app, key, log } = await harness({ policyFor: () => undefined });

  const response = await app.inject({ method: 'GET', url: `/ws?token=${await token(key)}` });
  assert.equal(response.statusCode, 401);
  assert.match(response.json<{ error: string }>().error, /permissions/);
  assert.deepEqual(
    log.map((r) => r.event),
    ['refused'],
  );

  await app.close();
});

test('a valid token opens a socket the registry knows about', async () => {
  const { app, registry, key, log } = await harness();

  const socket = await app.injectWS(`/ws?token=${await token(key)}`);
  assert.equal(registry.stats().connections, 1);
  assert.equal(log[0]?.event, 'connected');
  assert.equal(log[0]?.userId, 'user-1');
  assert.equal(log[0]?.channelId, 'ch12');

  socket.terminate();
  await app.close();
});

test('a bearer header works too, for clients that are not a browser', async () => {
  // Studio has to use the query parameter — the browser WebSocket constructor cannot set headers —
  // but nothing else should be forced into putting a credential in a URL.
  const { app, registry, key } = await harness();

  const socket = await app.injectWS('/ws', {
    headers: { authorization: `Bearer ${await token(key)}` },
  });
  assert.equal(registry.stats().connections, 1);

  socket.terminate();
  await app.close();
});

test('subscribe reaches the registry and is confirmed', async () => {
  const { app, registry, key, log } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const confirmed = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  assert.deepEqual(await confirmed, { type: 'subscribed', subject: 'atlas.ch12.asset.>' });
  assert.equal(registry.stats().subscriptions, 1);
  assert.ok(log.some((r) => r.event === 'subscribed' && r.pattern === 'atlas.ch12.asset.>'));

  socket.terminate();
  await app.close();
});

test('a published event reaches a subscribed socket', async () => {
  // This is the hop EP-13.2 exists for: the bridge publishes into the registry, and the registry
  // has to reach a real socket rather than a test double with a `send`.
  const { app, registry, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const subscribed = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  await subscribed;

  const event = nextFrame(socket);
  const delivered = registry.publish('atlas.ch12.asset.updated', { assetId: '01ABC' });
  assert.equal(delivered, 1);
  assert.deepEqual(await event, {
    type: 'event',
    subject: 'atlas.ch12.asset.updated',
    payload: { assetId: '01ABC' },
  });

  socket.terminate();
  await app.close();
});

test('a subscription to ANOTHER channel is refused, and the refusal reaches the client', async () => {
  const { app, registry, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const refused = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch99.asset.>' }));
  const frame = await refused;
  assert.equal(frame['type'], 'error');
  assert.equal(frame['subject'], 'atlas.ch99.asset.>');
  assert.equal(registry.stats().subscriptions, 0);

  socket.terminate();
  await app.close();
});

test('unsubscribe drops the subscription', async () => {
  const { app, registry, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const subscribed = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  await subscribed;

  const unsubscribed = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'unsubscribe', pattern: 'atlas.ch12.asset.>' }));
  assert.deepEqual(await unsubscribed, { type: 'unsubscribed', subject: 'atlas.ch12.asset.>' });
  assert.equal(registry.stats().subscriptions, 0);

  socket.terminate();
  await app.close();
});

test('an unparseable frame is answered, not swallowed', async () => {
  const { app, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const answered = nextFrame(socket);
  socket.send('not json');
  assert.deepEqual(await answered, { type: 'error', message: 'frame is not valid JSON' });

  socket.terminate();
  await app.close();
});

test('`resume` is refused by name rather than ignored', async () => {
  // websocket.md §4 lists it, and it needs the Redis replay window (EP-07.4, unbuilt). Silently
  // dropping it would let a reconnecting client believe it had caught up on the gap.
  const { app, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const answered = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'resume', pattern: 'atlas.ch12.asset.>' }));
  const frame = await answered;
  assert.equal(frame['type'], 'error');
  assert.match(String(frame['message']), /unsupported frame type "resume"/);

  socket.terminate();
  await app.close();
});

test('over a REAL socket: connect, subscribe, receive, and disconnect cleanly', async () => {
  // The one test that binds a port, and it earns it twice over.
  //
  // `injectWS` drives the plugin over an in-memory duplex, which is enough for every frame
  // assertion above but does NOT complete a closing handshake — a client `close()` there leaves
  // the server's socket without a `close` event. Asserting the registry drains under that harness
  // would have been asserting the mock. It also means nothing else here proves the endpoint works
  // over TCP at all, which is the entire point of a walking-skeleton story.
  //
  // The client is Node's built-in `WebSocket` (Node 22+), deliberately: it is the same API the
  // browser gives Studio, and it costs no dependency.
  const { app, registry, key, log } = await harness();

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === 'object');

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${await token(key)}`);
  const frames: Record<string, unknown>[] = [];
  client.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    client.addEventListener('open', () => resolve(), { once: true });
    client.addEventListener('error', () => reject(new Error('socket failed to open')), {
      once: true,
    });
  });

  assert.equal(registry.stats().connections, 1);

  client.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  await until(() => frames.length >= 1);
  assert.deepEqual(frames[0], { type: 'subscribed', subject: 'atlas.ch12.asset.>' });

  registry.publish('atlas.ch12.asset.updated', { assetId: '01ABC' });
  await until(() => frames.length >= 2);
  assert.equal(frames[1]?.['subject'], 'atlas.ch12.asset.updated');

  // The graceful close `injectWS` cannot exercise: the client sends a close frame, the server
  // answers it, and only then does the connection leave the registry.
  client.close();
  await until(() => registry.stats().connections === 0);
  assert.equal(registry.stats().connections, 0);
  assert.ok(log.some((r) => r.event === 'disconnected'));

  await app.close();
});

test('a revoked grant drops the subscription on the live socket', async () => {
  // websocket.md §6.3. Revocation has to reach an OPEN connection; waiting for a reconnect means
  // streaming events to someone whose access was removed for as long as they stay connected.
  const { app, registry, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const subscribed = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  await subscribed;

  const dropped = nextFrame(socket);
  registry.applyPolicyChange('user-1', compile({ subjectId: 'user-1', permVersion: 2, rules: [] }));
  const frame = await dropped;
  assert.equal(frame['type'], 'permissions-changed');
  assert.equal(frame['subject'], 'atlas.ch12.asset.>');
  assert.equal(registry.stats().subscriptions, 0);

  socket.terminate();
  await app.close();
});

test('/ws/stats and the health endpoints answer without a token', async () => {
  // Infrastructure, not a user surface — a scraper and a kubelet have no token to present.
  const { app } = await harness();

  const stats = await app.inject({ method: 'GET', url: '/ws/stats' });
  assert.equal(stats.statusCode, 200);
  assert.deepEqual(stats.json(), { connections: 0, subscriptions: 0 });

  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);

  await app.close();
});

test('metrics count connections and refusals', async () => {
  const { app, key } = await harness();
  const socket = await app.injectWS(`/ws?token=${await token(key)}`);

  const subscribed = nextFrame(socket);
  socket.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  await subscribed;

  await app.inject({ method: 'GET', url: '/ws?token=nonsense' });

  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  assert.match(body, /atlas_ws_connections\{service="websocket"\} 1/);
  assert.match(body, /atlas_ws_subscribes_total\{service="websocket",outcome="ok"\} 1/);
  assert.match(body, /atlas_ws_upgrades_refused_total\{service="websocket",reason="token"\} 1/);

  socket.terminate();
  await app.close();
});

test('disconnectUser closes that user’s sockets and leaves everyone else connected', async () => {
  // The answer to "a permissions.changed arrived and IAM cannot tell us the new policy". Keeping
  // the socket open would keep delivering under grants just announced stale; an empty policy would
  // leave the client attached but permanently deaf, with nothing to prompt a resubscribe once IAM
  // returns. A closed socket is the one outcome the client already recovers from.
  const { app, registry, key } = await harness();

  const mine = await app.injectWS(`/ws?token=${await token(key)}`);
  const theirs = await app.injectWS(
    `/ws?token=${await token(key, { sub: 'user-2', channelId: 'ch12' })}`,
  );
  assert.equal(registry.stats().connections, 2);

  const closed = registry.disconnectUser('user-1', 'permissions changed');
  assert.equal(closed, 1);
  assert.equal(registry.stats().connections, 1);

  // The survivor is user-2's, and it is still a working connection rather than a stranded entry.
  const confirmed = nextFrame(theirs);
  theirs.send(JSON.stringify({ type: 'subscribe', pattern: 'atlas.ch12.asset.>' }));
  assert.deepEqual(await confirmed, { type: 'subscribed', subject: 'atlas.ch12.asset.>' });

  mine.terminate();
  theirs.terminate();
  await app.close();
});

test('the node-wide cap refuses with 503, and only once it is actually reached', async () => {
  // Load-bearing since EP-13.2 routed /ws around the gateway: these connections no longer pass
  // through its rate limiting, so this is the only thing between a client loop and every file
  // descriptor on the node.
  const key = await generateTestKey();
  const registry = new ConnectionRegistry();
  const app = await buildWebsocketApp({
    registry,
    jwks: key.jwks,
    policyFor: () => policyFor(),
    issuer: ISSUER,
    audience: AUDIENCE,
    heartbeatIntervalMs: 0,
    maxConnections: 2,
  });
  await app.ready();

  const a = await app.injectWS(`/ws?token=${await token(key)}`);
  const b = await app.injectWS(`/ws?token=${await token(key, { sub: 'user-2' })}`);
  assert.equal(registry.stats().connections, 2);

  const refused = await app.inject({
    method: 'GET',
    url: `/ws?token=${await token(key, { sub: 'user-3' })}`,
  });
  // 503, not 429 — the client did nothing wrong, and retrying is the right response.
  assert.equal(refused.statusCode, 503);
  assert.match(refused.json<{ error: string }>().error, /capacity/);

  // And it frees up again, rather than latching.
  a.terminate();
  await until(() => registry.stats().connections === 1);
  const admitted = await app.injectWS(`/ws?token=${await token(key, { sub: 'user-3' })}`);
  assert.equal(registry.stats().connections, 2);

  admitted.terminate();
  b.terminate();
  await app.close();
});

test('the per-user cap stops ONE account consuming the whole node', async () => {
  // The node-wide cap alone is not an abuse control: one account can fill it and take the service
  // down for everyone. This is the axis that prevents it — the same split the gateway makes
  // between its address limit and its principal limit.
  const key = await generateTestKey();
  const registry = new ConnectionRegistry();
  const app = await buildWebsocketApp({
    registry,
    jwks: key.jwks,
    policyFor: () => policyFor(),
    issuer: ISSUER,
    audience: AUDIENCE,
    heartbeatIntervalMs: 0,
    maxConnections: 100,
    maxConnectionsPerUser: 1,
  });
  await app.ready();

  const mine = await app.injectWS(`/ws?token=${await token(key)}`);

  const refused = await app.inject({ method: 'GET', url: `/ws?token=${await token(key)}` });
  assert.equal(refused.statusCode, 429);
  assert.match(refused.json<{ error: string }>().error, /too many open connections/);

  // Another user is unaffected — the node has capacity, and this cap is per principal.
  const theirs = await app.injectWS(`/ws?token=${await token(key, { sub: 'user-2' })}`);
  assert.equal(registry.stats().connections, 2);

  mine.terminate();
  theirs.terminate();
  await app.close();
});

test('a refusal at capacity never reaches IAM for a policy', async () => {
  // Ordering, and it matters under exactly the conditions that produce it: a service at capacity
  // is a service under load, and resolving a policy it is about to discard would put that load
  // onto IAM as well.
  const key = await generateTestKey();
  const registry = new ConnectionRegistry();
  let policyCalls = 0;
  const app = await buildWebsocketApp({
    registry,
    jwks: key.jwks,
    policyFor: () => {
      policyCalls++;
      return policyFor();
    },
    issuer: ISSUER,
    audience: AUDIENCE,
    heartbeatIntervalMs: 0,
    maxConnections: 1,
  });
  await app.ready();

  const open = await app.injectWS(`/ws?token=${await token(key)}`);
  assert.equal(policyCalls, 1);

  await app.inject({ method: 'GET', url: `/ws?token=${await token(key, { sub: 'user-2' })}` });
  assert.equal(policyCalls, 1, 'the refused upgrade must not have asked IAM for a policy');

  open.terminate();
  await app.close();
});
