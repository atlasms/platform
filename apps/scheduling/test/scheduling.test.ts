// The shape every Atlas service shares (generated with the scaffold, and kept), plus the program
// table's HTTP surface: every route in the contract, its authorization, and the thin write path
// seen from the wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUlid, ulid } from '@atlas/contracts';
import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';
import { HealthRegistry, type AccessRecord } from '@atlas/service-kit';
import {
  buildSchedulingApp,
  INTERNAL_HEADERS,
  SchedulingService,
  sqliteScheduleStore,
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
  const store = sqliteScheduleStore();
  const service = new SchedulingService({ store });
  const app = await buildSchedulingApp({
    service,
    policyFor: () =>
      opts.noPolicy
        ? undefined
        : policyFor(opts.permissions ?? ['schedule:read', 'schedule:write']),
    health: opts.health ?? new HealthRegistry(),
    onAccessLog: (r) => logs.push(r),
    onError: (_err, ctx) => errors.push(ctx),
  });
  const caller = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  };
  return { app, store, service, logs, errors, caller };
}

const T0 = '2026-09-12T06:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const item = (
  seq: number,
  startMin: number,
  durationMin: number,
  extra: Record<string, unknown> = {},
) => ({
  seq,
  start: at(startMin),
  durationSec: durationMin * 60,
  itemType: 'media',
  mediaId: ulid(),
  ...extra,
});

// --- the shared shape --------------------------------------------------------------------------

test('health routes need no caller, and readiness reflects a critical failure', async () => {
  const health = new HealthRegistry().register('iam', () => false, { critical: true });
  const { app } = await harness({ health });
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 503);
  await app.close();
});

test('/metrics is scrapeable and carries the golden signals for this service', async () => {
  const { app } = await harness();
  await app.inject({ method: 'GET', url: '/healthz' });
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.match(res.body, /atlas_http_requests_total\{[^}]*service="scheduling"/);
  await app.close();
});

test('a 5xx is the RFC 9457 problem document, logged where it is raised, opaque to the caller', async () => {
  const { app, errors } = await harness();
  app.get('/boom', async () => {
    throw new Error('the database said something unrepeatable');
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(res.statusCode, 500);
  assert.match(res.headers['content-type'] as string, /^application\/problem\+json/);
  const p = res.json<{ code: string; message: string; correlationId: string; type: string }>();
  assert.equal(p.code, 'INTERNAL');
  assert.equal(p.message, 'Internal error');
  assert.equal(p.type, 'https://atlas.example/problems/internal');
  assert.equal(errors[0]?.correlationId, p.correlationId);
  assert.ok(isUlid(p.correlationId));
  await app.close();
});

// --- the program table -----------------------------------------------------------------------------

test('create → read back with its reel → list, all channel-scoped', async () => {
  const { app, caller } = await harness();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/schedules',
    headers: caller,
    payload: { broadcastDate: '2026-09-12', timezone: 'Europe/London' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const schedule = created.json<{
    id: string;
    state: string;
    version: number;
    channelId: string;
  }>();
  assert.equal(schedule.state, 'draft');
  assert.equal(schedule.channelId, CH);

  const got = await app.inject({
    method: 'GET',
    url: `/api/v1/schedules/${schedule.id}`,
    headers: caller,
  });
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json<{ items: unknown[] }>().items, [], 'a new schedule has an empty reel');

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/schedules?broadcastDate=2026-09-12',
    headers: caller,
  });
  assert.deepEqual(
    listed.json<{ items: { id: string }[] }>().items.map((s) => s.id),
    [schedule.id],
  );

  const other = { ...caller, [INTERNAL_HEADERS.channel]: 'ch99' };
  const cross = await app.inject({
    method: 'GET',
    url: `/api/v1/schedules/${schedule.id}`,
    headers: other,
  });
  assert.equal(cross.statusCode, 404, "another channel's schedule is not found — not forbidden");
  await app.close();
});

test('one schedule per channel per broadcast day is a 409 problem', async () => {
  const { app, caller } = await harness();
  const body = { broadcastDate: '2026-09-12', timezone: 'UTC' };
  await app.inject({ method: 'POST', url: '/api/v1/schedules', headers: caller, payload: body });
  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/schedules',
    headers: caller,
    payload: body,
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json<{ code: string }>().code, 'CONFLICT');
  await app.close();
});

test("PUT /items is the editor's save: the reel as given, overlaps included, ids kept", async () => {
  const { app, caller } = await harness();
  const { id } = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: caller,
      payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
    })
  ).json<{ id: string }>();

  const keep = ulid();
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/v1/schedules/${id}/items`,
    headers: caller,
    payload: [
      item(0, 0, 30, { id: keep, fixed: true, mediaTitle: 'News' }),
      item(1, 20, 30),
      item(2, 90, 10),
    ],
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const reel =
    saved.json<{ id: string; seq: number; end: string; fixed: boolean; mediaTitle?: string }[]>();
  assert.deepEqual(
    reel.map((i) => i.seq),
    [0, 1, 2],
    'an overlap (0–30 vs 20–50) and a gap were stored as given',
  );
  assert.equal(reel[0]?.id, keep);
  assert.equal(reel[0]?.fixed, true);
  assert.equal(reel[0]?.mediaTitle, 'News');
  assert.equal(reel[0]?.end, at(30), 'end is computed, never sent');
  await app.close();
});

test('a bad row in a reel of many names itself in the 422', async () => {
  const { app, caller } = await harness();
  const { id } = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: caller,
      payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
    })
  ).json<{ id: string }>();
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/schedules/${id}/items`,
    headers: caller,
    payload: [item(0, 0, 10), { ...item(1, 10, 10), itemType: 'live' }],
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.json<{ message: string }>().message, /^items\[1\]: .*live item has no mediaId/);
  await app.close();
});

test('POST, PATCH and DELETE one item; a PATCH is validated as the merged whole item', async () => {
  const { app, caller } = await harness();
  const { id } = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: caller,
      payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
    })
  ).json<{ id: string }>();

  const added = await app.inject({
    method: 'POST',
    url: `/api/v1/schedules/${id}/items`,
    headers: caller,
    payload: item(0, 0, 10),
  });
  assert.equal(added.statusCode, 201, added.body);
  const itemId = added.json<{ id: string }>().id;

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/v1/schedules/${id}/items/${itemId}`,
    headers: caller,
    payload: { durationSec: 1200, description: 'longer' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(
    patched.json<{ end: string; description: string }>().end,
    at(20),
    'end follows the new duration',
  );
  assert.equal(patched.json<{ description: string }>().description, 'longer');

  // Turning a media item into a live one without dropping its mediaId is refused — the merged
  // item is what is checked, not the patch alone.
  const bad = await app.inject({
    method: 'PATCH',
    url: `/api/v1/schedules/${id}/items/${itemId}`,
    headers: caller,
    payload: { itemType: 'live' },
  });
  assert.equal(bad.statusCode, 422);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/v1/schedules/${id}/items/${itemId}`,
    headers: caller,
  });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(
    (
      await app.inject({ method: 'GET', url: `/api/v1/schedules/${id}/items`, headers: caller })
    ).json(),
    [],
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/schedules/${id}/items/${itemId}`,
        headers: caller,
      })
    ).statusCode,
    404,
  );
  await app.close();
});

test('PATCH /schedules/{id}: the header, and state is not writable here', async () => {
  const { app, caller } = await harness();
  const { id, version } = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/schedules',
      headers: caller,
      payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
    })
  ).json<{ id: string; version: number }>();
  const ok = await app.inject({
    method: 'PATCH',
    url: `/api/v1/schedules/${id}`,
    headers: caller,
    payload: { notes: 'evening block' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json<{ version: number; notes: string }>().version, version + 1);
  const refused = await app.inject({
    method: 'PATCH',
    url: `/api/v1/schedules/${id}`,
    headers: caller,
    payload: { state: 'sent' },
  });
  assert.equal(refused.statusCode, 422);
  assert.match(refused.json<{ message: string }>().message, /not writable/);
  await app.close();
});

test('SECURITY: schedule:read for reads, schedule:write for writes; no policy is 401', async () => {
  const reader = await harness({ permissions: ['schedule:read'] });
  const res = await reader.app.inject({
    method: 'POST',
    url: '/api/v1/schedules',
    headers: reader.caller,
    payload: { broadcastDate: '2026-09-12', timezone: 'UTC' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json<{ code: string }>().code, 'FORBIDDEN');
  assert.equal(
    (await reader.app.inject({ method: 'GET', url: '/api/v1/schedules', headers: reader.caller }))
      .statusCode,
    200,
  );
  await reader.app.close();

  const nobody = await harness({ noPolicy: true });
  assert.equal(
    (await nobody.app.inject({ method: 'GET', url: '/api/v1/schedules', headers: nobody.caller }))
      .statusCode,
    401,
  );
  assert.equal(
    (await nobody.app.inject({ method: 'GET', url: '/api/v1/schedules' })).statusCode,
    401,
    'no caller at all',
  );
  await nobody.app.close();
});
