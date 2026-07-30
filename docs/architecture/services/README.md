# Service Specifications

> Detailed, per-service specifications for Atlas. The [Service Catalog](../03-service-catalog.md)
> is the one-page comparison; **this folder is the deep dive** — one document per service,
> all following the same template so services stay comparable and estimable.
>
> Parents: [System Architecture](../02-system-architecture.md) ·
> [Service Catalog](../03-service-catalog.md) ·
> [Messaging & Data Model](../04-messaging-and-data.md). Requirements traced here come from
> [Functional](../../requirements/05-functional-requirements.md) and
> [Non-Functional](../../requirements/06-non-functional-requirements.md) requirements.

## Index

| Service | Group | Critical path | Spec |
|---------|-------|:-------------:|------|
| API Gateway | Edge | ✅ | [api-gateway.md](api-gateway.md) |
| WebSocket Service (Pusher) | Edge | UX | [websocket.md](websocket.md) |
| IAM — Identity & Access | Domain | ✅ | [iam.md](iam.md) |
| RIM — Recording & Ingest | Domain | ✅ | [rim.md](rim.md) |
| HSM — Hierarchical Storage Manager | Domain | ✅ | [hsm.md](hsm.md) |
| MTS — Media Transcoding System | Domain | ✅ | [mts.md](mts.md) |
| MAM — Metadata & Asset Management | Domain | ✅ | [mam.md](mam.md) |
| Scheduling | Domain | ✅ (playout) | [scheduling.md](scheduling.md) |
| BMS — Workflow Engine | Domain | ✅ (automated) | [bms.md](bms.md) |
| Newsroom | Domain | news-only | [newsroom.md](newsroom.md) |
| Notifications & Messaging | Domain | UX | [notifications.md](notifications.md) |
| Integration / Feeds | Domain | no | [integration-feeds.md](integration-feeds.md) |
| AI Enrichment | Domain | no | [ai-enrichment.md](ai-enrichment.md) |
| Logging & Analytics | Domain | compliance | [logging-analytics.md](logging-analytics.md) |
| **Planning & Resource Scheduling** *(v2.0)* | Domain | no | [planning.md](planning.md) |
| **Editorial (web editor & projects)** *(v2.0)* | Domain | no | [editorial.md](editorial.md) |

> The last two services come from the
> [production-lifecycle expansion](../../strategy/19-production-lifecycle-scope.md) and are
> scoped as **[v2.0](../../roadmap/08-roadmap.md#v2)**, after v1.0 GA. They are specified now so
> the v1.0 build can make the [three cheap preparations](../../roadmap/08-roadmap.md#three-cheap-preparations-to-make-inside-v10)
> that keep the expansion additive.
| **Media Editor** *(capability, not a service)* | Studio + MAM + MTS | no | [media-editor.md](media-editor.md) |

> The **Media Editor** is a Studio feature backed by MAM (edit-project storage) and MTS (render),
> not a standalone deployable — [why](media-editor.md#0-why-a-capability-not-a-service). It follows
> the same spec template so it stays estimable.

**Infrastructure, not bespoke services** (specified elsewhere, no card here):
the **Message Broker** ([Messaging & Data §2](../04-messaging-and-data.md#2-broker-topology))
and **Service Registry / Discovery** (orchestrator-provided,
[Architecture §3.3](../02-system-architecture.md#33-service-registry--discovery)).

## Spec template

Every service document uses these sections. Where a section is genuinely N/A it says so
rather than being omitted, so the shape is predictable.

1. **Purpose & boundaries** — the one responsibility; explicit *in scope* / *out of scope*.
2. **Requirements covered** — the `FR-*` / `NFR-*` IDs this service implements.
3. **Domain model** — owned entities and their key fields; the store each lives in.
4. **Public API** — synchronous endpoints (method, path, purpose, authorization).
5. **Messaging** — events **emitted** and **consumed**, with commands and payload keys.
6. **Key flows** — sequence/state diagrams for the service's defining behaviours.
7. **Dependencies** — services and infrastructure it needs.
8. **Scaling & performance** — scaling model and the NFR targets it must hit.
9. **Failure modes & degradation** — what breaks, blast radius, recovery.
10. **Security & data sensitivity** — authz depth, PII, secrets.
11. **Configuration** — the knobs, per-channel where relevant.
12. **Observability** — the metrics, key log events, and traces that prove it healthy.
13. **Implementation notes** — Node/TypeScript specifics ([A2](../../README.md#assumptions-register)):
    framework, libraries, data access, concurrency, and any escape hatch.
14. **Open questions / future** — known unknowns and Post-v1.0 direction.

## Machine-readable contracts

Each spec's synchronous API and events have executable stubs alongside these documents:

- **REST:** [OpenAPI 3.1 stubs](../openapi/) — one `.yaml` per service (linked from each spec's
  *Public API* section).
- **Events:** [JSON Schema payloads](../schemas/) — the [envelope](../schemas/envelope.schema.json)
  plus one payload schema per event in the [catalog](../04-messaging-and-data.md#3-event-catalog-core).

## Conventions

- **Stack.** Node.js (LTS) + TypeScript; NestJS for domain/control-plane services, Fastify
  for thin high-throughput edges ([A2](../../README.md#assumptions-register),
  [Catalog §Recommended implementation stack](../03-service-catalog.md#recommended-implementation-stack)).
- **API paths** are illustrative and versioned under `/api/v1`; the gateway strips the prefix.
- **Event names** follow `<domain>.<entity>.<action>` and travel in the shared
  [envelope](../04-messaging-and-data.md#13-message-envelope); subjects are
  `atlas.<channelId>.<domain>.<entity>.<action>`.
- **Every write** goes out through the [outbox](../04-messaging-and-data.md#42-consistency) so
  "state changed ⇒ event published" holds.
- **Every row/document** carries `channelId`; queries are channel-scoped by default.

---
_Back to the [documentation index](../../README.md)._
