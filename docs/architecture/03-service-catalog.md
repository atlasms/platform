# Service Catalog

> One specification card per service: responsibility, interfaces (API + events),
> owned data, scaling, and dependencies. Parent:
> [System Architecture](02-system-architecture.md). Message contracts:
> [Messaging & Data](04-messaging-and-data.md).

Each card follows the same template so services can be compared and estimated. "Emits" and
"Consumes" name broker events (full catalog in [Messaging & Data §Event catalog](04-messaging-and-data.md#3-event-catalog-core)).
API paths are illustrative and versioned under `/api/v1`.

> **These are summary cards.** Each service has a full, detailed specification in
> [`architecture/services/`](services/) — domain model, complete API + event contracts, key
> flows, failure modes, scaling, security, configuration, observability, and implementation
> notes. Start here to compare services; open the matching spec to build one.

---

## HSM — Hierarchical Storage Manager

**Responsibility.** Authority over where asset bytes physically live and the file
operations on them across **online / near-line / offline** tiers.

**Key capabilities.**
- Place, copy, move, delete files; track each rendition's tier and online/offline status.
- Restore near-line/offline assets on demand; report restore ETAs.
- Compute and verify **checksums**; run periodic integrity sweeps.
- On send-to-air, copy high-res renditions + playlist to the control-room destination.
- Enforce storage least-privilege — other services request file ops via HSM, never touch
  storage credentials.

**API (sync).**
- `POST /assets/{id}/restore` — request restore to online.
- `GET /assets/{id}/location` — current tier/status of each rendition.
- `POST /files/operations` — copy/move/delete (internal, permissioned).
- `POST /playout/exports` — copy schedule outputs to a network destination.

**Events.** Emits `file.placed`, `file.moved`, `restore.completed`, `checksum.verified`,
`checksum.mismatch`, `playout.export.completed`. Consumes `transcode.completed`,
`schedule.sent-to-air`, `asset.deleted`.

**Owned data.** File location ledger (relational), tier policy config, checksum records.
**Scaling.** Horizontally scalable workers for file ops; throughput-bound. **Deps.** Object
storage, tape/archive gateway, control-room network. **Criticality.** Critical path.

---

## IAM — Identity and Access Management

**Responsibility.** Users, groups, roles, permission rules, and authentication.

**Key capabilities.**
- CRUD for users, groups, roles, and permission rules.
- Group membership (a user in ≥1 group); **effective permissions = union of user rules and
  all group rules** (see [FR-IAM](../requirements/05-functional-requirements.md#iam)).
- Issue **JWT access + refresh tokens**; rotate/revoke refresh tokens; permission-version
  claim for fast revocation.
- SSO federation (OIDC/SAML) and optional MFA (v1.0).

**API (sync).**
- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`.
- `GET/POST/PATCH/DELETE /users`, `/groups`, `/roles`, `/rules`.
- `GET /users/{id}/effective-permissions`.

**Events.** Emits `user.created`, `user.updated`, `permissions.changed`,
`group.membership.changed`. Consumes none (source of truth for identity).

**Owned data.** Users, groups, roles, rules, membership, refresh-token store (relational +
cache). **Scaling.** Stateless API replicas; token validation is local to each service via
shared public keys (JWKS). **Deps.** Optional external IdP. **Criticality.** Critical path.

---

## MTS — Media Transcoding System

**Responsibility.** Transcode accepted media to configured **profiles** with FFmpeg.

**Key capabilities.**
- Consume transcode commands (preset + input/output paths) from the queue.
- Produce the default rendition set (proxy, broadcast, thumbnail, VTT filmstrip, hover
  preview) and any channel/type-specific profiles.
- Report **progress** and completion; write checksums for each output.
- **Elastic**: instances scale up with queue depth and are removed when it drains.

**API (sync).** Thin — mostly queue-driven. `GET /jobs/{id}` for status; `POST /jobs` to
enqueue (normally issued by BMS/RIM, not users).

**Events.** Emits `transcode.started`, `transcode.progress`, `transcode.completed`,
`transcode.failed`. Consumes `ingest.accepted`, `transcode.job.create` (cmd, from BMS/RIM),
`editor.render.requested` (cmd, from the [media editor](services/media-editor.md)).

**Owned data.** Job queue + job records (persisted for retry/audit); profile presets
(config). **Scaling.** The canonical **scale-to-many** service; GPU-optional workers driven
by queue depth (KEDA). **Deps.** HSM for I/O paths, FFmpeg, optional GPU. **Criticality.**
Critical path.

---

## MAM — Media/Metadata & Asset Management

**Responsibility.** System of record for media **metadata** and the searchable catalog.

**Key capabilities.**
- Core fields for every asset (title, duration, description, file type, resolution, aspect
  ratio, audio channels) in the **relational** store.
- Type/category-specific extensible fields in the **document** store.
- **Cache** for hot reads; **search index** for simple + advanced search.
- Versioning and metadata **cloning on replacement** (new asset ID inherits prior metadata).
- Tags, description, shot-list, and customizable fields per media type/category.
- **Classification & discovery:** free-form tags, hierarchical **categories**,
  **subjects/topics** from controlled vocabularies, and a **people/cast register** (name,
  role-in-media, optional image — [FR-PPL](../requirements/05-functional-requirements.md#people)).
  Powers **faceted search** across category + subject + tag + person.

**API (sync).**
- `GET/POST/PATCH /assets`, `GET /assets/{id}`, `POST /assets/{id}/versions`.
- `GET /search?q=…` (simple) and `POST /search` (advanced, faceted: category/subject/tag/person).
- `GET/POST /field-schemas` (define type/category custom fields).
- `GET/POST /tags`, `/categories`, `/subjects` (controlled vocabularies).
- `GET/POST/PATCH /people`, `POST /assets/{id}/people` (associate a person + role).

**Events.** Emits `asset.created`, `asset.updated`, `asset.ready`, `asset.approved`,
`asset.rejected`, `asset.replaced`, `person.created`, `person.linked`, `taxonomy.updated`.
Consumes `ingest.accepted`, `transcode.completed`, `ai.enrichment.completed`,
`ai.suggestion.raised` (people/tag suggestions), `file.moved`.

**Owned data.** Relational core metadata, document extensible metadata, **tags / categories /
subjects / people register**, search index, cache. **Scaling.** Read-heavy; scale read
replicas + cache; index asynchronously. **Deps.** Data plane. **Criticality.** Critical path.

---

## Recording & Ingest Management (RIM)

**Responsibility.** Bring media into the system from files, folder watchers, FTP/upload,
and stream/broadcast recording.

**Key capabilities.**
- **Folder watchers** and inbound endpoints (upload/FTP) that detect new content.
- **Recording**: capture streams/broadcasts and segment into files (e.g. 24h → 1h files).
- **Acceptance rules** (customizable per channel/type): container/format, minimum size,
  matching aspect ratio, etc. Reject or quarantine non-conforming files.
- Extract technical metadata and hand off to MAM; request initial proxy+thumbnail.

**API (sync).**
- `POST /uploads` (chunked/resumable), `GET /ingest/queue`, `POST /ingest/{id}/accept`.
- `GET/POST /watchers`, `GET/POST /recorders`, `GET/POST /acceptance-rules`.

**Events.** Emits `ingest.detected`, `ingest.accepted`, `ingest.rejected`,
`recording.segment.completed`. Consumes `acceptance-rules.updated`.

**Owned data.** Ingest queue, watcher/recorder config, acceptance rules. **Scaling.**
Watchers are singletons per source; recorders scale per capture channel; upload endpoints
scale statelessly. **Deps.** HSM (place bytes), MTS (proxy), MAM (create asset).
**Criticality.** Critical path (entry point).

---

## BMS — Business Process Management System

**Responsibility.** Author and execute configurable **workflows** that orchestrate the
other services and human steps.

**Key capabilities.**
- Ship preset flows (e.g. the [canonical flow](../01-technical-brief.md#5-canonical-end-to-end-flow));
  let operators duplicate, modify, or author new flows per category/type/usage.
- Execute flows: issue commands, await events, handle timeouts/retries, and pause for
  human approval/tasks.
- Visibility: show where each asset is in its flow; SLA timers.

**API (sync).**
- `GET/POST/PATCH /workflows` (definitions), `POST /workflows/{id}/publish`.
- `GET /instances`, `GET /instances/{id}` (running flow state).

**Events.** Emits `workflow.step.requested` (a command step is carried out by issuing the
target service's own command, e.g. `transcode.job.create`), `workflow.completed`,
`workflow.task.created`. Consumes the completion events of every service it orchestrates.

**Owned data.** Workflow definitions, running instance state (relational + durable
timers). **Scaling.** Stateful engine; scale by partitioning instances; use a durable
workflow runtime (e.g. Temporal-style or a broker-backed saga). **Deps.** All orchestrated
services. **Criticality.** Critical path for automated flows (manual path can bypass).

---

## Scheduling

**Responsibility.** Build and edit broadcast/stream **program tables** and drive
send-to-air hand-off.

**Key capabilities.**
- Program-table CRUD per channel with time zones and channel-local calendars.
- Validate playlists (gaps/overlaps, rights windows, rendition availability via HSM).
- **Send-to-air**: trigger HSM to copy hi-res + playlist to the control room, exporting the
  playlist via a **pluggable format serializer** — first target **Cinegy Air MCRList**
  ([format spec](../integrations/14-playout-mcrlist-format.md)) — with control-room path
  rewrite so `src_path` resolves on the playout host
  ([D1](../01-technical-brief.md#9-resolved-decisions),
  [FR-SCH-5](../requirements/05-functional-requirements.md#scheduling)).
- Feed EPG export (via Integration/Feeds).

**API (sync).**
- `GET/POST/PATCH /schedules`, `/schedules/{id}/items`.
- `POST /schedules/{id}/send-to-air` (permissioned).

**Events.** Emits `schedule.updated`, `schedule.validated`, `schedule.sent-to-air`.
Consumes `asset.approved`, `asset.replaced`, `restore.completed`.

**Owned data.** Schedules, items, rights windows (relational). **Scaling.** Moderate;
channel-partitioned. **Deps.** MAM (assets), HSM (export), Integration (EPG).
**Criticality.** Critical path for playout.

---

## Newsroom

**Responsibility.** Full multimedia **newsroom** workflow — rundowns, stories, scripts, and
media association.

**Key capabilities.**
- Rundowns and stories; scripts with media/asset references; assignment and status.
- Wire/feed ingestion (via Integration), collaborative editing, and handoff to Scheduling
  for bulletins.
- MOS-style integration surface for newsroom/playout devices (v1.0 target).

**API (sync).** `GET/POST/PATCH /rundowns`, `/stories`, `/scripts`.

**Events.** Emits `story.updated`, `rundown.updated`, `rundown.ready`. Consumes
`asset.ready`, `feed.item.received`.

**Owned data.** Rundowns, stories, scripts (relational + document for rich content).
**Scaling.** Collaboration-heavy; real-time editing via the WebSocket service. **Deps.**
MAM, Integration, Scheduling. **Criticality.** Feature-critical for news customers;
optional for others.

---

## Notifications & Messaging

**Responsibility.** System notifications **and** user↔user/group messaging (chat), unified
because both are permission-aware delivery.

**Key capabilities.**
- Tasks (assign/forward), inbox, direct and group messages.
- System notifications (job done, approval needed, mention) with per-user preferences.
- Delivery through the WebSocket service (live) and optionally email/push (digest).

**API (sync).** `GET/POST /messages`, `/tasks`, `GET /inbox`, `PATCH /tasks/{id}`.

**Events.** Emits `message.sent`, `task.created`, `task.updated`, `notification.raised`.
Consumes many (`asset.approved`, `workflow.task.created`, `transcode.failed`, …) to raise
notifications.

**Owned data.** Messages, tasks, inbox state, preferences (relational). **Scaling.**
Stateless API + broker-backed delivery. **Deps.** WebSocket service. **Criticality.**
Non-critical to media path; important to UX.

---

## Integration / Feeds

**Responsibility.** All third-party **inbound** and **outbound** data — the "API/feed
creator" and 3rd-party connectors (EPG, HbbTV launchers, social/web).

**Key capabilities.**
- Author **inbound feeds** (JSON/XML) that map external data to Atlas assets/metadata.
- Author **outbound APIs/feeds** for third-party applications (custom shapes, auth).
- Prebuilt connectors: EPG publish, HbbTV launcher create/update, social publishing,
  website content.
- Scheduling, retries, transform mapping, and delivery receipts.

**API (sync).** `GET/POST /feeds/in`, `/feeds/out`, `/connectors`, `POST /feeds/{id}/run`.

**Events.** Emits `feed.item.received`, `publish.completed`, `publish.failed`. Consumes
`schedule.updated` (EPG), `asset.approved` (web/social).

**Owned data.** Feed/connector definitions, mapping templates, delivery logs. **Scaling.**
Worker-per-feed; scale with feed volume. **Deps.** External systems, MAM, Scheduling.
**Criticality.** Feature-critical; not on the core media path.

---

## AI Enrichment

**Responsibility.** Augment assets with AI-derived metadata and suggestions — **off the
critical path**.

**Key capabilities.**
- Face-**matching against the [people register](#mam--mediametadata--asset-management)** (name/role/
  image only), object/logo detection, shot detection, scene classification.
- Speech-to-text/subtitles, language ID, keyword and summary generation.
- Metadata **suggestions** surfaced to users for confirmation (human-in-the-loop); never
  auto-writes mandatory metadata or auto-creates people.
- **Provider-abstraction, online-first** ([D4](../01-technical-brief.md#9-resolved-decisions)):
  the **online tier** uses cloud/vendor providers (primary, full accuracy); the optional
  **offline tier** runs a small local model for **suggestions/simple tasks only** in
  air-gapped sites. The platform runs fine with AI **disabled**.

**API (sync).** `POST /enrich` (normally event-triggered), `GET /jobs/{id}`.

**Events.** Emits `ai.enrichment.completed`, `ai.suggestion.raised`, `ai.enrichment.failed`.
Consumes `asset.created`, `transcode.completed`.

**Owned data.** Enrichment job records, provider/config registry, optional small local model
store. **Scaling.** Online tier calls out to cloud providers (no local GPU); optional offline
tier runs small models on modest local hardware; queue-driven, fully async. **Deps.** MAM
(attach results/people), cloud AI provider (online) or small local model (offline).
**Criticality.** Non-critical — never blocks ingest/approval; may be disabled entirely.

---

## Logging & Analytics

**Responsibility.** Central **audit log**, operational metrics, and analytics/statistics.

**Key capabilities.**
- Ingest structured logs and audit events from every service (append-only).
- Metrics store + dashboards; the Studio Logs/Analytics/Statistics pages.
- Permission-filtered log visibility ("some logs visible to certain users, all retained").
- Reports: ingest volumes, transcode throughput, restore times, user activity.

**API (sync).** `GET /logs`, `POST /logs/query`, `GET /metrics`, `GET /reports/{name}`.

**Events.** Consumes essentially all events (audit sink). Emits `alert.raised` on
thresholds.

**Owned data.** Log/audit store (search index + cold storage), metrics store. **Scaling.**
Write-heavy ingest; scale the pipeline and index. **Deps.** Data plane. **Criticality.**
Non-critical to the media path; critical for compliance/ops.

---

## Planning & Resource Scheduling *(v2.0)*

**Responsibility.** Pre-production: projects, planning items, assignments, and the booking of
people, facilities, and equipment. **Not** the broadcast program table — that is
[Scheduling](#scheduling); see the
[naming warning](../strategy/19-production-lifecycle-scope.md#21-two-different-things-called-scheduling).

**Key capabilities.** Projects and planning items; assignments with briefs; a resource registry;
**conflict-free bookings** with holds and availability; call sheets; script breakdown into
requirements; shot lists; estimated-vs-actual cost tracking; promote-a-plan-to-a-schedule-slot.

**API.** `/projects`, `/planning-items`, `/assignments`, `/resources`, `/bookings`,
`/resources/availability`, `/shot-lists`. **Events.** Emits `booking.confirmed`,
`assignment.created`, `planning.promoted-to-schedule`; consumes `asset.ready`, `schedule.updated`.

**Owned data.** Projects, planning items, assignments, resources, bookings, breakdowns, shot
lists (relational + document). **Scaling.** Low volume; DB-enforced interval exclusion.
**Criticality.** Not on the media critical path. **Full spec:** [planning.md](services/planning.md).

---

## Editorial — Web Editor & Projects *(v2.0)*

**Responsibility.** Persistent editing **projects**, the browser timeline editor, and
**interchange** with desktop NLEs. Upgrades the v1.0 basic-NLE from one-shot operations to a
reopenable project.

**Key capabilities.** Save/reopen projects; **OTIO-compatible** timeline model; frame-accurate
browser playback over scrub-optimised proxies; server-side render via [MTS](#mts--media-transcoding-system);
versioning + locking; frame-accurate review notes; **export/import OTIO, AAF, FCPXML, EDL** with
a **fidelity report**. Native project files (`.prproj`, `.aep`) are proprietary and out of scope.

**API.** `/projects`, `/projects/{id}/timeline`, `/lock`, `/render`, `/export`, `/import`,
`/notes`. **Events.** Emits `edit.project.saved`, `edit.render.requested`,
`edit.interchange.completed`; consumes `transcode.completed`, `asset.replaced`.

**Owned data.** Edit projects, timelines, versions, render jobs, review notes (relational +
document). **Scaling.** Light service; the cost is MTS render + proxy design.
**Criticality.** Not on the media critical path. **Full spec:** [editorial.md](services/editorial.md).

---

## Service summary matrix

| Service | Scales to N | On critical path | Primary datastore | MVP? |
|---------|:-----------:|:----------------:|-------------------|:----:|
| API Gateway | ✅ | ✅ | — | ✅ |
| WebSocket | ✅ | UX | — | ✅ |
| IAM | ✅ | ✅ | Relational + cache | ✅ |
| RIM | partial | ✅ | Relational | ✅ |
| HSM | ✅ | ✅ | Relational + object | ✅ |
| MTS | ✅✅ | ✅ | Queue + object | ✅ |
| MAM | ✅ (reads) | ✅ | Relational + document + search + cache | ✅ |
| Scheduling | partial | ✅ | Relational | ✅ (basic) |
| BMS | partial | ✅ (auto) | Relational + timers | Beta |
| Notifications & Messaging | ✅ | UX | Relational | Beta |
| Newsroom | ✅ | news-only | Relational + document | Beta/v1.0 |
| Integration / Feeds | ✅ | no | Relational | Beta (in) / v1.0 (out) |
| AI Enrichment | ✅✅ | no | Queue | v1.0 |
| Logging & Analytics | ✅ | compliance | Search + cold | ✅ (audit) / v1.0 (analytics) |
| Planning & Resource Scheduling | partial | no | Relational + document | **v2.0** (news subset v1.0) |
| Editorial (web editor & projects) | ✅ | no | Relational + document | **v2.0** |

---

## Recommended implementation stack {#recommended-implementation-stack}

Atlas's backend is almost entirely **IO-bound orchestration** — moving bytes, calling
databases and the broker, supervising FFmpeg, fanning out events — which is exactly where
Node's event loop is strongest. So the recommendation is a **single primary stack: Node.js
(LTS) + TypeScript**, chosen deliberately (not just to match the team's fluency):

- **One language end to end.** The message envelope, event contracts, DTOs, and API client
  types live in shared TypeScript packages consumed by every service *and* the Angular
  Studio. For a Core team of ~5–6 ([A7](../README.md#assumptions-register)) that shared
  surface removes a whole class of drift and duplicated modelling.
- **Framework split.** **NestJS** for structured domain/control-plane services (modules, DI,
  testability, first-class validation and OpenAPI); **Fastify** for the thin, high-throughput
  edges (gateway/BFF, WebSocket) — and NestJS can run on the Fastify adapter, so it's one
  ecosystem, not two.
- **Monorepo** (Nx or Turborepo) with a per-service deployable and shared libraries; strict
  TypeScript; the data-plane clients are all first-class in Node (`pg`/Prisma, the Mongo
  driver, `ioredis`, the OpenSearch and NATS JS clients).
- **Where Node is *not* the right tool, isolate it — don't switch the service's language.**
  Two specific cases below (CPU-bound file hashing/movement; ML inference) get a native
  worker or a sidecar process that the Node service calls. That's the
  [escape-hatch policy](02-system-architecture.md#9-technology-recommendations-non-binding),
  applied narrowly and only when profiling justifies it.

| Service | Recommended runtime / framework | Why this fits (and any escape hatch) |
|---------|--------------------------------|--------------------------------------|
| **API Gateway / BFF** | Node + **Fastify** | Thin, high-throughput routing + request aggregation — a classic Node IO-bound strength; Fastify keeps per-request overhead low. |
| **WebSocket service** | Node (**Fastify + ws**, or `uWebSockets.js`) | The event loop holds tens of thousands of concurrent connections cheaply — one of Node's best fits. Escape hatch: `uWebSockets.js` native binding for extreme fan-out. |
| **IAM** | Node + **NestJS** | Structured CRUD + auth; `jose` for JWT/JWKS, Passport for OIDC/SAML. Nothing here is CPU-bound. |
| **MAM** | Node + **NestJS** | Heaviest domain service, but the work is orchestrating Postgres + Mongo + OpenSearch + Redis; TS types model the extensible metadata schema well. Scale read replicas. |
| **RIM** | Node + **NestJS** (worker processes) | Uploads, folder watchers, acceptance rules — IO-bound. Stream recording/segmentation shells out to **FFmpeg**/capture, so the runtime is incidental there. |
| **HSM** | Node + **NestJS** API; **worker-threads** for hashing/copy | ⚠️ The one genuinely CPU/IO-heavy service. Node streams + worker-threads handle most of it; **escape hatch: a native addon (Rust via napi-rs) or a small Go/Rust file-mover** *if* profiling shows Node can't saturate the storage/hash path. |
| **MTS** | Node + NestJS **orchestrator** over **FFmpeg** subprocesses | The heavy lifting is FFmpeg + GPU (NVENC/QSV), a separate process — so language barely matters. Node's `child_process` + progress parsing is a clean fit; scale the workers, not the runtime. |
| **Scheduling** | Node + **NestJS** | Program-table CRUD, validation, and the **pluggable MCRList serializer** (XML via `xmlbuilder2`/`fast-xml-parser`) — TS makes the [format contract](../integrations/14-playout-mcrlist-format.md) explicit. |
| **BMS** | Node + NestJS + **Temporal (TypeScript SDK)** | Durable orchestration with retries/timers/human steps stays **in-language** via Temporal's TS SDK; alternative is a broker-backed saga in Node. |
| **Newsroom** | Node + **NestJS** | Collaborative editing via the WebSocket service; MOS integration is protocol glue — all comfortably Node. |
| **Notifications & Messaging** | Node + NestJS/**Fastify** | Broker-backed, permission-aware fan-out + delivery — squarely Node's wheelhouse. |
| **Integration / Feeds** | Node + **NestJS** (worker-per-feed) | JSON/XML transforms, connectors, retries, scheduling; the JS ecosystem is rich in parsers and HTTP clients. |
| **AI Enrichment** | Node + NestJS **orchestrator**; **sidecar** for offline inference | Online tier calls cloud/vendor SDKs (IO-bound → Node). The optional offline tier runs a **Python/ONNX Runtime model server** as a sidecar the Node service calls over local HTTP/gRPC — ML inference is not Node's job ([D4](../01-technical-brief.md#9-resolved-decisions)). |
| **Logging & Analytics** | Node + NestJS/**Fastify** ingest | Write-heavy ingest into OpenSearch; Node streams handle the pipeline, heavy aggregation lives in the search engine. |
| **Service Registry / Discovery** | — (Kubernetes / broker) | Provided by the orchestrator + broker, not a bespoke service ([Architecture §3.3](02-system-architecture.md#33-service-registry--discovery)). |

**Runtime note.** Recommend **Node.js LTS** for enterprise/broadcast stability, native-addon
support, and library maturity; Bun/Deno are promising but not worth the ecosystem risk for a
first release. Nothing in the architecture is coupled to Node — a service can be reimplemented
in Go/.NET behind the same message and API contracts if a hot path ever demands it.

---
_Next: [Messaging & Data Model](04-messaging-and-data.md)._
