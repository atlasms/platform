// EP-04.8 — `GET /reference`, the serving half of the versioned snapshot.
//
// Almost all of this is `If-None-Match`, because that is where the failures are silent. A
// revalidation bug does not throw: it either ships the whole snapshot on every poll forever
// (slow, and only visible on a bandwidth graph) or returns 304 when the content changed (stale
// reference data, and validation starts rejecting things an admin just added).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configEtag, matchesEtag, serveSnapshot } from '../src/index.ts';

const snapshot = (configVersion: number) => ({
  configVersion,
  vocabularies: { tag: [{ id: '01H', key: 'sport' }] },
});

test('a first request gets the snapshot and an ETag', () => {
  const result = serveSnapshot(snapshot(4), undefined);
  assert.equal(result.status, 200);
  assert.equal(result.etag, 'W/"cv-4"');
  assert.equal(result.body?.configVersion, 4);
});

test('an unchanged version revalidates to 304 with no body', () => {
  const result = serveSnapshot(snapshot(4), 'W/"cv-4"');
  assert.equal(result.status, 304);
  assert.equal(result.body, undefined, 'the body IS the saving');
});

test('DANGER: a 304 still carries the ETag', () => {
  // A 304 without one tells the client its cached entry has no validator, so the next request is
  // unconditional — the revalidation silently stops working and every poll ships the snapshot.
  const result = serveSnapshot(snapshot(4), 'W/"cv-4"');
  assert.equal(result.etag, 'W/"cv-4"');
});

test('a bumped version is NOT a match', () => {
  // The direction that matters: getting this wrong serves stale reference data, and validation
  // then rejects a classification an admin has just added.
  const result = serveSnapshot(snapshot(5), 'W/"cv-4"');
  assert.equal(result.status, 200);
  assert.equal(result.body?.configVersion, 5);
});

test('comparison is WEAK, so a client that drops the W/ prefix still revalidates', () => {
  // RFC 9110 §13.1.2 requires weak comparison for If-None-Match. Comparing strictly is the quiet
  // failure: every poll ships the whole snapshot and nothing ever looks broken.
  assert.equal(matchesEtag('"cv-4"', 'W/"cv-4"'), true, 'strong candidate, weak tag');
  assert.equal(matchesEtag('W/"cv-4"', 'W/"cv-4"'), true);
  assert.equal(matchesEtag('W/"cv-4"', '"cv-4"'), true, 'the other way round too');
});

test('a LIST of etags is honoured, not treated as one opaque string', () => {
  // Browsers and caches legitimately send several. Treating the header as a single value means a
  // client holding two cached versions never revalidates.
  assert.equal(matchesEtag('W/"cv-1", W/"cv-4", W/"cv-9"', 'W/"cv-4"'), true);
  assert.equal(matchesEtag('W/"cv-1", W/"cv-2"', 'W/"cv-4"'), false);
  // A repeated header arrives as an array and means the same thing.
  assert.equal(matchesEtag(['W/"cv-1"', 'W/"cv-4"'], 'W/"cv-4"'), true);
});

test('`*` matches, because a snapshot always exists', () => {
  assert.equal(matchesEtag('*', 'W/"cv-4"'), true);
  assert.equal(serveSnapshot(snapshot(4), '*').status, 304);
});

test('junk and empty entries do not match, and do not throw', () => {
  // A malformed header must degrade to "send the snapshot", never to an error: the caller asked a
  // cache question badly, which is not a reason to fail their request.
  for (const bad of ['', '   ', ',,', 'garbage', 'W/', '"cv-40"', 'cv-4']) {
    assert.equal(matchesEtag(bad, 'W/"cv-4"'), false, `matched ${JSON.stringify(bad)}`);
  }
  assert.equal(serveSnapshot(snapshot(4), 'garbage').status, 200);
});

test('the etag is derived from the version alone', () => {
  // Two snapshots at the same version revalidate identically even if the JSON differs in key
  // order — which is why the tag is WEAK. A strong tag would promise byte-equality this cannot keep.
  assert.equal(configEtag(4), 'W/"cv-4"');
  assert.equal(serveSnapshot({ configVersion: 4, a: 1 }, undefined).etag, configEtag(4));
  assert.equal(serveSnapshot({ configVersion: 4, b: 2 }, undefined).etag, configEtag(4));
});
