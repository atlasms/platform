// EP-08.5 — one reference snapshot aggregated from many services.
//
// §5 step 2: "the BFF aggregates them into one snapshot with a combined configVersion + ETag".
// The interesting cases are all about what happens when that is only PARTLY possible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestKey } from '@atlas/service-kit';
import { aggregateReference, buildGateway, ReferenceUnavailable } from '../src/index.ts';

const SOURCES = [
  { service: 'mam', url: 'http://mam:3000/api/v1/reference' },
  { service: 'hsm', url: 'http://hsm:3000/api/v1/reference' },
];

/** A fetch that answers each source from a table, so no ports are involved. */
const fetching = (bodies: Record<string, { status?: number; body?: unknown }>): typeof fetch =>
  (async (url: string | URL) => {
    const key = String(url).includes('//mam') ? 'mam' : 'hsm';
    const entry = bodies[key];
    if (!entry) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(entry.body ?? {}), {
      status: entry.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

// =============================================================================
// The merge
// =============================================================================

test('the snapshot files each service under its own name and sums the versions', async () => {
  const snapshot = await aggregateReference({
    sources: SOURCES,
    fetchImpl: fetching({
      mam: { body: { configVersion: 5, vocabularies: { tag: [{ id: 't1', key: 'sport' }] } } },
      hsm: { body: { configVersion: 2, vocabularies: { storageTier: [] } } },
    }),
  });

  assert.equal(snapshot.configVersion, 7, '5 + 2');
  assert.deepEqual(snapshot.sources, { mam: 5, hsm: 2 }, 'and which service is at what');
  assert.ok(snapshot.services['mam'], 'mam data is filed under mam');
  assert.ok(snapshot.services['hsm']);
});

test('the combined version moves when ANY contributor moves', async () => {
  // The caching contract. If one service can change without the aggregate version moving, every
  // holder revalidates to 304 forever and never sees that service's new terms.
  const at = async (mam: number, hsm: number) =>
    (
      await aggregateReference({
        sources: SOURCES,
        fetchImpl: fetching({
          mam: { body: { configVersion: mam } },
          hsm: { body: { configVersion: hsm } },
        }),
      })
    ).configVersion;

  const base = await at(5, 2);
  assert.notEqual(await at(6, 2), base, 'mam moved');
  assert.notEqual(await at(5, 3), base, 'hsm moved');
});

test('the document is stable when the SOURCE ORDER changes', async () => {
  // Source order is configuration. Reordering it must not look like a content change to anything
  // comparing bodies, or an operator tidying a config file invalidates every cached snapshot.
  const impl = fetching({
    mam: { body: { configVersion: 5 } },
    hsm: { body: { configVersion: 2 } },
  });
  const a = await aggregateReference({ sources: SOURCES, fetchImpl: impl });
  const b = await aggregateReference({ sources: [...SOURCES].reverse(), fetchImpl: impl });

  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// =============================================================================
// Partial failure — the dangerous case
// =============================================================================

test('DANGER: an unreachable service FAILS the aggregate rather than omitting itself', async () => {
  // The snapshot is what validation reads (§5 step 4). A missing service does not degrade the
  // answer, it CHANGES it: "is this a known classification?" starts returning no for every term
  // that service owned, and valid writes get rejected. A client cannot tell a partial snapshot
  // from a complete one — but it can tell a failure, and its own client keeps the last good one.
  await assert.rejects(
    aggregateReference({
      sources: SOURCES,
      fetchImpl: fetching({ mam: { body: { configVersion: 5 } } }), // hsm throws
    }),
    (err: Error) => err instanceof ReferenceUnavailable && /hsm/.test(err.message),
  );
});

test('a source that answers with an error status also fails the aggregate', async () => {
  await assert.rejects(
    aggregateReference({
      sources: SOURCES,
      fetchImpl: fetching({
        mam: { body: { configVersion: 5 } },
        hsm: { status: 503, body: {} },
      }),
    }),
    /hsm.*503/,
  );
});

test('DANGER: a source with no configVersion is refused, not defaulted to zero', async () => {
  // Treating it as 0 would make the aggregate version stop responding to that service entirely —
  // its data could change forever behind an ETag that never moves.
  await assert.rejects(
    aggregateReference({
      sources: SOURCES,
      fetchImpl: fetching({
        mam: { body: { configVersion: 5 } },
        hsm: { body: { vocabularies: {} } },
      }),
    }),
    /no configVersion/,
  );
});

// =============================================================================
// Through the gateway
// =============================================================================

async function gateway(bodies: Record<string, { status?: number; body?: unknown }>) {
  const key = await generateTestKey();
  const app = buildGateway({
    jwks: key.jwks,
    routes: [{ service: 'mam', origin: 'http://mam:3000', prefix: '/api/v1/assets' }],
    referenceSources: SOURCES,
    fetchImpl: fetching(bodies),
  });
  const token = await key.sign({
    sub: 'user-1',
    channelId: 'ch12',
    permissions: [],
    permVersion: 1,
  });
  return { app, auth: { authorization: `Bearer ${token}` } };
}

const HEALTHY = {
  mam: { body: { configVersion: 5 } },
  hsm: { body: { configVersion: 2 } },
};

test('GET /api/v1/reference returns the aggregate with an ETag', async () => {
  const { app, auth } = await gateway(HEALTHY);
  const res = await app.inject({ method: 'GET', url: '/api/v1/reference', headers: auth });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['etag'], 'W/"cv-7"');
  assert.equal(res.json<{ configVersion: number }>().configVersion, 7);
});

test('an unchanged aggregate revalidates to 304, keeping the ETag', async () => {
  const { app, auth } = await gateway(HEALTHY);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/reference',
    headers: { ...auth, 'if-none-match': 'W/"cv-7"' },
  });

  assert.equal(res.statusCode, 304);
  assert.equal(res.body, '');
  assert.equal(res.headers['etag'], 'W/"cv-7"');
});

test('an unreachable contributor is a 503, not a partial 200', async () => {
  const { app, auth } = await gateway({ mam: { body: { configVersion: 5 } } });
  const res = await app.inject({ method: 'GET', url: '/api/v1/reference', headers: auth });

  assert.equal(res.statusCode, 503, 'a partial snapshot must never be served as a complete one');
  assert.match(res.json<{ message: string }>().message, /hsm/);
});

test('SECURITY: the aggregate needs a token, like any other protected route', async () => {
  const { app } = await gateway(HEALTHY);
  const res = await app.inject({ method: 'GET', url: '/api/v1/reference' });
  assert.equal(res.statusCode, 401);
});

test('the route is absent when no sources are configured', async () => {
  // A gateway with nothing to aggregate should 404 rather than serve an empty snapshot, which a
  // client would cache as "there is no reference data".
  const key = await generateTestKey();
  const app = buildGateway({ jwks: key.jwks, routes: [], fetchImpl: fetching({}) });
  const token = await key.sign({ sub: 'user-1', permissions: [], permVersion: 1 });

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/reference',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});
