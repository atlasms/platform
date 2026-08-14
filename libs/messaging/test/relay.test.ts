// EP-03.7 — pipelining `OutboxRelay.drain()`.
//
// ADR-0001 measured the gap: sequential publishing tops out around 123 msg/s while the same broker
// with 100 confirms in flight reaches 1216 — ~10×, entirely client-side. It also named the two
// things that make pipelining unsafe if done naively, and both are what this file is about:
//
//   "it would weaken the per-subject ordering that the serial loop gives by accident, and
//    markSent bookkeeping gets harder on partial failure"
//
// Neither failure is loud. Out-of-order delivery looks like a consumer bug months later, and a
// mis-marked record is either a lost event or a duplicate — all three found by someone else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryOutboxStore,
  OutboxRelay,
  RelayPartialFailure,
  type Broker,
  type Message,
  type OutboxRecord,
} from '../src/index.ts';

const record = (id: string, subject: string): OutboxRecord => ({
  id,
  message: { id, subject, body: { id } },
});

/** A broker that records order and can be made slow or made to fail, per subject. */
function recordingBroker(options: { delayFor?: (m: Message) => number; failOn?: string[] } = {}) {
  const published: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;

  const broker: Broker = {
    async publish(msg) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const delay = options.delayFor?.(msg) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      inFlight -= 1;
      if (options.failOn?.includes(msg.id)) throw new Error(`publish failed for ${msg.id}`);
      published.push(msg.id);
    },
    subscribe() {
      return { unsubscribe() {} };
    },
  };
  return { broker, published, peak: () => peakInFlight };
}

async function seeded(records: OutboxRecord[]) {
  const store = new InMemoryOutboxStore();
  for (const r of records) await store.add(r);
  return store;
}

// =============================================================================
// Ordering — the guarantee the serial loop gave by accident
// =============================================================================

test('DANGER: per-subject order is preserved even when publishes are slow and interleaved', async () => {
  // `asset.created` must reach a consumer before the `asset.approved` that follows it, or the
  // consumer sees an approval for an asset it has never heard of. The first message of subject A is
  // made SLOW so that a naive implementation — one worker per record — would let A2 overtake A1.
  const { broker, published } = recordingBroker({
    delayFor: (m) => (m.id === 'a1' ? 30 : 0),
  });
  const store = await seeded([
    record('a1', 'atlas.ch12.asset.created'),
    record('a2', 'atlas.ch12.asset.created'),
    record('a3', 'atlas.ch12.asset.created'),
  ]);

  await new OutboxRelay(store, broker, { concurrency: 8 }).drain();

  assert.deepEqual(published, ['a1', 'a2', 'a3'], 'a slow first message must still go first');
});

test('DIFFERENT subjects do overlap — that is the point', async () => {
  // Ordering is per subject, not global. If a slow subject blocked every other subject the
  // pipelining would buy nothing.
  const { broker, published, peak } = recordingBroker({
    delayFor: (m) => (m.subject.endsWith('.slow') ? 40 : 0),
  });
  const store = await seeded([
    record('s1', 'atlas.ch12.slow'),
    record('f1', 'atlas.ch12.fast'),
    record('f2', 'atlas.ch12.fast'),
  ]);

  await new OutboxRelay(store, broker, { concurrency: 8 }).drain();

  assert.ok(peak() > 1, 'nothing overlapped — the relay is still serial');
  assert.deepEqual(
    published,
    ['f1', 'f2', 's1'],
    'the fast subject finished while the slow one was still in flight',
  );
});

test('in-flight publishes are BOUNDED', async () => {
  // A backlog that accumulated during a broker outage would otherwise be published all at once the
  // moment it returns — a thundering herd aimed at the component that just came back.
  const { broker, peak } = recordingBroker({ delayFor: () => 5 });
  const store = await seeded(
    Array.from({ length: 50 }, (_, i) => record(`m${i}`, `atlas.ch12.subject${i}`)),
  );

  await new OutboxRelay(store, broker, { concurrency: 4 }).drain();

  assert.ok(peak() <= 4, `expected at most 4 in flight, saw ${peak()}`);
  assert.ok(peak() > 1, 'and it did actually pipeline');
});

// =============================================================================
// Partial failure — the bookkeeping ADR-0001 called out
// =============================================================================

test('DANGER: a failure stops ITS subject, and the rest of that subject stays unsent', async () => {
  // Publishing b3 after b2 failed would deliver them out of order, which is exactly what the
  // ordering guarantee exists to prevent. The next drain picks up from b2, still in order.
  const { broker, published } = recordingBroker({ failOn: ['b2'] });
  const store = await seeded([
    record('b1', 'atlas.ch12.b'),
    record('b2', 'atlas.ch12.b'),
    record('b3', 'atlas.ch12.b'),
  ]);

  await assert.rejects(new OutboxRelay(store, broker).drain(), RelayPartialFailure);

  assert.deepEqual(published, ['b1'], 'b3 must NOT overtake the failed b2');
  const unsent = (await store.listUnsent(10)).map((r) => r.id);
  assert.deepEqual(unsent, ['b2', 'b3'], 'and both remain for the next drain');
});

test('one subject failing does not stop another', async () => {
  const { broker, published } = recordingBroker({ failOn: ['x1'] });
  const store = await seeded([
    record('x1', 'atlas.ch12.x'),
    record('y1', 'atlas.ch12.y'),
    record('y2', 'atlas.ch12.y'),
  ]);

  await assert.rejects(new OutboxRelay(store, broker, { concurrency: 4 }).drain());

  assert.deepEqual(published.sort(), ['y1', 'y2'], 'y was unaffected by x failing');
  assert.deepEqual(
    (await store.listUnsent(10)).map((r) => r.id),
    ['x1'],
  );
});

test('DANGER: everything that published IS marked sent, even though the drain threw', async () => {
  // The bookkeeping half. If a partial failure discarded the marking, the next drain would
  // republish everything that already succeeded — turning one broker hiccup into a duplicate storm
  // that consumer idempotency then has to absorb.
  const { broker } = recordingBroker({ failOn: ['z9'] });
  const store = await seeded([
    ...Array.from({ length: 5 }, (_, i) => record(`ok${i}`, `atlas.ch12.s${i}`)),
    record('z9', 'atlas.ch12.z'),
  ]);

  const error = await new OutboxRelay(store, broker, { concurrency: 4 })
    .drain()
    .then(() => undefined)
    .catch((e: unknown) => e as RelayPartialFailure);

  assert.ok(error instanceof RelayPartialFailure);
  assert.equal(error.relayed, 5, 'the five that worked are counted');
  assert.equal(error.failed, 1);
  assert.deepEqual(
    (await store.listUnsent(10)).map((r) => r.id),
    ['z9'],
    'only the failure is left to retry',
  );
});

// =============================================================================
// The unchanged contract
// =============================================================================

test('an empty outbox is a no-op', async () => {
  const { broker, published } = recordingBroker();
  assert.equal(await new OutboxRelay(await seeded([]), broker).drain(), 0);
  assert.deepEqual(published, []);
});

test('drain returns the count relayed, and marks them all', async () => {
  const { broker, published } = recordingBroker();
  const store = await seeded([
    record('m1', 'atlas.ch12.a'),
    record('m2', 'atlas.ch12.b'),
    record('m3', 'atlas.ch12.a'),
  ]);

  assert.equal(await new OutboxRelay(store, broker, { concurrency: 4 }).drain(), 3);
  assert.equal(published.length, 3);
  assert.deepEqual(await store.listUnsent(10), []);
});

test('the batch limit still applies', async () => {
  const { broker, published } = recordingBroker();
  const store = await seeded(
    Array.from({ length: 10 }, (_, i) => record(`m${i}`, `atlas.ch12.s${i}`)),
  );

  assert.equal(await new OutboxRelay(store, broker).drain(4), 4);
  assert.equal(published.length, 4);
});

test('the old positional clock argument still works', async () => {
  // The third argument used to be the clock. Making a performance change into a breaking one would
  // be a poor trade, so both shapes are accepted.
  const { broker } = recordingBroker();
  const store = await seeded([record('m1', 'atlas.ch12.a')]);

  const relay = new OutboxRelay(store, broker, () => 12_345);
  assert.equal(await relay.drain(), 1);
  assert.deepEqual(await store.listUnsent(10), []);
});
