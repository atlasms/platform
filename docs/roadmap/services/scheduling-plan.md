# Scheduling — Implementation Plan

> Build plan for broadcast/stream **program tables** and the **send-to-air** hand-off to external
> playout. Spec: [scheduling](../../architecture/services/scheduling.md) · Stack: **Node + NestJS**
> with a **pluggable playlist serializer** · Ships: **Phase 1 (v0 CRUD)** → **Phase 2 (validation +
> send-to-air)**. Critical path for playout.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v0 | 1 | Program-table **CRUD** per channel. |
| v1 | 2 | **Validation** (gaps/overlaps, rendition availability, rights); **approved-only** guard; **send-to-air** export (MCRList) with control-room path rewrite. |
| v1.5 | 3 | Channel **time zones**/local calendars; EPG feed handoff; expiry-aware re-checks. |

**Non-goals.** Not the playout engine (external — [D1](../../01-technical-brief.md#9-resolved-decisions));
Atlas exports a standard playlist + hi-res files. Byte copy is [HSM](hsm-plan.md)'s job.

> **Reference slice:** [`reference/scheduling-service/`](../../../reference/scheduling-service/README.md)
> is a tested Scheduling slice — the schedulable-registry projection from MAM's lifecycle and the
> **approved-and-not-expired guard at serialization** (steps 4 & 6 below) — plus a two-service
> integration test proving the review lifecycle gates air across MAM → Scheduling.

## 2. Build sequence

1. **Schedule model + CRUD (v0)** — schedules and items per channel; `GET/POST/PATCH /schedules`,
   `/schedules/{id}/items`; channel-partitioned.
2. **Schedulability intake** — consume `asset.approved` (schedulable), `asset.expired`/`asset.deleted`
   (drop/flag), `asset.replaced` (swap references), `restore.completed` (rendition back online).
3. **Validation (v1)** — gap/overlap detection, rendition-availability check via HSM, rights windows;
   `schedule.validated`.
4. **Approved-only guard** — enforced **at serialization**: an unapproved, **expired**, or rejected
   asset can never appear in an exported playlist
   ([FR-SCH-3/5a](../../requirements/05-functional-requirements.md#scheduling)).
5. **Pluggable serializer (v1)** — format interface; first target **Cinegy Air MCRList**
   ([spec](../../integrations/14-playout-mcrlist-format.md)); XML via `xmlbuilder2`/`fast-xml-parser`;
   **control-room path rewrite** so `src_path` resolves on the playout host.
6. **Send-to-air (v1)** — `POST /schedules/{id}/send-to-air` (privileged, audited) → emit
   `schedule.sent-to-air` → HSM copies hi-res + playlist to the control-room destination.
7. **Time zones + EPG (v1.5)** — channel-local calendars; feed EPG export via
   [Integration](integration-feeds-plan.md).

## 3. Components / modules

- `schedules` (CRUD), `items`, `validation` (gaps/overlaps/availability/rights),
  `serializers` (pluggable; MCRList first), `send-to-air` (privileged action + export trigger),
  `schedulability` (event intake + guards).

## 4. Data plane & migrations

- **Relational:** schedules, items, rights windows; channel-partitioned. Additive migrations.

## 5. APIs & events

- REST: [`scheduling.yaml`](../../architecture/openapi/scheduling.yaml) — `/schedules`,
  `/schedules/{id}/items`, `/schedules/{id}/send-to-air`.
- **Emits:** `schedule.updated`, `schedule.validated`, `schedule.sent-to-air`. **Consumes:**
  `asset.approved`, `asset.expired`, `asset.deleted`, `asset.replaced`, `restore.completed`,
  `playout.export.completed`.

## 6. Dependencies & integration points

- **Requires first:** [MAM](mam-plan.md) (approved assets + rendition refs), [HSM](hsm-plan.md)
  (availability + export). **Consumed by:** [Integration](integration-feeds-plan.md) (EPG),
  [Newsroom](newsroom-plan.md) (bulletins), playout (via exported playlist).

## 7. Testing focus

- Gap/overlap validation correctness across edits.
- **Approved-and-not-expired guard at export** — including approval lapsing between scheduling and
  send-to-air (the export-time re-check).
- MCRList serialization conformance to the [format spec](../../integrations/14-playout-mcrlist-format.md);
  path-rewrite resolves on the playout host.
- Reference swap on `asset.replaced`; flag-not-drop on `asset.expired`.

## 8. Scaling & deployment

- **Moderate; channel-partitioned.** Config: per-channel calendars/time zones, validation rules,
  serializer selection + control-room destinations + path-rewrite rules, send-to-air permissions.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Unapproved/expired media reaches air | Approved-only guard enforced **at serialization**, not just on add. |
| Playout can't resolve `src_path` | Path-rewrite rules per channel; export audited + verified. |
| Format lock-in to MCRList | Serializer is pluggable behind a format interface. |
| Expiry between schedule and air | Export-time re-check blocks the affected item ([FR-SCH-3](../../requirements/05-functional-requirements.md#scheduling)). |
