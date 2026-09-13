// Against a REAL OpenSearch. CI runs this — the workflow declares an OpenSearch service and sets
// ATLAS_OPENSEARCH_URL. Locally it skips unless you point it at one:
//
//   docker compose -f infra/docker-compose.dev.yml up -d opensearch
//   ATLAS_OPENSEARCH_URL=http://localhost:59200 npm test -w @atlas/data-opensearch

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureIndex, openSearch, searchHealthy } from '../src/index.ts';

const URL = process.env['ATLAS_OPENSEARCH_URL'];

if (!URL) {
  // Convenient locally, REFUSED in CI — a silent skip there is indistinguishable from a pass, and
  // the deployed client would go unexercised (the same rule as ATLAS_PG_URL).
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_OPENSEARCH_URL is unset in CI: the OpenSearch tests would skip, leaving the ' +
        'deployed client unexercised. Restore the opensearch service in .github/workflows/ci.yml.',
    );
  }
  test('OpenSearch', { skip: 'set ATLAS_OPENSEARCH_URL to run against a real cluster' }, () => {});
} else {
  const node = URL;
  const unique = () => `spec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  test('a reachable cluster is healthy; an unreachable one is not, within the timeout', async () => {
    const up = openSearch({ node });
    assert.equal(await searchHealthy(up), true);
    await up.close();

    const down = openSearch({ node: 'http://127.0.0.1:1', requestTimeoutMs: 500 });
    const started = Date.now();
    assert.equal(await searchHealthy(down), false);
    assert.ok(Date.now() - started < 5_000, 'a down cluster answers "no" quickly, not by hanging');
    await down.close();
  });

  test('ensureIndex creates once, then finds; the mapping is the one given', async () => {
    const client = openSearch({ node });
    const name = unique();
    try {
      const first = await ensureIndex(client, {
        name,
        mappings: { properties: { channel_id: { type: 'keyword' }, seq: { type: 'long' } } },
      });
      assert.equal(first.created, true);
      const second = await ensureIndex(client, { name, mappings: { properties: {} } });
      assert.equal(second.created, false, 'idempotent: the second call is a no-op');

      const { body } = await client.indices.getMapping({ index: name });
      const props = body[name]?.mappings?.properties as Record<string, { type: string }>;
      assert.equal(props['channel_id']?.type, 'keyword');
      assert.equal(props['seq']?.type, 'long');
    } finally {
      await client.indices.delete({ index: name }).catch(() => undefined);
      await client.close();
    }
  });

  test('a document indexed by its own id is an overwrite the second time, never a duplicate', async () => {
    const client = openSearch({ node });
    const name = unique();
    try {
      await ensureIndex(client, {
        name,
        mappings: { properties: { channel_id: { type: 'keyword' }, seq: { type: 'long' } } },
      });
      const doc = { channel_id: 'ch12', seq: 1 };
      await client.index({ index: name, id: 'm1', body: doc, refresh: true });
      await client.index({ index: name, id: 'm1', body: { ...doc, seq: 1 }, refresh: true });
      const { body } = await client.count({ index: name });
      assert.equal(body.count, 1);
    } finally {
      await client.indices.delete({ index: name }).catch(() => undefined);
      await client.close();
    }
  });
}
