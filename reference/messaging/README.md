# @atlas/messaging — broker, outbox & idempotency

Broker-agnostic transport with an **in-memory broker** so services run and test with no real NATS.
Same `Broker` interface backs a NATS/RabbitMQ adapter in production (system plan §3.1).

## API

```ts
import { InMemoryBroker, InMemoryOutboxStore, OutboxRelay, InMemorySeenStore, idempotent } from '@atlas/messaging';

const broker = new InMemoryBroker();
broker.subscribe('atlas.*.asset.*.ready', idempotent(handler, new InMemorySeenStore()));

// producer side — transactional outbox (no dual-write):
const store = new InMemoryOutboxStore();
await store.add({ id: rec.id, message: { id: env.messageId, subject: subjectFor('ch12', env.type), body: env } });
await new OutboxRelay(store, broker).drain();
```

- **Subject matching**: NATS-style `*` (one token) and `>` (trailing).
- **In-memory broker**: awaited delivery, per-subscription retry, and a dead-letter queue.
- **Outbox relay**: publishes then marks sent (publish-before-mark ⇒ a crash is a safe redelivery).
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
