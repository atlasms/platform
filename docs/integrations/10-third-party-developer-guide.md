# Third-Party Developer & Integration Guide

> How external systems and developers connect to Atlas — authentication, the REST surface,
> webhooks/events, inbound/outbound feeds, and the connector model. Parent:
> [Technical Brief](../01-technical-brief.md). The service that hosts most of this:
> [Integration / Feeds](../architecture/03-service-catalog.md#integration--feeds). This is a
> reference outline; exact schemas are published per service alongside their code.

## 1. Ways to integrate

Atlas offers four integration surfaces, in increasing order of coupling:

| Surface | Direction | Use when |
|---------|-----------|----------|
| **REST API** (via API Gateway) | you → Atlas | Programmatic control: query assets, push metadata, drive schedules. |
| **Webhooks / event subscriptions** | Atlas → you | React to platform events (asset ready, approved, schedule changed). |
| **Inbound feeds** | you → Atlas (batch/stream) | Import external catalogs/wires (JSON/XML) with field mapping. |
| **Outbound feeds / custom APIs** | Atlas → you (published) | Expose tailored data shapes to a third-party app (EPG, web, partners). |
| **Prebuilt connectors** | both | EPG, HbbTV launchers, social/web, newsroom (MOS). |

All programmatic access goes through the **API Gateway**; there is no direct service or
database access for third parties.

> **Air-gapped deployments** ([A9](../README.md#assumptions-register)): Atlas may run in an
> **isolated network with no internet**. In that mode, outbound internet integrations (public
> social APIs, cloud services) are unavailable by design — integrate over the **local
> network** instead (playlist export to on-prem playout, LAN webhooks, local feed drops). The
> REST API, webhooks, and feeds all work fully offline within the facility network.

## 2. Authentication & authorization

Atlas uses the same [IAM](../architecture/03-service-catalog.md#iam--identity-and-access-management)
model for machines as for people.

- **Service accounts** — create a machine identity in IAM with a scoped set of permission
  rules ([FR-IAM](../requirements/05-functional-requirements.md#iam)). Prefer OAuth2
  **client-credentials**; the client exchanges its credentials for a short-lived **JWT
  access token**.
- **Scopes** map to Atlas permissions and are **channel-scoped** — a token is limited to the
  channels and departments its rules allow.
- Send the token as `Authorization: Bearer <access_token>`; refresh before expiry.
- **Least privilege:** grant only the rules an integration needs (e.g. `assets:read` on the
  Sports department, not global write).

```http
POST /api/v1/auth/token
Content-Type: application/json

{ "grant_type": "client_credentials",
  "client_id": "svc-epg-export",
  "client_secret": "••••" }
```
```json
{ "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900 }
```

## 3. REST conventions

- Base path: `/api/v1`. Versioned; breaking changes bump the major version.
- **JSON** by default; some feed endpoints negotiate **XML**.
- **Pagination:** cursor-based (`?cursor=…&limit=…`), `Link` headers for next/prev.
- **Filtering/search:** `GET /assets?query=…` (simple) and `POST /assets/search` (structured).
- **Idempotency:** send `Idempotency-Key` on writes; Atlas dedupes retries.
- **Rate limits:** per client; `429` with `Retry-After`. Limits are configurable per service
  account.
- **Errors:** RFC 7807 problem+json (`type`, `title`, `status`, `detail`, `correlationId`).
- **Correlation:** every response carries `X-Correlation-Id`; include it in support requests.

### Representative endpoints

| Method & path | Purpose |
|---------------|---------|
| `GET /api/v1/assets` | List/search assets (permission-filtered). |
| `GET /api/v1/assets/{id}` | Full metadata + rendition locations. |
| `POST /api/v1/assets` | Create an asset (e.g. register externally-hosted media). |
| `PATCH /api/v1/assets/{id}` | Update metadata (respecting mandatory-field rules). |
| `POST /api/v1/uploads` | Start a resumable upload session. |
| `GET /api/v1/schedules?channel=…` | Read a channel's program table. |
| `POST /api/v1/schedules/{id}/items` | Add/modify schedule items. |
| `GET /api/v1/feeds/in` / `POST …` | Manage inbound import feeds. |
| `GET /api/v1/feeds/out` / `POST …` | Manage outbound feeds/custom APIs. |

> Endpoints are illustrative; each service publishes an OpenAPI document as the normative
> contract. The gateway aggregates them at `/api/v1/openapi`.

## 4. Events & webhooks

Atlas publishes domain events (the [event catalog](../architecture/04-messaging-and-data.md#3-event-catalog-core)).
Third parties consume a permission-filtered subset via **webhooks** (Atlas POSTs to your
endpoint) or a **streaming subscription** (server-sent events / WebSocket bridge).

- **Subscribe:** register a webhook with the event types and a channel/department scope.
- **Envelope:** you receive the standard [message envelope](../architecture/04-messaging-and-data.md#13-message-envelope)
  (`type`, `channelId`, `occurredAt`, `correlationId`, `payload`).
- **Security:** each delivery is signed (HMAC over the body with your subscription secret);
  verify the `X-Atlas-Signature` header before trusting it.
- **Reliability:** at-least-once delivery with retries and backoff; make your handler
  idempotent on `messageId`. Failed deliveries go to a per-subscription DLQ you can replay.

Commonly subscribed events:

| Event | Typical consumer use |
|-------|----------------------|
| `asset.ready` | Trigger downstream publishing or QC. |
| `asset.approved` | Push to web/social/OTT. |
| `schedule.updated` / `schedule.sent-to-air` | EPG refresh, playout sync. |
| `transcode.completed` | Fetch a specific rendition. |
| `ai.enrichment.completed` | Sync generated subtitles/keywords. |

```http
POST https://partner.example.com/atlas-hook
X-Atlas-Signature: sha256=…
Content-Type: application/json

{ "type": "asset.approved", "channelId": "ch12",
  "occurredAt": "2026-07-21T10:15:00Z", "correlationId": "01J8Y…",
  "payload": { "assetId": "a_9f3…", "approver": "user-42" } }
```

## 5. Inbound feeds (importing into Atlas)

Author an **inbound feed** in the Integration service to map an external source into Atlas
assets/metadata ([FR-INT-1](../requirements/05-functional-requirements.md#integration)).

- **Formats:** JSON or XML.
- **Mapping:** declarative field mapping from source fields to Atlas core/extensible fields;
  transforms (date/format normalization, controlled-vocabulary lookups).
- **Triggers:** scheduled poll, pushed to an inbound endpoint, or file drop (folder watch).
- **Validation:** items pass the same acceptance rules as native ingest before becoming
  assets; failures are reported with reasons.

Example mapping (conceptual):
```yaml
feed: partner-catalog
format: json
match: "$.items[*]"
map:
  title: "$.name"
  description: "$.synopsis"
  durationSeconds: "$.runtime"
  custom.genre: "$.genre"          # extensible field
  custom.rightsWindow: "$.license" # extensible field
onAccept: attachToChannel: ch12
```

## 6. Outbound feeds & custom APIs (exposing Atlas)

Publish **custom output shapes** for third-party applications
([FR-INT-2](../requirements/05-functional-requirements.md#integration)) without giving raw API
access.

- Define the **selection** (which assets/schedules, filtered by channel/department/state)
  and the **shape** (JSON/XML template).
- Choose **delivery**: pull endpoint (partner fetches), push (Atlas POSTs on change), or
  scheduled export to a destination.
- Apply **auth** (service-account token or signed URL) and **rate limits** per consumer.

## 7. Prebuilt connectors

| Connector | Direction | Standard | Notes |
|-----------|-----------|----------|-------|
| **Playout / playlist export** | outbound | **Cinegy Air MCRList** ([spec](14-playout-mcrlist-format.md)) / pluggable | Send-to-air exports a standard playlist + hi-res files for third-party playout ([D1](../01-technical-brief.md#9-resolved-decisions), [FR-SCH-5](../requirements/05-functional-requirements.md#scheduling)). Works on the local LAN — air-gapped-safe. |
| **EPG publish** | outbound | XMLTV / TV-Anytime (configurable) | Derived from Scheduling ([FR-INT-3](../requirements/05-functional-requirements.md#integration)). |
| **HbbTV launcher** | outbound | HbbTV | Create/update launchers ([FR-INT-4](../requirements/05-functional-requirements.md#integration)). |
| **Social / website** | outbound | platform APIs | Publish approved assets/content ([FR-INT-5](../requirements/05-functional-requirements.md#integration)). |
| **Newsroom / playout** | both | MOS | Newsroom device integration ([FR-NRC-3](../requirements/05-functional-requirements.md#newsroom), Post-v1.0). |
| **Wire/agency feeds** | inbound | NewsML / custom | Into Newsroom via inbound feeds. |

## 8. Media access

- Third parties never receive storage credentials. To fetch a rendition, request a
  **time-limited signed URL** from the API; [HSM](../architecture/03-service-catalog.md#hsm--hierarchical-storage-manager)
  brokers the actual file access.
- Renditions available: proxy, broadcast, thumbnail, VTT filmstrip, hover preview
  ([Media profiles](../01-technical-brief.md#7-media-profiles-default-set)). Request the one
  matching your bandwidth/use.
- Offline/near-line assets may need a **restore** first (`POST /assets/{id}/restore`); poll
  or subscribe to `restore.completed`.

## 9. Versioning, deprecation & support

- **API version** in the path (`/api/v1`); **event schemas** carry `schemaVersion`.
- **Additive changes** don't bump the major version; be a **tolerant reader** (ignore unknown
  fields).
- **Deprecations** are announced with a sunset window and `Deprecation`/`Sunset` headers.
- Every request/event carries a **correlation id** — include it when contacting support.

## 10. Quick-start checklist

1. Get a **service account** and permission rules from an Atlas admin (least privilege).
2. Obtain a token via **client-credentials**.
3. Call `GET /api/v1/openapi` to discover the current contract.
4. For push scenarios, register a **webhook** and verify the HMAC signature.
5. For bulk import/export, define an **inbound/outbound feed** instead of hand-rolling calls.
6. Make all handlers **idempotent**; honor **rate limits** and **retry-after**.

---
_Next: [White Paper](../marketing/11-white-paper.md)._
