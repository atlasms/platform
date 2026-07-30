# Per-Service Implementation Plans

> One **build plan** per service — the engineering sequence to construct it, phase by phase.
> These sit under the [System Implementation Plan](../16-system-implementation-plan.md) (the
> general plan) and behind each service's [architecture spec](../../architecture/services/)
> (what the service *is*). A plan says *how and in what order to build it*.

## How the docs relate

| Doc | Answers |
|-----|---------|
| [Service Catalog](../../architecture/03-service-catalog.md) | What every service is, at a glance (compare/estimate). |
| [Service Spec](../../architecture/services/) | The full design of one service (domain, API, events, flows). |
| **Implementation Plan (here)** | The **build sequence** for one service: milestones per phase, modules, migrations, tests, deploy. |
| [System Implementation Plan](../16-system-implementation-plan.md) | Cross-service foundations, build order, standards. |

## Index (in build order)

| # | Service | First ships | Plan |
|---|---------|-------------|------|
| Backbone | API Gateway / BFF | Phase 0 | [api-gateway-plan](api-gateway-plan.md) |
| Backbone | WebSocket (Pusher) | Phase 0 | [websocket-plan](websocket-plan.md) |
| Backbone | IAM | Phase 0 (v0) → 3 (SSO/MFA) | [iam-plan](iam-plan.md) |
| MVP | HSM | Phase 1 (v1) → 3 (tiering) | [hsm-plan](hsm-plan.md) |
| MVP | RIM | Phase 1 (v1) → 3 (recording) | [rim-plan](rim-plan.md) |
| MVP | MTS | Phase 1 (v1) → 2 (autoscale) | [mts-plan](mts-plan.md) |
| MVP | MAM | Phase 1 (v1) → 2 (v2) | [mam-plan](mam-plan.md) |
| MVP | Scheduling | Phase 1 (v0) → 2 (send-to-air) | [scheduling-plan](scheduling-plan.md) |
| MVP | Logging & Analytics | Phase 1 (audit) → 3 (analytics) | [logging-analytics-plan](logging-analytics-plan.md) |
| Beta | BMS | Phase 2 (v1) → 3 (authoring) | [bms-plan](bms-plan.md) |
| Beta | Notifications & Messaging | Phase 2 | [notifications-plan](notifications-plan.md) |
| v1.0 | Newsroom | Phase 3 | [newsroom-plan](newsroom-plan.md) |
| v1.0 | Integration / Feeds | Phase 2 (in) → 3 (out) | [integration-feeds-plan](integration-feeds-plan.md) |
| v1.0 | AI Enrichment | Phase 3 | [ai-enrichment-plan](ai-enrichment-plan.md) |

**Feature plans** (cross-service capabilities, not a single service):
[Review, Approval, Expiry & Retention](../15-review-lifecycle-implementation-plan.md).

## Plan template {#template}

Each plan follows this shape so they're comparable and estimable:

1. **Scope & versions** — what each `vN` delivers, mapped to roadmap phases; explicit non-goals.
2. **Build sequence** — ordered milestones, each a shippable increment with concrete deliverables.
3. **Components / modules** — the internal building blocks to construct.
4. **Data plane & migrations** — stores owned, schema, migration approach.
5. **APIs & events** — the contracts to implement (linking OpenAPI stub + event schemas).
6. **Dependencies & integration points** — what must exist first; who consumes this service.
7. **Testing focus** — the risks worth targeting for this service specifically.
8. **Scaling & deployment** — how it scales, runtime specifics, config.
9. **Risks & mitigations** — service-specific.

All plans inherit the [cross-cutting standards](../16-system-implementation-plan.md#6-cross-cutting-engineering-standards)
(auth, multi-channel, outbox/idempotency, observability) — plans note only deviations.
