// A behaviour suite every transactional-outbox store must pass.
//
// The outbox is the platform's central correctness claim: a state change and the event announcing
// it commit together, or neither does. That claim is only worth anything if it holds on the store
// actually deployed — so the rules live here once, and both `node:sqlite` (tests, dev) and
// Postgres (production) are held to them.
//
// Test-support entry point: `@atlas/data/conformance`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboxRelay, type Broker, type Message, type OutboxStore } from '@atlas/messaging';

/**
 * What an implementation must provide to be tested. Everything is async so a synchronous driver
 * and a networked one can satisfy one suite — awaiting a synchronous value is free.
 */
export interface OutboxHarness {
  /** A clean store plus the pieces needed to prove atomicity against a real domain table. */
  setup: () => Promise<OutboxFixture>;
}

export interface OutboxFixture {
  store: OutboxStore;
  /** Run a unit of work; COMMIT on success, ROLLBACK if `fn` throws. */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Insert a row in the fixture's own domain table. Must be callable inside `transaction`. */
  insertDomainRow: (id: string) => Promise<void>;
  countDomainRows: () => Promise<number>;
  /** Enqueue within a transaction, alongside the domain write. */
  enqueue: (record: { id: string; message: Message }) => Promise<void>;
  cleanup: () => Promise<void>;
}

/** Records what it was asked to publish; the relay's view of a broker. */
class RecordingBroker implements Broker {
  readonly published: Message[] = [];
  async publish(msg: Message): Promise<void> {
    this.published.push(msg);
  }
  subscribe(): { unsubscribe: () => void } {
    return { unsubscribe: () => {} };
  }
}

const msg = (id: string, subject = 'atlas.ch12.asset.created'): Message => ({
  id,
  subject,
  body: { assetId: id, nested: { ok: true } },
});

export function outboxConformance(name: string, harness: OutboxHarness): void {
  async function withFixture(fn: (f: OutboxFixture) => Promise<void>): Promise<void> {
    const fixture = await harness.setup();
    try {
      await fn(fixture);
    } finally {
      await fixture.cleanup();
    }
  }

  test(`[${name}] a committed unit of work yields both the row and the event`, async () => {
    await withFixture(async (f) => {
      await f.transaction(async () => {
        await f.insertDomainRow('a1');
        await f.enqueue({ id: 'evt-1', message: msg('evt-1') });
      });

      assert.equal(await f.countDomainRows(), 1);
      const pending = await f.store.listUnsent(10);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.id, 'evt-1');
      // The body must survive the round trip through storage unchanged — envelopes are nested.
      assert.deepEqual(pending[0]?.message.body, { assetId: 'evt-1', nested: { ok: true } });
    });
  });

  test(`[${name}] ATOMICITY: a rolled-back unit of work leaves neither row nor event`, async () => {
    // The whole reason the outbox exists. If this fails, the platform can announce things that
    // did not happen, or do things it never announced.
    await withFixture(async (f) => {
      await assert.rejects(
        f.transaction(async () => {
          await f.insertDomainRow('a1');
          await f.enqueue({ id: 'evt-1', message: msg('evt-1') });
          throw new Error('domain rule violated after both writes');
        }),
        /domain rule violated/,
      );

      assert.equal(await f.countDomainRows(), 0, 'the domain row must be gone');
      assert.equal((await f.store.listUnsent(10)).length, 0, 'the event must be gone with it');
    });
  });

  test(`[${name}] the relay drains once and is safe to re-run`, async () => {
    await withFixture(async (f) => {
      const broker = new RecordingBroker();
      const relay = new OutboxRelay(f.store, broker);

      await f.transaction(async () => {
        await f.insertDomainRow('a1');
        await f.enqueue({ id: 'evt-1', message: msg('evt-1') });
      });

      assert.equal(await relay.drain(), 1);
      assert.equal(await relay.drain(), 0, 'a second drain must find nothing');
      assert.equal(broker.published.length, 1, 'and must not republish');
    });
  });

  test(`[${name}] unsent records come back in insertion order`, async () => {
    // The relay publishes in list order, so this is what per-stream ordering rests on.
    await withFixture(async (f) => {
      for (const id of ['evt-1', 'evt-2', 'evt-3']) {
        await f.transaction(async () => {
          await f.insertDomainRow(id);
          await f.enqueue({ id, message: msg(id) });
        });
      }
      const pending = await f.store.listUnsent(10);
      assert.deepEqual(
        pending.map((r) => r.id),
        ['evt-1', 'evt-2', 'evt-3'],
      );
    });
  });

  test(`[${name}] listUnsent respects its limit, and markSent removes from the queue`, async () => {
    await withFixture(async (f) => {
      for (const id of ['evt-1', 'evt-2', 'evt-3']) {
        await f.transaction(async () => {
          await f.insertDomainRow(id);
          await f.enqueue({ id, message: msg(id) });
        });
      }

      assert.equal((await f.store.listUnsent(2)).length, 2, 'batching must be honoured');

      await f.store.markSent('evt-1', Date.now());
      const remaining = await f.store.listUnsent(10);
      assert.deepEqual(
        remaining.map((r) => r.id),
        ['evt-2', 'evt-3'],
      );
    });
  });
}
