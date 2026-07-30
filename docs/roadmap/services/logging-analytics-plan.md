# Logging & Analytics — Implementation Plan

> Build plan for the central **audit log**, operational metrics, and analytics/statistics.
> Spec: [logging-analytics](../../architecture/services/logging-analytics.md) · Stack: **Node +
> NestJS/Fastify ingest** into OpenSearch + cold storage · Ships: **Phase 1 (audit)** → **Phase 3
> (analytics)**. Non-critical to the media path; **critical for compliance/ops**.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 1 | **Append-only audit** of all actions from every service; permission-filtered log queries. |
| v2 | 3 | Metrics store + **dashboards**; **reports** (ingest volumes, transcode throughput, restore times, user activity); Studio Logs/Analytics/Statistics pages; `alert.raised` on thresholds. |

**Non-goals.** Not a decision-maker; a sink + query surface. Not the live-push transport
([WebSocket](websocket-plan.md)) — though alerts may fan out through it.

## 2. Build sequence

1. **Audit ingest (v1)** — a write-heavy pipeline consuming audit/log events from **all** services
   (append-only); normalize to a common schema; index in OpenSearch + write-through to cold storage.
2. **Query surface (v1)** — `GET /logs`, `POST /logs/query` with **permission-filtered visibility**
   (some logs visible to certain users; **all retained**).
3. **Retention & tiering** — hot index window + cold archive; retention policy per log class
   (compliance-driven).
4. **Metrics store (v2)** — operational metrics ingestion; time-series aggregation.
5. **Reports & dashboards (v2)** — `GET /metrics`, `GET /reports/{name}`; the Studio Logs/Analytics/
   Statistics pages; scheduled report generation.
6. **Alerting (v2)** — threshold rules → emit `alert.raised` (→ Notifications/WebSocket).

## 3. Components / modules

- `ingest` (event → normalized audit), `store` (OpenSearch + cold), `query` (permission-filtered),
  `retention`, `metrics`, `reports`, `alerts`.

## 4. Data plane & migrations

- **Search index** (hot logs/metrics) + **cold storage** (archive). Schema-on-write for audit records;
  index lifecycle management for retention. Rebuild/replay not required (it's the sink), but ingest must
  be **idempotent** (dedupe on `messageId`).

## 5. APIs & events

- REST: [`logging-analytics.yaml`](../../architecture/openapi/logging-analytics.yaml) — `/logs`,
  `/logs/query`, `/metrics`, `/reports/{name}`.
- **Consumes:** essentially **all** events (audit sink). **Emits:** `alert.raised` on thresholds.

## 6. Dependencies & integration points

- **Requires first:** data plane (OpenSearch + cold), broker. **Consumed by:** Studio (log/analytics
  pages), ops/compliance; alerts → [Notifications](notifications-plan.md).

## 7. Testing focus

- **Append-only** integrity + idempotent ingest (no double-count on redelivery).
- **Permission-filtered** query correctness (a user sees only permitted logs; everything still retained).
- Retention/tiering transitions; report accuracy vs source events.
- Ingest throughput under load (write-heavy).

## 8. Scaling & deployment

- **Scale the pipeline + index** for write-heavy ingest; cold storage for retention. Config: log classes
  + retention, index lifecycle, report definitions, alert thresholds, visibility rules.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Audit gaps undermine compliance | Guaranteed delivery (durable subjects + DLQ); idempotent, append-only ingest. |
| Log volume overwhelms the index | Tiering (hot/cold) + ILM + sampling for non-audit telemetry (never audit). |
| Over-broad log visibility | Permission-filtered queries; visibility rules tested. |
