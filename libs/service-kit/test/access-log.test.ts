// #245 — per-request access records, and the volume decision behind them.
//
// The gateway has logged one line per request all along. Nothing else did, so the dashboard panel
// that takes a correlation id and returns "everything logged for this request" returned exactly ONE
// line for an ordinary request, however many services it touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessRecord, shouldLogAccess, DEFAULT_ACCESS_POLICY } from '../src/index.ts';

const fast = { status: 200, latencyMs: 5 };

test('every non-2xx is logged', () => {
  // When the correlation view is actually read, it needs to be complete — and that is exactly the
  // case where it is.
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    assert.equal(shouldLogAccess({ status, latencyMs: 5 }), true, `${status} was dropped`);
  }
});

test('a SLOW request is logged whatever its status', () => {
  // The 200 that took four seconds is the one an operator is hunting, and it is invisible to a
  // status filter — which is why "non-2xx only" would have been the wrong policy on its own.
  assert.equal(shouldLogAccess({ status: 200, latencyMs: 1_000 }), true, 'at the threshold');
  assert.equal(shouldLogAccess({ status: 200, latencyMs: 9_999 }), true);
  assert.equal(shouldLogAccess({ status: 200, latencyMs: 999 }), false, 'just under');
});

test('a fast success is NOT logged by default', () => {
  // The volume decision. An access line per service multiplies log volume by roughly the number of
  // hops, and a fast successful request is already fully described by the golden signals — rate,
  // status class, and a latency histogram, per route. A line for it adds bytes and no answer.
  assert.equal(shouldLogAccess(fast), false);
  assert.equal(DEFAULT_ACCESS_POLICY.sampleRatio, 0, 'off, deliberately');
});

test('sampling is honoured, and testable because the RNG is injected', () => {
  // A sampled logger tested against a real RNG either asserts nothing or is flaky, and both end
  // with the sampling never actually being verified.
  const always = () => 0;
  const never = () => 0.99;

  assert.equal(shouldLogAccess(fast, { sampleRatio: 0.5 }, always), true);
  assert.equal(shouldLogAccess(fast, { sampleRatio: 0.5 }, never), false);

  // The two ends have to be exact, because they are the settings an operator actually reaches for:
  // 1 to capture everything during an investigation, 0 to stop. `random()` is [0,1), so `< 1` is
  // always true and `< 0` never is — both ends land where the names promise.
  assert.equal(shouldLogAccess(fast, { sampleRatio: 1 }, never), true, 'ratio 1 logs everything');
  assert.equal(shouldLogAccess(fast, { sampleRatio: 0 }, always), false, 'zero means zero');
});

test('the thresholds are configurable, and a partial policy keeps the other defaults', () => {
  assert.equal(shouldLogAccess({ status: 200, latencyMs: 200 }, { slowMs: 100 }), true);
  // minStatus untouched, so a 404 is still logged even though only slowMs was overridden.
  assert.equal(shouldLogAccess({ status: 404, latencyMs: 1 }, { slowMs: 100 }), true);
  assert.equal(shouldLogAccess({ status: 500, latencyMs: 1 }, { minStatus: 599 }), false);
});

test('the record carries what an operator searches by', () => {
  const record = accessRecord({
    requestId: 'corr-1',
    method: 'GET',
    route: '/api/v1/assets/:id',
    status: 200,
    latencyMs: 12,
    userId: 'user-1',
    traceId: 'a'.repeat(32),
    now: () => 0,
  });

  assert.deepEqual(record, {
    requestId: 'corr-1',
    method: 'GET',
    route: '/api/v1/assets/:id',
    status: 200,
    latencyMs: 12,
    userId: 'user-1',
    traceId: 'a'.repeat(32),
    at: '1970-01-01T00:00:00.000Z',
  });
});

test('absent identity is OMITTED, never null', () => {
  // A JSON log line carrying `"userId": null` invites a query that matches it. An unauthenticated
  // request has no user, rather than a null one.
  const record = accessRecord({
    requestId: 'corr-1',
    method: 'GET',
    route: '/healthz',
    status: 200,
    latencyMs: 1,
  });
  assert.ok(!('userId' in record));
  assert.ok(!('traceId' in record));
});
