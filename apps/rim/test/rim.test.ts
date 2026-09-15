// The shape every Atlas service shares (generated with the scaffold, and kept), plus the upload's
// HTTP surface: every route in the contract, its authorization, and the resumable upload as a
// client sees it — the part size announced, a part refused by length, a resume, a 413 that is a
// 413, completion idempotent. Then the queue, the review and the rule sets (EP-15.3/15.6) as the
// Ingest panel sees them: the page shape, the 409s, the 422s, and who may do what.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUlid, ulid } from '@atlas/contracts';
import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';
import { HealthRegistry, type AccessRecord } from '@atlas/service-kit';
import {
  buildRimApp,
  fakeProbe,
  fsStaging,
  INTERNAL_HEADERS,
  RimService,
  sqliteRimStore,
} from '../src/index.ts';

const CH = 'ch12';
const PART = 1024;

function policyFor(permissions: string[]): EffectivePolicy {
  const rules: Rule[] = permissions.map((p) => ({ id: `r-${p}`, permissions: [p] }));
  return compile({ subjectId: 'user-1', permVersion: 1, rules, roles: [], groups: [] });
}

async function harness(
  opts: { permissions?: string[]; health?: HealthRegistry; noPolicy?: boolean } = {},
) {
  const logs: AccessRecord[] = [];
  const errors: { correlationId: string; url: string }[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'rim-http-'));
  const store = sqliteRimStore();
  const deferred: (() => Promise<void>)[] = [];
  const service = new RimService({
    store,
    staging: fsStaging(dir),
    probe: fakeProbe(),
    partSizeBytes: PART,
    defer: (task) => deferred.push(task),
  });
  const settle = async (): Promise<void> => {
    while (deferred.length > 0) await deferred.shift()!();
  };
  const app = await buildRimApp({
    service,
    partSizeBytes: PART,
    policyFor: () =>
      opts.noPolicy ? undefined : policyFor(opts.permissions ?? ['ingest:read', 'ingest:write']),
    health: opts.health ?? new HealthRegistry(),
    onAccessLog: (r) => logs.push(r),
    onError: (_err, ctx) => errors.push(ctx),
  });
  const caller = {
    [INTERNAL_HEADERS.user]: 'user-1',
    [INTERNAL_HEADERS.channel]: CH,
    'content-type': 'application/json',
  };
  const close = async (): Promise<void> => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { app, store, service, logs, errors, caller, close, settle };
}

/** One small upload, completed: the job as the client got it. */
async function uploadOne(
  h: Awaited<ReturnType<typeof harness>>,
  filename: string,
  size = 16,
): Promise<{ id: string; state: string }> {
  const started = await h.app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: h.caller,
    payload: { filename, sizeBytes: size },
  });
  assert.equal(started.statusCode, 201, started.body);
  const { uploadId } = started.json<{ uploadId: string }>();
  const put = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/parts/1`,
    headers: octets(h.caller),
    payload: randomBytes(size),
  });
  assert.equal(put.statusCode, 204, put.body);
  const done = await h.app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${uploadId}/complete`,
    headers: h.caller,
  });
  assert.equal(done.statusCode, 202, done.body);
  return done.json<{ id: string; state: string }>();
}

const ALL = ['ingest:read', 'ingest:write', 'ingest:approve', 'ingest:admin'];

const octets = (caller: Record<string, string>): Record<string, string> => ({
  ...caller,
  'content-type': 'application/octet-stream',
});

// --- the shared shape --------------------------------------------------------------------------

test('an EMPTY body with a JSON content type is not an error', async () => {
  const { app, close } = await harness();
  const res = await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 200);
  await close();
});

test('health routes need no caller, and readiness reflects a critical failure', async () => {
  const health = new HealthRegistry().register('iam', () => false, { critical: true });
  const { app, close } = await harness({ health });
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  const ready = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 503, 'a critical dependency down must fail readiness');
  await close();
});

test('/metrics is scrapeable and carries the golden signals for this service', async () => {
  const { app, close } = await harness();
  await app.inject({ method: 'GET', url: '/healthz' });
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.match(res.body, /atlas_http_requests_total\{[^}]*service="rim"/);
  await close();
});

test('a correlation id is a ULID, adopted only when the caller sent a well-formed one', async () => {
  const { app, logs, close } = await harness();
  const url = '/api/v1/uploads/01H00000000000000000000000'; // 401 without a caller: always logged
  const mine = ulid();
  await app.inject({ method: 'GET', url, headers: { [INTERNAL_HEADERS.correlation]: mine } });
  assert.equal(logs[0]?.requestId, mine, 'a well-formed id is adopted');
  const forged = 'not-a-ulid-' + 'x'.repeat(100);
  await app.inject({ method: 'GET', url, headers: { [INTERNAL_HEADERS.correlation]: forged } });
  assert.ok(isUlid(logs[1]?.requestId ?? ''), 'a malformed id is replaced with a minted ULID');
  await close();
});

test('an unauthenticated call is the RFC 9457 problem document, and is access-logged', async () => {
  const { app, logs, close } = await harness();
  const res = await app.inject({ method: 'POST', url: '/api/v1/uploads' });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'] as string, /^application\/problem\+json/);
  const problem = res.json<{ code: string; correlationId: string }>();
  assert.equal(problem.code, 'UNAUTHORIZED');
  assert.ok(isUlid(problem.correlationId));
  assert.equal(logs[0]?.route, '/api/v1/uploads');
  await close();
});

test('a 5xx is logged where it is raised, with the correlation id, and stays opaque to the caller', async () => {
  const { app, errors, close } = await harness();
  app.get('/boom', async () => {
    throw new Error('the disk said something unrepeatable');
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(res.statusCode, 500);
  const problem = res.json<{ code: string; message: string; correlationId: string }>();
  assert.equal(problem.code, 'INTERNAL');
  assert.equal(problem.message, 'Internal error');
  assert.equal(errors[0]?.correlationId, problem.correlationId);
  await close();
});

// --- the upload --------------------------------------------------------------------------------

test('start → parts (out of order, one resent) → status → complete: the contract end to end', async () => {
  const { app, caller, close } = await harness();
  const size = PART * 2 + 50;
  const whole = randomBytes(size);

  const started = await app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: caller,
    payload: { filename: 'clip.mxf', sizeBytes: size, contentType: 'application/mxf' },
  });
  assert.equal(started.statusCode, 201, started.body);
  const upload = started.json<{
    uploadId: string;
    partSizeBytes: number;
    partCount: number;
    received: number[];
    state: string;
    expiresAt: string;
  }>();
  assert.ok(isUlid(upload.uploadId));
  assert.equal(upload.partSizeBytes, PART, 'the server says how to slice');
  assert.equal(upload.partCount, 3);
  assert.deepEqual(upload.received, []);
  assert.equal(upload.state, 'open');

  const put = (n: number, bytes: Buffer) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${upload.uploadId}/parts/${n}`,
      headers: octets(caller),
      payload: bytes,
    });
  assert.equal((await put(3, whole.subarray(PART * 2))).statusCode, 204);
  assert.equal((await put(1, whole.subarray(0, PART))).statusCode, 204);
  assert.equal((await put(1, whole.subarray(0, PART))).statusCode, 204, 'resent: still fine');

  // What a client resumes from after a dropped connection.
  const status = await app.inject({
    method: 'GET',
    url: `/api/v1/uploads/${upload.uploadId}`,
    headers: caller,
  });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json<{ received: number[] }>().received, [1, 3]);

  // Completing with a hole is a 409 that names the hole.
  const early = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${upload.uploadId}/complete`,
    headers: caller,
  });
  assert.equal(early.statusCode, 409);
  assert.deepEqual(early.json<{ details: { missing: number[] } }>().details.missing, [2]);

  assert.equal((await put(2, whole.subarray(PART, PART * 2))).statusCode, 204);
  const done = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${upload.uploadId}/complete`,
    headers: caller,
  });
  assert.equal(done.statusCode, 202, done.body);
  const job = done.json<{
    id: string;
    state: string;
    checksum: string;
    sizeBytes: number;
    filename: string;
    receivedPath?: string;
  }>();
  assert.equal(job.state, 'detected');
  assert.equal(job.sizeBytes, size);
  assert.equal(job.checksum, createHash('sha256').update(whole).digest('hex'));
  assert.equal(job.filename, 'clip.mxf');
  assert.equal(job.receivedPath, undefined, 'a disk path does not cross the wire');

  // Idempotent: the same job, not a second one.
  const again = await app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${upload.uploadId}/complete`,
    headers: caller,
  });
  assert.equal(again.statusCode, 202);
  assert.equal(again.json<{ id: string }>().id, job.id);
  await close();
});

test('a part of the wrong length is a 422, an oversized one a 413 — neither is a 500', async () => {
  const { app, caller, errors, close } = await harness();
  const { uploadId } = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: caller,
      payload: { filename: 'a.bin', sizeBytes: PART + 10 },
    })
  ).json<{ uploadId: string }>();

  const short = await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/parts/1`,
    headers: octets(caller),
    payload: randomBytes(PART - 1),
  });
  assert.equal(short.statusCode, 422);
  assert.match(short.json<{ message: string }>().message, /1024 bytes/);

  // Larger than any part may be: Fastify stops reading at the cap, and the taxonomy says 413.
  const huge = await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/parts/1`,
    headers: octets(caller),
    payload: randomBytes(PART + 1),
  });
  assert.equal(huge.statusCode, 413, huge.body);
  assert.equal(huge.json<{ code: string }>().code, 'PAYLOAD_TOO_LARGE');
  assert.match(huge.headers['content-type'] as string, /^application\/problem\+json/);

  // The wrong content type for bytes is a validation error, not a parse failure.
  const json = await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/parts/1`,
    headers: caller,
    payload: { not: 'bytes' },
  });
  assert.equal(json.statusCode, 422);
  assert.equal(errors.length, 0, 'none of these was a server error');
  await close();
});

test('a bad start is refused: no path as a filename, no zero-length file', async () => {
  const { app, caller, close } = await harness();
  for (const [payload, why] of [
    [{ filename: '../etc/passwd', sizeBytes: 10 }, /plain file name/],
    [{ filename: 'a.bin', sizeBytes: 0 }, /positive integer/],
    [{ sizeBytes: 10 }, /filename is required/],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: caller,
      payload,
    });
    assert.equal(res.statusCode, 422, res.body);
    assert.match(res.json<{ message: string }>().message, why);
  }
  await close();
});

test('DELETE abandons an upload; it is then not found', async () => {
  const { app, caller, close } = await harness();
  const { uploadId } = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: caller,
      payload: { filename: 'a.bin', sizeBytes: 10 },
    })
  ).json<{ uploadId: string }>();
  const gone = await app.inject({
    method: 'DELETE',
    url: `/api/v1/uploads/${uploadId}`,
    headers: caller,
  });
  assert.equal(gone.statusCode, 204);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}`, headers: caller }))
      .statusCode,
    404,
  );
  await close();
});

test("SECURITY: ingest:write for every upload route; another channel's upload is 404; no policy is 401", async () => {
  const writer = await harness();
  const { uploadId } = (
    await writer.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: writer.caller,
      payload: { filename: 'a.bin', sizeBytes: 10 },
    })
  ).json<{ uploadId: string }>();
  const other = { ...writer.caller, [INTERNAL_HEADERS.channel]: 'ch99' };
  assert.equal(
    (await writer.app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}`, headers: other }))
      .statusCode,
    404,
    "another channel's upload is not found — not forbidden",
  );
  await writer.close();

  const reader = await harness({ permissions: ['ingest:read'] });
  const refused = await reader.app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: reader.caller,
    payload: { filename: 'a.bin', sizeBytes: 10 },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json<{ code: string }>().code, 'FORBIDDEN');
  await reader.close();

  const nobody = await harness({ noPolicy: true });
  assert.equal(
    (
      await nobody.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: nobody.caller,
        payload: { filename: 'a.bin', sizeBytes: 10 },
      })
    ).statusCode,
    401,
  );
  await nobody.close();
});

// --- the queue, the review, the rules (EP-15.3 / EP-15.6) ----------------------------------------------

test('rule sets: create → get → list → replace → delete through the contract; a bad rule is a 422', async () => {
  const h = await harness({ permissions: ALL });
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/acceptance-rules',
    headers: h.caller,
    payload: {
      name: 'masters',
      scope: { sourceKind: 'upload' },
      rules: [{ kind: 'container', onFail: 'reject', containers: ['mxf'] }],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const set = created.json<{
    id: string;
    version: number;
    rules: { id: string }[];
    enabled: boolean;
  }>();
  assert.ok(isUlid(set.id));
  assert.ok(isUlid(set.rules[0]!.id), 'the rule id is minted');
  assert.equal(set.enabled, true);

  const listed = await h.app.inject({
    method: 'GET',
    url: '/api/v1/acceptance-rules',
    headers: h.caller,
  });
  assert.deepEqual(
    listed.json<{ id: string }[]>().map((x) => x.id),
    [set.id],
  );
  const one = await h.app.inject({
    method: 'GET',
    url: `/api/v1/acceptance-rules/${set.id}`,
    headers: h.caller,
  });
  assert.equal(one.statusCode, 200);

  const bad = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/acceptance-rules/${set.id}`,
    headers: h.caller,
    payload: { name: 'masters', rules: [{ kind: 'minSizeBytes', onFail: 'reject' }] },
  });
  assert.equal(bad.statusCode, 422, bad.body);
  assert.match(bad.json<{ message: string }>().message, /bytes/);

  const replaced = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/acceptance-rules/${set.id}`,
    headers: h.caller,
    payload: { name: 'masters v2', rules: [], enabled: false },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json<{ version: number }>().version, 2);

  assert.equal(
    (
      await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/acceptance-rules/${set.id}`,
        headers: h.caller,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await h.app.inject({
        method: 'GET',
        url: `/api/v1/acceptance-rules/${set.id}`,
        headers: h.caller,
      })
    ).statusCode,
    404,
  );
  await h.close();
});

test('the queue and the review: a quarantined job listed by state, accepted once, 409 after; a reject needs a reason', async () => {
  const h = await harness({ permissions: ALL });
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/acceptance-rules',
    headers: h.caller,
    payload: {
      name: 'no stubs',
      rules: [{ kind: 'minSizeBytes', onFail: 'quarantine', bytes: 1024 }],
    },
  });
  const a = await uploadOne(h, 'a.mxf');
  const b = await uploadOne(h, 'b.mxf');
  assert.equal(a.state, 'detected', 'the request answers before validation');
  await h.settle();

  // GET /ingest/{id}: what a client polls after completing.
  const polled = await h.app.inject({
    method: 'GET',
    url: `/api/v1/ingest/${a.id}`,
    headers: h.caller,
  });
  assert.equal(polled.statusCode, 200);
  const held = polled.json<{
    state: string;
    reason?: string;
    ruleId?: string;
    receivedPath?: string;
    technicalMetadata?: { videoCodec?: string; width?: number };
  }>();
  assert.equal(held.state, 'quarantined');
  assert.match(held.reason ?? '', /under the minimum/);
  assert.ok(isUlid(held.ruleId ?? ''));
  assert.equal(held.receivedPath, undefined, 'a disk path does not cross the wire');
  assert.equal(
    held.technicalMetadata?.videoCodec,
    'mpeg2video',
    'what the probe read is on the wire',
  );
  assert.equal(held.technicalMetadata?.width, 1920);

  // The queue: the page shape, newest first, filtered by state.
  const queue = await h.app.inject({
    method: 'GET',
    url: '/api/v1/ingest/queue?state=quarantined&limit=1',
    headers: h.caller,
  });
  assert.equal(queue.statusCode, 200, queue.body);
  const page = queue.json<{
    items: { id: string; receivedPath?: string }[];
    nextCursor?: string;
  }>();
  assert.deepEqual(
    page.items.map((j) => j.id),
    [b.id],
  );
  assert.equal(page.nextCursor, b.id);
  assert.equal(page.items[0]!.receivedPath, undefined);
  const next = await h.app.inject({
    method: 'GET',
    url: `/api/v1/ingest/queue?state=quarantined&limit=1&cursor=${page.nextCursor}`,
    headers: h.caller,
  });
  const page2 = next.json<{ items: { id: string }[]; nextCursor?: string }>();
  assert.deepEqual(
    page2.items.map((j) => j.id),
    [a.id],
  );
  assert.equal(page2.nextCursor, undefined, 'the end is the absence of a cursor');
  for (const q of ['limit=0', 'limit=201', 'state=lost', 'order=sideways', 'cursor=nope']) {
    const r = await h.app.inject({
      method: 'GET',
      url: `/api/v1/ingest/queue?${q}`,
      headers: h.caller,
    });
    assert.equal(r.statusCode, 422, q);
  }

  // The review.
  const accepted = await h.app.inject({
    method: 'POST',
    url: `/api/v1/ingest/${a.id}/accept`,
    headers: h.caller,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json<{ state: string; reason?: string }>().state, 'accepted');
  assert.equal(accepted.json<{ reason?: string }>().reason, undefined);
  const again = await h.app.inject({
    method: 'POST',
    url: `/api/v1/ingest/${a.id}/accept`,
    headers: h.caller,
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json<{ code: string }>().code, 'CONFLICT');

  const noReason = await h.app.inject({
    method: 'POST',
    url: `/api/v1/ingest/${b.id}/reject`,
    headers: h.caller,
    payload: {},
  });
  assert.equal(noReason.statusCode, 422);
  const rejected = await h.app.inject({
    method: 'POST',
    url: `/api/v1/ingest/${b.id}/reject`,
    headers: h.caller,
    payload: { reason: 'not ours' },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json<{ state: string; reason: string }>().reason, 'not ours');
  assert.equal(
    (
      await h.app.inject({
        method: 'GET',
        url: '/api/v1/ingest/queue?state=quarantined',
        headers: h.caller,
      })
    ).json<{ items: unknown[] }>().items.length,
    0,
  );
  await h.close();
});

test("SECURITY: ingest:read for the queue, ingest:approve for the review, ingest:admin for the rules; another channel's job is 404", async () => {
  const admin = await harness({ permissions: ALL });
  await admin.app.inject({
    method: 'POST',
    url: '/api/v1/acceptance-rules',
    headers: admin.caller,
    payload: {
      name: 'hold all',
      rules: [{ kind: 'maxSizeBytes', onFail: 'quarantine', bytes: 1 }],
    },
  });
  const job = await uploadOne(admin, 'x.mxf');
  await admin.settle();
  const other = { ...admin.caller, [INTERNAL_HEADERS.channel]: 'ch99' };
  for (const [method, url] of [
    ['GET', `/api/v1/ingest/${job.id}`],
    ['POST', `/api/v1/ingest/${job.id}/accept`],
    ['POST', `/api/v1/ingest/${job.id}/reject`],
  ] as const) {
    const r = await admin.app.inject({ method, url, headers: other, payload: { reason: 'x' } });
    assert.equal(r.statusCode, 404, `${method} ${url} from another channel`);
  }
  assert.equal(
    (await admin.app.inject({ method: 'GET', url: '/api/v1/ingest/queue', headers: other })).json<{
      items: unknown[];
    }>().items.length,
    0,
    "another channel's queue is empty, not forbidden",
  );

  // A reader sees the queue and nothing else; a writer cannot review; an approver cannot administer.
  const matrix: [string[], string, string, number][] = [
    [['ingest:read'], 'GET', '/api/v1/ingest/queue', 200],
    [['ingest:write'], 'GET', '/api/v1/ingest/queue', 403],
    [['ingest:read'], 'POST', `/api/v1/ingest/${job.id}/accept`, 403],
    [['ingest:write'], 'POST', `/api/v1/ingest/${job.id}/reject`, 403],
    [['ingest:approve'], 'GET', '/api/v1/acceptance-rules', 403],
    [['ingest:approve'], 'POST', '/api/v1/acceptance-rules', 403],
    [['ingest:read'], 'DELETE', '/api/v1/acceptance-rules/01H0000000000000000000000Z', 403],
  ];
  for (const [permissions, method, url, status] of matrix) {
    // Same store, so the same job: a second app over it with a narrower policy.
    const app = await buildRimApp({
      service: admin.service,
      partSizeBytes: PART,
      policyFor: () => policyFor(permissions),
    });
    const r = await app.inject({
      method: method as 'GET',
      url,
      headers: admin.caller,
      payload: { reason: 'x', name: 'n', rules: [] },
    });
    assert.equal(r.statusCode, status, `${permissions.join(',')} ${method} ${url}`);
    if (status === 403) assert.equal(r.json<{ code: string }>().code, 'FORBIDDEN');
    await app.close();
  }
  await admin.close();
});
