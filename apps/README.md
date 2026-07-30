# `apps/` — deployables

One deployable per service, plus Studio. Each is built from the
[service template](../docs/roadmap/21-epic-breakdown.md) (`service-kit`) so health, logging,
config, auth, errors and tracing are identical everywhere and are never re-implemented per service.

## Planned deployables

| App                 | Spec                                                                       | Plan                                                       | First ships     |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------- |
| `api-gateway`       | [api-gateway.md](../docs/architecture/services/api-gateway.md)             | [plan](../docs/roadmap/services/api-gateway-plan.md)       | Phase 0         |
| `websocket`         | [websocket.md](../docs/architecture/services/websocket.md)                 | [plan](../docs/roadmap/services/websocket-plan.md)         | Phase 0         |
| `iam`               | [iam.md](../docs/architecture/services/iam.md)                             | [plan](../docs/roadmap/services/iam-plan.md)               | Phase 0 (v0)    |
| `hsm`               | [hsm.md](../docs/architecture/services/hsm.md)                             | [plan](../docs/roadmap/services/hsm-plan.md)               | Phase 1         |
| `rim`               | [rim.md](../docs/architecture/services/rim.md)                             | [plan](../docs/roadmap/services/rim-plan.md)               | Phase 1         |
| `mts`               | [mts.md](../docs/architecture/services/mts.md)                             | [plan](../docs/roadmap/services/mts-plan.md)               | Phase 1         |
| `mam`               | [mam.md](../docs/architecture/services/mam.md)                             | [plan](../docs/roadmap/services/mam-plan.md)               | Phase 1         |
| `scheduling`        | [scheduling.md](../docs/architecture/services/scheduling.md)               | [plan](../docs/roadmap/services/scheduling-plan.md)        | Phase 1         |
| `logging-analytics` | [logging-analytics.md](../docs/architecture/services/logging-analytics.md) | [plan](../docs/roadmap/services/logging-analytics-plan.md) | Phase 1         |
| `bms`               | [bms.md](../docs/architecture/services/bms.md)                             | [plan](../docs/roadmap/services/bms-plan.md)               | Phase 2         |
| `notifications`     | [notifications.md](../docs/architecture/services/notifications.md)         | [plan](../docs/roadmap/services/notifications-plan.md)     | Phase 2         |
| `integration-feeds` | [integration-feeds.md](../docs/architecture/services/integration-feeds.md) | [plan](../docs/roadmap/services/integration-feeds-plan.md) | Phase 2 (in)    |
| `newsroom`          | [newsroom.md](../docs/architecture/services/newsroom.md)                   | [plan](../docs/roadmap/services/newsroom-plan.md)          | Phase 3         |
| `ai-enrichment`     | [ai-enrichment.md](../docs/architecture/services/ai-enrichment.md)         | [plan](../docs/roadmap/services/ai-enrichment-plan.md)     | Phase 3         |
| `studio`            | [studio-frontend.md](../docs/architecture/studio-frontend.md)              | —                                                          | Phase 0 (shell) |

> The **Media Editor** is not here — it is a [Studio capability](../docs/architecture/services/media-editor.md)
> backed by MAM and MTS, not a deployable.

## Conventions

- **Every row and every message carries `channelId`**; queries are channel-scoped by default.
- **Every write goes out through the outbox** so "state changed ⇒ event published" holds.
- **Contracts first**: the service's [OpenAPI stub](../docs/architecture/openapi/) and
  [event payload schemas](../docs/architecture/schemas/) are merged before its implementation
  stories are pulled.
- Services **never** call IAM per request — they evaluate the compiled policy locally with
  `@atlas/policy`.
- Only **HSM** holds storage credentials; every other service requests file operations through it.

---

_Structure: [System Implementation Plan §3.1](../docs/roadmap/16-system-implementation-plan.md#31-monorepo--shared-libraries) ·
build order: [§4](../docs/roadmap/16-system-implementation-plan.md#4-service-build-order--dependency-graph)._
