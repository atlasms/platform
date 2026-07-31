# ADR-0001 — Message broker: NATS JetStream

- **Status:** Accepted
- **Date:** 2026-07-31
- **Story:** EP-03.0 (spike, timebox 3 d)
- **Harness:** [`spikes/broker/`](../../spikes/broker/) — `npm run spike -w @atlas/broker-spike`

## Context

Every Atlas service publishes domain events through the transactional outbox and consumes other
services' events idempotently ([messaging §1.2](../architecture/04-messaging-and-data.md#12-delivery-guarantees--idempotency)).
The broker is therefore in the path of essentially all cross-service behaviour, and swapping it
later would touch every service's deployment, its topology-as-code, and its operational runbooks.

Two candidates were named in the backlog: **NATS JetStream** and **RabbitMQ**.

Constraints that actually bear on the choice:

- **A9 / FR-PLat-7 — the platform must install and run fully offline**, in air-gapped facilities.
  Everything ships in the offline bundle; there is no "just pull it from the internet" step.
- Subjects are `atlas.<channelId>.<domain>.<entity>.<action>`, matched with `*` (one token) and
  `>` (one-or-more trailing tokens) — see [`matchSubject`](../../libs/messaging/src/subject.ts).
- Delivery is at-least-once with explicit ack; consumers dedupe.
- On-prem broadcast operators run this themselves. Operational surface area is a cost they pay.

## Options

Both were implemented against the **same** [`Broker`](../../libs/messaging/src/types.ts) interface
the platform already programs against, so nothing below depends on a convenience only one of them
offers.

Fairness notes, because they change the numbers materially:

- RabbitMQ uses a **confirm channel** and awaits the broker ack on every publish. JetStream's
  `publish()` awaits a server ack by definition; a plain amqplib channel would have "won"
  throughput purely by not making the promise.
- Messages are `persistent: true` on RabbitMQ, and JetStream streams are file-backed. Both are
  writing to disk before acknowledging.
- The durability test (T3) **pre-declares topology** on both. RabbitMQ needs a queue bound to the
  exchange before a message can land anywhere; in production that is a deploy-time step, so a test
  that skipped it would have measured deployment order rather than durability.

## Evidence

Measured 2026-07-31 on Docker Desktop / Windows 11, single node, default tuning, 200-byte
payloads, 20,000 messages per publish mode. **These are relative numbers on a developer laptop, not
a capacity plan** — the fsync path through Docker Desktop's VM dominates the absolute figures.

| | NATS JetStream | RabbitMQ |
|---|---:|---:|
| T1 subject fidelity vs `matchSubject()` | ✅ exact | ❌ 1 divergence |
| T2 load spike, 40,000 msgs delivered | ✅ | ✅ |
| T3 durability across a broker restart | ✅ 2000/2000 | ✅ 2000/2000 |
| T4 redelivery, attempt cap, dead-letter | ✅ 3/3 + DLQ | ✅ 3/3 + DLQ |
| **T5 publish before any consumer exists** | ✅ 100/100 retained | ❌ **0/100 — silent loss** |
| publish msg/s — sequential | **123** | 77 |
| publish msg/s — pipelined ×100 | 1216 | **1259** |
| latency p50 / p95 / p99 ms | 2.6 / 44.9 / 48.9 | 3.2 / 48.4 / 56.2 |
| image size | **10 MB** | 85 MB |
| memory after load | **43 MB** | 96 MB |

Three results carried the decision.

### T5 — RabbitMQ accepts and discards messages nobody is bound to

A message published to a topic exchange with no matching queue binding is **dropped, and the
publisher confirm still succeeds**. All 100 messages were accepted; none reached a subscriber that
attached moments later.

This is not a curiosity, it is a direct conflict with the outbox.
[`OutboxRelay.drain()`](../../libs/messaging/src/outbox.ts) marks a record sent as soon as
`publish()` resolves. Under RabbitMQ, a missing or renamed binding means the state change
committed, the outbox forgot the event, and nothing was delivered — the exact dual-write drift the
outbox exists to prevent, reintroduced underneath it.

It is **mitigable**: publish with the `mandatory` flag and handle `basic.return`, and/or manage all
topology as code applied strictly before any service starts. But it converts a broker default into
a standing platform invariant that must be enforced forever, in every environment, including the
ones operators modify on site.

JetStream stores by subject into the stream whether or not a consumer exists, so a late-deploying
consumer picks up everything from the stream's retention window. Nothing to enforce.

### T1 — `>` and `#` are not the same wildcard

Atlas' `>` matches **one-or-more** trailing tokens; AMQP's `#` matches **zero-or-more**. So
`atlas.ch12.>` correctly refuses `atlas.ch12`, while the translated binding `atlas.ch12.#` accepts
it. NATS subject wildcards *are* `matchSubject()`'s semantics — zero translation, zero divergence.

Scope honestly: the divergence is only reachable with a two-token subject, and every legal Atlas
subject has at least four. It is a latent trap rather than a live bug. But it is one more rule that
has to stay true in a translation layer that would otherwise not exist.

### Footprint under A9

10 MB versus 85 MB, and 43 MB versus 96 MB resident. NATS is a single static Go binary; RabbitMQ
carries an Erlang/OTP runtime. For a platform that ships as an offline bundle to on-prem facilities
and is operated by broadcast engineers rather than a platform team, the smaller, single-process,
single-config-file server is materially cheaper to install, diagnose and upgrade.

### Where RabbitMQ was better or equal

Stated plainly, because they are real:

- **Dead-lettering is first-class.** `x-dead-letter-exchange` is a queue argument and the broker
  routes there itself. JetStream has no DLQ — it caps redelivery at `max_deliver` and publishes an
  *advisory*, which must be captured into its own stream to reconstruct the feature.
- **Pipelined throughput was marginally higher** (1259 vs 1216 msg/s — inside noise).
- **The management UI ships in the box** and is genuinely good. NATS' equivalent is thinner.
- **Far more people have operated it**, and more of the surrounding tooling assumes AMQP.

## Decision

**NATS JetStream.**

The deciding factor is T5. Atlas' correctness story rests on the transactional outbox, and
RabbitMQ's default behaviour silently voids it whenever topology lags deployment. RabbitMQ's own
strength — an explicit, curated exchange/queue/binding topology — is exactly what turns into a
liability in a product installed and modified on customer sites.

Subject-model fidelity and the air-gapped footprint reinforce it. Throughput did not distinguish
them.

## Consequences

- **EP-03.1** lifts `reference/messaging` onto a JetStream adapter. The spike's
  [`NatsJetStreamBroker`](../../spikes/broker/src/nats-broker.ts) is the starting point, not the
  finished article.
- **EP-03.4 owns a real gap.** The DLQ must be built from `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>`
  into a dedicated stream, plus the inspection/replay tool. This is work RabbitMQ would have given
  us for free, and it is now a tracked story rather than an assumption.
- **Publish-side dedupe comes free.** JetStream collapses duplicate `msgID`s inside a window, so a
  relay that crashes between `publish()` and `markSent()` does not produce a duplicate at all.
  Consumers still dedupe — the window is finite and this is a bonus, not the guarantee.
- **The offline bundle** gains one ~10 MB image.
- **`InMemoryBroker` remains the test double.** No test in CI talks to a broker; `infra/docker-compose.dev.yml`
  is for local development and the spike.

### Unrelated finding worth its own story

Sequential publishing tops out around **123 msg/s**, while the same broker with 100 confirms in
flight reaches **1216 msg/s** — a ~10× gap that is entirely client-side. `OutboxRelay.drain()`
publishes in a serial `await` loop, so **the relay, not the broker, is the throughput ceiling**.

Pipelining it is not free: it would weaken the per-subject ordering that the serial loop gives by
accident, and `markSent` bookkeeping gets harder on partial failure. Raised as a follow-up story
rather than folded in here.

## Revisit when

- A deployment needs multi-region or leaf-node federation between facilities (JetStream mirroring
  is a strength here, but it is untested by this spike).
- Sustained event rates approach the pipelined ceiling on production hardware — at which point
  measure on that hardware rather than trusting these figures.
- An integration partner requires AMQP 1.0 at the edge. That is a gateway concern and should not
  drive the internal bus.
