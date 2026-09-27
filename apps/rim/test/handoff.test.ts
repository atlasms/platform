// The recorder's hand-off over HTTP (EP-39; ADR-0008): a finished capture's file reaches RIM
// through SIGNED internal routes, and nothing else does. A signed request moves the file and makes
// the recorder's job; an unsigned, tampered, foreign-key or stale one is one bare 401, counted and
// logged with its reason; and a recorder's upload is invisible to the gateway-facing routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '@atlas/policy';
import { INTERNAL_SIGNATURE_HEADER, signInternal } from '@atlas/service-kit';
import {
  buildRimApp,
  handOffFilename,
  httpHandOff,
  fakeProbe,
  fsStaging,
  INTERNAL_HEADERS,
  RimService,
  sqliteRimStore,
} from '../src/index.ts';

const CH = 'ch12';
const KEY = 'recorder-key-'.padEnd(40, 'x');
const PART = 1024;
const NOW = new Date('2026-09-14T13:10:00.000Z');

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'rim-handoff-'));
  const store = sqliteRimStore();
  const service = new RimService({
    store,
    staging: fsStaging(dir),
    probe: fakeProbe(),
    partSizeBytes: PART,
    now: () => NOW,
    defer: () => undefined,
  });
  const refusals: string[] = [];
  const app = await buildRimApp({
    service,
    partSizeBytes: PART,
    policyFor: () =>
      compile({
        subjectId: 'user-1',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['ingest:read', 'ingest:write', 'ingest:admin'] }],
      }),
    internalKeys: [KEY],
    onInternalRefused: (reason) => refusals.push(reason),
    now: () => NOW,
  });
  const admin = {
    userId: 'user-1',
    channelId: CH,
    policy: compile({
      subjectId: 'user-1',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['ingest:admin'] }],
    }),
  };
  // A recorder, its first capture leased and finished — what a worker would hold.
  const recorder = await service.createRecorder(admin, {
    name: 'air',
    input: { url: 'udp://239.1.1.1:5000' },
    timezone: 'UTC',
    windows: [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '13:00', to: '15:00' },
    ],
  });
  const [capture] = await store.captures(recorder.id, '2000-01-01T00:00:00.000Z', 1);
  await store.transaction((tx) =>
    tx.leaseCapture(
      capture!.id,
      'pod-a',
      NOW.toISOString(),
      new Date(NOW.getTime() + 30_000).toISOString(),
    ),
  );
  const running = (await store.capture(capture!.id))!;
  await store.transaction((tx) =>
    tx.putCapture({ ...running, state: 'completed', endedAt: NOW.toISOString() }, 'running'),
  );
  const close = async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { app, store, service, recorder, captureId: capture!.id, refusals, close };
}

/** A signed internal request, as the worker sends it: the header covers these exact bytes. */
function signed(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body: string | Buffer = '',
  over: { key?: string; at?: Date; contentType?: string } = {},
) {
  const contentType =
    over.contentType ?? (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json');
  return {
    method,
    url,
    headers: {
      'content-type': contentType,
      [INTERNAL_SIGNATURE_HEADER]: signInternal(
        over.key ?? KEY,
        { method, path: url, body },
        over.at ?? NOW,
      ),
    },
    ...(body.length > 0 ? { payload: body } : {}),
  };
}

test("a signed hand-off moves a capture's file into RIM as the RECORDER's job", async () => {
  const h = await harness();
  try {
    const bytes = randomBytes(1500);
    const started = await h.app.inject(
      signed(
        'POST',
        `/internal/v1/captures/${h.captureId}/upload`,
        JSON.stringify({ filename: 'air-1300.ts', sizeBytes: 1500 }),
      ),
    );
    assert.equal(started.statusCode, 201, started.body);
    const { uploadId, partCount } = started.json<{ uploadId: string; partCount: number }>();
    assert.equal(partCount, 2);
    for (const [n, part] of [
      [2, bytes.subarray(PART)],
      [1, bytes.subarray(0, PART)],
    ] as const) {
      const put = await h.app.inject(
        signed('PUT', `/internal/v1/uploads/${uploadId}/parts/${n}`, Buffer.from(part)),
      );
      assert.equal(put.statusCode, 204, put.body);
    }
    const status = await h.app.inject(signed('GET', `/internal/v1/uploads/${uploadId}`));
    assert.deepEqual(status.json<{ received: number[] }>().received, [1, 2]);
    const done = await h.app.inject(signed('POST', `/internal/v1/uploads/${uploadId}/complete`));
    assert.equal(done.statusCode, 202, done.body);
    const job = done.json<{ id: string; source: string; sourceKind: string; createdBy: string }>();
    assert.deepEqual(
      [job.source, job.sourceKind, job.createdBy],
      [h.recorder.id, 'recorder', 'rim-recorder'],
    );
    assert.equal((await h.store.capture(h.captureId))?.jobId, job.id);

    // The gateway-facing routes do not know this upload — status, parts and abort alike.
    const user = { [INTERNAL_HEADERS.user]: 'user-1', [INTERNAL_HEADERS.channel]: CH };
    for (const req of [
      { method: 'GET' as const, url: `/api/v1/uploads/${uploadId}` },
      { method: 'DELETE' as const, url: `/api/v1/uploads/${uploadId}` },
    ]) {
      assert.equal((await h.app.inject({ ...req, headers: user })).statusCode, 404);
    }
  } finally {
    await h.close();
  }
});

test('an unsigned, tampered, foreign or stale request is one bare 401, counted, its reason logged', async () => {
  const h = await harness();
  try {
    const url = `/internal/v1/captures/${h.captureId}/upload`;
    const body = JSON.stringify({ filename: 'x.ts', sizeBytes: 10 });
    const good = signed('POST', url, body);
    const attempts = [
      { ...good, headers: { 'content-type': 'application/json' } }, // unsigned
      { ...good, payload: JSON.stringify({ filename: 'y.ts', sizeBytes: 10 }) }, // body changed
      signed('POST', url, body, { key: 'another-key-'.padEnd(40, 'y') }),
      signed('POST', url, body, { at: new Date(NOW.getTime() - 120_000) }),
    ];
    for (const attempt of attempts) {
      const res = await h.app.inject(attempt);
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json<{ message: string }>().message, 'not an internal request');
    }
    assert.deepEqual(h.refusals, [
      'unsigned',
      'bad signature',
      'bad signature',
      'signature outside the time window',
    ]);
    const metrics = await h.app.inject({ method: 'GET', url: '/metrics' });
    assert.match(metrics.body, /atlas_rim_internal_refused_total 4/);
    // Gateway headers are no way in either.
    const asUser = await h.app.inject({
      method: 'POST',
      url,
      headers: {
        [INTERNAL_HEADERS.user]: 'user-1',
        [INTERNAL_HEADERS.channel]: CH,
        'content-type': 'application/json',
      },
      payload: body,
    });
    assert.equal(asUser.statusCode, 401);
  } finally {
    await h.close();
  }
});

test("the worker's client, over real HTTP: every request it signs is one RIM accepts, and the file arrives whole", async () => {
  const h = await harness();
  try {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const address = h.app.server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const bytes = randomBytes(PART * 2 + 300); // three parts, the last short
    const file = join(tmpdir(), `handoff-${Date.now()}.ts`);
    await writeFile(file, bytes);
    const capture = (await h.store.capture(h.captureId))!;
    const { jobId } = await httpHandOff({ origin, key: KEY, now: () => NOW }).handOver(
      capture,
      file,
    );
    const job = (await h.store.job(jobId))!;
    assert.deepEqual(
      [job.sourceKind, job.source, job.sizeBytes],
      ['recorder', h.recorder.id, bytes.length],
    );
    assert.equal(job.filename, handOffFilename(capture));
    assert.match(job.filename, /^rec_20260914T\d{6}Z_p1\.ts$/);
    assert.equal(h.refusals.length, 0);
    await rm(file, { force: true });
  } finally {
    await h.close();
  }
});
