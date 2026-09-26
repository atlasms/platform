// Signed internal requests (ADR-0008): a request signed by a key the verifier holds is accepted;
// one altered in method, path, query or body, stale, unsigned, or signed by another key is not;
// a rotation holds both keys; a short key is refused at configuration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { internalKeys, signInternal, verifyInternal } from '../src/index.ts';

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
