// A behaviour suite every Broker implementation must pass.
//
// The point of programming against `Broker` is that a service cannot tell which transport it got.
// That is only true if the implementations actually agree — so the rules live here once, and both
// the in-memory broker and the JetStream adapter are held to them.
//
// This is a test-support entry point (`@atlas/messaging/conformance`), imported by test files in
// other packages. It uses node:test directly so the suite reads as ordinary tests in whichever
// package runs it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeadLetterQueue, type Broker, type Message } from './types.ts';
import { idempotent, type SeenStore } from './idempotency.ts';

export interface ConformanceHarness {
  /** A fresh broker. Called once per test; give each one an isolated namespace if needed. */
  make: () => Promise<{ broker: Broker; cleanup?: () => Promise<void> }>;
  /**
   * How many messages this broker gave up on. Optional: not every transport exposes it, and the
   * `Broker` interface deliberately does not require it.
   */
  deadLetterCount?: (broker: Broker) => Promise<number>;
  /**
   * How long to wait for an async transport to deliver. In-memory delivery is immediate; a real
   * broker needs a real budget.
   */
  timeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the suite. `name` labels the implementation under test; `prefix` must be unique per run so
 * a durable transport's retained history cannot leak between suites.
 */
export function brokerConformance(name: string, harness: ConformanceHarness): void {
  const timeout = harness.timeoutMs ?? 5_000;

  /** Poll until true or the budget runs out. Async predicates too — a real DLQ is a round trip. */
  async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(20);
    }
    return predicate();
  }

  /** Unique per test, so retained history in a durable broker cannot bleed across tests. */
  let counter = 0;
  const ns = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}`;

  /**
   * A unique message id per publish.
   *
   * Not a detail. JetStream deduplicates on `msgID` across the WHOLE STREAM for the length of its
   * dedupe window — not per subject — so a reused id makes `publish()` resolve successfully while
   * the message is silently discarded. Real messages carry a ULID (`envelope.messageId`); a suite
   * that reused `'m1'` would be testing the dedupe window rather than delivery.
   */
  const mid = (): string => `cf-${ns()}-${Math.random().toString(36).slice(2, 10)}`;

  async function withBroker(fn: (broker: Broker, chan: string) => Promise<void>): Promise<void> {
    const { broker, cleanup } = await harness.make();
    try {
      await fn(broker, `ch${ns()}`);
    } finally {
      await cleanup?.();
    }
  }

  test(`[${name}] delivers a message to a matching subscriber`, async () => {
    await withBroker(async (broker, chan) => {
      const got: Message[] = [];
      broker.subscribe(`atlas.${chan}.>`, (m) => {
        got.push(m);
      });
      await sleep(harness.timeoutMs ? 500 : 0); // let a real consumer attach

      await broker.publish({
        id: mid(),
        subject: `atlas.${chan}.asset.created`,
        body: { assetId: 'a1', nested: { n: 1 } },
      });

      assert.ok(await waitFor(() => got.length === 1), `expected 1 message, got ${got.length}`);
      assert.equal(got[0]?.subject, `atlas.${chan}.asset.created`);
      // Body fidelity matters: envelopes are nested objects, not flat strings.
      assert.deepEqual(got[0]?.body, { assetId: 'a1', nested: { n: 1 } });
    });
  });

  test(`[${name}] does not deliver a non-matching subject`, async () => {
    await withBroker(async (broker, chan) => {
      const got: Message[] = [];
      broker.subscribe(`atlas.${chan}.asset.>`, (m) => {
        got.push(m);
      });
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.schedule.updated`, body: {} });
      await sleep(harness.timeoutMs ? 1_000 : 0);

      assert.equal(got.length, 0);
    });
  });

  test(`[${name}] '*' matches exactly one token`, async () => {
    await withBroker(async (broker, chan) => {
      const got: string[] = [];
      broker.subscribe(`atlas.${chan}.*.created`, (m) => {
        got.push(m.subject);
      });
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });
      // One token too many — '*' must not swallow it.
      await broker.publish({
        id: mid(),
        subject: `atlas.${chan}.asset.rendition.created`,
        body: {},
      });

      assert.ok(await waitFor(() => got.length >= 1));
      await sleep(harness.timeoutMs ? 1_000 : 0);
      assert.deepEqual(got, [`atlas.${chan}.asset.created`]);
    });
  });

  test(`[${name}] two subscriptions both receive the same message`, async () => {
    await withBroker(async (broker, chan) => {
      const a: Message[] = [];
      const b: Message[] = [];
      broker.subscribe(`atlas.${chan}.>`, (m) => {
        a.push(m);
      });
      broker.subscribe(`atlas.${chan}.asset.>`, (m) => {
        b.push(m);
      });
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });

      assert.ok(await waitFor(() => a.length === 1 && b.length === 1));
    });
  });

  test(`[${name}] broadcast: two subscriptions on the SAME pattern each receive the message, once`, async () => {
    await withBroker(async (broker, chan) => {
      const a: Message[] = [];
      const b: Message[] = [];
      broker.subscribe(
        `atlas.${chan}.>`,
        (m) => {
          a.push(m);
        },
        { broadcast: true },
      );
      broker.subscribe(
        `atlas.${chan}.>`,
        (m) => {
          b.push(m);
        },
        { broadcast: true },
      );
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });

      assert.ok(
        await waitFor(() => a.length === 1 && b.length === 1),
        `expected each to get 1, got ${a.length} and ${b.length}`,
      );
      await sleep(harness.timeoutMs ? 500 : 0);
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
    });
  });

  test(`[${name}] broadcast: a failing handler is neither retried nor dead-lettered`, async () => {
    await withBroker(async (broker, chan) => {
      // The dead-letter store of a durable transport is shared across the run, so the assertion
      // is that THIS message added nothing to it.
      const deadBefore = (await harness.deadLetterCount?.(broker)) ?? 0;
      let calls = 0;
      broker.subscribe(
        `atlas.${chan}.>`,
        () => {
          calls++;
          throw new Error('nope');
        },
        { broadcast: true, maxAttempts: 3 },
      );
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });
      assert.ok(await waitFor(() => calls >= 1));
      await sleep(harness.timeoutMs ? 1_000 : 50);
      assert.equal(calls, 1);
      if (harness.deadLetterCount) assert.equal(await harness.deadLetterCount(broker), deadBefore);
    });
  });

  test(`[${name}] LIVE: progress reaches who is subscribed now, and nobody who comes later`, async () => {
    await withBroker(async (broker, chan) => {
      const early: Message[] = [];
      broker.subscribe(`live.${chan}.>`, (m) => {
        early.push(m);
      });
      await sleep(harness.timeoutMs ? 500 : 0);

      const id = mid();
      await broker.publishLive({
        id,
        subject: `live.${chan}.transcode.progress`,
        body: { jobId: 'j1', percent: 42 },
      });
      assert.ok(await waitFor(() => early.length === 1), 'the attached subscriber got it');
      assert.equal(early[0]?.id, id, 'with its id');
      assert.deepEqual(early[0]?.body, { jobId: 'j1', percent: 42 });

      // Nothing kept it: a subscriber attaching afterwards gets nothing. This is the property
      // that keeps progress out of the stream and out of the audit log.
      const late: Message[] = [];
      broker.subscribe(`live.${chan}.>`, (m) => {
        late.push(m);
      });
      await sleep(harness.timeoutMs ? 1_000 : 20);
      assert.equal(late.length, 0);
    });
  });

  test(`[${name}] LIVE: a failing handler is not retried, and nothing is dead-lettered`, async () => {
    await withBroker(async (broker, chan) => {
      const deadBefore = (await harness.deadLetterCount?.(broker)) ?? 0;
      let calls = 0;
      broker.subscribe(
        `live.${chan}.>`,
        () => {
          calls++;
          throw new Error('nope');
        },
        { maxAttempts: 5 },
      );
      await sleep(harness.timeoutMs ? 500 : 0);
      await broker.publishLive({ id: mid(), subject: `live.${chan}.x.progress`, body: {} });
      assert.ok(await waitFor(() => calls >= 1));
      await sleep(harness.timeoutMs ? 1_000 : 50);
      assert.equal(calls, 1);
      if (harness.deadLetterCount) assert.equal(await harness.deadLetterCount(broker), deadBefore);
    });
  });

  test(`[${name}] LIVE and durable do not mix: each publish refuses the other's subjects`, async () => {
    await withBroker(async (broker, chan) => {
      await assert.rejects(
        broker.publishLive({ id: mid(), subject: `atlas.${chan}.transcode.progress`, body: {} }),
        /not a live\. subject/,
      );
      await assert.rejects(
        broker.publish({ id: mid(), subject: `live.${chan}.transcode.progress`, body: {} }),
        /is a live\. subject/,
      );
    });
  });

  test(`[${name}] unsubscribe stops delivery`, async () => {
    await withBroker(async (broker, chan) => {
      const got: Message[] = [];
      const sub = broker.subscribe(`atlas.${chan}.>`, (m) => {
        got.push(m);
      });
      await sleep(harness.timeoutMs ? 500 : 0);

      sub.unsubscribe();
      await sleep(harness.timeoutMs ? 500 : 0);
      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });
      await sleep(harness.timeoutMs ? 1_000 : 0);

      assert.equal(got.length, 0);
    });
  });

  test(`[${name}] a failing handler is retried up to maxAttempts, then dead-lettered`, async () => {
    await withBroker(async (broker, chan) => {
      let attempts = 0;
      broker.subscribe(
        `atlas.${chan}.>`,
        () => {
          attempts++;
          throw new Error('always fails');
        },
        { maxAttempts: 3 },
      );
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });

      assert.ok(await waitFor(() => attempts >= 3), `expected 3 attempts, saw ${attempts}`);
      await sleep(harness.timeoutMs ? 2_000 : 0);
      assert.equal(attempts, 3, 'must stop at the cap, not retry forever');

      if (harness.deadLetterCount) {
        assert.ok(
          (await harness.deadLetterCount(broker)) >= 1,
          'an exhausted message must be dead-lettered, not dropped silently',
        );
      }
    });
  });

  // --- dead letters: inspection and replay (EP-03.4) -------------------------------------------
  //
  // Only run against a broker that claims the capability. The in-memory double and the JetStream
  // adapter reach dead letters by completely different routes — one keeps an array, the other
  // reconstructs from advisories and a second read of the source stream — which is exactly why
  // they belong under one suite rather than one set of tests each.

  test(`[${name}] a dead letter can be inspected, and names the message that failed`, async () => {
    await withBroker(async (broker, chan) => {
      if (!isDeadLetterQueue(broker)) return; // capability not offered
      const id = mid();

      broker.subscribe(
        `atlas.${chan}.>`,
        () => {
          throw new Error('always fails');
        },
        { maxAttempts: 2 },
      );
      await sleep(harness.timeoutMs ? 500 : 0);
      await broker.publish({ id, subject: `atlas.${chan}.asset.created`, body: { n: 1 } });

      assert.ok(
        await waitFor(async () => (await broker.deadLetterCount()) >= 1),
        'the message never reached the dead-letter queue',
      );
      await sleep(harness.timeoutMs ? 1_500 : 0);

      const entries = await broker.listDeadLetters(10);
      const entry = entries.find((e) => e.id === id);
      assert.ok(entry, `no dead letter for ${id}: saw ${entries.map((e) => e.id).join(', ')}`);
      assert.equal(entry.subject, `atlas.${chan}.asset.created`);
      assert.ok(entry.attempts >= 2, `expected the attempts it made, saw ${entry.attempts}`);
      // The payload has to come back or replay is impossible and inspection is a count.
      assert.deepEqual(entry.message?.body, { n: 1 });
    });
  });

  test(`[${name}] DANGER: replay actually re-delivers, rather than reporting success`, async () => {
    // The trap this pins is JetStream's: it deduplicates on msgID across the whole stream for the
    // dedupe window, so republishing under the ORIGINAL id resolves successfully and is silently
    // discarded. A replay that reports success and delivers nothing is worse than one that fails.
    await withBroker(async (broker, chan) => {
      if (!isDeadLetterQueue(broker)) return;
      const id = mid();
      let fail = true;
      let delivered = 0;

      broker.subscribe(
        `atlas.${chan}.>`,
        () => {
          delivered++;
          if (fail) throw new Error('failing on purpose');
        },
        { maxAttempts: 2 },
      );
      await sleep(harness.timeoutMs ? 500 : 0);
      await broker.publish({ id, subject: `atlas.${chan}.asset.created`, body: { n: 1 } });

      assert.ok(await waitFor(async () => (await broker.deadLetterCount()) >= 1));
      await sleep(harness.timeoutMs ? 1_500 : 0);
      const before = delivered;

      // The handler is fixed — which is the whole reason an operator replays.
      fail = false;
      const result = await broker.replay(id);
      assert.equal(result.replayed, true, result.reason ?? 'replay refused');

      assert.ok(
        await waitFor(() => delivered > before),
        'replay claimed success but nothing was delivered',
      );
    });
  });

  test(`[${name}] replaying an unknown id is refused with a reason, not silently`, async () => {
    await withBroker(async (broker) => {
      if (!isDeadLetterQueue(broker)) return;
      const result = await broker.replay('no-such-message');
      assert.equal(result.replayed, false);
      assert.ok(result.reason, 'a refusal must say why — an operator is reading this');
    });
  });

  test(`[${name}] a handler that succeeds is not retried`, async () => {
    await withBroker(async (broker, chan) => {
      let attempts = 0;
      broker.subscribe(`atlas.${chan}.>`, () => {
        attempts++;
      });
      await sleep(harness.timeoutMs ? 500 : 0);

      await broker.publish({ id: mid(), subject: `atlas.${chan}.asset.created`, body: {} });

      assert.ok(await waitFor(() => attempts === 1));
      await sleep(harness.timeoutMs ? 1_500 : 0);
      assert.equal(attempts, 1, 'an acked message must not come back');
    });
  });
}

// --- SeenStore ---------------------------------------------------------------
//
// A behaviour suite every SeenStore implementation must pass.
//
// Consumer idempotency is the receiving half of the outbox's promise: the outbox guarantees an
// event is published at least once, and that "at least" is precisely what makes a duplicate
// arrive. Whether the duplicate is harmless depends entirely on this port being atomic — so the
// rules live here once, and the in-memory, sqlite and Postgres stores are all held to them.

/** A fresh, empty store per test. `cleanup` drops whatever backing storage it created. */
export interface SeenStoreHarness {
  make: () => Promise<{ store: SeenStore; cleanup?: () => Promise<void> }>;
}

export function seenStoreConformance(name: string, harness: SeenStoreHarness): void {
  async function withStore(fn: (store: SeenStore) => Promise<void>): Promise<void> {
    const { store, cleanup } = await harness.make();
    try {
      await fn(store);
    } finally {
      await cleanup?.();
    }
  }

  test(`[${name}] markSeen reports NEW once and duplicate thereafter`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.markSeen('evt-1'), true, 'the first sighting is new');
      assert.equal(await store.markSeen('evt-1'), false, 'the second is a duplicate');
      assert.equal(await store.markSeen('evt-1'), false, 'and it stays a duplicate');
    });
  });

  test(`[${name}] distinct ids do not shadow one another`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.markSeen('evt-1'), true);
      assert.equal(await store.markSeen('evt-2'), true, 'a different id is unaffected');
      assert.equal(await store.markSeen('evt-1'), false);
    });
  });

  test(`[${name}] ATOMICITY: concurrent markSeen of one id yields exactly ONE winner`, async () => {
    // The reason this port exists in this shape. The old `seen()` + `remember()` pair failed here
    // by construction: every caller observes "not seen" before any of them has remembered, so all
    // of them proceed and the effect is applied N times. A store that is not atomic passes every
    // other test in this suite and fails this one.
    await withStore(async (store) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, async () => store.markSeen('evt-race')),
      );
      const winners = results.filter(Boolean).length;
      assert.equal(winners, 1, `exactly one caller may claim the id, got ${winners}`);
    });
  });

  test(`[${name}] forget releases a mark so a redelivery is processed`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.markSeen('evt-1'), true);
      await store.forget('evt-1');
      assert.equal(await store.markSeen('evt-1'), true, 'a forgotten id is new again');
    });
  });

  test(`[${name}] forgetting an id that was never marked is a no-op, not an error`, async () => {
    // `idempotent` calls forget on the failure path, which can run for an id another replica
    // already cleaned up. Throwing there would replace the handler's real error with a spurious one.
    await withStore(async (store) => {
      await store.forget('never-seen');
      assert.equal(await store.markSeen('never-seen'), true);
    });
  });

  test(`[${name}] idempotent(): a redelivered message is handled once`, async () => {
    await withStore(async (store) => {
      let handled = 0;
      const handler = idempotent(() => {
        handled++;
      }, store);

      const msg: Message = { id: 'evt-dup', subject: 'atlas.ch12.asset.created', body: {} };
      await handler(msg);
      await handler(msg); // at-least-once redelivery
      assert.equal(handled, 1);
    });
  });

  test(`[${name}] idempotent(): a FAILED handler is retried, not suppressed`, async () => {
    // The half a claim-first design gets wrong if it forgets to release. Marking before processing
    // is what makes concurrent duplicates safe; without the release, one transient failure means
    // the message is skipped by every future redelivery and the effect never happens at all.
    await withStore(async (store) => {
      let attempts = 0;
      const handler = idempotent((): void => {
        attempts++;
        if (attempts === 1) throw new Error('transient downstream failure');
      }, store);

      const msg: Message = { id: 'evt-retry', subject: 'atlas.ch12.asset.created', body: {} };
      await assert.rejects(handler(msg), /transient downstream failure/);
      await handler(msg); // the broker redelivers
      assert.equal(attempts, 2, 'the retry must reach the handler');

      await handler(msg); // and once it has succeeded, it is a duplicate again
      assert.equal(attempts, 2, 'a success must still suppress later duplicates');
    });
  });

  test(`[${name}] idempotent(): keyOf chooses the identity that is deduped`, async () => {
    await withStore(async (store) => {
      let handled = 0;
      const handler = idempotent(
        () => {
          handled++;
        },
        store,
        (m) => (m.body as { key: string }).key,
      );

      await handler({ id: 'a', subject: 'atlas.ch12.asset.created', body: { key: 'k1' } });
      await handler({ id: 'b', subject: 'atlas.ch12.asset.created', body: { key: 'k1' } });
      assert.equal(handled, 1, 'different message ids, same business key — handled once');

      await handler({ id: 'c', subject: 'atlas.ch12.asset.created', body: { key: 'k2' } });
      assert.equal(handled, 2);
    });
  });
}
