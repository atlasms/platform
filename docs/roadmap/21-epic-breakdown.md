# Epic Breakdown — epics, stories & tasks

> The delivery backlog: **46 epics** across the five phases, decomposed into stories. This is the
> source the GitHub backlog is generated from. *How* the team works with it:
> [Delivery Process](20-delivery-process.md). *What* each service is:
> [service specs](../architecture/services/); *how to build one*:
> [per-service plans](services/README.md).

## How to read this

```
Phase (roadmap milestone)  →  Epic (EP-nn)  →  Story (EP-nn.s)  →  Task (in GitHub only)
   Project field "Phase"       issue type Epic    sub-issue           sub-issue
```

- **Epic IDs are stable.** Never renumber; deprecate instead (same rule as `FR-*` ids).
- **Story estimates** use 1/2/3/5/8. Anything over 8 must be split before it is pulled.
- **Tasks are not enumerated here** — they are created in GitHub when a story is refined, because
  task-level division of labour is a decision for the iteration, not the plan.
- **Decomposition depth is deliberate**: Phases 0–1 are fully storied (that is the work being
  loaded now); Phases 2–GA list epics with story headlines and are refined one phase ahead. Planning
  detail more than ~2 phases out is waste — it will change.

**Legend:** `⚑` = on the critical path · `◆` = correctness-critical (2 reviewers + pairing,
[DoD](20-delivery-process.md#7-definition-of-done)) · `⟳` = has a preceding spike.

## Epic index

| # | Epic | Phase | Service | Depends on |
|---|------|:-----:|---------|-----------|
| **EP-01** | Monorepo, CI/CD & environments | 0 | shared | — |
| **EP-02** | `contracts` — shared types & validation ⚑ | 0 | shared | EP-01 |
| **EP-03** | `messaging` — broker client, outbox, idempotency ⚑ | 0 | shared | EP-02 ⟳ |
| **EP-04** | `service-kit` — the service template ⚑ | 0 | shared | EP-02 |
| **EP-05** | `policy` — authorization evaluator ◆ | 0 | shared | EP-02 |
| **EP-06** | `reference` — config & reference data | 0 | shared | EP-02 |
| **EP-07** | `data` — store clients, migrations, outbox table | 0 | shared | EP-01 |
| **EP-08** | API Gateway / BFF v0 ⚑ | 0 | gateway | EP-04 |
| **EP-09** | WebSocket service v0 | 0 | websocket | EP-03, EP-04 |
| **EP-10** | IAM v0 — login, JWT, users/roles ⚑ | 0 | iam | EP-04, EP-05, EP-07 |
| **EP-11** | Studio shell (Angular) | 0 | studio | EP-08, EP-10 |
| **EP-12** | Observability baseline | 0 | shared | EP-04 |
| **EP-13** | Walking skeleton — "hello asset" ⚑ | 0 | shared | EP-08…EP-12 |
| **EP-14** | HSM v1 — online tier, file ops, checksum ⚑◆ | 1 | hsm | EP-04, EP-07 |
| **EP-15** | RIM v1 — upload, watch, acceptance ⚑ | 1 | rim | EP-14 |
| **EP-16** | MTS v1 — transcode to proxy/thumb/broadcast ⚑ | 1 | mts | EP-14, EP-03 |
| **EP-17** | MAM v1 — core metadata, tags, search ⚑ | 1 | mam | EP-07, EP-03 |
| **EP-18** | Scheduling v0 — program-table CRUD | 1 | scheduling | EP-17 |
| **EP-19** | Logging v1 — append-only audit | 1 | logging | EP-03 |
| **EP-20** | Studio MVP pages | 1 | studio | EP-11, EP-17 |
| **EP-21** | MVP hardening & pilot readiness | 1 | shared | EP-14…EP-20 |
| **EP-22** | BMS v1 — engine & preset flows | 2 | bms | EP-03, EP-17 ⟳ |
| **EP-23** | BMS workflow designer (DSL ⇄ BPMN, canvas) | 2 | bms/studio | EP-22 |
| **EP-24** | Review, approval, expiry & retention | 2 | mam/bms | EP-22 |
| **EP-25** | Notifications & Messaging v1 | 2 | notifications | EP-09 |
| **EP-26** | Media Editor v1 (basic-NLE) | 2 | studio/mam/mts | EP-16, EP-17 |
| **EP-27** | MAM v2 — advanced search, shot-list, schema editor | 2 | mam | EP-17 |
| **EP-28** | Classification & discovery — taxonomy, people, facets | 2 | mam | EP-17 |
| **EP-29** | MTS v2 — autoscale, filmstrip, per-channel profiles | 2 | mts | EP-16 |
| **EP-30** | Multi-channel isolation, theming & i18n | 2 | shared/studio | EP-10, EP-11 |
| **EP-31** | Scheduling v1 — validation, send-to-air, MCRList ⚑◆ | 2 | scheduling/hsm | EP-18, EP-14 |
| **EP-32** | Integration — inbound feeds | 2 | integration | EP-17 |
| **EP-33** | Configuration & reference-data admin | 2 | shared/studio | EP-06 |
| **EP-34** | BMS v2 — authoring, duplication, flow visibility | 3 | bms | EP-23 |
| **EP-35** | AI Enrichment | 3 | ai | EP-17, EP-28 |
| **EP-36** | HSM v2 — near-line/offline tiering, restore, sweeps ◆ | 3 | hsm | EP-14 |
| **EP-37** | Integration — outbound APIs, EPG, HbbTV, social | 3 | integration | EP-32, EP-31 |
| **EP-38** | Newsroom — rundowns, stories, scripts | 3 | newsroom | EP-17, EP-25 |
| **EP-39** | RIM v2 — stream recording & segmentation | 3 | rim | EP-15 |
| **EP-40** | IAM v2 — SSO (OIDC/SAML), MFA | 3 | iam | EP-10 |
| **EP-41** | Analytics — reports, charts, permission-filtered logs | 3 | logging | EP-19 |
| **EP-42** | HA across the critical path | 3 | shared | EP-21 |
| **EP-43** | Performance & capacity validation | GA | shared | EP-42 |
| **EP-44** | Security hardening & external pen test | GA | shared | EP-42 |
| **EP-45** | Accessibility & i18n/RTL QA | GA | studio | EP-30 |
| **EP-46** | Ops docs, DR drills & GA sign-off | GA | shared | EP-43, EP-44 |

---

# Phase 0 — Foundations (S01–S03)

**Exit:** a trivial asset can be created through the gateway, stored, and its change pushed live to
Studio — the whole spine proven end-to-end.

> Four of these libraries already exist as **tested reference implementations** in
> [`reference/`](../../reference/README.md) (84 passing tests). Those stories are *lift, harden and
> productionize*, not *design from scratch* — estimates reflect that.

## EP-01 — Monorepo, CI/CD & environments

**Goal:** every later story lands on rails rather than scaffolding.

| ID | Story | Est |
|----|-------|:---:|
| 01.1 | Nx/Turborepo monorepo, strict TS config, one lint/format/test setup | 3 |
| 01.2 | CI pipeline: install → lint → typecheck → test → build, per-package caching | 3 |
| 01.3 | **Consumer-fanout CI** — changing a shared lib runs all dependents' tests | 3 |
| 01.4 | Container build per deployable + image publish to the registry | 3 |
| 01.5 | IaC for dev + staging; environment templates | 5 |
| 01.6 | Branch protection, PR template, CODEOWNERS, conventional commits | 2 |
| 01.7 | **Offline/air-gapped bundle skeleton** — build artifacts with no external pulls | 3 |

**DoD:** a trivial change flows commit → CI → image → dev environment automatically.
**Refs:** [plan §3.1](16-system-implementation-plan.md#31-monorepo--shared-libraries),
[FR-PLat-7](../requirements/05-functional-requirements.md#platform)

## EP-02 — `contracts` ⚑

**Goal:** the single source of cross-service truth, before any service is written.

| ID | Story | Est |
|----|-------|:---:|
| 02.1 | Lift [`reference/contracts`](../../reference/contracts/README.md); package + publish internally | 2 |
| 02.2 | Envelope build/validate + payload validator for **all 53 event schemas** | 5 |
| 02.3 | Generate TypeScript types from JSON Schema in CI; fail on drift | 3 |
| 02.4 | Generate API clients from the [OpenAPI stubs](../architecture/openapi/) | 3 |
| 02.5 | Tier-0 enum export + a CI check that no Tier-1/2 list is schema-`enum`'d | 2 |
| 02.6 | Semantic versioning + changelog discipline for the package | 2 |

**DoD:** a service and Studio both compile against generated types; a schema change breaks CI loudly.
**Refs:** [schemas](../architecture/schemas/README.md), [config §2.1](../architecture/configuration-and-reference-data.md#21-tier-0--contract-enums-frozen)

## EP-03 — `messaging` ⚑ ⟳

| ID | Story | Est |
|----|-------|:---:|
| 03.0 | ~~**Spike:** NATS JetStream vs RabbitMQ under a load-spike test~~ → [ADR-0001](../adr/0001-message-broker.md): **NATS JetStream** | — |
| 03.1 | Lift [`reference/messaging`](../../reference/messaging/README.md) onto the chosen broker | 5 |
| 03.2 | Publish-with-outbox; **atomic** state-change ⇒ event | 5 |
| 03.3 | Subscribe-with-idempotency; `SeenStore` with atomic `SET NX`/`INSERT … ON CONFLICT` ◆ | 3 |
| 03.4 | Retry, backoff, DLQ + a DLQ inspection/replay tool | 3 |
| 03.5 | Correlation/causation propagation through the async context | 3 |
| 03.6 | In-memory broker for tests + dev | 2 |
| 03.7 | Pipeline `OutboxRelay.drain()` — bounded in-flight publishes, preserving per-subject order *(from [ADR-0001](../adr/0001-message-broker.md); ~10× measured headroom)* | 3 |

**DoD:** an outbox write and its publish are proven atomic under an induced rollback; duplicate
delivery is provably safe.
**Refs:** [messaging §1.2](../architecture/04-messaging-and-data.md#12-delivery-guarantees--idempotency)

## EP-04 — `service-kit` ⚑

| ID | Story | Est |
|----|-------|:---:|
| 04.1 | Lift [`reference/service-kit`](../../reference/service-kit/README.md) | 2 |
| 04.2 | Health `/healthz` + readiness `/readyz` with dependency checks | 2 |
| 04.3 | Structured logging + correlation context | 3 |
| 04.4 | Config load/validate (**bootstrap only** — env/secrets, not reference data) | 2 |
| 04.5 | JWT/JWKS auth middleware + `permVersion` staleness rejection | 3 |
| 04.6 | Error taxonomy → RFC-9457 problem responses | 2 |
| 04.7 | OpenTelemetry tracing + graceful shutdown | 3 |
| 04.8 | `GET /reference` snapshot endpoint baked into the template | 3 |
| 04.9 | **Service generator** — `nx g service <name>` scaffolds a compliant service | 3 |

**DoD:** a generated empty service passes health, auth, tracing and smoke checks unmodified.

## EP-05 — `policy` ◆

| ID | Story | Est |
|----|-------|:---:|
| 05.1 | `can()` evaluator — permissions, wildcards, scope predicates | 5 |
| 05.2 | Field-group semantics; union of matching grants | 3 |
| 05.3 | `compile()` — user + groups + roles → flat effective policy | 3 |
| 05.4 | Category-subtree matching on the materialized path | 2 |
| 05.5 | **Cross-target contract tests** — identical decisions in Node and browser builds | 3 |
| 05.6 | Zero runtime deps + browser bundle-size guard in CI | 2 |

**DoD:** a table of (policy, permission, context) → decision passes identically on both targets.
**Refs:** [authorization model](../architecture/authorization-model.md)

## EP-06 — `reference`

| ID | Story | Est |
|----|-------|:---:|
| 06.1 | Descriptor types + `defineSettings()` registry | 3 |
| 06.2 | Validation from descriptors (bounds/options/pattern), server **and** client | 3 |
| 06.3 | Nearest-wins resolution with **origin level** returned | 3 |
| 06.4 | Snapshot client — fetch, cache, ETag revalidate, `config.changed` invalidation | 3 |
| 06.5 | Registry-entry guard: reject unknown `kind` (the Tier-1 safety property) ◆ | 2 |
| 06.6 | Seed loader — idempotent apply from version-controlled files | 3 |

**Refs:** [configuration & reference data](../architecture/configuration-and-reference-data.md)

## EP-07 — `data`

| ID | Story | Est |
|----|-------|:---:|
| 07.1 | Lift [`reference/data`](../../reference/data/README.md); map to `pg`/Prisma | 3 |
| 07.2 | Migration runner + conventions; expand→migrate→contract discipline | 3 |
| 07.3 | `withTransaction` + the SQL-backed outbox table | 3 |
| 07.4 | Mongo, Redis, OpenSearch clients with health checks | 3 |
| 07.5 | Provision the data plane in dev/staging via IaC | 3 |
| 07.6 | Per-service schema ownership + `channelId` conventions enforced in review | 2 |

## EP-08 — API Gateway / BFF v0 ⚑

| ID | Story | Est |
|----|-------|:---:|
| 08.1 | Fastify edge: routing, proxy to services, TLS termination | 3 |
| 08.2 | JWT authentication via JWKS; reject stale `permVersion` | 3 |
| 08.3 | Rate limiting + request-size limits | 2 |
| 08.4 | Correlation-id issuance and propagation | 2 |
| 08.5 | Aggregated `GET /reference` snapshot across services (ETag) | 3 |
| 08.6 | Access logging → `gateway.access.logged` (sampled) | 2 |

## EP-09 — WebSocket service v0

| ID | Story | Est |
|----|-------|:---:|
| 09.1 | Fastify + ws server; auth handshake | 3 |
| 09.2 | Public + private channel subscription, **permission-aware fan-out** ◆ | 5 |
| 09.3 | Broker → socket bridge | 3 |
| 09.4 | Reconnect/backoff + Studio polling fallback (NFR-AVAIL-7) | 3 |

## EP-10 — IAM v0 ⚑

| ID | Story | Est |
|----|-------|:---:|
| 10.1 | User/Credential entities; argon2id hashing ◆ | 3 |
| 10.2 | `POST /auth/login`, `/refresh`, `/logout`; rotating refresh-token family ◆ | 5 |
| 10.3 | JWKS endpoint + key rotation | 3 |
| 10.4 | Groups, roles, rules, assignments CRUD | 5 |
| 10.5 | `GET /users/me/effective-permissions` compiled per `permVersion` | 3 |
| 10.6 | `permissions.changed` / `group.membership.changed` emission | 2 |
| 10.7 | Seed the [starter roles](../architecture/authorization-model.md#9-starter-roles) | 2 |
| 10.8 | `LoginEvent` audit trail (lastLogin/lastIp) | 2 |

## EP-11 — Studio shell (Angular)

| ID | Story | Est |
|----|-------|:---:|
| 11.1 | Angular app skeleton, routing, build pipeline | 3 |
| 11.2 | Auth flow (login, token refresh, guarded routes) | 3 |
| 11.3 | **VS Code-style workbench**: activity bar, primary side bar, editor area, status bar | 8 |
| 11.4 | WebSocket client + live-update plumbing | 3 |
| 11.5 | Generated API clients wired from `contracts` | 2 |
| 11.6 | i18n/RTL scaffolding + design tokens (light/dark) | 5 |
| 11.7 | `can()` integration — permission-driven rendering | 3 |

**Refs:** [Studio front-end](../architecture/studio-frontend.md)

## EP-12 — Observability baseline

| ID | Story | Est |
|----|-------|:---:|
| 12.1 | Log aggregation + retention for all services | 3 |
| 12.2 | Metrics store + per-service golden-signal dashboards | 3 |
| 12.3 | Distributed tracing collector | 3 |
| 12.4 | Alert routing skeleton (`alert.raised` → channel) | 2 |

## EP-13 — Walking skeleton ⚑

| ID | Story | Est |
|----|-------|:---:|
| 13.1 | Minimal asset create through gateway → service → Postgres | 3 |
| 13.2 | Outbox → broker → consumer → WebSocket → Studio live update | 3 |
| 13.3 | **One end-to-end trace** spanning gateway → service → broker → consumer | 3 |
| 13.4 | Smoke suite automated in CI against dev | 3 |

**DoD = Phase 0 exit criteria.** This epic *is* the phase gate.

---

# Phase 1 — Ingest-to-Schedule spine → MVP (S04–S11)

**Exit:** on one channel — upload → validate → transcode (proxy+broadcast+thumbnail) → metadata →
search → schedule, every step audited and live-updated.

## EP-14 — HSM v1 ⚑◆

| ID | Story | Est |
|----|-------|:---:|
| 14.1 | File ledger schema — the [File record](../architecture/schemas/file.schema.json) as SoR | 5 |
| 14.2 | Storage targets + credential handling (**only HSM holds storage creds**) ◆ | 3 |
| 14.3 | Place/copy/move/delete on the online tier, streamed ◆ | 8 |
| 14.4 | Streaming checksum on placement; `file.placed` emission ◆ | 5 |
| 14.5 | Operation queue + workers with progress and resume | 5 |
| 14.6 | `GET /assets/{id}/location`; `POST /files/operations` (service-only) | 3 |
| 14.7 | Enforce **all file ops via HSM** (no other service touches storage) | 2 |

**Refs:** [HSM spec](../architecture/services/hsm.md), [FR-HSM-1,2,4,5](../requirements/05-functional-requirements.md#hsm)

## EP-15 — RIM v1 ⚑

| ID | Story | Est |
|----|-------|:---:|
| 15.1 | Chunked/resumable upload endpoint | 5 |
| 15.2 | Folder watcher (singleton per source) | 5 |
| 15.3 | Acceptance-rule engine — container/size/aspect; accept/quarantine/reject | 5 |
| 15.4 | ffprobe technical-metadata extraction | 3 |
| 15.5 | `ingest.detected/accepted/rejected` emission | 2 |
| 15.6 | Ingest queue + quarantine review API | 3 |

## EP-16 — MTS v1 ⚑

| ID | Story | Est |
|----|-------|:---:|
| 16.1 | Job queue consumer for `transcode.job.create` | 3 |
| 16.2 | FFmpeg subprocess orchestration with cancellation | 5 |
| 16.3 | Default rendition set: proxy, broadcast, thumbnail | 5 |
| 16.4 | Progress parsing → `transcode.progress` (best-effort) | 3 |
| 16.5 | `transcode.completed` with per-output checksums; `transcode.failed` | 3 |
| 16.6 | Profile registry (Tier-1); manual multi-instance scaling | 3 |

## EP-17 — MAM v1 ⚑

| ID | Story | Est |
|----|-------|:---:|
| 17.1 | Asset core schema + lifecycle states | 5 |
| 17.2 | `AssetExtended` document store + FieldSchema v1 | 5 |
| 17.3 | Free-form tags + `AssetTag` join | 3 |
| 17.4 | Simple search indexing + query | 5 |
| 17.5 | Mandatory-metadata gate before `asset.ready` | 3 |
| 17.6 | Asset lifecycle events (`created/updated/ready`) via outbox | 3 |
| 17.7 | Read cache for hot assets | 3 |
| 17.8 | **FileRef** mirror of the HSM ledger; consume `file.placed`/`transcode.completed` | 3 |

## EP-18 — Scheduling v0

| ID | Story | Est |
|----|-------|:---:|
| 18.1 | Schedule + ScheduleItem schema (the **reel** model) | 5 |
| 18.2 | Program-table CRUD per channel | 5 |
| 18.3 | `schedule.updated` emission | 2 |
| 18.4 | Materialized item starts; thin write path (**no per-write overlap/gap blocking**) | 3 |

**Refs:** [FR-SCH-9](../requirements/05-functional-requirements.md#scheduling) — validation is
on-demand, deliberately not a write gate.

## EP-19 — Logging v1

| ID | Story | Est |
|----|-------|:---:|
| 19.1 | Audit sink consuming all events; append-only store | 5 |
| 19.2 | Audit-event contract with field-level `delta` at write time | 3 |
| 19.3 | `GET /logs` + query API, permission-filtered | 3 |
| 19.4 | Retention + cold-storage tiering | 3 |

## EP-20 — Studio MVP pages

| ID | Story | Est |
|----|-------|:---:|
| 20.1 | Media panel — browse tree, recent, filters | 5 |
| 20.2 | **Asset editor** — Basic info + Files tabs, permission-gated fields | 8 |
| 20.3 | Ingest/Import panel — queue, upload, quarantine | 5 |
| 20.4 | Search — simple query + results | 3 |
| 20.5 | Schedule editor v0 — reel view, add/move/remove | 8 |
| 20.6 | Dashboard (basic) — system state, new items | 5 |
| 20.7 | User management (basic) | 3 |
| 20.8 | Transfer tray — grouped upload/download progress | 3 |
| 20.9 | Live updates wired to WebSocket across panels | 3 |

## EP-21 — MVP hardening & pilot readiness

| ID | Story | Est |
|----|-------|:---:|
| 21.1 | End-to-end MVP acceptance test (upload → schedule) automated | 5 |
| 21.2 | Deploy to the [minimum viable footprint](../requirements/07-hardware-requirements.md#9-minimum-viable-footprint-for-the-mvp-milestone) | 3 |
| 21.3 | **Install + first restore drill** rehearsed ([runbook](../operations/17-operations-runbook.md)) | 3 |
| 21.4 | Performance sanity against MVP-relevant NFRs | 3 |
| 21.5 | Pilot feedback loop + defect triage rhythm | 2 |

---

# Phase 2 — Workflow, approval & collaboration → Beta (S12–S19)

> Story headlines only; refined into full stories during Phase 1's final iterations.

| Epic | Story headlines |
|------|-----------------|
| **EP-22 BMS v1** ⟳ | *Spike: Temporal vs broker-saga (5 d)* · durable runtime · `Effects` boundary + pure interpreter · command/event adapters · human-step wait · canonical ingest-to-air preset · instance state API · timeout/retry/compensation |
| **EP-23 Workflow designer** | DSL validator · **DSL ⇄ BPMN lossless converter** (`bpmn-moddle` + `atlas:` extension) · Foblex Flow canvas · palette + property panel · FEEL expression editor · publish/version flow · import/export BPMN |
| **EP-24 Review & approval** | Review points at multiple workflow positions · manual approve/reject verdicts + retained history · category-inherited **expiry** → re-review · **rejected-retention** → purge scheduler · air-gating at export · verdict audit |
| **EP-25 Notifications** | Task entity + state machine · inbox + unread counts · user/group messaging · notification-type registry + templates · per-user preferences · WebSocket delivery · **task→BMS feedback** |
| **EP-26 Media Editor v1** | EditProject persistence · timeline UI (trim/arrange) · proxy scrubbing · transitions/filters · `editor.render.requested` → MTS · render-to-new-version · progress + failure handling |
| **EP-27 MAM v2** | Advanced faceted search · shot-list · metadata schema editor · auto-vs-manual field distinction · version chain + replace-with-clone |
| **EP-28 Classification** | Category tree + materialized path · **live per-field inheritance with override** · per-role cast inheritance · subjects/structures/classifications vocabularies · people register · faceted search across all axes |
| **EP-29 MTS v2** | Autoscale on queue depth (KEDA) · VTT filmstrip · hover preview · per-channel/per-type profiles |
| **EP-30 Multi-channel & theming** | Channel isolation end-to-end · per-tenant + per-user themes · i18n + **RTL** · workspace persistence |
| **EP-31 Scheduling v1** ◆ | On-demand validation (gaps/overlaps/rights/availability) · approved-and-not-expired gate · **MCRList serializer** (pluggable) · send-to-air export · **control-room path rewrite** ◆ · export verification |
| **EP-32 Integration inbound** | Inbound feed authoring · JSON/XML mapping templates · scheduling + retries · `feed.item.received` · delivery log |
| **EP-33 Config admin** | Generated settings UI from descriptors · vocabulary admin (deprecate/merge) · registry admin · seed export/import CLI · CI drift report |

---

# Phase 3 — Full-feature, integrations & HA → v1.0 (S20–S28)

| Epic | Story headlines |
|------|-----------------|
| **EP-34 BMS v2** | Author/duplicate/modify flows in Studio · per-category/type/usage flow selection · flow-position visibility on the asset · SLA timers |
| **EP-35 AI Enrichment** | Provider abstraction (online-first) · detection (objects/shots/scenes) · STT/subtitles · **face-matching against the people register** · suggestion queue (human-confirmed) · runs fully off the critical path |
| **EP-36 HSM v2** ◆ | Near-line + offline tiers · tier policies (age/usage/proximity) · restore with ETA · **integrity sweeps** · quarantine on mismatch · pre-restore for near-air media |
| **EP-37 Integration outbound** | Outbound API/feed authoring · EPG publish · HbbTV launchers · social/web publishing · delivery receipts |
| **EP-38 Newsroom** | Rundowns · stories + status flow · scripts with media refs · wires → story promotion · assignment · `rundown.ready` → Scheduling |
| **EP-39 RIM v2** | Stream/broadcast capture · segmentation (24 h → 1 h) · recorder scheduling · `recording.segment.completed` |
| **EP-40 IAM v2** | OIDC + SAML federation · MFA · service accounts |
| **EP-41 Analytics** | Reports (ingest volume, transcode throughput, restore times, user activity) · charts · permission-filtered log views · **change-history/diff read model + git-style viewer** |
| **EP-42 HA** | ≥2 replicas across the critical path · broker clustering · DB replication + failover · GPU transcoding · cloud burst |

---

# GA — Hardening (S29–S31)

| Epic | Story headlines |
|------|-----------------|
| **EP-43 Performance** | Load tests to [NFR targets](../requirements/06-non-functional-requirements.md#performance) · 2 h playlist export < 10 min · capacity validation · profiling + the HSM escape-hatch decision |
| **EP-44 Security** | External **pen test** + remediation · secret/credential audit · authorization test matrix · dependency/supply-chain scan |
| **EP-45 Accessibility & i18n** | WCAG 2.1 AA on core flows · full RTL QA · keyboard navigation · high-contrast theme |
| **EP-46 Ops & sign-off** | [Runbook](../operations/17-operations-runbook.md) rehearsed end-to-end · **failover/chaos drills for RTO/RPO** · air-gapped install rehearsal · admin + integration guides · **GA sign-off** |

---

## v2.0 horizon — deliberately excluded

The [production-lifecycle expansion](../strategy/19-production-lifecycle-scope.md) (pre-production
planning, production, post-production, the [Editorial service](../architecture/services/editorial.md),
NLE interchange) is **not** in this backlog. Keeping it out is what protects the v1.0 GA date; it
enters as a new epic set after GA. The three cheap in-v1.0 preparations are tracked in
[roadmap §v2](08-roadmap.md#v2).

## Traceability

Every story carries its `FR-*`/`NFR-*` id in the **Requirement** project field
([process §8.3](20-delivery-process.md#83-fields)). A requirement with no story by the end of its
owning phase is a planning defect — check with the
[traceability table](../requirements/05-functional-requirements.md#traceability) at each phase gate.

---
_Related: [Delivery Process](20-delivery-process.md) · [Roadmap](08-roadmap.md) ·
[Per-service plans](services/README.md) · [System Implementation Plan](16-system-implementation-plan.md)._
