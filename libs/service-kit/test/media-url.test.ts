// Signed media URLs (ADR-0012): a URL grants exactly what was signed — one file of one asset in one
// channel, as one content type, until a time — under any current key, and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MEDIA_URL_SECONDS,
  signMediaUrl,
  verifyMediaUrl,
  type MediaGrant,
} from '../src/index.ts';

const KEY = 'k'.repeat(32);
const OLD = 'o'.repeat(32);
const NOW = new Date('2026-11-23T12:00:00Z');
const t = Math.floor(NOW.getTime() / 1000);
const grant: MediaGrant = {
  channelId: 'ch12',
  assetId: '01K00000000000000000000AST',
  kind: 'proxy',
  variant: 'edit',
  contentType: 'video/mp4',
  exp: t + 1800,
};

/** What HSM's route parses out of a URL. */
function parsed(url: string) {
  const u = new URL(url, 'https://atlas.example');
  const [, , , assetId, kind] = u.pathname.split('/');
  return {
    assetId: decodeURIComponent(assetId!),
    kind: decodeURIComponent(kind!),
    query: Object.fromEntries(u.searchParams) as Record<string, string>,
  };
}

test('a signed URL verifies, and carries back exactly the grant', () => {
  const url = signMediaUrl(KEY, grant);
  assert.match(url, /^\/media\/v1\/01K00000000000000000000AST\/proxy\?/);
  const verdict = verifyMediaUrl([KEY], parsed(url), NOW);
  assert.deepEqual(verdict, { ok: true, grant });
});

test('every granted field is signed: changing any one refuses the URL', () => {
  const p = parsed(signMediaUrl(KEY, grant));
  const refused = (q: Partial<typeof p>) =>
    verifyMediaUrl([KEY], { ...p, ...q, query: { ...p.query, ...(q.query ?? {}) } }, NOW).ok;
  assert.equal(refused({ assetId: '01K00000000000000000000XXX' }), false);
  assert.equal(refused({ kind: 'original' }), false);
  assert.equal(refused({ query: { ch: 'ch99' } }), false, 'another channel');
  assert.equal(refused({ query: { v: '' } }), false, 'the variant dropped');
  assert.equal(refused({ query: { ct: 'text/html' } }), false, 'another content type');
  assert.equal(refused({ query: { exp: String(grant.exp + 60) } }), false, 'a longer life');
});

test('order and encoding of the query do not matter — the canonical string is signed', () => {
  const p = parsed(signMediaUrl(KEY, grant));
  const reordered = Object.fromEntries(Object.entries(p.query).reverse());
  assert.equal(verifyMediaUrl([KEY], { ...p, query: reordered }, NOW).ok, true);
});

test('expired, beyond the ceiling, malformed, unsigned, or with no key: refused, with a reason', () => {
  const at = (exp: number) => parsed(signMediaUrl(KEY, { ...grant, exp }));
  const reason = (v: ReturnType<typeof verifyMediaUrl>) => (v.ok ? 'ok' : v.reason);
  assert.equal(reason(verifyMediaUrl([KEY], at(t), NOW)), 'media URL expired');
  assert.equal(
    reason(verifyMediaUrl([KEY], at(t + MAX_MEDIA_URL_SECONDS + 1), NOW)),
    'media URL lives longer than the ceiling',
  );
  assert.equal(verifyMediaUrl([KEY], at(t + MAX_MEDIA_URL_SECONDS), NOW).ok, true);
  const p = at(t + 60);
  assert.equal(
    reason(verifyMediaUrl([KEY], { ...p, query: { ...p.query, sig: 'zz' } }, NOW)),
    'malformed media URL',
  );
  const { sig: _sig, ...unsigned } = p.query;
  assert.equal(
    reason(verifyMediaUrl([KEY], { ...p, query: unsigned }, NOW)),
    'incomplete media URL',
  );
  assert.equal(reason(verifyMediaUrl([], p, NOW)), 'no media URL key configured');
  assert.equal(reason(verifyMediaUrl(['x'.repeat(32)], p, NOW)), 'bad media URL signature');
});

test('a key rotates: the verifier accepts any key it holds', () => {
  const p = parsed(signMediaUrl(OLD, grant));
  assert.equal(verifyMediaUrl([KEY, OLD], p, NOW).ok, true);
  assert.equal(verifyMediaUrl([KEY], p, NOW).ok, false);
});

test('a grant with no variant signs and verifies without one', () => {
  const { variant: _v, ...plain } = grant;
  const url = signMediaUrl(KEY, plain);
  assert.ok(!url.includes('v='));
  assert.deepEqual(verifyMediaUrl([KEY], parsed(url), NOW), { ok: true, grant: plain });
});
