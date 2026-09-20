// The shape every Atlas service shares (generated with the scaffold, and kept), plus the one read
// surface this service has: the history of an entity, behind two permissions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, isUlid, ulid, type EventPayloads } from '@atlas/contracts';
import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';
import { HealthRegistry, type AccessRecord } from '@atlas/service-kit';
import {
  buildLoggingApp,
  INTERNAL_HEADERS,
  ingest,
  requiredPermission,
  sqliteAuditStore,
} from '../src/index.ts';

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

// --- GET /logs and POST /logs/query (EP-19.3) ------------------------------------------------------------

/** Put a plain domain event into the store, the way the sink would. */
async function event(
  store: ReturnType<typeof sqliteAuditStore>,
  type: string,
  opts: {
    actorId?: string;
    correlationId?: string;
    channelId?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  const channelId = opts.channelId ?? CH;
  const envelope = buildEnvelope({
    type,
    channelId,
    payload: opts.payload ?? { n: 1 },
    actor: { kind: 'user', id: opts.actorId ?? 'u' },
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
  });
  await ingest(store, {
    id: envelope.messageId,
    subject: `atlas.${channelId}.${type}`,
    body: envelope,
  });
  return envelope.messageId;
}

test('visibility: an entry needs <domain>:read, and audit.recorded needs the ENTITY read', () => {
  const base = {
    messageId: 'm',
    channelId: CH,
    occurredAt: 'now',
    seq: 1,
    prevHash: '',
    hash: '',
    payload: {},
  };
  assert.equal(requiredPermission({ ...base, type: 'asset.created' }), 'asset:read');
  // IAM's domains take user:admin — no role grants a `permissions:read`, and the identity trail
  // is what an administrator reads the log for (EP-10.6).
  assert.equal(requiredPermission({ ...base, type: 'permissions.changed' }), 'user:admin');
  assert.equal(requiredPermission({ ...base, type: 'group.membership.changed' }), 'user:admin');
  assert.equal(
    requiredPermission({ ...base, type: 'audit.recorded', payload: { entityType: 'group' } }),
    'user:admin',
  );
  assert.equal(
    requiredPermission({ ...base, type: 'audit.recorded', payload: { entityType: 'schedule' } }),
    'schedule:read',
  );
  // The websocket service maps the same subject to the same permission — one rule, two places.
  assert.equal(
    requiredPermission({ ...base, type: 'audit.recorded', payload: null }),
    'audit:read',
  );
});

test('logs: permission-FILTERED — some entries visible to some users, all retained', async () => {
  // FR-LOG-2. A reader with logs:read and asset:read sees asset events and asset deltas, and does
  // NOT see the user or permission events in the same channel — which are still in the log.
  const { app, store, caller } = await harness({ permissions: ['logs:read', 'asset:read'] });
  await event(store, 'asset.created');
  await event(store, 'user.created');
  await event(store, 'permissions.changed');
  await recorded(store, ulid(), 1); // audit.recorded for an asset → asset:read
  await event(store, 'asset.updated');

  const res = await app.inject({ method: 'GET', url: '/api/v1/logs', headers: caller });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ items: { type: string; seq: number }[]; nextCursor?: number }>();
  assert.deepEqual(
    body.items.map((e) => e.type),
    ['asset.updated', 'audit.recorded', 'asset.created'],
    'newest first, and only what this caller may read',
  );
  assert.equal(body.nextCursor, undefined, 'the store page was not full: the log ran out');
  assert.equal((await store.count()).events, 5, 'everything is still retained');
  await app.close();
});

test('logs: a thin page keeps its cursor, and the cursor advances per row CONSIDERED', async () => {
  // Five rows, limit 2, and the caller may see only asset events: page 1 considers [5, 4] and
  // returns what is visible of them; its cursor is 4 regardless — so page 2 starts at 3, not at
  // the last visible row, and no row is re-scanned or skipped.
  const { app, store, caller } = await harness({ permissions: ['logs:read', 'asset:read'] });
  await event(store, 'asset.created'); // 1
  await event(store, 'user.created'); // 2
  await event(store, 'user.created'); // 3
  await event(store, 'user.created'); // 4
  await event(store, 'asset.updated'); // 5

  const p1 = (
    await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2', headers: caller })
  ).json<{
    items: { seq: number }[];
    nextCursor?: number;
  }>();
  assert.deepEqual(
    p1.items.map((e) => e.seq),
    [5],
    'thin: 4 was considered and was not visible',
  );
  assert.equal(p1.nextCursor, 4, 'but the cursor moved past it');

  const p2 = (
    await app.inject({
      method: 'GET',
      url: `/api/v1/logs?limit=2&before=${p1.nextCursor}`,
      headers: caller,
    })
  ).json<{ items: { seq: number }[]; nextCursor?: number }>();
  assert.deepEqual(p2.items, [], 'a page with nothing visible is still a page');
  assert.equal(p2.nextCursor, 2);

  const p3 = (
    await app.inject({
      method: 'GET',
      url: `/api/v1/logs?limit=2&before=${p2.nextCursor}`,
      headers: caller,
    })
  ).json<{ items: { seq: number }[]; nextCursor?: number }>();
  assert.deepEqual(
    p3.items.map((e) => e.seq),
    [1],
  );
  assert.equal(p3.nextCursor, undefined, 'short store page: the end');
  await app.close();
});

test('logs: filters — by correlation id (the request view), by type, and as a JSON query', async () => {
  const { app, store, caller } = await harness({ permissions: ['logs:read', 'asset:read'] });
  const corr = ulid();
  await event(store, 'asset.created', { correlationId: corr });
  await event(store, 'asset.updated', { correlationId: corr });
  await event(store, 'asset.updated');

  const byCorr = (
    await app.inject({ method: 'GET', url: `/api/v1/logs?correlationId=${corr}`, headers: caller })
  ).json<{ items: { type: string }[] }>();
  assert.deepEqual(
    byCorr.items.map((e) => e.type),
    ['asset.updated', 'asset.created'],
  );

  const byType = (
    await app.inject({ method: 'GET', url: '/api/v1/logs?type=asset.created', headers: caller })
  ).json<{ items: { type: string }[] }>();
  assert.deepEqual(
    byType.items.map((e) => e.type),
    ['asset.created'],
  );

  const query = await app.inject({
    method: 'POST',
    url: '/api/v1/logs/query',
    headers: { ...caller, 'content-type': 'application/json' },
    payload: { types: ['asset.updated'], correlationId: corr, limit: 10 },
  });
  assert.equal(query.statusCode, 200);
  assert.deepEqual(
    query.json<{ items: { type: string }[] }>().items.map((e) => e.type),
    ['asset.updated'],
  );
  await app.close();
});

test('logs: a bad filter is a 422 problem, not a 500', async () => {
  const { app, caller } = await harness();
  const res = await app.inject({ method: 'GET', url: '/api/v1/logs?before=abc', headers: caller });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json<{ code: string }>().code, 'VALIDATION');
  await app.close();
});

test('SECURITY: logs need logs:read — asset:read alone is 403, and another channel sees nothing', async () => {
  const { app, store, caller } = await harness({ permissions: ['asset:read'] });
  await event(store, 'asset.created');
  const res = await app.inject({ method: 'GET', url: '/api/v1/logs', headers: caller });
  assert.equal(res.statusCode, 403);
  await app.close();

  const other = await harness();
  await event(other.store, 'asset.created', { channelId: 'ch12' });
  const cross = await other.app.inject({
    method: 'GET',
    url: '/api/v1/logs',
    headers: { [INTERNAL_HEADERS.user]: 'user-1', [INTERNAL_HEADERS.channel]: 'ch99' },
  });
  assert.deepEqual(cross.json<{ items: unknown[] }>().items, []);
  await other.app.close();
});

// --- retention policies (EP-19.4) ------------------------------------------------------------------------

test('retention: the defaults until set; PUT replaces the channel policy, bumps its version, and audits it into the log itself', async () => {
  const { app, store, caller } = await harness({ permissions: ['compliance:admin', 'logs:read'] });
  const before = await app.inject({
    method: 'GET',
    url: '/api/v1/retention-policies',
    headers: caller,
  });
  assert.equal(before.statusCode, 200, before.body);
  assert.deepEqual(
    before.json<{
      hotDays: number;
      coldDays: number;
      legalHold: boolean;
      version: number;
      defaults: boolean;
    }>(),
    {
      channelId: CH,
      hotDays: 90,
      coldDays: 0,
      legalHold: false,
      version: 0,
      updatedAt: '',
      updatedBy: '',
      defaults: true,
    },
  );

  const put = await app.inject({
    method: 'PUT',
    url: '/api/v1/retention-policies',
    headers: { ...caller, 'content-type': 'application/json' },
    payload: { hotDays: 30, coldDays: 3650, legalHold: false },
  });
  assert.equal(put.statusCode, 200, put.body);
  const policy = put.json<{
    version: number;
    updatedBy: string;
    defaults: boolean;
    hotDays: number;
  }>();
  assert.equal(policy.version, 1);
  assert.equal(policy.updatedBy, 'user-1');
  assert.equal(policy.defaults, false);

  const again = await app.inject({
    method: 'PUT',
    url: '/api/v1/retention-policies',
    headers: { ...caller, 'content-type': 'application/json' },
    payload: { hotDays: 30, coldDays: 3650, legalHold: true },
  });
  assert.equal(again.json<{ version: number }>().version, 2);
  assert.equal((await store.retentionPolicy(CH))?.legalHold, true);

  // The keeper's own mutation is in the log it keeps: two revisions, field-level deltas.
  const history = await store.history(CH, 'retention-policy', CH);
  assert.deepEqual(
    history.map((h) => [h.revision, h.action, h.actorId]),
    [
      [1, 'retention-policy.updated', 'user-1'],
      [2, 'retention-policy.updated', 'user-1'],
    ],
  );
  assert.deepEqual(history[1]!.delta['legalHold'], { before: false, after: true });
  assert.equal('hotDays' in history[1]!.delta, false, 'unchanged fields are not in the delta');
  // And it is a link in the channel's chain, like every record.
  const chain = await store.chain(CH);
  assert.equal(chain.length, 2);
  assert.equal(chain[1]!.prevHash, chain[0]!.hash);

  const bad = await app.inject({
    method: 'PUT',
    url: '/api/v1/retention-policies',
    headers: { ...caller, 'content-type': 'application/json' },
    payload: { hotDays: 0, coldDays: 0 },
  });
  assert.equal(bad.statusCode, 422);
  await app.close();
});

test('SECURITY: retention is governance — compliance:admin for the read and the write, logs:read alone is 403', async () => {
  const reader = await harness({ permissions: ['logs:read', 'asset:read'] });
  for (const method of ['GET', 'PUT'] as const) {
    const res = await reader.app.inject({
      method,
      url: '/api/v1/retention-policies',
      headers: { ...reader.caller, 'content-type': 'application/json' },
      ...(method === 'PUT' ? { payload: { hotDays: 1, coldDays: 0 } } : {}),
    });
    assert.equal(res.statusCode, 403, method);
    assert.equal(res.json<{ code: string }>().code, 'FORBIDDEN');
  }
  await reader.app.close();

  // Another channel's admin does not see this channel's policy: the route is the caller's channel.
  const admin = await harness({ permissions: ['compliance:admin'] });
  await admin.app.inject({
    method: 'PUT',
    url: '/api/v1/retention-policies',
    headers: { ...admin.caller, 'content-type': 'application/json' },
    payload: { hotDays: 3, coldDays: 0 },
  });
  const other = await admin.app.inject({
    method: 'GET',
    url: '/api/v1/retention-policies',
    headers: { [INTERNAL_HEADERS.user]: 'user-2', [INTERNAL_HEADERS.channel]: 'ch99' },
  });
  assert.equal(other.json<{ defaults: boolean; channelId: string }>().defaults, true);
  assert.equal(other.json<{ channelId: string }>().channelId, 'ch99');

  // The policy's HISTORY is governance too: compliance:admin (with logs:read), not a
  // `retention-policy:read` nobody holds — the same exception identities make with user:admin.
  const history = await admin.app.inject({
    method: 'GET',
    url: '/api/v1/history/retention-policy/ch12',
    headers: admin.caller,
  });
  assert.equal(history.statusCode, 403, 'logs:read is still the door');
  await admin.app.close();
  const auditor = await harness({ permissions: ['logs:read', 'compliance:admin'] });
  await auditor.app.inject({
    method: 'PUT',
    url: '/api/v1/retention-policies',
    headers: { ...auditor.caller, 'content-type': 'application/json' },
    payload: { hotDays: 3, coldDays: 0 },
  });
  const read = await auditor.app.inject({
    method: 'GET',
    url: '/api/v1/history/retention-policy/ch12',
    headers: auditor.caller,
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json<{ revisions: unknown[] }>().revisions.length, 1);
  await auditor.app.close();
});
