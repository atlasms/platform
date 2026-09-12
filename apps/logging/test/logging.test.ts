// The shape every Atlas service shares (generated with the scaffold, and kept), plus the one read
// surface this service has: the history of an entity, behind two permissions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, isUlid, ulid, type EventPayloads } from '@atlas/contracts';
import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';
import { HealthRegistry, type AccessRecord } from '@atlas/service-kit';
import { buildLoggingApp, INTERNAL_HEADERS, ingest, sqliteAuditStore } from '../src/index.ts';

const CH = 'ch12';

function policyFor(permissions: string[]): EffectivePolicy {
  const rules: Rule[] = permissions.map((p) => ({ id: `r-${p}`, permissions: [p] }));
  return compile({ subjectId: 'user-1', permVersion: 1, rules, roles: [], groups: [] });
}

async function harness(
  opts: { permissions?: string[]; health?: HealthRegistry; noPolicy?: boolean } = {},
) {
  const logs: AccessRecord[] = [];
  const errors: { correlationId: string; url: string }[] = [];
  const store = sqliteAuditStore();
  const app = await buildLoggingApp({
    store,
    policyFor: () =>
      opts.noPolicy ? undefined : policyFor(opts.permissions ?? ['logs:read', 'asset:read']),
    health: opts.health ?? new HealthRegistry(),
    onAccessLog: (r) => logs.push(r),
    onError: (_err, ctx) => errors.push(ctx),
  });
  const caller = { [INTERNAL_HEADERS.user]: 'user-1', [INTERNAL_HEADERS.channel]: CH };
  return { app, store, logs, errors, caller };
}

/** Put one audit.recorded revision for an asset into the store, the way the sink would. */
async function recorded(
  store: ReturnType<typeof sqliteAuditStore>,
  entityId: string,
  revision: number,
  channelId = CH,
) {
  const payload: EventPayloads['audit.recorded'] = {
    entityType: 'asset',
    entityId,
    revision,
    action: revision === 1 ? 'asset.created' : 'asset.updated',
    origin: { service: 'mam' },
    delta: {
      title:
        revision === 1 ? { after: 'v1' } : { before: `v${revision - 1}`, after: `v${revision}` },
    },
  };
  const envelope = buildEnvelope({
    type: 'audit.recorded',
    channelId,
    payload,
    actor: { kind: 'user', id: 'u' },
  });
  await ingest(store, {
    id: envelope.messageId,
    subject: `atlas.${channelId}.audit.recorded`,
    body: envelope,
  });
}

// --- the shared shape --------------------------------------------------------------------------

test('health routes need no caller, and readiness reflects a critical failure', async () => {
  const health = new HealthRegistry().register('iam', () => false, { critical: true });
  const { app } = await harness({ health });
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  const ready = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 503, 'a critical dependency down must fail readiness');
  await app.close();
});

test('/metrics is scrapeable and carries the golden signals for this service', async () => {
  const { app } = await harness();
  await app.inject({ method: 'GET', url: '/healthz' });
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /atlas_http_requests_total\{[^}]*service="logging"/);
  await app.close();
});

test('a correlation id is a ULID, adopted only when the caller sent a well-formed one', async () => {
  const { app, logs } = await harness();
  const url = '/api/v1/history/asset/x'; // 401 without a caller, so it is always logged
  const mine = ulid();
  await app.inject({ method: 'GET', url, headers: { [INTERNAL_HEADERS.correlation]: mine } });
  assert.equal(logs[0]?.requestId, mine, 'a well-formed id is adopted');
  await app.inject({
    method: 'GET',
    url,
    headers: { [INTERNAL_HEADERS.correlation]: 'not-a-ulid' },
  });
  assert.ok(isUlid(logs[1]?.requestId ?? ''), 'a malformed id is replaced with a minted ULID');
  await app.close();
});

test('a 5xx is logged where it is raised, with the correlation id, and stays opaque to the caller', async () => {
  const { app, errors } = await harness();
  app.get('/boom', async () => {
    throw new Error('the database said something unrepeatable');
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(res.statusCode, 500);
  const problem = res.json<{ code: string; message: string; correlationId: string }>();
  assert.equal(problem.code, 'INTERNAL');
  assert.equal(problem.message, 'Internal error');
  assert.equal(errors[0]?.correlationId, problem.correlationId);
  await app.close();
});

// --- GET /history/{entityType}/{id} ------------------------------------------------------------------

test('history: the revision timeline, in order, for a caller with both permissions', async () => {
  const { app, store, caller } = await harness();
  const id = ulid();
  await recorded(store, id, 1);
  await recorded(store, id, 2);
  await recorded(store, ulid(), 1); // someone else's

  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/history/asset/${id}`,
    headers: caller,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    entityType: string;
    entityId: string;
    revisions: { revision: number; action: string; delta: unknown; messageId: string }[];
  }>();
  assert.equal(body.entityId, id);
  assert.deepEqual(
    body.revisions.map((r) => [r.revision, r.action, r.delta]),
    [
      [1, 'asset.created', { title: { after: 'v1' } }],
      [2, 'asset.updated', { title: { before: 'v1', after: 'v2' } }],
    ],
  );
  assert.ok(isUlid(body.revisions[0]?.messageId ?? ''), 'each revision deep-links to the log');
  await app.close();
});

test('history: the history of nothing is EMPTY, not 404', async () => {
  // A 404 would tell a caller who may read the channel that no such entity ever existed there —
  // which is itself information. Empty is what a reader with no history is entitled to know.
  const { app, caller } = await harness();
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/history/asset/${ulid()}`,
    headers: caller,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<{ revisions: unknown[] }>().revisions, []);
  await app.close();
});

test('SECURITY: history is channel-scoped — another channel sees nothing', async () => {
  const { app, store } = await harness();
  const id = ulid();
  await recorded(store, id, 1, 'ch12');
  const other = { [INTERNAL_HEADERS.user]: 'user-1', [INTERNAL_HEADERS.channel]: 'ch99' };
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/history/asset/${id}`,
    headers: other,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<{ revisions: unknown[] }>().revisions, []);
  await app.close();
});

test('SECURITY: no caller is 401; no policy is 401, never an empty policy', async () => {
  const { app } = await harness({ noPolicy: true });
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/v1/history/asset/x' })).statusCode,
    401,
  );
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/history/asset/x',
    headers: { [INTERNAL_HEADERS.user]: 'user-1', [INTERNAL_HEADERS.channel]: CH },
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.json<{ message: string }>().message, /no policy/);
  await app.close();
});

test('SECURITY: BOTH logs:read and read on the entity are required — either alone is 403', async () => {
  // A history is the entity's past states. Someone who may read logs but not assets must not
  // learn what an asset used to say, and someone who may read assets is not thereby an auditor.
  for (const permissions of [['logs:read'], ['asset:read']]) {
    const { app, store, caller } = await harness({ permissions });
    const id = ulid();
    await recorded(store, id, 1);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/history/asset/${id}`,
      headers: caller,
    });
    assert.equal(res.statusCode, 403, `only ${permissions[0]} must be refused`);
    assert.equal(res.json<{ code: string }>().code, 'FORBIDDEN');
    await app.close();
  }
});
