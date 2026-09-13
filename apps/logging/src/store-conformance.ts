// A behaviour suite every AuditStore must pass — sqlite in tests, Postgres in production.
//
// Driven through `ingest`, not the port's methods one at a time, because the properties that
// matter are properties of the unit of work: appended once under redelivery, the chain intact,
// the history projected, and — the one only a database can prove — append-only enforced below the
// service's own code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid, type EventPayloads } from '@atlas/contracts';
import type { Message } from '@atlas/messaging';
import { ingest } from './sink.ts';
import { verifyChain, type AuditStore, type LogBrowser } from './store.ts';

export interface AuditStoreHarness {
  /** A clean store; `cleanup` drops whatever it created. */
  make: () => Promise<{ store: AuditStore; cleanup?: () => Promise<void> }>;
  /**
   * Try to alter or remove an appended record by whatever means the adapter's backing store
   * offers — a raw UPDATE, a raw DELETE. Must throw if append-only holds. The suite cannot reach
   * around the port itself; the adapter knows how.
   */
  tamper: (store: AuditStore, messageId: string) => Promise<void>;
}

const CH = 'ch12';

function domainMessage(type = 'asset.created', channelId = CH): Message {
  const envelope = buildEnvelope({
    type,
    channelId,
    payload: { assetId: ulid(), createdBy: 'user-1', title: 'A clip' },
    actor: { kind: 'user', id: 'user-1' },
    correlationId: ulid(),
  });
  return { id: envelope.messageId, subject: `atlas.${channelId}.${type}`, body: envelope };
}

function auditMessage(
  entityId: string,
  revision: number,
  delta: EventPayloads['audit.recorded']['delta'],
): Message {
  const payload: EventPayloads['audit.recorded'] = {
    entityType: 'asset',
    entityId,
    revision,
    action: revision === 1 ? 'asset.created' : 'asset.updated',
    origin: { service: 'mam' },
    delta,
  };
  const envelope = buildEnvelope({
    type: 'audit.recorded',
    channelId: CH,
    payload,
    actor: { kind: 'user', id: 'user-1' },
  });
  return { id: envelope.messageId, subject: `atlas.${CH}.audit.recorded`, body: envelope };
}

export function auditStoreConformance(name: string, harness: AuditStoreHarness): void {
  async function withStore(fn: (store: AuditStore) => Promise<void>): Promise<void> {
    const { store, cleanup } = await harness.make();
    try {
      await fn(store);
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
    }
  }

  test(`[${name}] appends every envelope once, and a redelivery is a duplicate`, async () => {
    await withStore(async (store) => {
      const msg = domainMessage();
      assert.equal(await ingest(store, msg), 'appended');
      assert.equal(
        await ingest(store, msg),
        'duplicate',
        'at-least-once delivery, exactly-once append',
      );
      assert.deepEqual(await store.count(), { events: 1, history: 0 });
    });
  });

  test(`[${name}] the chain is gapless per channel, and verifies`, async () => {
    await withStore(async (store) => {
      for (let i = 0; i < 5; i++) await ingest(store, domainMessage());
      await ingest(store, domainMessage('asset.created', 'ch99')); // another channel, its own chain

      const chain = await store.chain(CH);
      assert.deepEqual(
        chain.map((e) => e.seq),
        [1, 2, 3, 4, 5],
      );
      assert.deepEqual(verifyChain(chain), { ok: true });
      assert.deepEqual(verifyChain(await store.chain('ch99')), { ok: true });
      assert.equal((await store.chain('ch99'))[0]?.seq, 1, 'channels do not share a sequence');
    });
  });

  test(`[${name}] TAMPER-EVIDENT: an altered record breaks every link after it`, async () => {
    // The chain is not decoration. Verification recomputes each hash from its predecessor and
    // its content, so an in-place change — even if the database allowed one — is detectable.
    await withStore(async (store) => {
      for (let i = 0; i < 4; i++) await ingest(store, domainMessage());
      const chain = await store.chain(CH);
      const forged = chain.map((e) => (e.seq === 2 ? { ...e, type: 'asset.deleted' } : e));
      const result = verifyChain(forged);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.atSeq, 2, 'and it names where');
    });
  });

  test(`[${name}] APPEND-ONLY is enforced by the database, not by the service`, async () => {
    // The service's own code cannot rewrite the log; a compliance record it could is not a record.
    await withStore(async (store) => {
      const msg = domainMessage();
      await ingest(store, msg);
      await assert.rejects(harness.tamper(store, msg.id), /append-only/);
      assert.deepEqual(verifyChain(await store.chain(CH)), { ok: true }, 'and nothing changed');
    });
  });

  test(`[${name}] an audit.recorded event is projected into the entity's history, in revision order`, async () => {
    await withStore(async (store) => {
      const id = ulid();
      await ingest(store, auditMessage(id, 1, { title: { after: 'First' } }));
      await ingest(store, auditMessage(id, 2, { title: { before: 'First', after: 'Second' } }));
      await ingest(store, auditMessage(ulid(), 1, { title: { after: 'Other' } }));

      const history = await store.history(CH, 'asset', id);
      assert.deepEqual(
        history.map((h) => [h.revision, h.action, h.delta]),
        [
          [1, 'asset.created', { title: { after: 'First' } }],
          [2, 'asset.updated', { title: { before: 'First', after: 'Second' } }],
        ],
      );
      assert.equal(history[0]?.actorId, 'user-1');
      assert.ok(history[0]?.messageId, 'each revision links back to the envelope in the log');
      assert.deepEqual(
        await store.history(CH, 'asset', 'nope'),
        [],
        'the history of nothing is empty',
      );
      assert.deepEqual(await store.history('ch99', 'asset', id), [], 'and channel-scoped');
      assert.deepEqual(await store.count(), { events: 3, history: 3 });
    });
  });

  test(`[${name}] ATOMICITY: a failed projection leaves neither the record nor the claim`, async () => {
    // An audit.recorded envelope whose payload fails its schema is refused — and the log entry and
    // the seen-mark that were written before the refusal roll back with it, so the redelivery is
    // processed rather than skipped, and the log never holds a record without its history row.
    await withStore(async (store) => {
      const bad = auditMessage(ulid(), 1, { title: { after: 'x' } });
      (bad.body as { payload: Record<string, unknown> }).payload['revision'] = 0; // minimum is 1
      await assert.rejects(ingest(store, bad), /does not match its schema/);
      assert.deepEqual(await store.count(), { events: 0, history: 0 });
      assert.deepEqual(verifyChain(await store.chain(CH)), { ok: true });
      // A redelivery of a now-valid message with the same id is NOT a duplicate: the claim rolled back.
      (bad.body as { payload: Record<string, unknown> }).payload['revision'] = 1;
      assert.equal(await ingest(store, bad), 'appended');
    });
  });

  // The browse cases, with the store reading its own log. The OpenSearch index runs the same
  // cases with the store writing and the index reading (index-opensearch.test.ts).
  browseConformance(name, {
    make: async () => {
      const { store, cleanup } = await harness.make();
      return {
        store,
        browser: store,
        cleanup: async () => {
          await cleanup?.();
          await store.close().catch(() => undefined);
        },
      };
    },
  });

  test(`[${name}] heads and chainSince: what the projector reads is gapless, per channel`, async () => {
    await withStore(async (store) => {
      assert.deepEqual(await store.heads(), [], 'no channels, no heads');
      for (let i = 0; i < 5; i++) await ingest(store, domainMessage('asset.created'));
      await ingest(store, domainMessage('asset.created', 'ch99'));

      const heads = await store.heads();
      assert.deepEqual(
        heads.map((h) => [h.channelId, h.seq]),
        [
          [CH, 5],
          ['ch99', 1],
        ],
      );
      const chain = await store.chain(CH);
      assert.equal(heads[0]?.hash, chain[4]?.hash, 'the head is the last link');

      const slice = await store.chainSince(CH, 2, 2);
      assert.deepEqual(
        slice.map((e) => e.seq),
        [3, 4],
        'strictly after the cursor, in chain order, bounded',
      );
      assert.deepEqual(
        (await store.chainSince(CH, 4, 100)).map((e) => e.seq),
        [5],
      );
      assert.deepEqual(await store.chainSince(CH, 5, 100), [], 'caught up');
      assert.ok(
        (await store.chainSince('ch99', 0, 100)).every((e) => e.channelId === 'ch99'),
        'a channel sees only its own chain',
      );
    });
  });

  test(`[${name}] a message that is not an envelope is refused, and appends nothing`, async () => {
    await withStore(async (store) => {
      await assert.rejects(
        ingest(store, {
          id: ulid(),
          subject: `atlas.${CH}.asset.created`,
          body: { userId: 'bare payload' },
        }),
        /is not an envelope/,
      );
      assert.deepEqual(await store.count(), { events: 0, history: 0 });
    });
  });
}

// --- the browse, from either side ------------------------------------------------------------------

export interface BrowseHarness {
  /**
   * A store to write through, a browser to read from — the same object for a store adapter; a
   * store plus its index for OpenSearch — and, when the two are not one, how to make the reader
   * catch up with the writer before the assertions (a projector tick).
   */
  make: () => Promise<{
    store: AuditStore;
    browser: LogBrowser;
    sync?: () => Promise<void>;
    cleanup?: () => Promise<void>;
  }>;
}

export function browseConformance(name: string, harness: BrowseHarness): void {
  async function withBrowser(
    fn: (store: AuditStore, browser: LogBrowser, sync: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const { store, browser, sync, cleanup } = await harness.make();
    try {
      await fn(store, browser, sync ?? (async () => undefined));
    } finally {
      await cleanup?.();
    }
  }

  test(`[${name}] browse: newest first, keyset on seq, and every filter narrows`, async () => {
    await withBrowser(async (store, browser, sync) => {
      const corr = ulid();
      const at = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs).toISOString();
      const put = async (
        type: string,
        actorId: string,
        correlationId: string | undefined,
        occurredAt: string,
      ) => {
        const envelope = buildEnvelope({
          type,
          channelId: CH,
          payload: { n: 1 },
          actor: { kind: 'user', id: actorId },
          ...(correlationId ? { correlationId } : {}),
        });
        (envelope as { occurredAt: string }).occurredAt = occurredAt;
        await ingest(store, {
          id: envelope.messageId,
          subject: `atlas.${CH}.${type}`,
          body: envelope,
        });
      };
      await put('asset.created', 'alice', corr, at(0)); // seq 1
      await put('asset.updated', 'alice', corr, at(1_000)); // seq 2
      await put('user.created', 'bob', undefined, at(2_000)); // seq 3
      await put('asset.updated', 'bob', undefined, at(3_000)); // seq 4
      await ingest(store, domainMessage('asset.created', 'ch99')); // another channel, never seen
      await sync();

      const all = await browser.browse(CH, { limit: 10 });
      assert.deepEqual(
        all.map((e) => e.seq),
        [4, 3, 2, 1],
        'newest first, one channel only',
      );

      const page1 = await browser.browse(CH, { limit: 2 });
      assert.deepEqual(
        page1.map((e) => e.seq),
        [4, 3],
      );
      const page2 = await browser.browse(CH, { limit: 2, before: 3 });
      assert.deepEqual(
        page2.map((e) => e.seq),
        [2, 1],
        'keyset: strictly older than the cursor',
      );

      assert.deepEqual(
        (await browser.browse(CH, { limit: 10, types: ['asset.updated'] })).map((e) => e.seq),
        [4, 2],
      );
      assert.deepEqual(
        (await browser.browse(CH, { limit: 10, types: ['user.created', 'asset.created'] })).map(
          (e) => e.seq,
        ),
        [3, 1],
      );
      assert.deepEqual(
        (await browser.browse(CH, { limit: 10, correlationId: corr })).map((e) => e.seq),
        [2, 1],
      );
      assert.deepEqual(
        (await browser.browse(CH, { limit: 10, actorId: 'bob' })).map((e) => e.seq),
        [4, 3],
      );
      assert.deepEqual(
        (await browser.browse(CH, { limit: 10, from: at(1_000), to: at(2_000) })).map((e) => e.seq),
        [3, 2],
        'inclusive bounds',
      );
      assert.deepEqual(
        (await browser.browse(CH, { limit: 10, types: ['asset.updated'], actorId: 'alice' })).map(
          (e) => e.seq,
        ),
        [2],
        'filters combine',
      );
    });
  });
}
