# `@atlas/messaging-nats`

The NATS JetStream adapter chosen in [ADR-0001](../../docs/adr/0001-message-broker.md). Implements
`Broker` from [`@atlas/messaging`](../messaging/) and nothing else, so a service holding a `Broker`
cannot tell which transport it got.

```ts
const broker = await NatsBroker.connect({
  servers: process.env.ATLAS_NATS_URL,
  service: 'mam', // ← the subscribing service's identity. Load-bearing. See below.
});
```

## Why this is a separate package

`@atlas/messaging` has **zero runtime dependencies** and every service depends on it. Putting the
`@nats-io/*` client there would push a transport into every consumer, including browser-adjacent
ones.
Only a composition root pulls this package in.

## Three things that will bite you

**Message ids must be globally unique.** JetStream deduplicates on `msgID` across the _entire
stream_ for the length of the dedupe window — not per subject. Reuse an id and `publish()` resolves
successfully while the message is silently discarded. Atlas ids are ULIDs (`envelope.messageId`),
so this is satisfied by construction; it breaks the moment someone uses a counter or a natural key.
Pinned by a test.

**A durable consumer is a shared cursor.** Durables are named per `(service, pattern)` by
[`durableName`](src/nats-broker.ts). Two instances of `mam` sharing one durable is exactly right —
the work splits and each event is handled once. `mam` and `scheduler` sharing one would mean each
steals half the other's events. That is why `service` is a required option and not a nicety.

**A renamed durable replays everything.** The name is the cursor's identity. Change it and the new
consumer starts from the beginning of the stream under `DeliverPolicy.All`.

## Dead-lettering is reconstructed, not built in

JetStream has no DLQ. It caps redelivery at `max_deliver` and publishes an advisory, which this
adapter captures into an `ATLAS_DLQ` stream so nothing is dropped silently. ADR-0001 records this
as a real cost of the choice. Inspection and replay are **EP-03.4**.

## Tests

The shared conformance suite (`@atlas/messaging/conformance`) — the same one `InMemoryBroker`
passes — plus JetStream-specific behaviour. **CI runs them against a real JetStream server.**
Locally they skip unless `ATLAS_NATS_URL` is set:

```sh
docker compose -f infra/docker-compose.dev.yml up -d
ATLAS_NATS_URL=nats://localhost:54222 npm test -w @atlas/messaging-nats
```

This README used to argue that skipping in CI was the honest default, because the in-memory broker
"already covers the behaviour". It does not. Stream-wide dedupe, and two instances of one service
sharing a cursor while a second service gets its own copy, are properties of **JetStream** — the
double only proves we implemented our own double consistently, which is exactly what a conformance
suite exists to distrust. The real objection was cost, and a container declared by the workflow
costs a developer nothing and the job about five seconds.

So a skip is still right on a laptop without Docker, and refused in CI: a missing `ATLAS_NATS_URL`
throws rather than skipping, because a silent skip there is indistinguishable from a passing suite.
