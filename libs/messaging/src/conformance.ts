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
import type { Broker, Message } from './types.ts';

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

  async function waitFor(predicate: () => boolean): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return true;
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
