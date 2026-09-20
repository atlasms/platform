// The projector, against an in-memory index: what it copies, where it resumes, and what it does
// when the index fails. The real engine is index-opensearch.test.ts; the properties here are the
// projector's own and hold for any AuditIndex.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid } from '@atlas/contracts';
import {
  ingest,
  memoryAuditIndex,
  sqliteAuditStore,
  startProjector,
  type AuditIndex,
  type AuditStore,
} from '../src/index.ts';

const memoryIndex = memoryAuditIndex;

async function put(store: AuditStore, channelId = 'ch12'): Promise<void> {
  const envelope = buildEnvelope({
    type: 'asset.created',
    channelId,
    payload: { assetId: ulid() },
    actor: { kind: 'user', id: 'u1' },
  });
  await ingest(store, {
    id: envelope.messageId,
    subject: `atlas.${channelId}.asset.created`,
    body: envelope,
  });
}

const NEVER = 3_600_000; // a timer that will not fire during a test

test('copies every channel in chain order, in batches, and is idempotent when caught up', async () => {
  const store = sqliteAuditStore();
  const { index, docs, bulks } = memoryIndex();
  for (let i = 0; i < 7; i++) await put(store);
  await put(store, 'ch99');

  const projector = startProjector({ store, index, intervalMs: NEVER, batch: 3 });
  assert.equal(await projector.tick(), 8);
  assert.equal(bulks(), 4, '7 rows in batches of 3 is three bulks, plus one for ch99');
  assert.equal(projector.lag(), 0);
  assert.deepEqual(
    (await index.browse('ch12', { limit: 10 })).map((e) => e.seq),
    [7, 6, 5, 4, 3, 2, 1],
  );
  assert.equal(await projector.tick(), 0, 'nothing new, nothing indexed');
  assert.equal(docs.size, 8);

  await put(store);
  assert.equal(await projector.tick(), 1, 'only the new row');
  projector.stop();
  await store.close();
});

test('RESUMES from the index, not from a checkpoint of its own: a new projector indexes only what is missing', async () => {
  const store = sqliteAuditStore();
  const { index, bulks } = memoryIndex();
  for (let i = 0; i < 4; i++) await put(store);
  const first = startProjector({ store, index, intervalMs: NEVER });
  await first.tick();
  first.stop();

  await put(store);
  await put(store);
  const second = startProjector({ store, index, intervalMs: NEVER });
  assert.equal(await second.tick(), 2, 'the two rows appended since — the index said where it was');
  assert.equal(bulks(), 2);
  second.stop();
  await store.close();
});

test('a dropped index is rebuilt from the log on the next tick — the index is a derived view', async () => {
  const store = sqliteAuditStore();
  const { index, docs } = memoryIndex();
  for (let i = 0; i < 3; i++) await put(store);
  const projector = startProjector({ store, index, intervalMs: NEVER });
  await projector.tick();
  assert.equal(docs.size, 3);

  await index.drop();
  assert.equal(docs.size, 0);
  // The in-memory heads say "indexed to 3"; a rebuild must not trust them. Dropping is an
  // operator action outside the projector, so it learns of it the way it learns of anything:
  // by asking the index on the tick after a failure or a restart. Simulate the restart.
  projector.stop();
  const rebuilt = startProjector({ store, index, intervalMs: NEVER });
  assert.equal(await rebuilt.tick(), 3, 'everything, again');
  rebuilt.stop();
  await store.close();
});

test('a failed bulk is reported, nothing is marked indexed, and the next tick retries from the index', async () => {
  const store = sqliteAuditStore();
  let fail = true;
  const { index, docs } = memoryIndex({ failNext: () => fail });
  const errors: unknown[] = [];
  for (let i = 0; i < 2; i++) await put(store);
  const projector = startProjector({
    store,
    index,
    intervalMs: NEVER,
    onError: (err) => errors.push(err),
  });

  assert.equal(await projector.tick(), 0);
  assert.equal(errors.length, 1);
  assert.equal(docs.size, 0);

  fail = false;
  assert.equal(await projector.tick(), 2, 'retried, from the index’s own heads');
  assert.equal(projector.lag(), 0);
  projector.stop();
  await store.close();
});

test('ticks do not overlap: a tick that is running makes the next one a no-op', async () => {
  const store = sqliteAuditStore();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: AuditIndex = {
    ...memoryIndex().index,
    index: async () => {
      await gate;
    },
  };
  await put(store);
  const projector = startProjector({ store, index: slow, intervalMs: NEVER });
  const running = projector.tick();
  assert.equal(await projector.tick(), 0, 'the second tick yields to the first');
  release?.();
  assert.equal(await running, 1);
  projector.stop();
  await store.close();
});
