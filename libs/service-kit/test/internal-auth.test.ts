// Signed internal requests (ADR-0008): a request signed by a key the verifier holds is accepted;
// one altered in method, path, query or body, stale, unsigned, or signed by another key is not;
// a rotation holds both keys; a short key is refused at configuration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  internalKeys,
  preflightInternal,
  signInternal,
  signInternalDigest,
  verifyInternal,
  verifyInternalDigest,
} from '../src/index.ts';

const KEY = 'k'.repeat(32);
const OTHER = 'o'.repeat(32);
const now = new Date('2026-09-27T12:00:00Z');
const req = {
  method: 'PUT',
  path: '/internal/v1/uploads/01H/parts/2?x=1',
  body: new Uint8Array([1, 2, 3]),
};

test('a request signed with a held key is accepted', () => {
  assert.deepEqual(verifyInternal([KEY], req, signInternal(KEY, req, now), now), { ok: true });
});

test('what the signature covers cannot be changed: method, path, query, body', () => {
  const header = signInternal(KEY, req, now);
  for (const changed of [
    { ...req, method: 'POST' },
    { ...req, path: '/internal/v1/uploads/01H/parts/3?x=1' },
    { ...req, path: '/internal/v1/uploads/01H/parts/2?x=2' },
    { ...req, body: new Uint8Array([1, 2, 4]) },
  ]) {
    assert.deepEqual(verifyInternal([KEY], changed, header, now), {
      ok: false,
      reason: 'bad signature',
    });
  }
});

test('stale, unsigned, malformed and foreign signatures are refused', () => {
  const header = signInternal(KEY, req, now);
  const later = new Date(now.getTime() + 61_000);
  assert.equal(verifyInternal([KEY], req, header, later).ok, false);
  assert.equal(verifyInternal([KEY], req, header, new Date(now.getTime() + 59_000)).ok, true);
  assert.deepEqual(verifyInternal([KEY], req, undefined, now), { ok: false, reason: 'unsigned' });
  assert.deepEqual(verifyInternal([KEY], req, 'v1,t=1,sig=zz', now), {
    ok: false,
    reason: 'malformed signature',
  });
  assert.equal(verifyInternal([KEY], req, signInternal(OTHER, req, now), now).ok, false);
  assert.deepEqual(verifyInternal([], req, header, now), {
    ok: false,
    reason: 'no internal key configured',
  });
});

test('a rotation: the verifier holds both keys, so either signer is accepted', () => {
  const keys = internalKeys(`${OTHER}, ${KEY}`);
  assert.deepEqual(keys, [OTHER, KEY]);
  assert.equal(verifyInternal(keys, req, signInternal(KEY, req, now), now).ok, true);
  assert.equal(verifyInternal(keys, req, signInternal(OTHER, req, now), now).ok, true);
});

test('a key shorter than 32 bytes is refused at configuration — without echoing it', () => {
  assert.throws(
    () => internalKeys(`${KEY},short-key`),
    (err: Error) => {
      assert.match(err.message, /shorter than 32 bytes/);
      assert.ok(!err.message.includes('short-key'));
      return true;
    },
  );
});

test('ADR-0009: a digest signature verifies the same bytes as a body signature, and nothing else', () => {
  const key = 'k'.repeat(32);
  const body = Buffer.from('the bytes of a rendition');
  const sha = createHash('sha256').update(body).digest('hex');
  const now = new Date('2026-10-01T12:00:00.000Z');
  const req = { method: 'PUT', path: '/internal/v1/assets/A/files/proxy' };
  const signed = signInternalDigest(key, { ...req, bodySha256: sha }, now);
  // The string signed is the same one `signInternal` signs for those bytes.
  assert.equal(signed, signInternal(key, { ...req, body }, now));
  assert.deepEqual(verifyInternalDigest([key], { ...req, bodySha256: sha }, signed, now), {
    ok: true,
  });
  assert.deepEqual(verifyInternal([key], { ...req, body }, signed, now), { ok: true });
  // Other bytes, another path: refused.
  const other = createHash('sha256').update('tampered').digest('hex');
  assert.deepEqual(verifyInternalDigest([key], { ...req, bodySha256: other }, signed, now), {
    ok: false,
    reason: 'bad signature',
  });
  assert.equal(
    verifyInternalDigest([key], { ...req, path: '/internal/v1/x', bodySha256: sha }, signed, now)
      .ok,
    false,
  );
});

test('ADR-0009: the preflight refuses what needs no body — before a stream is read', () => {
  const key = 'k'.repeat(32);
  const now = new Date('2026-10-01T12:00:00.000Z');
  const signed = signInternalDigest(
    key,
    { method: 'PUT', path: '/p', bodySha256: 'a'.repeat(64) },
    now,
  );
  assert.deepEqual(preflightInternal([key], signed, now), { ok: true });
  assert.deepEqual(preflightInternal([key], undefined, now), { ok: false, reason: 'unsigned' });
  assert.deepEqual(preflightInternal([], signed, now), {
    ok: false,
    reason: 'no internal key configured',
  });
  assert.deepEqual(preflightInternal([key], signed, new Date(now.getTime() + 61_000)), {
    ok: false,
    reason: 'signature outside the time window',
  });
  assert.deepEqual(preflightInternal([key], 'v1,t=1,sig=zz', now), {
    ok: false,
    reason: 'malformed signature',
  });
});
