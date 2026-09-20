// The OpenSearch index against a REAL engine: the browse cases every LogBrowser must pass, read
// from the index after the projector copied the store's log; and the round trip the deployment
// depends on — resume after a restart, rebuild after a drop, 503 when the engine is away.
//
// CI runs this — the workflow declares an OpenSearch service and sets ATLAS_OPENSEARCH_URL.
// Locally: ATLAS_OPENSEARCH_URL=http://localhost:59200 npx nx test @atlas/logging

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid } from '@atlas/contracts';
import { openSearch } from '@atlas/data-opensearch';
import {
  browseConformance,
  ingest,
  openSearchAuditIndex,
  sqliteAuditStore,
  startProjector,
  type AuditStore,
} from '../src/index.ts';

const URL = process.env['ATLAS_OPENSEARCH_URL'];

if (!URL) {
  if (process.env['CI']) {
    throw new Error(
      'ATLAS_OPENSEARCH_URL is unset in CI: the OpenSearch browse conformance would skip, leaving ' +
        'the deployed index unexercised. Restore the opensearch service in .github/workflows/ci.yml.',
    );
  }
  test('OpenSearch audit index', { skip: 'set ATLAS_OPENSEARCH_URL to run' }, () => {});
} else {
  const node = URL;
  const NEVER = 3_600_000;
  const unique = () =>
    `spec-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** One index per test, dropped after; the store is the sqlite double, the projector is driven. */
  const harness = async () => {
    const client = openSearch({ node });
    const index = openSearchAuditIndex(client, { index: unique() });
    const store = sqliteAuditStore();
    const projector = startProjector({ store, index, intervalMs: NEVER });
    return {
      store,
      index,
      projector,
      client,
      cleanup: async () => {
        projector.stop();
        await index.drop().catch(() => undefined);
        await client.close();
        await store.close();
      },
    };
  };

  browseConformance('OpenSearch index', {
    make: async () => {
      const h = await harness();
      return {
        store: h.store,
        browser: h.index,
        sync: async () => {
          await h.projector.tick();
        },
        cleanup: h.cleanup,
      };
    },
  });

  async function put(store: AuditStore, channelId = 'ch12'): Promise<void> {
    const envelope = buildEnvelope({
      type: 'asset.created',
      channelId,
      payload: { assetId: ulid(), nested: { deep: [1, 2, { x: 'y' }] } },
      actor: { kind: 'user', id: 'u1' },
    });
    await ingest(store, {
      id: envelope.messageId,
      subject: `atlas.${channelId}.asset.created`,
      body: envelope,
    });
  }

  test('[OpenSearch index] heads come from the engine; a restart resumes, a drop rebuilds', async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 3; i++) await put(h.store);
      await put(h.store, 'ch99');
      assert.equal(await h.projector.tick(), 4);
      assert.deepEqual(
        (await h.index.heads()).sort((a, b) => a.channelId.localeCompare(b.channelId)),
        [
          { channelId: 'ch12', seq: 3 },
          { channelId: 'ch99', seq: 1 },
        ],
      );

      // A second projector — a restarted pod — asks the engine, not a table of its own.
      await put(h.store);
      const restarted = startProjector({ store: h.store, index: h.index, intervalMs: NEVER });
      assert.equal(await restarted.tick(), 1);
      restarted.stop();

      // The payload survives the round trip untouched even though it is not indexed.
      const [newest] = await h.index.browse('ch12', { limit: 1 });
      assert.equal(newest?.seq, 4);
      assert.deepEqual((newest?.payload as { nested: unknown }).nested, {
        deep: [1, 2, { x: 'y' }],
      });

      await h.index.drop();
      const rebuilt = startProjector({ store: h.store, index: h.index, intervalMs: NEVER });
      assert.equal(await rebuilt.tick(), 5, 'everything, from the log');
      rebuilt.stop();
      assert.deepEqual(
        (await h.index.browse('ch12', { limit: 10 })).map((e) => e.seq),
        [4, 3, 2, 1],
      );
    } finally {
      await h.cleanup();
    }
  });

  test('[OpenSearch index] trim removes what occurred before the cutoff and sits below the head — never the head', async () => {
    const h = await harness();
    try {
      // Five records; the store's clock is now, so "before" is chosen around the records' own
      // occurredAt: everything is trimmed except what the seq floor protects.
      for (let i = 0; i < 5; i += 1) await put(h.store);
      await h.projector.tick();
      const chain = await h.store.chain('ch12');
      const head = chain[chain.length - 1]!;
      const future = new Date(Date.now() + 60_000).toISOString();
      assert.equal(await h.index.trim('ch12', future, head.seq), 4, 'four below the head');
      assert.deepEqual(await h.index.heads(), [{ channelId: 'ch12', seq: head.seq }]);
      assert.equal(await h.index.trim('ch12', future, head.seq), 0, 'idempotent');
      // The head survives whatever the cutoff, so the projector's checkpoint does.
      assert.equal(
        (await h.index.browse('ch12', { limit: 10 })).map((e) => e.seq).join(','),
        String(head.seq),
      );
      await put(h.store);
      assert.equal(await h.projector.tick(), 1, 'the next tick resumes from the kept head');
    } finally {
      await h.cleanup();
    }
  });

  test('[OpenSearch index] an engine that cannot be reached is a 503 problem, not a 500', async () => {
    const client = openSearch({ node: 'http://127.0.0.1:1', requestTimeoutMs: 500 });
    const index = openSearchAuditIndex(client, { index: unique() });
    await assert.rejects(
      index.browse('ch12', { limit: 1 }),
      (err: { status?: number; code?: string }) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'UNAVAILABLE');
        return true;
      },
    );
    await client.close();
  });
}
