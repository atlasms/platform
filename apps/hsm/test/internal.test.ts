// HSM's internal surface over the wire (ADR-0009): a producer's file streamed and signed over its
// digest; what is refused BEFORE the body is read, and what AFTER; an input read back signed; an
// operation requested, idempotently. Real bytes, a temporary directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@atlas/contracts';
import { compile } from '@atlas/policy';
import { signInternal, signInternalDigest } from '@atlas/service-kit';
import {
  buildHsmApp,
  driverFactory,
  HsmService,
  INTERNAL_HEADERS,
  sqliteHsmStore,
} from '../src/index.ts';

const KEY = 'k'.repeat(40);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

async function harness() {
  const base = await mkdtemp(join(tmpdir(), 'hsm-http-'));
  const store = sqliteHsmStore();
  const service = new HsmService({ store, drivers: driverFactory({ credentialsDir: base }) });
  await service.bootstrapTarget(base);
  const refusals: string[] = [];
  const app = await buildHsmApp({
    service,
    policyFor: () =>
      compile({
        subjectId: 'u1',
        permVersion: 1,
        rules: [{ id: 'r', permissions: ['asset:read', 'storage:admin'] }],
        roles: [],
        groups: [],
      }),
    internalKeys: [KEY],
    onInternalRefused: (reason) => refusals.push(reason),
    fsBase: base,
  });
  return {
    app,
    base,
    refusals,
    close: async () => {
      await app.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

const place = (assetId: string, query = 'channelId=ch12&producedBy=transcode') =>
  `/internal/v1/assets/${assetId}/files/proxy?${query}`;

test('a producer places a file: signed over its digest, streamed, recorded with HSM’s own checksum', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    const body = Buffer.from('proxy rendition bytes');
    const url = place(
      assetId,
      'channelId=ch12&producedBy=transcode&technical=%7B%22container%22%3A%22mp4%22%7D',
    );
    const res = await h.app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-atlas-internal': signInternalDigest(KEY, {
          method: 'PUT',
          path: url,
          bodySha256: sha(body),
        }),
      },
      payload: body,
    });
    assert.equal(res.statusCode, 201, res.body);
    const file = res.json();
    assert.deepEqual(file.checksum, { algorithm: 'sha256', value: sha(body) });
    assert.equal(file.sizeBytes, body.length);
    assert.deepEqual(file.technical, { container: 'mp4' });

    // Read back, signed — what MTS does for an input.
    const content = `/internal/v1/assets/${assetId}/files/proxy/content`;
    const got = await h.app.inject({
      method: 'GET',
      url: content,
      headers: { 'x-atlas-internal': signInternal(KEY, { method: 'GET', path: content }) },
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers['x-atlas-sha256'], sha(body));
    assert.equal(got.rawPayload.toString(), body.toString());

    // Through the public surface, with a caller the gateway established.
    const where = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${assetId}/location`,
      headers: { [INTERNAL_HEADERS.user]: 'u1', [INTERNAL_HEADERS.channel]: 'ch12' },
    });
    assert.equal(where.statusCode, 200);
    assert.deepEqual(
      where.json().map((f: { kind: string; replicas: unknown[] }) => [f.kind, f.replicas]),
      [['proxy', []]],
    );
  } finally {
    await h.close();
  }
});

test('refused BEFORE the body: unsigned, stale — and AFTER it: bytes that are not the ones signed, which are removed', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    const url = place(assetId);
    const body = Buffer.from('the real bytes');

    const unsigned = await h.app.inject({
      method: 'PUT',
      url,
      headers: { 'content-type': 'application/octet-stream' },
      payload: body,
    });
    assert.equal(unsigned.statusCode, 401);
    const stale = await h.app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-atlas-internal': signInternalDigest(
          KEY,
          { method: 'PUT', path: url, bodySha256: sha(body) },
          new Date(Date.now() - 120_000),
        ),
      },
      payload: body,
    });
    assert.equal(stale.statusCode, 401);

    const tampered = await h.app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-atlas-internal': signInternalDigest(KEY, {
          method: 'PUT',
          path: url,
          bodySha256: sha(body),
        }),
      },
      payload: Buffer.from('other bytes, same size'),
    });
    assert.equal(tampered.statusCode, 401);
    assert.deepEqual(h.refusals, [
      'unsigned',
      'signature outside the time window',
      'bad signature',
    ]);
    // Nothing was kept: the only entries left are HSM's own directories.
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(...(await walk(join(d, e.name))));
        else out.push(e.name);
      }
      return out;
    };
    assert.deepEqual(await walk(h.base), []);

    // The query is inside the signature: changing the channel breaks it.
    const signedFor = signInternalDigest(KEY, { method: 'PUT', path: url, bodySha256: sha(body) });
    const moved = await h.app.inject({
      method: 'PUT',
      url: url.replace('ch12', 'ch99'),
      headers: { 'content-type': 'application/octet-stream', 'x-atlas-internal': signedFor },
      payload: body,
    });
    assert.equal(moved.statusCode, 401);
  } finally {
    await h.close();
  }
});

test('an operation is requested signed, idempotently by its id; a bad request names the field', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    const url = place(assetId);
    const body = Buffer.from('x');
    const placed = await h.app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-atlas-internal': signInternalDigest(KEY, {
          method: 'PUT',
          path: url,
          bodySha256: sha(body),
        }),
      },
      payload: body,
    });
    const fileId = placed.json().id as string;
    const post = (payload: object) => {
      const raw = JSON.stringify(payload);
      const path = '/internal/v1/files/operations';
      return h.app.inject({
        method: 'POST',
        url: path,
        headers: {
          'content-type': 'application/json',
          'x-atlas-internal': signInternal(KEY, { method: 'POST', path, body: raw }),
        },
        payload: raw,
      });
    };
    const id = ulid();
    const first = await post({ id, kind: 'delete', fileId, requestedBy: 'test' });
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(first.json().state, 'queued');
    assert.equal((await post({ id, kind: 'delete', fileId })).json().id, id);
    const bad = await post({ kind: 'teleport', fileId });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.json().message, /kind must be/);

    // Its progress, publicly, in the caller's channel.
    const seen = await h.app.inject({
      method: 'GET',
      url: `/api/v1/operations/${id}`,
      headers: { [INTERNAL_HEADERS.user]: 'u1', [INTERNAL_HEADERS.channel]: 'ch12' },
    });
    assert.equal(seen.statusCode, 200);
    assert.equal(seen.json().holder, undefined, 'the lease is the workers’ business');
  } finally {
    await h.close();
  }
});
