# Functional Requirements

> What Atlas must do, as numbered, testable requirements. IDs are stable (`FR-<area>-<n>`)
> and referenced across the set. Each carries a **MoSCoW** priority and the **release** that
> owns it ([MVP], [Beta], [v1.0], [Post]). Parent:
> [Technical Brief](../01-technical-brief.md). Verification approach:
> [Non-Functional Requirements §Verification](06-non-functional-requirements.md#verification).

**Priority legend.** M = Must, S = Should, C = Could, W = Won't-yet.
**Release legend.** MVP → Beta → v1.0 (first stable full-feature) → Post-v1.0.

---

## Platform-wide {#platform}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-PLat-1 | The system SHALL be operable as multiple isolated channels/stations within one deployment. | M | MVP (single) → Beta (multi) |
| FR-PLat-2 | The UI SHALL support multiple languages, including at least one RTL language. | S | Beta |
| FR-PLat-3 | The UI SHALL support per-tenant and per-user themes. | S | Beta |
| FR-PLat-4 | Business process flows, ingest rules, transcode profiles, and metadata field schemas SHALL be configurable without a code deploy — within the classification and safety rules of [FR-CFG](#configuration). | M | MVP (rules/profiles) → v1.0 (flows) |
| FR-PLat-5 | Every user and system action SHALL be logged with actor, resource, channel, and correlation id. | M | MVP |
| FR-PLat-6 | The system SHALL stream live data changes to Studio (public and private channels). | M | MVP |
| FR-PLat-7 | The system SHALL be fully operable in an **isolated / air-gapped network** with no internet access; no core function (ingest, transcode, metadata, workflow, scheduling, AI) SHALL depend on external connectivity. | M | MVP |
| FR-PLat-8 | Any feature that can use the internet (vendor AI, cloud transcode burst, external publishing) SHALL be an optional, per-deployment plug-in that degrades gracefully when disabled. | M | Beta |

### Configuration & reference data {#configuration}

> Design: [Configuration & Reference Data](../architecture/configuration-and-reference-data.md).

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-CFG-1 | Admin-changeable lists and knobs SHALL be classified into **contract enums** (code, not editable), **registries** (code-known kind + data entries), **vocabularies** (pure data) and **settings** (typed values); only the latter three SHALL be runtime-editable (FR-PLat-4). | M | MVP |
| FR-CFG-2 | Creating a **registry entry** SHALL be rejected unless its kind/handler is declared by the running code — an operator SHALL NOT be able to introduce a value no service can handle. | M | Beta |
| FR-CFG-3 | Every runtime setting SHALL be declared by a **descriptor** (type, bounds, default, scope, sensitivity, help text) shipped with the code that reads it; the system SHALL be fully operable with an empty settings store, using declared defaults. | M | MVP |
| FR-CFG-4 | Studio SHALL **generate** the settings admin UI from descriptors, and SHALL validate input with the same rules the owning service enforces. | S | Beta |
| FR-CFG-5 | Settings SHALL resolve **nearest-wins** across `deployment → channel → category → user` within the descriptor's declared scope, and the UI SHALL show the value's **origin level** with a *reset to inherited* action. | S | Beta |
| FR-CFG-6 | Reference data SHALL be served as a **versioned, cached snapshot** with a `configVersion`; changes SHALL emit `config.changed` and SHALL NOT require a per-request database read. A stale snapshot SHALL keep the system operable (FR-PLat-7). | M | Beta |
| FR-CFG-7 | Vocabulary terms SHALL carry a **stable id** referenced by assets and a **mutable label**; terms in use SHALL be **deprecated or merged**, never hard-deleted, so historical assets and audit entries remain resolvable. | M | Beta |
| FR-CFG-8 | Default reference data SHALL be **seeded from version-controlled files** applied idempotently, and any subset SHALL be **exportable/importable** as a bundle for environment promotion. | S | Beta |
| FR-CFG-9 | Every configuration, registry and vocabulary change SHALL be audited and diffable through the same change-history pipeline as content edits ([FR-AUD](#audit)), with **sensitive values redacted**. | M | Beta |
| FR-CFG-10 | Writing configuration SHALL require `config:admin` **scoped to the level being written**; per-area grants (`storage:admin`, `taxonomy:admin`, `workflow:admin`, …) remain the authority for their own registries. | M | Beta |

## Identity & Access (IAM) {#iam}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-IAM-1 | The system SHALL support CRUD for users, groups, roles, and permission rules. | M | MVP |
| FR-IAM-2 | A user SHALL belong to zero or more groups; a group SHALL contain many users. | M | MVP |
| FR-IAM-3 | Permission rules SHALL be assignable to both users and groups. | M | MVP |
| FR-IAM-4 | A user's **effective permissions** SHALL be the set **union** of the user's own rules and the rules of every group the user belongs to. | M | MVP |
| FR-IAM-5 | Authentication SHALL issue a short-lived JWT access token and a longer-lived, revocable refresh token. | M | MVP |
| FR-IAM-6 | Access tokens SHALL authorize each request according to the caller's effective permissions. | M | MVP |
| FR-IAM-7 | The system SHALL allow permission checks scoped to a resource and department/group (e.g. "edit Sports assets only"). | M | MVP |
| FR-IAM-8 | Revoking a permission or refresh token SHALL invalidate affected access within one access-token TTL. | M | MVP |
| FR-IAM-9 | The system SHOULD federate authentication to an external IdP via OIDC/SAML (SSO). | S | v1.0 |
| FR-IAM-10 | The system SHOULD support MFA for configurable privileged roles. | S | v1.0 |
| FR-IAM-11 | The system COULD support explicit deny rules that override grants, if a customer requires it. | C | Post |
| FR-IAM-12 | A grant SHALL be **scopeable** by channel, **category subtree** (prefix match on the category path), resource **state**, and **ownership**; a write grant MAY further narrow to **field groups** ([FR-UI-13](#studio)). | M | MVP (channel) → Beta (subtree/fields) |
| FR-IAM-13 | Authorization decisions SHALL be produced by a **single shared evaluator** used by both the services (**enforcement**) and Studio (**UI gating**), so both always agree. The **server is authoritative** and SHALL re-check every request; client-side evaluation is presentation only. | M | MVP |
| FR-IAM-14 | The **compiled effective policy** SHALL be retrievable by the client and cached against **`permVersion`**; the access token SHALL carry `permVersion`, **not** the rule set. A grant/membership change SHALL bump `permVersion` and emit `permissions.changed`. | M | MVP |

> **Permission resolution (normative for FR-IAM-4).** Given user `U` in groups `G1…Gn`,
> `effective(U) = rules(U) ∪ rules(G1) ∪ … ∪ rules(Gn)`. Grants are additive; the base
> model has no deny. A request is authorized iff the required permission is in
> `effective(U)` and the resource's channel/department is in scope.

## Recording & Ingest (RIM) {#ingest}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-ING-1 | The system SHALL accept media via web upload, FTP, and folder watch. | M | MVP |
| FR-ING-2 | Uploads SHALL be resumable/chunked for large files. | M | MVP |
| FR-ING-3 | The system SHALL record streams/broadcasts and segment recordings into files of a configurable duration (e.g. 24h → 1h files). | S | v1.0 |
| FR-ING-4 | Each source SHALL enforce configurable acceptance rules (container/format, minimum size, aspect-ratio match, and others). | M | MVP |
| FR-ING-5 | Files failing acceptance SHALL be rejected or quarantined with a recorded reason and a notification. | M | MVP |
| FR-ING-6 | On acceptance the system SHALL extract technical metadata and compute a checksum. | M | MVP |
| FR-ING-7 | Accepted media SHALL appear on the Ingest/Import page for permitted users. | M | MVP |

## Transcoding (MTS) {#transcode}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-MTS-1 | The system SHALL transcode accepted media to configured profiles using FFmpeg. | M | MVP |
| FR-MTS-2 | At ingest the system SHALL produce a proxy (low-res) rendition and a thumbnail. | M | MVP |
| FR-MTS-3 | The system SHALL produce, per profile, a broadcast (high-res) rendition, a VTT scrub filmstrip, and a hover preview. | M | MVP (broadcast) → Beta (VTT/hover) |
| FR-MTS-4 | Each rendition SHALL have its own checksum. | M | MVP |
| FR-MTS-5 | Transcode jobs SHALL report progress and completion/failure as events. | M | MVP |
| FR-MTS-6 | The transcoder SHALL scale to multiple instances driven by queue depth and scale down when drained. | M | MVP (manual) → Beta (auto) |
| FR-MTS-7 | Transcode profiles SHALL be configurable per channel and media type. | S | Beta |
| FR-MTS-8 | The system SHOULD support GPU-accelerated transcoding where hardware is available. | S | v1.0 |

## Metadata & Assets (MAM) {#mam}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-MAM-1 | Every asset SHALL carry the core fields: title, duration, description, file type, resolution, aspect ratio, audio channels. | M | MVP |
| FR-MAM-2 | The system SHALL support type/category-specific extensible metadata fields defined by operators. | M | MVP (basic) → Beta (schema editor) |
| FR-MAM-3 | The system SHALL support tags, description, and shot-list on assets. | M | Beta |
| FR-MAM-4 | The system SHALL provide simple search and advanced (structured) search across core and extensible metadata. | M | MVP (simple) → Beta (advanced) |
| FR-MAM-5 | Entering mandatory metadata (title, description, main credits) SHALL be required before an asset can advance. | M | MVP |
| FR-MAM-6 | The system SHALL version assets and, on replacement, clone the previous version's metadata to a new asset ID. | M | Beta |
| FR-MAM-7 | Metadata reads SHALL be served through a cache for performance. | S | MVP |
| FR-MAM-8 | The system SHALL record automatically-derived metadata distinctly from user-entered metadata. | S | Beta |
| FR-MAM-9 | Assets SHALL carry a **media type** (video / photo / audio / live event / …) and **broadcast-planning fields**: episode number, **structure** (format/genre — animation/drama/news/…), **allowed broadcast count**, and a **recommended broadcast window** (advisory — distinct from the *enforced* expiry, [FR-APP-7](#approval)). | S | Beta |
| FR-MAM-10 | Assets SHALL support **asset-to-asset relations** — notably **rush / source-original** links to the raw camera/recorder material an item was made from — navigable both ways. | S | Beta |
| FR-MAM-11 | The **Files** view SHALL list every rendition (original, hi-res, low-res, thumbnail, …) with its **integrity hash**, **online/offline state**, and technical info (codec, bitrate, size); the expected file set MAY vary by category / BMS configuration. | M | MVP (core set) → Beta (full) |

### Classification & discovery (tags, subjects, categories) {#classification}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-TAX-1 | Assets SHALL support **free-form tags** (keywords) for ad-hoc labelling. | M | MVP |
| FR-TAX-2 | The system SHALL support a hierarchical **category** taxonomy that assets can be assigned to. | M | Beta |
| FR-TAX-3 | The system SHALL support **subjects/topics** drawn from an operator-managed **controlled vocabulary**. | S | Beta |
| FR-TAX-4 | Controlled vocabularies (categories, subjects, **structures**, **classifications**, roles) SHALL be managed by permitted operators without a deploy. | S | Beta |
| FR-TAX-5 | Search SHALL support **faceted filtering** by category, subject, tag, and person simultaneously. | M | Beta |
| FR-TAX-6 | Tags/subjects/categories SHALL be indexed so assets can be found by any of them. | M | MVP (tags) → Beta (facets) |
| FR-TAX-7 | A category MAY define a **default expiry** (an absolute date or a relative duration) that is inherited by its descendant categories and by the media assigned to it, driving media expiry (FR-APP-7). | M | Beta |
| FR-TAX-8 | Assets MAY carry **one or more content classifications** drawn from an **operator-updatable classification list** (FR-TAX-4); classifications are indexed and facetable (FR-TAX-5/6). | S | Beta |
| FR-TAX-9 | Categories SHALL carry settings/metadata that **cascade live, per field**: a category inherits from its parent and media inherits from its category (structure, subjects, classifications, tags, cast & crew, genre, supply type, production group/date, keep-duration, review-needed), each **overridable** at any level; editing a category value **propagates** to descendants that have not overridden it. | M | Beta |
| FR-TAX-9a | **Cast & crew SHALL inherit per role** — an asset MAY override an individual role (e.g. director per episode) while inheriting others (e.g. a program's producer). | S | Beta |
| FR-TAX-10 | A category SHALL have a **kind** (department / program / season / …; the tree nests arbitrarily deep — **~20 levels**) and the flags **media-addable** (may media be added **directly** here — typically **false** on department/program nodes) and **review-needed** (media here requires approval, gating [FR-APP-2](#approval)). | S | Beta |

### People / cast register {#people}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-PPL-1 | The system SHALL maintain a **people register** (presenters, cast, contributors). | S | Beta |
| FR-PPL-2 | A person record SHALL be limited to **name, role in the particular media, and an optional image** ([D5](../01-technical-brief.md#9-resolved-decisions)). | M | Beta |
| FR-PPL-3 | Assets SHALL associate people with a role for that asset (e.g. "presenter", "guest"). | S | Beta |
| FR-PPL-4 | Users SHALL be able to **search/find assets by person** (creator/cast). | S | Beta |
| FR-PPL-5 | AI face-matching MAY **suggest** people from the register for human confirmation; it SHALL NOT auto-create people or auto-write on-air metadata. | M | v1.0 |
| FR-PPL-6 | Asset cast associations SHALL distinguish **on-screen** roles (presenter, guest, cast) from **crew** roles (**producer, director, editor, …**), each recorded per asset. | S | Beta |

## Workflow (BMS) {#workflow}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-BMS-1 | The system SHALL ship preset process flows, including the canonical ingest-to-air flow. | M | Beta |
| FR-BMS-2 | Operators SHALL be able to duplicate and modify existing flows **in the visual designer** (FR-BMS-7). | M | v1.0 |
| FR-BMS-3 | Operators SHALL be able to author new flows scoped to a category, type, or asset usage. | M | v1.0 |
| FR-BMS-4 | The engine SHALL orchestrate steps by issuing commands and reacting to events, with retries and timeouts. | M | Beta |
| FR-BMS-5 | Flows SHALL support human-in-the-loop steps (approval, task assignment). | M | Beta |
| FR-BMS-6 | The system SHALL show each asset's current position in its flow. | S | v1.0 |
| FR-BMS-7 | Studio SHALL provide a **visual, drag-and-drop workflow designer** to author and edit flows — placing and connecting steps on a canvas — that reads and writes the same versioned [workflow definition](#workflow) the engine executes (no code/deploy). | M | v1.0 |
| FR-BMS-8 | The designer SHALL offer a **palette of step types**: service **actions** (transcode, move, publish, …), **human tasks** (assign to user/role, approval/review), **timers/waits**, **conditions/branches**, **parallel** splits/joins, and **sub-flows**. | M | v1.0 |
| FR-BMS-9 | A flow SHALL be **validated** (reachability, unbound references, type-correct connections) and produce a **new immutable version on publish**; running instances stay pinned to their version. | M | v1.0 |
| FR-BMS-10 | Workflow definitions SHALL be **losslessly exportable/importable as BPMN 2.0** — including diagram layout — for interoperability with standard BPMN tools; engine-specific policies (retry/timeout/SLA, data mapping) MAY be carried in BPMN **extension elements**. | S | v1.0 |

## Review, Approval & Tasks {#approval}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-APP-1 | A permitted user SHALL review content and create a task for another user by assigning the media to them. | M | Beta |
| FR-APP-2 | Media SHALL require **manual human approval** before it is broadcast-usable. An approval MAY carry an expiry (per FR-APP-7); with none it is permanent. | M | Beta |
| FR-APP-3 | Rejected media SHALL be either discarded or replaced by an updated version (metadata cloned, new ID). | M | Beta |
| FR-APP-4 | Replacement media MAY be a new upload or Studio editor output. | M | Beta → v1.0 |
| FR-APP-5 | Review/approval steps MAY occur at **multiple points** in a flow (e.g. post-ingest QC, post-edit, pre-schedule, rights re-check), placed as [BMS](#workflow) human-in-the-loop steps. Each SHALL resolve to a recorded verdict, and verdict **history SHALL be retained** for audit. | M | Beta |
| FR-APP-6 | Approval and rejection SHALL be **manual human decisions**. AI MAY surface advisory flags for the reviewer but SHALL NOT auto-approve or auto-reject. | M | Beta |
| FR-APP-7 | Each media SHALL have an **expiry date** after which it becomes **unusable** (not broadcast-usable) and requires **re-review**. The default expiry SHALL be inherited from the media's category (nearest ancestor, per FR-TAX-7) and MAY be overridden per media; media with no applicable expiry is permanent. | M | Beta |
| FR-APP-8 | Rejected media SHALL be **retained for a configured period** and then **purged** (unless replaced first), releasing its bytes ([HSM](#hsm)). | M | Beta |

## Scheduling {#scheduling}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-SCH-1 | Permitted users SHALL create and edit broadcast/stream program tables per channel. | M | MVP (basic) → v1.0 (full) |
| FR-SCH-2 | The system SHALL provide schedule validation (gaps/overlaps, fixed anchors, rendition availability) as an **explicit, on-demand** operation — in the editor and as a pre-flight before send-to-air — **not** as a per-write gate ([FR-SCH-9](#scheduling)). | S | Beta |
| FR-SCH-3 | Only **currently-valid** approved media (approved **and not expired**, per FR-APP-7) SHALL be schedulable for air; expiry falling between scheduling and send-to-air SHALL block the affected item at export. | M | Beta |
| FR-SCH-4 | Sending part or all of a schedule to the control room SHALL copy high-res files and the playlist to a configured network destination. | M | Beta |
| FR-SCH-5 | The exported playlist SHALL use a **standard format consumable by third-party playout software**; the first target is **Cinegy Air MCRList** ([spec](../integrations/14-playout-mcrlist-format.md)) and the exporter SHALL be pluggable for other formats. | M | Beta |
| FR-SCH-5a | On export, media `src_path` values SHALL resolve on the **playout host** (control-room path rewrite), and only **approved** renditions SHALL be referenced. | M | Beta |
| FR-SCH-6 | Schedules SHALL respect channel time zone and local calendar. | M | v1.0 |
| FR-SCH-7 | Directly driving playout/CG hardware (a "channel-in-the-box") is out of scope; Atlas integrates with external playout ([D1](../01-technical-brief.md#9-resolved-decisions)). | W | Post |
| FR-SCH-8 | Scheduling SHALL surface each asset's **broadcast history** — derived from the media's **placement count in schedules** — and SHALL **warn** (advisory, in the editor) when a placement would exceed the asset's **allowed broadcast count** ([FR-MAM-9](#mam)). The `repeat` flag is informational, not the counting mechanism. | S | Beta → v1.0 |
| FR-SCH-9 | A schedule SHALL be a **reel** — an ordered sequence of items each with a start and duration, the next beginning where the previous ends. The **schedule editor SHALL prevent the user from saving overlaps** and SHALL flag **gaps** (gaps are legitimate and SHALL NOT be blocked). The **backend SHALL NOT hard-block** overlaps or gaps — it persists what it is given, keeping the write path thin; validation is **on-demand** (FR-SCH-2), not per-write. | M | MVP (model) → Beta (editor) |
| FR-SCH-10 | Items MAY be **fixed** (time-locked anchors, e.g. a title at 10:00 sharp). The editor SHALL **reflow** surrounding non-fixed items — anchors bound the reflow window — and SHALL surface any change that would push an item over an anchor or open a gap before it. | M | Beta |
| FR-SCH-11 | A schedule item MAY play **part of a media** via **in/out points**, applied by the playout software at air. | S | Beta |
| FR-SCH-12 | **Live** items SHALL have no media reference and MAY carry a **sub-schedule** of items played during the live block. Nesting SHALL be limited to **exactly one level** (a sub-schedule item cannot itself be live-with-children). | S | Beta → v1.0 |
| FR-SCH-13 | Users SHALL be able to **copy part or all of one date's schedule to another date** at a target time offset, choosing to **merge** into or **overwrite** the destination range. | S | Beta |
| FR-SCH-14 | Schedule items SHALL carry control-room fields: **category and media titles defaulted from the source but overridable**, episode, free-text **description/notes**, and **repeat** and **featured** flags. | S | Beta |

## Media Editor {#editor}

The editor is **basic-NLE across video, audio, and image** ([D3](../01-technical-brief.md#9-resolved-decisions),
[Brief §4.10](../01-technical-brief.md#410-media-editor-scope)) — not a full NLE.

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-EDT-1 | The editor SHALL load a list of media and show a preview. | S | Beta |
| FR-EDT-2 | Editor output SHALL be rendered **server-side** and appear on the Import page as a new asset version. | S | Beta |
| **Video** | | | |
| FR-EDT-3 | The editor SHALL apply trim/cut and merge to video. | S | Beta |
| FR-EDT-4 | The editor SHALL add **static and animated titles** to video. | S | Beta |
| FR-EDT-5 | The editor SHALL add **logo/graphic overlays** to video. | S | Beta |
| **Audio** | | | |
| FR-EDT-6 | The editor SHALL edit standalone **audio** files (trim, join, level). | S | Beta |
| FR-EDT-7 | The editor SHALL **add, replace, and fade** audio on video. | S | Beta |
| **Image** | | | |
| FR-EDT-8 | The editor SHALL **crop and resize** images. | S | Beta |
| FR-EDT-9 | The editor SHALL support simple **layer compositing** for images. | C | v1.0 |
| **Boundary** | | | |
| FR-EDT-10 | Craft post-production — colour grading, VFX/compositing, sound design, audio mastering — is out of scope; Atlas integrates with those tools ([lifecycle §4](../strategy/19-production-lifecycle-scope.md#4-post-production)). | W | Post |

### Project-based web editor (v2.0) {#editor-v2}

The [lifecycle expansion](../strategy/19-production-lifecycle-scope.md#4-post-production)
upgrades the editor from one-shot operations to a **persistent, reopenable project** with
desktop-NLE interchange. Owned by the [Editorial service](../architecture/services/editorial.md).
**This is the expansion's largest single commitment and is deliberately v2.0** — it must not
enlarge the v1.0 editor above.

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-EDT-11 | Editing work SHALL be persisted as a **project** that users can save, reopen, and continue in a later session. | M | v2.0 |
| FR-EDT-12 | A project's timeline SHALL be stored in an **OpenTimelineIO-compatible model**, so interchange is an adapter at the boundary rather than a late translation layer. | M | v2.0 |
| FR-EDT-13 | The editor SHALL provide **frame-accurate browser playback** of a multi-clip timeline, served by **scrub-optimised proxy renditions** (segmented, keyframe-dense). | M | v2.0 |
| FR-EDT-14 | Projects SHALL be **versioned**, and concurrent editing SHALL be prevented by an explicit **lock** (never last-write-wins on a timeline). | M | v2.0 |
| FR-EDT-15 | Rendering a project SHALL be **server-side** via [MTS](../architecture/services/mts.md), producing a master that enters the platform as a normal asset version. | M | v2.0 |
| FR-EDT-16 | The system SHALL **export** a project as **OTIO, AAF, FCPXML, and EDL (CMX3600)** for use in desktop NLEs. | M | v2.0 |
| FR-EDT-17 | The system SHALL **import** OTIO, AAF, FCPXML, and EDL into a new project. | S | v2.0 |
| FR-EDT-18 | Every interchange operation SHALL produce a **fidelity report** stating what was not carried across (effects, plugins, grades). | M | v2.0 |
| FR-EDT-19 | Reading or writing **native project files** (`.prproj`, `.aep`, `.drp`) is **out of scope** — they are proprietary and undocumented; interchange uses FR-EDT-16/17 formats. | W | — |
| FR-EDT-20 | The editor SHALL support **review of cuts** with frame-accurate, resolvable comments against a project version. | S | v2.0 |

## Planning & Resource Scheduling {#planning}

Pre-production planning and the booking of people, facilities, and equipment. Owned by the
[Planning service](../architecture/services/planning.md). **Distinct from broadcast
[Scheduling](#scheduling)** — see the
[naming warning](../strategy/19-production-lifecycle-scope.md#21-two-different-things-called-scheduling).
News planning lands earlier than the general case.

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-PLN-1 | The system SHALL support **projects/productions** as a scope that planning, media, and workflow attach to. | M | v2.0 (`projectId` reserved in v1.0) |
| FR-PLN-2 | The system SHALL support **planning items** (stories, events, programmes) with intended date, status, and coverage notes. | M | v1.0 (news) → v2.0 (general) |
| FR-PLN-3 | Users SHALL create **assignments** against a planning item — assignee, role, brief, due date — delivered as tasks. | M | v1.0 (news) → v2.0 |
| FR-PLN-4 | The system SHALL maintain a **resource registry**: people, facilities, equipment, vehicles, rooms. | M | v2.0 |
| FR-PLN-5 | Users SHALL **book** resources against a time window, and the system SHALL **detect and prevent conflicting bookings** unless the resource permits shared use. | M | v2.0 |
| FR-PLN-6 | Bookings SHALL support a provisional **hold** that expires, distinct from a confirmed booking. | S | v2.0 |
| FR-PLN-7 | The system SHALL answer **availability** queries over a time window per resource/kind. | M | v2.0 |
| FR-PLN-8 | The system SHALL generate **call sheets** from planning and booking data. | S | v2.0 |
| FR-PLN-9 | The system SHALL support **script breakdown** — tagging cast, props, locations, and VFX elements — producing a requirement set that feeds resource booking. | S | v2.0 |
| FR-PLN-10 | The system SHALL support **shot lists** linked to planning items, and SHALL link captured footage back to shot-list entries. | S | v2.0 |
| FR-PLN-11 | The system SHALL track **estimated vs actual cost** per project against rate cards, and export to finance. Full accounting/ledger functionality is **out of scope**. | S | v2.0 |
| FR-PLN-12 | A planning item SHALL be **promotable to a broadcast schedule slot** before its media exists, and the slot SHALL be filled when an approved asset becomes available. | S | v2.0 |
| FR-PLN-13 | Staffing data SHALL be limited to availability and production role; **HR records, contracts, and payroll are out of scope** and integrated at the boundary. | M | v2.0 |

## Production Support {#production}

Atlas does **not** perform production (filming, directing, lighting, cinematography, sound
recording are ⚪ out of scope). It supports the **data-shaped activities around** the shoot —
where metadata is cheapest to capture
([lifecycle §3](../strategy/19-production-lifecycle-scope.md#3-production)).

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-PRD-1 | The system SHALL support **camera-card / rushes ingest** with offload verification and checksum, as an [RIM](../architecture/services/rim.md) source. | M | v1.0 |
| FR-PRD-2 | Users SHALL **log shots** against footage — good takes, descriptions, links to shot-list entries — at or shortly after capture. | S | v2.0 |
| FR-PRD-3 | The system SHALL support **dailies/rushes review** — proxy playback, comments, and approval — reusing the existing review and approval model. | S | v2.0 |
| FR-PRD-4 | The system SHALL support **field/remote contribution**: upload from location with low-bandwidth proxy handling. | S | v2.0 |
| FR-PRD-5 | The system SHOULD support **live-event run orders** (cue lists) for live shows, without extending into studio automation. | C | v2.0 |
| FR-PRD-6 | Studio/gallery hardware control (vision mixers, robotic cameras, tally, lighting) is **out of scope**; Atlas integrates via MOS at most. | W | — |

## Standards & Interoperability {#standards}

Conformance commitments from [Standards & FIMS](../integrations/20-standards-and-fims.md).

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-STD-1 | The Atlas data model SHALL have a **documented mapping to FIMS/EBUCore** (`BMContent` → Asset, `BMEssence` → Rendition/FileEntry) — FIMS conformance **level L1**. | M | v1.0 |
| FR-STD-2 | Assets SHALL carry an **external-identifier map** (`{scheme, value}`) so FIMS/IPTC/partner ids round-trip without a later migration. | M | v1.0 |
| FR-STD-3 | The system SHALL provide an optional **FIMS facade** exposing conformant Capture, Transfer, Transform, Repository, QA, and AME job interfaces mapped onto Atlas services — **level L2**. | S | v2.0 |
| FR-STD-4 | The FIMS facade SHALL also act as a **consumer**, allowing Atlas to drive third-party FIMS services — **level L3**. | S | v2.0 |
| FR-STD-5 | FIMS conformance of **internal** service-to-service traffic (level L4) is **not planned**; the internal backbone remains event-driven. | W | — |
| FR-STD-6 | Scheduling SHALL support **BXF (SMPTE ST 2021)** import/export for schedule and as-run exchange with traffic and program-management systems. | S | v1.0 |
| FR-STD-7 | Newsroom SHALL exchange news content using **IPTC NewsML-G2 / ninjs**. | S | v1.0 (news) |
| FR-STD-8 | Every standards adapter SHALL be an **optional deployment** that no core service depends on, preserving air-gapped operation ([FR-PLat-7](#platform)). | M | v1.0 |

## Newsroom {#newsroom}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-NRC-1 | The system SHALL support rundowns, stories, and scripts with media references. | S | v1.0 |
| FR-NRC-2 | Newsroom SHALL support assignment and status tracking of stories. | S | v1.0 |
| FR-NRC-3 | Newsroom SHOULD integrate with newsroom/playout devices (MOS-style). | C | Post |

## Notifications, Messaging & Inbox {#messaging}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-MSG-1 | Users SHALL have an inbox of incoming tasks and messages. | M | Beta |
| FR-MSG-2 | Users SHALL send, receive, and forward messages to users or groups. | M | Beta |
| FR-MSG-3 | The system SHALL raise notifications for relevant events (job done, approval needed, mention). | M | Beta |
| FR-MSG-4 | Notification delivery SHALL be live via WebSocket and MAY digest via email/push. | S | v1.0 |

## Integration & Feeds {#integration}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-INT-1 | Operators SHALL create and edit inbound import feeds using JSON or XML with field mapping. | S | Beta |
| FR-INT-2 | Operators SHALL create and edit customized output APIs/feeds for third-party applications. | S | v1.0 |
| FR-INT-3 | The system SHALL publish EPG data from schedules. | S | v1.0 |
| FR-INT-4 | The system SHOULD create and update HbbTV launchers. | C | v1.0 |
| FR-INT-5 | The system SHALL manage social media and website content publishing. | S | v1.0 |
| FR-INT-6 | **Categories** SHALL supply **EPG fields** (show-in-EPG, EPG title/description) used by EPG publishing (FR-INT-3). | S | v1.0 |
| FR-INT-7 | **Categories** SHALL define a **web/platform publishing profile** — web state (published/unpublished), **send trigger** (on-approval / on-broadcast / manual), publish window, web keep-duration, web category/title/summary/description, and **featured** — driving outbound web/social publishing (FR-INT-5). Media inherit the profile. | S | v1.0 |

## AI Enrichment {#ai}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-AI-1 | The system SHOULD derive metadata via AI (faces, cast, objects/logos, shots) at ingest. | S | v1.0 |
| FR-AI-2 | The system SHOULD generate speech-to-text/subtitles and language ID. | S | v1.0 |
| FR-AI-3 | AI outputs SHALL be presented as suggestions for human confirmation, not auto-applied to mandatory fields. | M | v1.0 |
| FR-AI-4 | AI enrichment SHALL never block the critical ingest/approval path on failure. | M | v1.0 |
| FR-AI-5 | AI SHALL be provided via a **provider-abstraction** supporting multiple back-ends (cloud/vendor and local). | M | v1.0 |
| FR-AI-6 | **Online (full) tier:** where internet is available, full enrichment SHALL run against cloud/vendor providers ([D4](../01-technical-brief.md#9-resolved-decisions)). This is the primary tier. | M | v1.0 |
| FR-AI-7 | **Offline (limited) tier:** air-gapped deployments MAY run a small local model for **suggestions and simple tasks only**; full-accuracy features MAY be unavailable offline. | S | Post (optional add-on) |
| FR-AI-8 | The platform SHALL be fully operable with AI **disabled** (no online provider and no local model). | M | Beta |
| FR-AI-9 | Face-matching SHALL operate only against the limited [people register](#people) and produce suggestions for confirmation. | M | v1.0 |

## Storage & Integrity (HSM) {#hsm}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-HSM-1 | The system SHALL manage assets across online, near-line, and offline tiers. | M | MVP (online) → v1.0 (near-line/offline automation) |
| FR-HSM-2 | The system SHALL change assets' online/offline status and perform copy/move/delete. | M | MVP |
| FR-HSM-3 | The system SHALL restore near-line/offline assets on demand and report restore ETAs. | S | v1.0 |
| FR-HSM-4 | The system SHALL verify checksums on ingest and via periodic integrity sweeps. | M | MVP (ingest) → v1.0 (sweeps) |
| FR-HSM-5 | Services SHALL perform file operations only through HSM (no direct storage access). | M | MVP |
| FR-HSM-6 | Media SHALL be **demoted from online** to near-line/offline once **used up** — its [`allowedBroadcastCount`](#mam) airings are done — or after its category **keep-duration** elapses post-use; a null/indefinite keep-duration keeps it online. This is tiering, **not deletion**; the asset stays restorable. | S | v1.0 |
| FR-HSM-7 | **Every file SHALL be recorded** with its **technical info** (container, codecs, duration, dimensions, bitrate, size) and a **system-generated integrity checksum**, plus its storage location, tier and status. A file SHALL belong to **exactly one asset** and SHALL NOT be shared between assets; an asset MAY have many files. | M | MVP |

## Studio (UI) {#studio}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-UI-1 | Studio SHALL be responsive, desktop- and tablet-first. | M | MVP |
| FR-UI-2 | Studio SHALL provide the main pages listed in the [Technical Brief §4.6](../01-technical-brief.md#46-studio). | M/S | phased per page |
| FR-UI-3 | Users SHALL personalize their workspace; layout (open tabs, editor groups, side-bar state, theme) SHALL persist server-side and restore at next login. | S | Beta |
| FR-UI-4 | Studio SHALL reflect live public/private changes without a manual refresh. | M | MVP |
| FR-UI-5 | Access to pages and actions SHALL be gated by the user's effective permissions. | M | MVP |
| FR-UI-6 | Studio SHALL use a **workbench shell** ([Studio Front-End](../architecture/studio-frontend.md)): an **activity bar** of icons, each opening a **panel** whose **views** are collapsible sub-panels. | M | MVP → Beta (full panel set) |
| FR-UI-7 | Users SHALL open **multiple items of varying types** (asset, schedule, workflow, tag, diff, dashboard, …) as **tabs** in a splittable editor area. | M | MVP (tabs) → Beta (splits) |
| FR-UI-8 | A bottom **status bar** SHALL show system health, current channel, live-sync state, background-job summary, notifications, and the current user. | S | Beta |
| FR-UI-9 | Background **transfers (uploads/downloads)** SHALL surface as a **grouped, minimizable tray** (bottom-corner), with per-item progress/retry. | S | Beta |
| FR-UI-10 | Studio SHALL offer **light, dark, and high-contrast** themes (per-user, "follow OS"), plus operator/per-tenant brand theming ([FR-PLat-3](#platform)), via design tokens. | S | MVP (light/dark) → v1.0 (HC/brand) |
| FR-UI-11 | Studio SHALL provide a customizable **dashboard**: (a) system-state charts/tables of asset counts by lifecycle state and throughput; (b) a "what's new" feed (new media/categories/tags/people, schedule changes); (c) the user's inbox (tasks, messages); (d) the user's notifications (changes to owned assets, approvals/expiries, mentions). | M (basic) → S (full) | MVP → Beta |
| FR-UI-12 | On login after a **version rollout**, Studio SHALL show a **Welcome / What's New** view (new features + fixes since the user last saw it), dismissible per version and re-openable from Help. | C | v1.0 |
| FR-UI-13 | Item editing SHALL be gated **per field group** by the user's effective permissions — fields the user may not edit render **read-only** ([data model](../architecture/data-model.md#field-level-permissioning)); the owning service re-enforces. | M | Beta |

## Logging & Analytics {#analytics}

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-LOG-1 | The system SHALL retain all action/audit logs server-side (append-only). | M | MVP |
| FR-LOG-2 | Log visibility SHALL be permission-filtered ("some logs visible to some users, all retained"). | M | Beta |
| FR-LOG-3 | The system SHALL provide analytics/statistics reports and charts. | S | v1.0 |

## Audit, History & Diff {#audit}

"Log/diff everything": every change is recorded, and any mutable item exposes a visual history.

| ID | Requirement | Pri | Release |
|----|-------------|:---:|:-------:|
| FR-AUD-1 | **Every mutating action** (create/update/delete, lifecycle transition, permission change, schedule edit, …) SHALL be recorded with **who** (actor), **when**, **where** (origin/service/action), and the **change** (before → after). | M | MVP |
| FR-AUD-2 | The system SHALL maintain a **per-entity change history** for every versionable entity — asset core + extensible metadata, tags/categories/subjects, people, a schedule (per channel/date), workflow definitions, feeds, permissions. | M | Beta |
| FR-AUD-3 | Studio SHALL provide a **history/diff viewer** for any such entity — a **revision timeline** with a **git-diff-style**, field-level (mostly text) visualization of each change (added/removed/changed, before → after); structured fields diff key-by-key, long text diffs line-by-line. | S | Beta |
| FR-AUD-4 | Audit records SHALL be **append-only and permission-filtered** for viewing ([FR-LOG-1/2](#analytics)); the full record is always retained. | M | MVP → Beta |
| FR-AUD-5 | A history entry SHALL **link to the item and revision** so it opens directly from the audit log and the dashboard "what's new" feed ([FR-UI-11](#studio)). | S | Beta |

---

## Traceability

Every requirement maps to at least one service ([Service Catalog](../architecture/03-service-catalog.md))
and one roadmap phase ([Roadmap](../roadmap/08-roadmap.md)). Acceptance tests are derived per
requirement; see [NFR §Verification](06-non-functional-requirements.md#verification) for the
method. A living traceability matrix (requirement → service → test → release) should be kept
in the project tracker, seeded from this document.

---
_Next: [Non-Functional Requirements](06-non-functional-requirements.md)._
