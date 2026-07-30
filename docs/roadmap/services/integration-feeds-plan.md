# Integration / Feeds — Implementation Plan

> Build plan for all third-party **inbound** and **outbound** data — the feed/API creator and
> prebuilt connectors (EPG, HbbTV, social/web). Spec:
> [integration-feeds](../../architecture/services/integration-feeds.md) · Stack: **Node + NestJS
> (worker-per-feed)** · Ships: **Phase 2 (inbound)** → **Phase 3 (outbound + connectors)**.
> Feature-critical; not on the core media path.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 (in) | 2 | Author **inbound feeds** (JSON/XML) mapping external data → Atlas assets/metadata; scheduling, retries, transform mapping. |
| v2 (out) | 3 | Author **outbound APIs/feeds** (custom shapes, auth); prebuilt connectors: **EPG publish**, **HbbTV** launcher create/update, **social/web** publishing; delivery receipts. |

**Non-goals.** Not the public gateway ([API Gateway](api-gateway-plan.md) fronts Atlas's own API); this
service builds **customer-defined** feeds/connectors and transforms.

## 2. Build sequence

1. **Feed/connector model (v1)** — definitions for inbound feeds, mapping templates, schedules; worker-
   per-feed execution with retries + delivery logs.
2. **Inbound feeds (v1)** — fetch/receive JSON/XML; **transform mapping** to Atlas assets/metadata;
   emit `feed.item.received`; dedupe + validation; `POST /feeds/{id}/run` for manual runs.
3. **Outbound feeds/APIs (v2)** — author custom output shapes with auth; publish on triggers
   (`schedule.updated` → EPG; `asset.approved` → web/social); `publish.completed`/`publish.failed`.
4. **Connectors (v2)** — **EPG** publish, **HbbTV** launcher create/update, **social** publishing,
   **website** content; each a pluggable connector behind a common interface.
5. **Delivery receipts + retries** — track delivery state; backoff; DLQ for poison items.

## 3. Components / modules

- `feeds-in` (fetch/receive + map), `feeds-out` (compose + publish), `connectors` (EPG/HbbTV/social/web),
  `mapping` (transform templates), `scheduler` (feed runs), `delivery-log/receipts`.

## 4. Data plane & migrations

- **Relational:** feed/connector definitions, mapping templates, delivery logs. Additive migrations;
  definitions are versioned + config-editable.

## 5. APIs & events

- REST: [`integration-feeds.yaml`](../../architecture/openapi/integration-feeds.yaml) — `/feeds/in`,
  `/feeds/out`, `/connectors`, `/feeds/{id}/run`.
- **Emits:** `feed.item.received`, `publish.completed`, `publish.failed`. **Consumes:**
  `schedule.updated` (EPG), `asset.approved` (web/social).

## 6. Dependencies & integration points

- **Requires first:** [MAM](mam-plan.md), [Scheduling](scheduling-plan.md), broker; external systems.
  **Consumed by:** [Newsroom](newsroom-plan.md) (wire intake), external partners.

## 7. Testing focus

- Transform-mapping correctness (external shape ↔ Atlas metadata) + validation of malformed inbound data.
- Idempotent inbound (same wire item once); reliable outbound with retries + receipts.
- Connector conformance (EPG/HbbTV/social API contracts); auth per connector.

## 8. Scaling & deployment

- **Worker-per-feed; scale with feed volume.** Config: feed/connector definitions, mapping templates,
  schedules, external endpoints/credentials, retry/backoff policy.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Malformed external data breaks ingest | Strict validation + quarantine + per-feed isolation. |
| Outbound partner API changes | Connectors behind a versioned adapter interface; contract tests. |
| Duplicate publishes | Idempotency keys + delivery receipts. |
| Feed floods | Per-feed rate limits + backpressure + DLQ. |
