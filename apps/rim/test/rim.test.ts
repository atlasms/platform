// The shape every Atlas service shares (generated with the scaffold, and kept), plus the upload's
// HTTP surface: every route in the contract, its authorization, and the resumable upload as a
// client sees it — the part size announced, a part refused by length, a resume, a 413 that is a
// 413, completion idempotent.

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
  const service = new RimService({ store, staging: fsStaging(dir), partSizeBytes: PART });
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
  return { app, store, service, logs, errors, caller, close };
}

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
