# Glossary

> Shared vocabulary for the Atlas documentation set. Terms are used consistently across all
> documents; if a term here conflicts with a document, the document is wrong — fix it.

## Services & components

| Term | Meaning |
|------|---------|
| **Atlas** | The media automation platform described by this documentation set. |
| **Studio** | The Angular single-page application; the only user-facing interface. |
| **HSM** | Hierarchical Storage Manager — authority over where asset files physically live (online / near-line / offline) and file operations on them. |
| **IAM** | Identity and Access Management — users, groups, roles, permission rules, authentication. |
| **MTS** | Media Transcoding System — FFmpeg-based transcoding to configured profiles; scales to many instances. |
| **MAM** | Media/Metadata & Asset Management — system of record for media metadata and the searchable catalog. |
| **RIM** | Recording & Ingest Management — brings media in via upload, FTP, folder watch, and recording. |
| **BMS** | Business Process Management System — the configurable workflow engine. |
| **Scheduling** | Builds and edits program tables; drives send-to-air. |
| **Newsroom** | Multimedia newsroom workflow (rundowns, stories, scripts). |
| **Notifications & Messaging** | System notifications plus user↔user/group messaging and tasks. |
| **Integration / Feeds** | Inbound and outbound third-party data; feed authoring and connectors. |
| **AI Enrichment** | AI-derived metadata and suggestions; off the critical path. |
| **Logging & Analytics** | Central audit log, metrics, and analytics/statistics. |
| **API Gateway** | Single ingress for Studio and third parties; auth, routing, rate limiting. |
| **WebSocket Service / Pusher** | Permission-aware fan-out of platform events to Studio clients. |
| **Service Registry** | Tracks live service instances and health; supports MTS elasticity. |
| **Message Broker** | The asynchronous communication backbone between services. |

## Media & storage

| Term | Meaning |
|------|---------|
| **Asset** | A managed media item and its metadata and files. |
| **File** | The first-class stored-bytes entity: a physical file with technical info, integrity checksum, storage location/tier/status and provenance. A file **belongs to exactly one asset** (never shared); an asset **has many files** ([Data Model §1.5](architecture/data-model.md#15-files)). HSM is its system of record. |
| **Rendition** | A **file of a generated kind** — proxy, broadcast, thumbnail, VTT filmstrip, hover preview (the `RenditionKind` enum). "Rendition" describes the *role* of a file; the stored entity is a **File**. |
| **Variant** | Distinguishes several files of the *same* kind on one asset (e.g. subtitle language, numbered thumbnail); uniqueness is `(assetId, kind, variant)`. |
| **Original / Master** | The immutable source file (`kind=original`), checksummed. |
| **Proxy** | Low-resolution rendition for browsing/editing. |
| **Broadcast rendition** | High-resolution, on-air-conformant version. |
| **Thumbnail** | Still poster image for grids/lists. |
| **VTT filmstrip** | Sprite + WebVTT cues for scrub preview in the player. |
| **Hover preview** | Short low-bitrate clip shown on mouse-over. |
| **Online tier** | Fast storage for day-to-day schedule media. |
| **Near-line tier** | On-demand storage with modest restore latency. |
| **Offline tier** | Archive/backup (tape or cloud archive); longest restore. |
| **Restore** | Bringing a near-line/offline asset back to online. |
| **Checksum** | Integrity hash stored per rendition; verified on ingest and in sweeps. |
| **Send to air** | Copying hi-res files + playlist to the control-room network destination. |
| **Ingest** | Bringing media into the system and validating it against acceptance rules. |
| **Acceptance rules** | Configurable checks (format, minimum size, aspect ratio) media must pass. |
| **Profile / Preset** | A named transcode configuration (codec, resolution, bitrate). |
| **MCRList** | The Cinegy Air `mcrs_playlist` XML playlist exported at send-to-air for third-party playout. See the [format spec](integrations/14-playout-mcrlist-format.md). |
| **Cinegy Air / Playout** | Third-party playout software; the first target for Atlas's playlist export. |
| **VANC** | Vertical Ancillary data — non-picture data (captions/metadata) carried in a video signal; a `group type="vanc"` in MCRList. |
| **AudioMatrix** | Channel-mapping matrix (out×in gains) in an MCRList item defining how source audio maps to output channels. |
| **MXF** | Material Exchange Format — the broadcast media container referenced by MCRList items. |
| **Channel-in-the-box** | A future (Post-v1.0) integrated CG + playout appliance; out of current scope. |
| **CG** | Character Generator — on-screen graphics/titling (part of the future channel-in-the-box). |

## Classification & discovery

| Term | Meaning |
|------|---------|
| **Media type** | The *kind* of an asset — video, photo, audio, live event; one per asset. A [Tier-1 registry](architecture/configuration-and-reference-data.md#22-tier-1--registries-the-important-middle) (code-known handlers, admin labels/defaults). |
| **Tag** | A free-form keyword for ad-hoc labelling of assets. |
| **Subject / Topic** | What an asset is *about*, from a controlled vocabulary. |
| **Structure** | The asset's format/genre axis (animation, drama, news); zero or one per asset. |
| **Classification** | Content-related class, **one or more** per asset, from an operator-updatable list (distinct from media type and structure). |
| **Category** | A node in the hierarchical taxonomy an asset belongs to; represents departments → programs → seasons, nesting up to ~20 deep. |
| **Taxonomy** | The hierarchical category structure used to organize assets. |
| **Controlled vocabulary** | An operator-managed list of allowed terms (categories, subjects, structures, classifications, roles). Terms have a **stable id** (referenced by assets) and **mutable labels**; in-use terms are **deprecated or merged, never deleted** ([Config §2.3](architecture/configuration-and-reference-data.md#23-tier-2--vocabularies-pure-data)). |
| **Materialized path** | A category's precomputed ancestor path (e.g. `/sports/football/`), enabling cheap subtree scoping in authorization and search. |
| **People / Cast register** | A database of persons (name, role in the media, optional image) used to enrich metadata and find assets by creator/cast. |
| **Faceted search** | Search that narrows results by multiple axes at once (category + subject + tag + person). |
| **Face-matching** | Proposing people from the register for a face in media, for human confirmation — not open-ended biometric identification. |

## Configuration & reference data

| Term | Meaning |
|------|---------|
| **Contract enum (Tier 0)** | A fixed value set that **code branches on** (`Tier`, `RenditionKind`, node kinds, states); lives in `@atlas/contracts`, changed only by release — **not** admin-editable ([Config §2.1](architecture/configuration-and-reference-data.md#21-tier-0--contract-enums-frozen)). |
| **Registry (Tier 1)** | A list whose *kind* is code-known but whose *entries* are admin data (media types, notification types, transcode profiles, acceptance rules, storage targets, roles). Creating an entry with an unknown kind is rejected. |
| **Vocabulary (Tier 2)** | A pure-data controlled list no code branches on (see *Controlled vocabulary*). |
| **Setting (Tier 3)** | A typed, scoped, admin-editable value (retention days, sweep cron, thresholds), declared by a **descriptor** in code with type/bounds/default/scope; only the value is stored. |
| **Setting descriptor** | The code-shipped declaration of a setting; Studio **generates** the admin UI from it ([schema](architecture/schemas/setting-descriptor.schema.json)). |
| **Reference snapshot** | A versioned, cached bundle of registries/vocabularies/resolved settings served to services and Studio, carrying a **`configVersion`**; validation is an in-memory lookup, not a per-request DB read. |
| **Nearest-wins resolution** | Setting/category inheritance order `code default → deployment → channel → category → user`; the nearest level that sets a key wins, and the UI shows the value's origin. |
| **Seed-as-code** | Default reference data shipped as version-controlled files, applied idempotently, exportable/importable for environment promotion. |

## Identity & access

| Term | Meaning |
|------|---------|
| **User** | A person (or service account) with an identity in IAM. |
| **Group** | A cohort of users, usually a department or role-based set. |
| **Role** | A named bundle of permission rules. |
| **Permission rule** | A grant assignable to a user or group. |
| **Effective permissions** | The **union** of a user's own rules and all their groups' rules, compiled once per `permVersion`. |
| **Field group** | A named subset of an entity's fields (asset: `core`, `taxonomy`, `cast`, `rights`, …) a write grant can be narrowed to, so "edit metadata but not rights" is expressible. |
| **permVersion** | A monotonic version of a user's effective policy; bumped on any grant/membership change so stale clients refresh within one token TTL. |
| **Scope (of a grant)** | The channel / category-subtree / ownership / state a permission applies to — a permission is never global by accident. |
| **Access token** | Short-lived JWT authorizing requests. |
| **Refresh token** | Longer-lived, rotating, revocable token used to obtain access tokens. |
| **Service account** | A machine identity for third-party/integration access. |
| **Channel / Station / Tenant** | An isolated broadcast property within a deployment; data is channel-scoped. |

## Architecture & messaging

| Term | Meaning |
|------|---------|
| **Microservice** | An independently deployable service owning one capability and its data. |
| **Command** | A private, point-to-point instruction to a service. |
| **Event** | A broadcast fact other services may react to. |
| **Progress** | High-volume, lossy-tolerant status updates (e.g. transcode %). |
| **Response** | The reply to a command. |
| **Envelope** | The common message wrapper (ids, type, channel, actor, timestamp). |
| **Correlation id** | Identifier tying all messages in one flow together. |
| **Idempotency** | Property that processing a message more than once is safe. |
| **At-least-once** | Delivery guarantee where messages may arrive more than once. |
| **DLQ** | Dead-letter queue for messages that exceed retry limits. |
| **Outbox pattern** | Technique ensuring "state changed ⇒ event published" reliably. |
| **Choreography** | Coordination by services reacting to events (no central conductor). |
| **Orchestration** | Coordination by a central engine (BMS) issuing steps. |
| **Read model / projection** | A queryable view built from events (e.g. the search index). |

## Workflow, scheduling & review

| Term | Meaning |
|------|---------|
| **Workflow definition** | The versioned, BPMN-2.0-convertible **JSON DSL** graph the Studio designer edits and BMS executes ([schema](architecture/schemas/workflow-definition.schema.json)). |
| **Workflow instance** | One running execution of a definition against an asset; its step history + human tasks form the asset **Flow** view. |
| **JSON DSL** | Atlas's native workflow format — a JSON graph of nodes/edges, losslessly convertible to and from BPMN 2.0 so standard tools interoperate. |
| **BPMN 2.0** | Business Process Model and Notation — the industry XML standard the DSL round-trips through (via `bpmn-moddle` + the `atlas:` moddle extension). |
| **FEEL** | Friendly Enough Expression Language (from DMN) — the expression syntax for workflow conditions/gateways, evaluated by `feelin`. |
| **Effects boundary** | The pattern isolating the pure workflow interpreter from the engine, so logic is engine-independent and testable ([BMS design §10.0](architecture/bms-workflow-dsl-and-designer.md)). |
| **Temporal** | The durable-execution engine (TypeScript SDK) BMS runs workflows on (retries, timers, human waits). |
| **Foblex Flow** | The open-source Angular canvas library the drag-and-drop workflow designer is built on. |
| **Human task** | A workflow step that pauses for a person (approve/edit/review); materialized as a [Task](architecture/data-model.md#7-the-notifications-tasks--inbox-aggregate) and completing it advances the instance. |
| **Reel** | The schedule model: an ordered sequence of items each with a start + duration, the next beginning where the previous ends ([Data Model §3.4](architecture/data-model.md#34-the-reel--the-fixed-anchor)). |
| **Fixed anchor** | A time-locked schedule item (e.g. a title at 10:00 sharp); the editor reflows surrounding non-fixed items around it. |
| **In/out points** | Start/end offsets letting a schedule item, edit clip, or script media-ref play **part** of a media. |
| **Live item / sub-schedule** | A schedule item with no media reference that may carry a one-level-deep sub-schedule of items played during the live block. |
| **Review verdict** | A manual approve/reject decision at a workflow review point; verdict history is retained ([FR-APP](requirements/05-functional-requirements.md#approval)). |
| **Expiry (usable-until)** | The time a media becomes **unusable** and needs re-review; inherited from the category, overridable per asset ([FR-APP-7](requirements/05-functional-requirements.md#approval)). |
| **Rejected-retention** | How long a **rejected** asset is kept before purge (a separate knob from expiry). |
| **Keep-duration** | How long a media stays **online after use** before HSM tiers it down — an HSM storage knob, **orthogonal** to expiry and rejected-retention. |

## Delivery & planning

| Term | Meaning |
|------|---------|
| **MVP** | Minimum Viable Product — the ingest-to-schedule spine for one channel. |
| **Beta** | Multi-channel workflow release (approval, tasks, messaging, editor, feeds). |
| **v1.0** | First stable full-feature release. |
| **GA** | General Availability — hardened, perf-proven, pen-tested v1.0. |
| **MoSCoW** | Prioritization: Must / Should / Could / Won't-yet. |
| **FR / NFR** | Functional / Non-Functional Requirement (with stable IDs). |
| **RTO / RPO** | Recovery Time / Point Objective. |
| **SLO** | Service Level Objective (a measurable reliability/performance target). |
| **PW / PM** | Person-week / Person-month of effort. |
| **HA** | High Availability. |
| **Air-gapped / isolated network** | A deployment with no internet access; the Atlas core must run fully offline, while AI degrades to a limited local tier or off. Cannot use the SaaS model. |
| **SaaS / Managed service** | Atlas run in the vendor's cloud on a per-channel/seat subscription instead of a customer install — a deployment/commercial option alongside on-prem ([Architecture §7.1](architecture/02-system-architecture.md#saas)). |
| **Site connector / edge relay** | A lightweight on-prem HSM agent (or VPN/Direct-Connect) that lets a cloud-hosted Atlas deliver hi-res media + playlist onto the customer's control-room network. |
| **Offline install bundle** | A self-contained package (artifacts + AI models) that installs Atlas without external registries. |
| **Core team** | The smallest agile team (~5–6) — the recommended staffing plan; scales up in later phases. |
| **Basic-NLE** | The [media editor](architecture/services/media-editor.md)'s scope: trim/arrange clips, simple transitions (cut/dissolve) and filters (crop/gain/fade), + audio and image editing — short of a full NLE (no multi-layer compositing, CG/titling, or grading). |
| **AI online (full) tier** | Full-strength enrichment via cloud/vendor AI; the primary AI experience, for connected deployments. |
| **AI offline (limited) tier** | An optional small local model for air-gapped sites — suggestions/simple tasks only, not full accuracy. |
| **AI-assisted development** | Using coding assistants / agentic tooling to speed up the build; factored into the timeline as a ~15–20% whole-program calendar reduction ([A12](README.md#assumptions-register)). |

## Production lifecycle

| Term | Meaning |
|------|---------|
| **Pre-production** | Planning, budgeting, resource scheduling, staffing, and preparation before shooting. |
| **Production** | The shoot itself. Atlas supports the data around it (rushes ingest, shot logging, dailies), not the craft. |
| **Post-production** | Editing, grading, sound, VFX, final review. Atlas covers editing; craft work is integrated. |
| **Resource scheduling** | Booking people, facilities, and equipment against time (pre-production) — **distinct from broadcast scheduling**. |
| **Broadcast scheduling** | Building the program table/playlist that goes to air. |
| **Script breakdown** | Tagging a script's elements (cast, props, locations, VFX) to generate production requirements. |
| **Shot list** | The ordered list of shots planned for a production, linked to captured footage. |
| **Call sheet** | The daily document telling crew and cast where and when to be, generated from planning data. |
| **Rushes / Dailies** | Raw captured footage, reviewed shortly after the shoot. |
| **Camera-card ingest** | Offloading and verifying media from camera storage into the platform. |
| **Edit project** | A persistent, reopenable set of edit decisions (v2.0), owned by the Editorial service. |
| **Fidelity report** | The record of what an interchange import/export could not carry across (effects, plugins, grades). |
| **Basic-NLE (v1.0) vs project editor (v2.0)** | v1.0 is one-shot operations rendered server-side; v2.0 adds a saved project, timeline model, and NLE interchange. |

## Standards & external

| Term | Meaning |
|------|---------|
| **FIMS** | Framework for Interoperable Media Services (EBU/AMWA) — media service interfaces (Capture, Transfer, Transform, Repository, QA, AME) plus a common data model. Atlas implements it as a [boundary facade](integrations/20-standards-and-fims.md). |
| **BMContent / BMEssence** | FIMS/EBUCore's split between the editorial object and its physical instantiation — maps to Atlas's Asset and Rendition/FileEntry. |
| **EBUCore** | The EBU media metadata model underlying FIMS; Atlas's data-model mapping target. |
| **BXF** | Broadcast eXchange Format (SMPTE ST 2021) — schedule/as-run/content metadata exchange between traffic, automation, and program management. |
| **OTIO / OpenTimelineIO** | Open editorial timeline interchange model; the recommended internal timeline representation for the Editorial service. |
| **AAF** | Advanced Authoring Format — professional timeline+media interchange; the best-fidelity route to Avid and Premiere. |
| **FCPXML / XMEML / EDL** | Timeline interchange formats for Final Cut & Resolve / legacy Premiere / universal-but-lossy cuts-only exchange. |
| **NewsML-G2 / ninjs** | IPTC standards for news content exchange. |
| **MovieLabs 2030** | Industry vision and ontology for cloud-based production; watched, not adopted wholesale. |
| **OVP** | Online Video Platform (Brightcove, Kaltura) — streaming/distribution; a Atlas integration target, not a rival. |
| **FFmpeg** | The transcoding engine used by MTS. |
| **Node.js / TypeScript** | The recommended single primary backend stack for all services ([A2](README.md#assumptions-register)). |
| **NestJS** | The recommended Node framework for structured domain/control-plane services (modules, DI, validation). |
| **Fastify** | The recommended Node framework for thin high-throughput edges (API gateway/BFF, WebSocket). |
| **Escape hatch** | Dropping a single profiled hot path to a native addon (napi-rs) or small Go/Rust worker — not switching a whole service's language. |
| **JWT** | JSON Web Token — the token format for authentication. |
| **OIDC / SAML** | Federation protocols for single sign-on. |
| **EPG** | Electronic Program Guide. |
| **XMLTV / TV-Anytime** | EPG data standards. |
| **HbbTV** | Hybrid Broadcast Broadband TV standard (launchers/apps). |
| **MOS** | Media Object Server protocol — newsroom/playout device integration. |
| **WebVTT / VTT** | Web Video Text Tracks — used for the scrub filmstrip and subtitles. |
| **WCAG** | Web Content Accessibility Guidelines. |
| **PII** | Personally Identifiable Information. |

---
_Back to the [documentation index](README.md)._
