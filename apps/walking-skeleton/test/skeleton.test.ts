import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestKey } from '@atlas/service-kit';
import { compile, type EffectivePolicy } from '@atlas/policy';
import { isUlid, type Envelope } from '@atlas/contracts';
import type { ServerFrame } from '@atlas/websocket';
import { buildSpine } from '../src/index.ts';

const CHANNEL = 'ch12';

const policyOf = (userId: string, permissions: string[]): EffectivePolicy =>
  compile({
    subjectId: userId,
    permVersion: 1,
    rules: [{ id: 'r', permissions, scope: { channelIds: [CHANNEL] } }],
  });

async function spine(
  grants: Record<string, string[]> = { 'user-1': ['asset:write', 'asset:read'] },
) {
  const key = await generateTestKey();
  const policies = new Map(Object.entries(grants).map(([u, p]) => [u, policyOf(u, p)] as const));
  const s = buildSpine({
    jwks: key.jwks,
    policyFor: (userId) => policies.get(userId),
  });
  const tokenFor = (sub: string) =>
    key.sign({ sub, channelId: CHANNEL, permissions: grants[sub] ?? [], permVersion: 1 });
  return { ...s, key, tokenFor, policies };
}

/** A live Studio client: subscribed, permission-checked, recording what it receives. */
function studioClient(s: Awaited<ReturnType<typeof spine>>, userId: string, id = 'studio-1') {
  const frames: ServerFrame[] = [];
  s.sockets.add({
    id,
    userId,
    channelId: CHANNEL,
    policy: s.policies.get(userId)!,
    send: (f) => frames.push(f),
  });
  s.sockets.subscribe(id, `atlas.${CHANNEL}.asset.>`);
  return { frames, events: () => frames.filter((f) => f.type === 'event') };
}

// =============================================================================
// EP-13 — the Phase 0 exit criteria, executable.
// =============================================================================

test('WALKING SKELETON: create through the gateway, store, relay, and push live', async () => {
  const s = await spine();
  const studio = studioClient(s, 'user-1');
  const token = await s.tokenFor('user-1');

  // 1. Through the gateway: authenticated, routed, proxied to the service.
  const res = await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: 'First light' },
  });

  assert.equal(res.statusCode, 201, `gateway->service failed: ${res.body}`);
  const asset = res.json();
  assert.ok(isUlid(asset.id));
  assert.equal(asset.channelId, CHANNEL);
  assert.equal(asset.createdBy, 'user-1');

  // 2. Stored.
  assert.equal(s.service.assets.get(asset.id)?.title, 'First light');

  // 3. Nothing has been published yet — the event is sitting in the outbox, committed with
  //    the row. That gap is the guarantee, not a delay to be optimised away.
  assert.equal(studio.events().length, 0);

  // 4. Relay drains -> broker -> bridge -> permission-checked fan-out -> Studio.
  const relayed = await s.settle();
  assert.equal(relayed, 1);

  const delivered = studio.events();
  assert.equal(delivered.length, 1, 'the change must reach a subscribed client');
  assert.equal(delivered[0]?.subject, `atlas.${CHANNEL}.asset.created`);

  const envelope = delivered[0]?.payload as Envelope;
  assert.equal(envelope.type, 'asset.created');
  assert.deepEqual(envelope.payload, { assetId: asset.id, title: 'First light' });
});

test('EP-13.3: ONE correlation id threads gateway -> service -> broker -> socket', async () => {
  const s = await spine();
  const studio = studioClient(s, 'user-1');
  const token = await s.tokenFor('user-1');

  const res = await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-correlation-id': 'trace-me',
    },
    payload: { title: 'Traceable' },
  });

  assert.equal(res.statusCode, 201);
  // The gateway echoes the id it established (here, adopted from the caller).
  assert.equal(res.headers['x-correlation-id'], 'trace-me');

  await s.settle();

  // The SAME id survives the async hop — which is what makes a single trace possible across
  // the sync request and the event that followed it.
  const envelope = studio.events()[0]?.payload as Envelope;
  assert.equal(envelope.correlationId, 'trace-me');
});

test('the outbox is atomic: a rejected request leaves neither row nor event', async () => {
  const s = await spine();
  const studio = studioClient(s, 'user-1');
  const token = await s.tokenFor('user-1');

  const before = s.service.assets.all().length;

  const res = await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: '' }, // fails validation
  });

  assert.equal(res.statusCode, 422);
  assert.equal(s.service.assets.all().length, before, 'no row written');
  assert.equal(await s.settle(), 0, 'no event enqueued');
  assert.equal(studio.events().length, 0);
});

// --- the spine refuses at every layer it should ------------------------------

test('unauthenticated requests never reach the service', async () => {
  const s = await spine();
  const res = await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    payload: { title: 'nope' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(s.service.assets.all().length, 0, 'the service must not have been called');
});

test('SECURITY: authenticated but unauthorized is refused BY THE SERVICE, not the gateway', async () => {
  // reader can authenticate and is routed through, but holds no asset:write.
  const s = await spine({ reader: ['asset:read'] });
  const token = await s.tokenFor('reader');

  const res = await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: 'should not persist' },
  });

  assert.equal(res.statusCode, 403, 'the owning service makes the resource decision');
  assert.equal(s.service.assets.all().length, 0);
  assert.equal(await s.settle(), 0);
});

test('SECURITY: the live update is permission-checked, not broadcast', async () => {
  const s = await spine({
    'user-1': ['asset:write', 'asset:read'],
    'no-read': ['asset:write'], // may create, may NOT watch
  });
  const watcher = studioClient(s, 'user-1', 'ok');
  const blind = studioClient(s, 'no-read', 'blind');

  const token = await s.tokenFor('user-1');
  await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: 'Watched' },
  });
  await s.settle();

  assert.equal(watcher.events().length, 1);
  assert.equal(blind.events().length, 0, 'a subscriber without read must not receive');
});

test('SECURITY: a client in another tenant receives nothing', async () => {
  const s = await spine();
  const outsider = { frames: [] as ServerFrame[] };
  s.sockets.add({
    id: 'other-tenant',
    userId: 'user-1',
    channelId: 'ch99',
    policy: compile({
      subjectId: 'user-1',
      permVersion: 1,
      rules: [{ id: 'wide', permissions: ['*:read'] }], // deliberately over-broad
    }),
    send: (f) => outsider.frames.push(f),
  });
  // Even subscribing is refused: a subscription cannot name another tenant.
  assert.equal(s.sockets.subscribe('other-tenant', `atlas.${CHANNEL}.asset.>`).ok, false);

  const token = await s.tokenFor('user-1');
  await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: 'Private to ch12' },
  });
  await s.settle();

  assert.equal(outsider.frames.filter((f) => f.type === 'event').length, 0);
});

// --- idempotence of the async path ------------------------------------------

test('draining twice publishes once — the relay marks what it sent', async () => {
  const s = await spine();
  const studio = studioClient(s, 'user-1');
  const token = await s.tokenFor('user-1');

  await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: 'Once' },
  });

  assert.equal(await s.settle(), 1);
  assert.equal(await s.settle(), 0, 'a second drain must find nothing');
  assert.equal(studio.events().length, 1);
});

test('the asset is readable back through the gateway', async () => {
  const s = await spine();
  const token = await s.tokenFor('user-1');

  const created = await s.gateway.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { title: 'Round trip' },
  });
  const { id } = created.json();

  const fetched = await s.gateway.inject({
    method: 'GET',
    url: `/api/v1/assets/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().title, 'Round trip');
});
