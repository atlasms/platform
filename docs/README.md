# Atlas Automation — Documentation Set

Atlas is a next-generation, service-based automation platform for the media industry
(TV, radio, news, live events). This repository holds the reference documentation for
the platform: the technical vision, architecture, requirements, delivery roadmap, and
the non-technical material used to explain Atlas to stakeholders and customers.

This set supersedes and expands the original single-file draft. It is written so that
each document can evolve independently while staying consistent with the others.

## How to read this set

Start with the **Technical Brief** for the whole-system picture, then branch into the
area you care about.

| # | Document | Audience | Purpose |
|---|----------|----------|---------|
| 01 | [Technical Brief](01-technical-brief.md) | Everyone | The master reference. Vision, principles, service overview, end-to-end flows. Completes the original draft. |
| 02 | [System Architecture](architecture/02-system-architecture.md) | Architects, engineers | Runtime topology, cross-cutting services, security model, deployment shapes. |
| 03 | [Service Catalog](architecture/03-service-catalog.md) | Engineers, tech leads | Per-service **summary** cards: responsibility, interfaces, data, events, scaling. |
| 03+ | [Service Specifications](architecture/services/) | Engineers, tech leads | **Detailed** per-service deep dives (one file per service) behind the catalog, plus the [Media Editor](architecture/services/media-editor.md) capability spec. |
| 03+ | [OpenAPI Stubs](architecture/openapi/) | Engineers, integrators | OpenAPI 3.1 stub per service for the synchronous REST surface. |
| 03+ | [Event Payload Schemas](architecture/schemas/) | Engineers | JSON Schema (2020-12) contracts for broker event payloads + the message envelope. |
| 03+ | [BMS Workflow DSL & Designer — Technical Design](architecture/bms-workflow-dsl-and-designer.md) | Engineers | Deep dive: the [WorkflowDefinition](architecture/schemas/workflow-definition.schema.json) model, FEEL, validator, Temporal interpreter, BPMN converter, and the Foblex Flow canvas. |
| 03+ | [Studio Front-End — Architecture & UX](architecture/studio-frontend.md) | Front-end, product | The VS Code-style workbench: activity bar, panels/views, tabbed editors, status bar, transfer tray, theming, dashboard, welcome/what's-new, and the history/diff viewer. |
| 03+ | [Domain Data Model](architecture/data-model.md) | Engineers, product | The logical entity model: **Asset**, **Category**, **Schedule**, **Identity**, and **Configuration & reference-data** aggregates, plus field-level permissioning and the ownership map. |
| 03+ | [Configuration & Reference Data](architecture/configuration-and-reference-data.md) | Engineers, ops, admins | Where the system's static lists live and **which an admin may change at runtime**: contract enums vs. registries vs. vocabularies vs. settings, descriptor-in-code, the cached snapshot, and seed/promotion. |
| 03+ | [Authorization Model](architecture/authorization-model.md) | Engineers, security | Users/groups/roles/rules: the scoped **grant** contract, the shared evaluator used by **both backend and Studio**, policy delivery/caching, and starter roles. |
| 03+ | [BMS Workflow Assets](architecture/workflows/) | Engineers | Validated fixtures: preset flows, designer palette, `atlas:` BPMN extension, golden BPMN export. |
| ref | [`reference/`](../reference/README.md) | Engineers | **Working, tested** reference code (84 tests): foundation libs [`contracts`](../reference/contracts/README.md)/[`messaging`](../reference/messaging/README.md)/[`service-kit`](../reference/service-kit/README.md)/[`data`](../reference/data/README.md), the [`bms-workflow`](../reference/bms-workflow/README.md) core, three assembled services ([`mam`](../reference/mam-service/README.md)/[`scheduling`](../reference/scheduling-service/README.md)/[`notifications`](../reference/notifications-service/README.md)) with integration + fan-out tests, and an [`http-edge`](../reference/http-edge/README.md) (Fastify + JWT + problem-mapping). |
| 04 | [Messaging & Data Model](architecture/04-messaging-and-data.md) | Engineers | Broker topology, message contracts, event catalog, persistence strategy. |
| 05 | [Functional Requirements](requirements/05-functional-requirements.md) | Product, QA | What the system must do, expressed as numbered, testable requirements. |
| 06 | [Non-Functional Requirements](requirements/06-non-functional-requirements.md) | Architects, QA, ops | Performance, availability, security, compliance targets. |
| 07 | [Hardware & Infrastructure](requirements/07-hardware-requirements.md) | Ops, sales engineering | Minimum and recommended hardware per deployment tier. |
| 17 | [Operations Runbook](operations/17-operations-runbook.md) | Ops, SRE | Install (incl. air-gapped), zero-downtime upgrade/rollback, backup & restore (RPO), disaster recovery (RTO), cutover, and the smoke/health suite. |
| 08 | [Delivery Roadmap](roadmap/08-roadmap.md) | Leadership, delivery | Phased plan from MVP to first stable full-feature release (v1.0). |
| 09 | [Resourcing, Time & Cost](roadmap/09-resourcing-estimates.md) | Leadership, finance | Team shape, effort estimates, timeline and budget scenarios. |
| 15 | [Review Lifecycle — Implementation Plan](roadmap/15-review-lifecycle-implementation-plan.md) | Engineers, delivery | Step-by-step build plan for manual review, approval expiry, category-inherited expiry, and rejected-retention purge (Beta / Phase 2). |
| 16 | [System Implementation Plan](roadmap/16-system-implementation-plan.md) | Engineers, delivery | The **general** build plan: foundations, shared contracts, service build order, phase→deliverable mapping, cross-cutting standards. |
| 16+ | [Per-Service Implementation Plans](roadmap/services/README.md) | Engineers | One **build plan per service** (backbone → MVP → Beta → v1.0), behind the [service specs](architecture/services/). |
| 10 | [Third-Party Developer Guide](integrations/10-third-party-developer-guide.md) | Integrators | How external systems and developers connect to Atlas. |
| 14 | [Playout Export — MCRList](integrations/14-playout-mcrlist-format.md) | Integrators, playout | The Cinegy Air `mcrs_playlist` format Atlas exports at send-to-air. |
| 18 | [Market & Positioning](strategy/18-market-and-positioning.md) | Leadership, sales | Target customers, competitive landscape (Dalet, Avid, Superdesk…), differentiation. |
| 19 | [Production Lifecycle Scope](strategy/19-production-lifecycle-scope.md) | Everyone | **What Atlas builds, integrates, and excludes** across pre-production, production, post — the v2.0 scope decision. |
| 20 | [Standards & FIMS](integrations/20-standards-and-fims.md) | Architects, integrators | FIMS conformance (services + data model), BXF, EBUCore, OTIO, NewsML-G2. |
| 11 | [White Paper](marketing/11-white-paper.md) | Executives, buyers | Non-technical narrative: problem, approach, value. |
| 12 | [Brochure](marketing/12-brochure.md) | Sales, prospects | One-glance product summary. |
| 13 | [Glossary](13-glossary.md) | Everyone | Shared vocabulary and acronyms. |

## Document conventions

- **Requirement IDs** are stable and referenced across documents: `FR-<area>-<n>` for
  functional, `NFR-<area>-<n>` for non-functional. Never renumber; deprecate instead.
- **MoSCoW** priorities (Must / Should / Could / Won't-for-now) tag each requirement to
  the release that owns it.
- **Assumptions** that drive estimates live in one place — the
  [Assumptions Register](#assumptions-register) below — and are referenced, not repeated.
- Diagrams use [Mermaid](https://mermaid.js.org/) so they render on most Markdown hosts
  and stay diff-friendly in version control.

## Assumptions Register

These assumptions shape the roadmap and the estimates. They are deliberately explicit so
they can be challenged and changed. Changing one may shift the numbers in documents 08–09.

| ID | Assumption | Rationale | If wrong… |
|----|-----------|-----------|-----------|
| A1 | **Deployment is on-prem-first, cloud-optional (hybrid), and can also be offered vendor-hosted as a managed service (SaaS).** | Broadcast control rooms, near-line/offline tiers, folder watchers and tape archives in the draft are classic on-prem infrastructure; the same containers also run cloud-hosted for customers without a DC ([Architecture §7](architecture/02-system-architecture.md#7-deployment-shapes)). | A pure-cloud target simplifies HSM/infra but changes storage, egress cost and latency planning; SaaS adds a last-mile playout hand-off and shifts hosting cost onto the vendor. |
| A2 | **Backend is a single primary stack: Node.js (LTS) + TypeScript** (NestJS for domain/control-plane services, Fastify for thin high-throughput edges), with a narrow **escape hatch** — a native addon or small Go/Rust worker — only for profiled CPU-bound hot paths (HSM hashing/byte-movement, extreme WebSocket fan-out) and a Python/ONNX sidecar for offline ML inference. _(Stakeholder preference: TypeScript/Node.)_ | One language end to end lets contracts/types be shared across services and the Angular Studio — a force-multiplier for the small [Core team](roadmap/09-resourcing-estimates.md); Atlas is overwhelmingly IO-bound orchestration, Node's strength. Per-service picks: [Service Catalog §Recommended implementation stack](architecture/03-service-catalog.md#recommended-implementation-stack). | A different stack (e.g. .NET/Go) shifts hiring and some ops ergonomics but not the architecture — contracts are language-agnostic. |
| A3 | **Studio is Angular** (given), served as an SPA against an API gateway. | Stated in the draft. | — |
| A4 | **Message broker is a durable, topic-capable broker** (recommendation: NATS JetStream or RabbitMQ; Kafka if heavy event-sourcing is chosen). | Matches the command/progress/broadcast messaging described in the draft. | Kafka raises ops cost but strengthens replay/audit. |
| A5 | **Transcoding uses FFmpeg** (given) with GPU acceleration optional. | Stated in the draft. | — |
| A6 | **First customer is a single mid-size broadcaster: 1–3 channels, 10–100 concurrent Studio users.** _(Confirmed by stakeholder.)_ | A concrete anchor for sizing; multi-tenant scale is a later phase. | Larger launch customer pulls scale/HA work earlier. |
| A7 | **The team is deliberately the smallest that keeps the build agile — a core of ~5–6, scaling selectively.** _(Confirmed by stakeholder.)_ | Agility over headcount; doc 09 details the core team and where it scales. | A larger team compresses the calendar; see doc 09. |
| A8 | **"MVP" = a usable ingest-to-schedule spine for one channel**, not a feature-complete replacement of the legacy Atlas. | Keeps the first milestone shippable and testable with a real workflow. | A broader MVP definition extends Phase 1. |
| A9 | **Some deployments run in isolated / air-gapped networks with no internet.** The **core platform** MUST be fully operable offline; **AI is online-first** (A12b) and merely degrades to a limited local tier (or off) offline. _(Confirmed by stakeholder.)_ | Broadcast facilities are frequently network-isolated for security. | Cloud-only features (full AI, cloud burst) are unavailable offline; the platform still runs. |
| A10 | **Playout is external.** Atlas hands off standard playlist formats + hi-res files to third-party playout software; first target is **Cinegy Air MCRList** ([spec](integrations/14-playout-mcrlist-format.md)), exporter pluggable. A future "channel-in-the-box" (CG, playout) is Post-v1.0. _(Confirmed by stakeholder.)_ | Keeps the platform boundary clean; integrate rather than build playout now. | Building playout in-house is a separate future product line. |
| A11 | **No legacy data migration.** Existing legacy-Atlas data will not be imported into this project. _(Confirmed by stakeholder.)_ | Removes a whole workstream from the estimates. | If migration is later required, it is scoped as its own project. |
| A12 | **The build uses AI-assisted development** (coding assistants / agentic tooling), factored into the timeline as a ~15–20% whole-program calendar reduction. _(Stakeholder direction.)_ | Compresses the Core-team calendar without adding headcount. | If the measured speedup is lower, the pre-AI baseline in [doc 09 §3](roadmap/09-resourcing-estimates.md#timeline) still holds. |
| A12b | **AI is an online-first feature.** Full enrichment uses cloud/vendor providers; air-gapped sites get a limited local tier or none. _(Stakeholder direction.)_ | Avoids a mandatory on-prem GPU pool at every site; ships the online tier first. | A customer needing full on-prem AI would reintroduce a local GPU pool as a scoped add-on. |
| A13 | **Four customer segments**: broadcasters (TV **and radio**), news organisations, government/institutes, content owners/distributors — with a mid-size broadcaster as the launch beachhead (A6). _(Stakeholder research.)_ | From competitive research; each segment is served by the same spine with different emphasis ([doc 15](strategy/18-market-and-positioning.md)). | A different lead segment reorders roadmap emphasis (e.g. news-first pulls planning earlier). |
| A14 | **Atlas covers the full production lifecycle, but the expansion beyond the automation spine is v2.0** — pre-production planning, production support, and the project-based web editor ship after v1.0 GA. _(Recommended; stakeholder to confirm.)_ | The expansion is ≈ +35–45% effort ([doc 16 §6](strategy/19-production-lifecycle-scope.md#6-delivery-consequence-this-is-a-v20-horizon)); sequencing ships a sellable product 8–14 months earlier. | Forcing it into v1.0 moves GA from ~16–18 to ~24–30 months. |
| A15 | **Craft tools are integrated, not rebuilt** — grading, VFX, sound design, long-form scripting, budgeting, HR/payroll stay with the specialist tools that own them. | Atlas's defensible core is the metadata/workflow/automation spine ([doc 16 §1](strategy/19-production-lifecycle-scope.md#1-the-decision-rule)). | Building any of these turns a focused platform into a shallow suite. |
| A16 | **FIMS is implemented as a boundary conformance layer** (facade + data-model mapping), not as the internal domain model; **BXF** is prioritised alongside it for schedule/as-run exchange. _(Engineering judgment on a stakeholder requirement.)_ | FIMS is SOAP/SOA-era and job-oriented; the core is event-driven. A facade delivers conformance without slowing the core ([doc 17 §1](integrations/20-standards-and-fims.md#1-position-adopt-fims-as-an-adapter-layer-not-as-the-internal-model)). | A tender demanding FIMS-conformant *internal* traffic (level L4) would need a scoped extension. |

## Status

Draft **`v0.9`** — the strategy layer is in place: who Atlas competes with, which parts of the
production lifecycle it covers, and how it conforms to industry standards. The **v1.0 scope is
unchanged**; the lifecycle expansion is scoped as [v2.0](roadmap/08-roadmap.md#v2).

- **`v0.9`** adds the strategy and lifecycle layer, from competitive research into Dalet, Avid,
  Superdesk and the OVP vendors:
  - **[Market & Positioning](strategy/18-market-and-positioning.md)**: four customer segments
    (broadcast incl. **radio**, news, government/institutes, content owners), the rival map
    (Dalet and Avid are the real overlap; Brightcove/Kaltura are OVPs and **integration targets**;
    Ooyala is now Dalet), and where Atlas wins (A13).
  - **[Production Lifecycle Scope](strategy/19-production-lifecycle-scope.md)**: the
    build / build-light / integrate / exclude decision for **every** pre-production, production and
    post activity, with the decision rule *"build what is data-shaped, integrate what is
    craft-shaped"* (A14, A15). New: **FR-PLN**, **FR-PRD**, **FR-EDT-11…20**, **FR-STD**.
  - **[Standards & FIMS](integrations/20-standards-and-fims.md)**: FIMS implemented as a
    **boundary facade + EBUCore data-model mapping** rather than the internal model, with published
    [conformance levels](integrations/20-standards-and-fims.md#6-conformance-levels); **BXF**
    prioritised alongside it for schedule/as-run exchange (A16).
  - Two new service specs — **[Planning](architecture/services/planning.md)** (projects, bookings,
    assignments) and **[Editorial](architecture/services/editorial.md)** (the v2.0 promotion of the
    [Media Editor](architecture/services/media-editor.md) capability, preserving its contracts).
  - **[v2.0 horizon](roadmap/08-roadmap.md#v2)** in the roadmap + a
    [scope delta](roadmap/09-resourcing-estimates.md#lifecycle-delta) in resourcing: the expansion is
    **≈ +35–45%** (~125–205 PW), sequenced **after** v1.0 GA so a sellable product ships 8–14 months
    earlier.
- **`v0.8`** closes the design-completeness gaps ahead of the delivery breakdown:
  - **Domain data model** ([data-model.md](architecture/data-model.md)) now covers all aggregates —
    Asset (incl. Files, EditProject), Category, Schedule, Identity, **Configuration & reference
    data**, Newsroom, Notifications/Tasks/Inbox, Integration/Feeds, and Audit/Revision.
  - **Configuration & reference data** ([design](architecture/configuration-and-reference-data.md)):
    the four-tier model (contract enum / registry / vocabulary / setting) for what admins may change
    at runtime, with [descriptor](architecture/schemas/setting-descriptor.schema.json) and
    [vocabulary](architecture/schemas/vocabulary-term.schema.json) contracts and **FR-CFG-1…10**.
  - **Authorization model** ([design](architecture/authorization-model.md)) and the **File** entity
    ([schema](architecture/schemas/file.schema.json)) with a normative one-asset/many-files rule.
  - **Contract set closed**: every event named in a [service spec](architecture/services/) has a
    [payload schema](architecture/schemas/README.md#index) (20 added); the **Media Editor** is
    specified as a [Studio+MAM+MTS capability](architecture/services/media-editor.md).
  - **Operations runbook** ([17](operations/17-operations-runbook.md)): install/air-gapped,
    upgrade/rollback, backup/restore (RPO), DR (RTO), cutover.
- **`v0.7`** settles two capabilities and adds the reference layer:
  - **Review, approval, expiry & retention** ([D7](01-technical-brief.md#9-resolved-decisions)):
    manual approval with **category-inherited media expiry → re-review** and **rejected-retention →
    purge**, gating air at export ([plan 15](roadmap/15-review-lifecycle-implementation-plan.md)).
  - **BMS visual workflow designer** ([D8](01-technical-brief.md#9-resolved-decisions)): a
    drag-and-drop designer (Foblex Flow) over a **BPMN-2.0-convertible JSON DSL**, executed on
    Temporal via an `Effects` boundary
    ([design](architecture/bms-workflow-dsl-and-designer.md), [contract](architecture/schemas/workflow-definition.schema.json),
    [plan](roadmap/services/bms-plan.md)).
  - **Reference implementation** ([`reference/`](../reference/README.md)): **84 passing tests**
    realizing the foundation libs (contracts / messaging / service-kit / data), the BMS workflow
    core (validator, lossless DSL⇄BPMN converter, interpreter, canvas core), three assembled
    services (MAM / Scheduling / Notifications) with cross-service integration + fan-out, and an
    HTTP edge. Building it **validated the contracts and corrected four issues** it surfaced: the
    BPMN **NCName-id** rule, gaps in the **`atlas:` moddle extension**, the **envelope `type`
    pattern** (was 3-token, real events are 2-token), and an **idempotency-concurrency** note.
- **`v0.6`** — machine-readable contracts: an [OpenAPI 3.1 stub](architecture/openapi/) per service
  and [JSON Schema payloads](architecture/schemas/) for every broker event.
- **`v0.5`** — detailed per-service specifications in [architecture/services/](architecture/services/);
  D1–D6 recorded as [Resolved Decisions](01-technical-brief.md#9-resolved-decisions).
- **`v0.4`** — the [Node.js/TypeScript backend stack](architecture/03-service-catalog.md#recommended-implementation-stack)
  ([A2](#assumptions-register)) and the [cloud-hosted / SaaS](architecture/02-system-architecture.md#saas)
  deployment option ([A1](#assumptions-register)).

**Next:** delivery breakdown — **epics → sprints → tasks** (the domain data structures/models pass is
now complete).
