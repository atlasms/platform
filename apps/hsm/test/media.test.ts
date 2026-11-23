// HSM's media route (ADR-0012): a browser reads a file through a URL MAM signed — no bearer, the
// signature is the credential. Real bytes on a temporary filesystem target.
//
// What must hold: a valid URL serves the file whole, or the one range asked for (206), or 416 past
// the end; every request is re-checked against the ledger — another channel's file is a missing
// one (#577), a file not online is a 409 (restore first); an altered, expired or unsigned URL is a
// 403 and its query never reaches a log; and the response can never be a page that runs script.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@atlas/contracts';
import { signInternalDigest, signMediaUrl, type MediaGrant } from '@atlas/service-kit';
import {
  buildHsmApp,
  driverFactory,
  HsmService,
  parseRange,
  sqliteHsmStore,
} from '../src/index.ts';

const KEY = 'k'.repeat(40);
const MEDIA_KEY = 'm'.repeat(40);
const NOW = new Date('2026-11-23T12:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const BODY = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

async function harness(mediaKeys: string[] = [MEDIA_KEY]) {
  const base = await mkdtemp(join(tmpdir(), 'hsm-media-'));
  const store = sqliteHsmStore();
  const service = new HsmService({ store, drivers: driverFactory({ credentialsDir: base }) });
  await service.bootstrapTarget(base);
  const refusals: { reason: string; path: string }[] = [];
  const errors: string[] = [];
  const app = await buildHsmApp({
    service,
    policyFor: () => undefined,
    internalKeys: [KEY],
    mediaKeys,
    onMediaRefused: (reason, ctx) => refusals.push({ reason, path: ctx.path }),
    onError: (_err, ctx) => errors.push(ctx.url),
    fsBase: base,
    now: () => NOW,
  });
  /** Place a file as a producer does (ADR-0009). */
  const place = async (assetId: string, channelId = 'ch12', variant?: string) => {
    const url = `/internal/v1/assets/${assetId}/files/proxy?channelId=${channelId}&producedBy=transcode${
      variant ? `&variant=${variant}` : ''
    }`;
    const res = await app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-atlas-internal': signInternalDigest(
          KEY,
          { method: 'PUT', path: url, bodySha256: sha(BODY) },
          NOW,
        ),
      },
      payload: BODY,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string };
  };
  return {
    app,
    store,
    place,
    refusals,
    errors,
    close: async () => {
      await app.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

const grant = (assetId: string, over: Partial<MediaGrant> = {}): MediaGrant => ({
  channelId: 'ch12',
  assetId,
  kind: 'proxy',
  variant: 'edit',
  contentType: 'video/mp4',
  exp: T + 1800,
  ...over,
});

test('a signed URL serves the file — whole, or the one range asked for — with no bearer', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    await h.place(assetId, 'ch12', 'edit');
    const url = signMediaUrl(MEDIA_KEY, grant(assetId));

    const whole = await h.app.inject({ method: 'GET', url });
    assert.equal(whole.statusCode, 200, whole.body);
    assert.deepEqual(whole.rawPayload, BODY);
    assert.equal(whole.headers['content-length'], String(BODY.length));
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(whole.headers['etag'], `"${sha(BODY)}"`);
    assert.equal(whole.headers['cache-control'], 'private, max-age=1800');
    // Never a page that runs script, whatever the content type says.
    assert.equal(whole.headers['x-content-type-options'], 'nosniff');
    assert.equal(whole.headers['content-security-policy'], "default-src 'none'; sandbox");

    const part = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=100-199' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 100-199/${BODY.length}`);
    assert.equal(part.headers['content-length'], '100');
    assert.deepEqual(part.rawPayload, BODY.subarray(100, 200));

    const tail = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=-10' } });
    assert.deepEqual(tail.rawPayload, BODY.subarray(BODY.length - 10));

    const past = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=99999-' } });
    assert.equal(past.statusCode, 416);
    assert.equal(past.headers['content-range'], `bytes */${BODY.length}`);

    // A range under a stale If-Range: the whole of the current file.
    const stale = await h.app.inject({
      method: 'GET',
      url,
      headers: { range: 'bytes=0-9', 'if-range': '"another"' },
    });
    assert.equal(stale.statusCode, 200);

    const cached = await h.app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': `"${sha(BODY)}"` },
    });
    assert.equal(cached.statusCode, 304);
  } finally {
    await h.close();
  }
});

test('an altered, expired or unsigned URL is a 403 — and its query never reaches a log', async () => {
  const h = await harness();
  try {
    const assetId = ulid();
    await h.place(assetId, 'ch12', 'edit');
    const url = signMediaUrl(MEDIA_KEY, grant(assetId));
    const refused = async (u: string) => (await h.app.inject({ method: 'GET', url: u })).statusCode;

    assert.equal(await refused(url.replace('/proxy?', '/original?')), 403, 'another kind');
    assert.equal(await refused(url.replace('ch=ch12', 'ch=ch99')), 403, 'another channel');
    assert.equal(await refused(url.replace('ct=video%2Fmp4', 'ct=text%2Fhtml')), 403);
    assert.equal(await refused(url.split('&sig=')[0]!), 403, 'unsigned');
    assert.equal(
      await refused(signMediaUrl(MEDIA_KEY, grant(assetId, { exp: T - 1 }))),
      403,
      'expired',
    );
    assert.equal(await refused(signMediaUrl('x'.repeat(40), grant(assetId))), 403, 'another key');
    assert.ok(h.refusals.length >= 6);
    for (const r of h.refusals) {
      assert.ok(!r.path.includes('?'), `logged without its query: ${r.path}`);
    }
  } finally {
    await h.close();
  }
});

test('the ledger is re-checked on every request: another channel’s file is missing, a file not online is 409', async () => {
  const h = await harness();
  try {
    // A file of ch99, under a URL signed for ch12 (the signature is valid; the channel is not its).
    const theirs = ulid();
    await h.place(theirs, 'ch99', 'edit');
    const cross = await h.app.inject({
      method: 'GET',
      url: signMediaUrl(MEDIA_KEY, grant(theirs)),
    });
    assert.equal(cross.statusCode, 404, 'answered exactly as a missing file (#577)');

    // A file that has gone near-line since the URL was signed.
    const assetId = ulid();
    const placed = await h.place(assetId, 'ch12', 'edit');
    const file = (await h.store.liveFile(assetId, 'proxy', 'edit'))!;
    assert.equal(file.id, placed.id);
    await h.store.transaction((tx) =>
      tx.putFile(
        { ...file, storage: { ...file.storage, tier: 'near-line' }, version: file.version + 1 },
        file.version,
      ),
    );
    const cold = await h.app.inject({
      method: 'GET',
      url: signMediaUrl(MEDIA_KEY, grant(assetId)),
    });
    assert.equal(cold.statusCode, 409);
  } finally {
    await h.close();
  }
});

test('with no media key configured, every media URL is refused', async () => {
  const h = await harness([]);
  try {
    const assetId = ulid();
    await h.place(assetId, 'ch12', 'edit');
    const res = await h.app.inject({ method: 'GET', url: signMediaUrl(MEDIA_KEY, grant(assetId)) });
    assert.equal(res.statusCode, 403);
    assert.equal(h.refusals[0]?.reason, 'no media URL key configured');
  } finally {
    await h.close();
  }
});

test('Range: one range is served, anything else is the whole file, past the end is unsatisfiable', () => {
  assert.deepEqual(parseRange(undefined, 100), { kind: 'whole' });
  assert.deepEqual(parseRange('bytes=0-9', 100), { kind: 'partial', range: { start: 0, end: 9 } });
  assert.deepEqual(parseRange('bytes=90-', 100), {
    kind: 'partial',
    range: { start: 90, end: 99 },
  });
  assert.deepEqual(parseRange('bytes=90-500', 100), {
    kind: 'partial',
    range: { start: 90, end: 99 },
  });
  assert.deepEqual(parseRange('bytes=-5', 100), { kind: 'partial', range: { start: 95, end: 99 } });
  assert.deepEqual(parseRange('bytes=-500', 100), {
    kind: 'partial',
    range: { start: 0, end: 99 },
  });
  assert.deepEqual(parseRange('bytes=100-', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=0-9,20-29', 100), { kind: 'whole' }, 'several: ignored');
  assert.deepEqual(parseRange('items=0-9', 100), { kind: 'whole' });
  assert.deepEqual(parseRange('bytes=9-0', 100), { kind: 'whole' });
});
