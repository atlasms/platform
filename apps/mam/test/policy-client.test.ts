// The policy client is an authorization component, so its FAILURE modes are the point.
//
// Every one of these tests exists because the convenient behaviour is the unsafe one: serving a
// stale policy when IAM is down, or treating an unparseable response as "no rules".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EffectivePolicy } from '@atlas/policy';
import { PolicyClient } from '../src/index.ts';

const POLICY: EffectivePolicy = {
  subjectId: 'user-1',
  permVersion: 3,
  rules: [{ id: 'r', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } }],
};

/** A fetch double that records calls and returns whatever the test queues up. */
function fakeFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return responder(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'text/json' } });

function clientWith(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  now: () => number = () => 1000,
) {
  const { impl, calls } = fakeFetch(responder);
  const client = new PolicyClient({
    origin: 'http://iam:3000',
    ttlMs: 30_000,
    fetchImpl: impl,
    now,
  });
  return { client, calls };
}

test('fetches the compiled policy and identifies the subject by header', async () => {
  const { client, calls } = clientWith(() => ok(POLICY));

  assert.deepEqual(await client.policyFor('user-1'), POLICY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://iam:3000/api/v1/users/me/effective-permissions');
  assert.equal(calls[0]?.headers['x-atlas-user'], 'user-1');
});

test('a cached policy is reused within its TTL', async () => {
  const { client, calls } = clientWith(() => ok(POLICY));

  await client.policyFor('user-1');
  await client.policyFor('user-1');
  assert.equal(calls.length, 1, 'IAM must not be on the critical path of every request');
});

test('the cache expires, so a revocation takes effect', async () => {
  // The TTL is a revocation window. If the entry never expired, a permission removed in IAM would
  // stay live in MAM until the process restarted.
  let clock = 1000;
  const { client, calls } = clientWith(
    () => ok(POLICY),
    () => clock,
  );

  await client.policyFor('user-1');
  clock += 30_001;
  await client.policyFor('user-1');

  assert.equal(calls.length, 2);
});

test('concurrent requests for one subject make ONE call to IAM', async () => {
  // A cold cache under load must not turn into a fetch per in-flight request.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { client, calls } = clientWith(async () => {
    await gate;
    return ok(POLICY);
  });

  const all = Promise.all([
    client.policyFor('user-1'),
    client.policyFor('user-1'),
    client.policyFor('user-1'),
  ]);
  release();
  const results = await all;

  assert.equal(calls.length, 1);
  for (const r of results) assert.deepEqual(r, POLICY);
});

// =============================================================================
// Failing closed
// =============================================================================

test('SECURITY: an unreachable IAM yields no policy, never an empty one', async () => {
  // Undefined becomes 401. An empty rule set would become 403 — plausible-looking, and wrong:
  // it is indistinguishable from a caller who genuinely has no grants, and it means an IAM outage
  // silently reclassifies "we don't know" as "we checked".
  const { client } = clientWith(() => {
    throw new Error('ECONNREFUSED');
  });

  assert.equal(await client.policyFor('user-1'), undefined);
});

test('SECURITY: a non-2xx from IAM yields no policy', async () => {
  for (const status of [401, 404, 500, 503]) {
    const { client } = clientWith(() => new Response('nope', { status }));
    assert.equal(await client.policyFor('user-1'), undefined, `status ${status}`);
  }
});

test('SECURITY: a body that is not a policy is refused, not coerced', async () => {
  // `{}` has no rules. Reading that as "a policy with no rules" is a guess about authorization.
  for (const body of [{}, { subjectId: 'user-1' }, { rules: 'all' }, null]) {
    const { client } = clientWith(() => ok(body));
    assert.equal(await client.policyFor('user-1'), undefined, JSON.stringify(body));
  }

  const { client } = clientWith(() => new Response('<html>gateway error</html>', { status: 200 }));
  assert.equal(await client.policyFor('user-1'), undefined, 'unparseable body');
});

test('SECURITY: an expired entry is NOT served when IAM is down', async () => {
  // The seductive failure: "we had a policy a minute ago, use that". It makes a revoked permission
  // outlive its revocation for exactly as long as IAM is unavailable.
  let clock = 1000;
  let healthy = true;
  const { client } = clientWith(
    () => {
      if (!healthy) throw new Error('ECONNREFUSED');
      return ok(POLICY);
    },
    () => clock,
  );

  assert.deepEqual(await client.policyFor('user-1'), POLICY);

  healthy = false;
  clock += 30_001;
  assert.equal(await client.policyFor('user-1'), undefined);
});

test('a failed fetch is not cached as a failure either', async () => {
  // The mirror of the rule above: a transient error must not lock the subject out for a full TTL.
  let healthy = false;
  const { client } = clientWith(() => {
    if (!healthy) throw new Error('ECONNREFUSED');
    return ok(POLICY);
  });

  assert.equal(await client.policyFor('user-1'), undefined);
  healthy = true;
  assert.deepEqual(await client.policyFor('user-1'), POLICY);
});

// =============================================================================
// Housekeeping
// =============================================================================

test('the cache is bounded', async () => {
  const { impl, calls } = fakeFetch(() => ok(POLICY));
  const client = new PolicyClient({ origin: 'http://iam:3000', maxEntries: 2, fetchImpl: impl });

  await client.policyFor('a');
  await client.policyFor('b');
  await client.policyFor('c'); // evicts 'a'
  await client.policyFor('c');
  await client.policyFor('a'); // must be a miss

  assert.equal(calls.length, 4);
});

test('invalidate drops an entry, and everything', async () => {
  const { client, calls } = clientWith(() => ok(POLICY));

  await client.policyFor('user-1');
  client.invalidate('user-1');
  await client.policyFor('user-1');
  assert.equal(calls.length, 2);

  client.invalidate();
  await client.policyFor('user-1');
  assert.equal(calls.length, 3);
});
