# OpenAPI Stubs

> One **OpenAPI 3.1** document per service, stubbing the synchronous REST surface described in
> each [service specification](../services/). These are **contract skeletons** — every path,
> method, tag, security requirement, and the key request/response schema shapes — meant to be
> fleshed out into full contracts and to seed generated clients/servers.
>
> Async contracts (broker events) live next door in [../schemas/](../schemas/).

## Files

| Service | Spec | OpenAPI |
|---------|------|---------|
| API Gateway | [api-gateway](../services/api-gateway.md) | [api-gateway.yaml](api-gateway.yaml) |
| WebSocket | [websocket](../services/websocket.md) | [websocket.yaml](websocket.yaml) |
| IAM | [iam](../services/iam.md) | [iam.yaml](iam.yaml) |
| RIM | [rim](../services/rim.md) | [rim.yaml](rim.yaml) |
| HSM | [hsm](../services/hsm.md) | [hsm.yaml](hsm.yaml) |
| MTS | [mts](../services/mts.md) | [mts.yaml](mts.yaml) |
| MAM | [mam](../services/mam.md) | [mam.yaml](mam.yaml) |
| Scheduling | [scheduling](../services/scheduling.md) | [scheduling.yaml](scheduling.yaml) |
| BMS | [bms](../services/bms.md) | [bms.yaml](bms.yaml) |
| Newsroom | [newsroom](../services/newsroom.md) | [newsroom.yaml](newsroom.yaml) |
| Notifications & Messaging | [notifications](../services/notifications.md) | [notifications.yaml](notifications.yaml) |
| Integration / Feeds | [integration-feeds](../services/integration-feeds.md) | [integration-feeds.yaml](integration-feeds.yaml) |
| AI Enrichment | [ai-enrichment](../services/ai-enrichment.md) | [ai-enrichment.yaml](ai-enrichment.yaml) |
| Logging & Analytics | [logging-analytics](../services/logging-analytics.md) | [logging-analytics.yaml](logging-analytics.yaml) |
| Media Editor *(capability)* | [media-editor](../services/media-editor.md) | in [mam.yaml](mam.yaml) — tag `editor` |
| Reference / config *(cross-cutting)* | [config & reference data](../configuration-and-reference-data.md) | `/reference`, `/vocabularies`, `/settings` in [mam.yaml](mam.yaml) — tags `reference`, `config` |

## Conventions

- **OpenAPI 3.1.0** (JSON-Schema-2020-12-aligned, so these compose with
  [../schemas/](../schemas/)).
- **Base path** `/api/v1`; the [API Gateway](../services/api-gateway.md) terminates TLS,
  authenticates, and proxies to the owning service — clients call one host, these documents
  describe the service behind it.
- **Security:** a global `bearerAuth` (JWT access token). Public endpoints (login, JWKS,
  health) override with `security: []`. Internal service-to-service endpoints are tagged
  `internal` and are not exposed to Studio through the gateway.
- **Errors:** a shared `Error` shape (`code`, `message`, `correlationId`) via the `Error`
  response; the `correlationId` matches the [message envelope](../schemas/envelope.schema.json).
- **Stubs, not full contracts.** Request/response bodies are representative shapes; enums and
  ids mirror [common.schema.json](../schemas/common.schema.json). Flesh out per endpoint as it
  is built. Each file is self-contained (components inlined) so any linter/generator resolves
  it without external refs.
- **Authorization scopes** in each operation's description use the same names as the service
  spec's API table (e.g. `asset:write`, `schedule:send`).

## Tooling

- Lint: `redocly lint iam.yaml` or `spectral lint *.yaml`.
- Preview: `redocly preview-docs mam.yaml`, or paste into editor.swagger.io.
- Generate: `openapi-generator-cli generate -i mam.yaml -g typescript-axios` (client) or
  `-g typescript-nestjs` (server stubs), matching the [Node/TypeScript stack](../services/README.md#conventions).

---
_Back to [Service Specifications](../services/) · [documentation index](../../README.md)._
