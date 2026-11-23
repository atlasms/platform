// The gateway's streaming route (ADR-0012): `/media/` is public — the signed URL is the credential,
// checked by HSM — and its body is BYTES, piped through untouched: binary preserved, `Range`
// forwarded, the byte-range answer and the safety headers relayed, GET and HEAD only, and the URL's
// query (its signature) kept out of the edge log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestKey } from '@atlas/service-kit';
import { buildGateway, type AccessLogRecord } from '../src/index.ts';

const routes = [
  { service: 'mam', origin: 'http://mam:3000', prefix: '/api/v1/assets' },
  { service: 'hsm', origin: 'http://hsm:3000', prefix: '/media/', public: true, stream: true },
];

/** Bytes a JSON relay would mangle: every value 0–255, invalid UTF-8 among them. */
const BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));

async function gateway() {
  const key = await generateTestKey();
  const sent: Array<{ url: string; method: string; headers: Headers }> = [];
  const logs: AccessLogRecord[] = [];
  const app = buildGateway({
    jwks: key.jwks,
    routes,
    onAccessLog: (r) => logs.push(r),
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      sent.push({ url, method: init?.method ?? 'GET', headers });
      const range = headers.get('range');
      const body = range === 'bytes=10-19' ? BYTES.subarray(10, 20) : BYTES;
      return new Response(init?.method === 'HEAD' ? null : body, {
        status: range === 'bytes=10-19' ? 206 : 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
          ...(range === 'bytes=10-19' ? { 'content-range': `bytes 10-19/${BYTES.length}` } : {}),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'x-not-relayed': 'internal',
        },
      });
    }) as typeof fetch,
  });
  return { app, sent, logs };
}

const URL_ = '/media/v1/01K00000000000000000000AST/proxy?ch=ch12&v=edit&exp=1&sig=abc';

test('a media URL needs no bearer, and its bytes come through untouched', async () => {
  const { app, sent } = await gateway();
  const res = await app.inject({ method: 'GET', url: URL_ });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, BYTES, 'binary, byte for byte');
  assert.equal(sent[0]!.url, `http://hsm:3000${URL_}`, 'the signed query forwarded as it came');
  assert.equal(
    sent[0]!.headers.get('x-atlas-user'),
    null,
    'no identity: the signature is HSM’s to check',
  );
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(res.headers['x-not-relayed'], undefined);
  await app.close();
});

test('Range is forwarded and the 206 relayed with its Content-Range', async () => {
  const { app, sent } = await gateway();
  const res = await app.inject({
    method: 'GET',
    url: URL_,
    headers: { range: 'bytes=10-19', 'if-range': '"abc"' },
  });
  assert.equal(sent[0]!.headers.get('range'), 'bytes=10-19');
  assert.equal(sent[0]!.headers.get('if-range'), '"abc"');
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 10-19/${BYTES.length}`);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.deepEqual(res.rawPayload, BYTES.subarray(10, 20));
  await app.close();
});

test('GET and HEAD only; the edge log keeps the path, never the signature', async () => {
  const { app, sent, logs } = await gateway();
  const head = await app.inject({ method: 'HEAD', url: URL_ });
  assert.equal(head.statusCode, 200);
  assert.equal(head.rawPayload.length, 0);
  const post = await app.inject({ method: 'POST', url: URL_, payload: 'x' });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers['allow'], 'GET, HEAD');
  assert.equal(sent.length, 1, 'the POST never reached HSM');
  for (const record of logs) {
    assert.ok(!record.path.includes('sig='), `logged without its query: ${record.path}`);
  }
  await app.close();
});
