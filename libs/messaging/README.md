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
- **`subscribe(pattern, handler, { broadcast: true })`** (EP-17.7): every instance gets every
  message, from now on, once. The default subscription is a SHARED cursor — instances of one
  service split the work, a failure is retried then dead-lettered, a restart resumes. A cache
  invalidation or a fan-out to connected clients wants the opposite on every count, and broadcast
  is that: not durable, not retried, not dead-lettered, nothing published before the instance
  existed. On JetStream it is an ephemeral consumer (`DeliverPolicy.New`, `AckPolicy.None`,
  deleted by the server once the instance is gone). Never use it for work.

Composes with [`@atlas/contracts`](../contracts/README.md): build the envelope there, wrap it as a
transport `Message` (`id = messageId`, `subject = subjectFor(...)`, `body = envelope`), publish here.

## Consumer idempotency — `SeenStore`

The receiving half of the outbox's promise. The outbox guarantees an event is published **at least
once**, and "at least" is exactly what puts a duplicate on the wire.

**The race used to be in the interface.** `SeenStore` was `seen(id)` then `remember(id)` — two calls
with a gap, which no backing store can make atomic: by the time `remember` runs the decision was
already taken on stale information, so two concurrent deliveries both observe "not seen" and both
apply the effect. The port is now a single `markSeen(id): Promise<boolean>` that records **and**
reports whether this caller was the one that recorded it. Redis `SET NX` and Postgres
`INSERT … ON CONFLICT DO NOTHING` exist for precisely this reason.

`idempotent()` claims, then processes, then **releases on failure** — and each part of that order is
load-bearing. Claiming first is what makes concurrent duplicates safe. Releasing on failure is what
keeps a claim from becoming message loss: without it, one transient handler error means every
redelivery is skipped by a consumer that never did the work.

> ⚠️ **Which store depends on what the consumer DOES, and getting this backwards breaks things in
> opposite directions.**
>
> - A consumer that **writes to a database** wants a durable, shared store — and its mark must
>   commit in the **same transaction** as its writes. `SqliteSeenStore` / `PgSeenStore` in
>   [`@atlas/data`](../data/README.md) take a transaction handle for that. Otherwise a crash between
>   the claim and the commit leaves the id marked with the effect never applied, and redelivery is
>   suppressed forever.
> - A consumer that **fans out to its own connections** — the WebSocket bridge — must use the
>   per-process `InMemorySeenStore`. Sharing dedup across those replicas is **actively wrong**:
>   replica A claims the message and replica B's clients silently never receive it. Every replica
>   must process every message.
>
> There is one broker consumer in the platform today (the bridge), and it is the second kind.

Any implementation must pass `seenStoreConformance` from `@atlas/messaging/conformance`, which the
in-memory, sqlite and Postgres stores all run. Its atomicity case is the one that matters: a store
with the old check-then-set race passes **every other test in the suite** and fails only that one.

## Run

```bash
npm install && npm test   # 36 tests — zero runtime deps
```

## Tests prove

- subject matching (literals, `*`, `>`, arity); publish delivers to matching subs only;
- a failing handler **retries then dead-letters**;
- the outbox relay **drains once and is safe to re-run** (already-sent records skipped);
- an idempotent consumer processes a **redelivered** message once;
- end-to-end: outbox → broker → idempotent consumer swallows the duplicate;
- `markSeen` is **atomic**: eight concurrent claims on one id yield exactly one winner;
- a **failed** handler releases its claim, so the redelivery is retried rather than swallowed;
- `InMemorySeenStore` is **per-process**, so two replicas of a fan-out consumer both deliver;
- …and it **grows without bound**, which is the reason the durable stores have `prune`.
