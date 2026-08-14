# @atlas/messaging — broker, outbox & idempotency

Broker-agnostic transport with an **in-memory broker** so services run and test with no real NATS.
Same `Broker` interface backs a NATS/RabbitMQ adapter in production (system plan §3.1).

## API

```ts
import {
  InMemoryBroker,
  InMemoryOutboxStore,
  OutboxRelay,
  InMemorySeenStore,
  idempotent,
} from '@atlas/messaging';

const broker = new InMemoryBroker();
broker.subscribe('atlas.*.asset.*.ready', idempotent(handler, new InMemorySeenStore()));

// producer side — transactional outbox (no dual-write):
const store = new InMemoryOutboxStore();
await store.add({
  id: rec.id,
  message: { id: env.messageId, subject: subjectFor('ch12', env.type), body: env },
});
await new OutboxRelay(store, broker).drain();
```

- **Subject matching**: NATS-style `*` (one token) and `>` (trailing).
- **In-memory broker**: awaited delivery, per-subscription retry, and a dead-letter queue.
- **`DeadLetterQueue`** (EP-03.4): inspection and replay, as a capability a broker MAY implement
  rather than part of `Broker`. Every service publishes and subscribes; none of them should be able
  to replay. `isDeadLetterQueue(broker)` is how a tool asks.
- **Outbox relay**: publishes then marks sent (publish-before-mark ⇒ a crash is a safe redelivery),
  **pipelined across subjects** with bounded in-flight publishes (EP-03.7) — measured 238 → 1650
  msg/s against real JetStream, a **6.9×** improvement.
  - Ordering is preserved **per subject**, which the serial loop it replaces gave by accident and
    which is load-bearing: `asset.created` must reach a consumer before the `asset.approved` that
    follows it. Each subject is a queue processed strictly in order; the parallelism is in how many
    subjects are in flight.
  - A publish failure stops **its** subject for that drain and leaves the rest of it unsent —
    publishing message 3 after message 2 failed would deliver them out of order. Other subjects are
    unaffected, and everything that did publish **is marked sent** before `RelayPartialFailure` is
    thrown, so a retry does not republish it.
- **`idempotent`**: dedupes redelivered messages by id — process-once under at-least-once delivery.

Composes with [`@atlas/contracts`](../contracts/README.md): build the envelope there, wrap it as a
transport `Message` (`id = messageId`, `subject = subjectFor(...)`, `body = envelope`), publish here.

## Run

```bash
npm install && npm test   # 6 tests — zero runtime deps
```

## Tests prove

- subject matching (literals, `*`, `>`, arity); publish delivers to matching subs only;
- a failing handler **retries then dead-letters**;
- the outbox relay **drains once and is safe to re-run** (already-sent records skipped);
- an idempotent consumer processes a **redelivered** message once;
- end-to-end: outbox → broker → idempotent consumer swallows the duplicate.
