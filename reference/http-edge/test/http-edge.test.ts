import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../messaging/src/index.ts';
import { buildEnvelope, ulid, subjectFor, type Envelope } from '../../contracts/src/index.ts';
import { generateTestKey, HealthRegistry } from '../../service-kit/src/index.ts';
import { MamService, AssetStore } from '../../mam-service/src/index.ts';
import { buildApp } from '../src/index.ts';

async function world() {
  const broker = new InMemoryBroker();
  const mam = new MamService(broker, new AssetStore());
  mam.start();
  const approved: Envelope[] = [];
  broker.subscribe('atlas.*.asset.approved', (m) => approved.push(m.body as Envelope));

  const pub = (type: string, payload: any) => {
    const env = buildEnvelope({ type, channelId: 'ch12', payload });
    return broker.publish({ id: env.messageId, subject: subjectFor('ch12', type), body: env });
  };
  const A = ulid();
  await pub('ingest.accepted', { assetId: A, checksum: { algorithm: 'sha256', value: 'a' }, source: 's', path: '/x.mxf', technicalMetadata: { container: 'mxf' } }); await mam.drain();
  await pub('transcode.completed', { assetId: A, renditions: [{ kind: 'broadcast', path: '/r.mp4', checksum: { algorithm: 'sha256', value: 'b' } }] }); await mam.drain();

  const key = await generateTestKey();
  const health = new HealthRegistry().register('db', () => true);
  const app = buildApp({ mam, health, jwks: key.jwks });
  const token = (claims: any) => key.sign(claims);
  return { app, mam, A, token, approved };
}

test('health endpoints are public', async () => {
  const w = await world();
  assert.equal((await w.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  const ready = await w.app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().status, 'ready');
});

test('GET /assets/:id returns the asset or a 404 problem', async () => {
  const w = await world();
  assert.equal((await w.app.inject({ method: 'GET', url: `/assets/${w.A}` })).json().state, 'ready');
  const miss = await w.app.inject({ method: 'GET', url: '/assets/nope' });
  assert.equal(miss.statusCode, 404);
  assert.equal(miss.json().code, 'NOT_FOUND');
});

test('approve without a token is 401', async () => {
  const w = await world();
  const res = await w.app.inject({ method: 'POST', url: `/assets/${w.A}/approve`, payload: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'UNAUTHORIZED');
  assert.ok(res.headers['x-correlation-id']); // correlation set even on the failure path
});

test('approve without the permission is 403', async () => {
  const w = await world();
  const token = await w.token({ sub: 'user-9', permissions: ['asset:read'] });
  const res = await w.app.inject({ method: 'POST', url: `/assets/${w.A}/approve`, headers: { authorization: `Bearer ${token}` }, payload: {} });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'FORBIDDEN');
});

test('approve with a valid token + permission is 200 and emits asset.approved', async () => {
  const w = await world();
  const token = await w.token({ sub: 'user-1', permissions: ['asset:approve'] });
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const res = await w.app.inject({ method: 'POST', url: `/assets/${w.A}/approve`, headers: { authorization: `Bearer ${token}` }, payload: { expiresAt } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'approved');
  await w.mam.drain();
  assert.equal(w.approved.length, 1);
  assert.equal(w.approved[0].payload.approver, 'user-1');
});

test('an incoming ULID x-correlation-id threads from HTTP header to the emitted event', async () => {
  const w = await world();
  const cid = ulid();
  const token = await w.token({ sub: 'user-1', permissions: ['asset:approve'] });
  const res = await w.app.inject({ method: 'POST', url: `/assets/${w.A}/approve`, headers: { authorization: `Bearer ${token}`, 'x-correlation-id': cid }, payload: {} });
  assert.equal(res.headers['x-correlation-id'], cid);      // echoed back
  await w.mam.drain();
  assert.equal(w.approved[0].correlationId, cid);          // and threaded onto the domain event
});

test('reject with a valid token is 200', async () => {
  const w = await world();
  const token = await w.token({ sub: 'user-2', permissions: ['asset:approve'] });
  const res = await w.app.inject({ method: 'POST', url: `/assets/${w.A}/reject`, headers: { authorization: `Bearer ${token}` }, payload: { reason: 'blurry' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, 'rejected');
});
