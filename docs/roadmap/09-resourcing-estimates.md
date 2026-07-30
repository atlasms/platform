# Resourcing, Time & Cost

> Team shape, effort estimates, timeline, and budget scenarios to take Atlas from start to
> v1.0 GA. Parent: [Roadmap](08-roadmap.md). All figures are **planning estimates** for
> decision-making, not a fixed quote — they carry the ranges and assumptions stated here.

> **Read this first.** Estimates depend on the [Assumptions Register](../README.md#assumptions-register),
> especially A2 (stack), A6 (first customer: 1–3 channels, 10–100 users), A7 (**smallest
> agile team**), A8 (MVP definition), A9 (air-gapped operation) and A10 (external
> playout). The six original open questions are now **resolved decisions**
> ([Brief §9](../01-technical-brief.md#9-resolved-decisions)) — legacy migration is out
> (removes a workstream), the editor is a bounded basic-NLE across video/audio/image (broader
> than a single trimmer), and AI is **online-first** (cloud opex, no mandatory GPU). Estimates
> are stated **before** the AI-assisted-development speedup in
> [§8](#8-ai-assisted-development). Cost figures use **blended day-rate placeholders** you
> should replace with your actual rates.

## 1. Team shape

Atlas spans a broad surface (media pipeline, distributed backend, rich SPA, infra). The team
is organized around the service groupings, not one big pool. Per
[A7](../README.md#assumptions-register) the intent is the **smallest team that stays agile**,
so the **Core** column below is the recommended starting point; Lean/Standard show where to
add people as phases demand.

| Role | **Core (start)** | Lean | Standard | Primary focus |
|------|:----------------:|:----:|:--------:|---------------|
| Tech lead / architect (hands-on) | 1 | 1 | 1 | Architecture, contracts, reviews; also codes |
| Backend engineers | 2 | 2 | 4 | Domain services (IAM, MAM, HSM, RIM, BMS, Scheduling, Integration) |
| Media/streaming engineer | 1 | 1 | 1 | MTS/FFmpeg, transcode profiles, HSM tiering, playlist export, editor render |
| Frontend engineers (Angular) | 1 | 1 | 2 | Studio pages, editor UI, WebSocket UX |
| Platform/DevOps/SRE | 1 | 1 | 1–2 | CI/CD, IaC, orchestration, broker, observability, **offline install bundles**, HA |
| QA / test automation | shared | 1 | 1–2 | Test framework, contract/integration/perf tests |
| Product/PM | part-time | 0.5 | 1 | Backlog, workflow definitions, stakeholder decisions |
| UX/UI designer | part-time | 0.5 | 1 | Studio design system, themes, a11y |
| AI engineer | — (from Ph3) | — (Ph3) | 1 (Ph3) | AI enrichment: cloud-provider integration + optional offline sidecar ([D4](../01-technical-brief.md#9-resolved-decisions)) |
| **Headcount (FTE, peak)** | **~5–6** | **~8** | **~13–14** | |

**Recommended path:** start at **Core (~5–6)** through MVP for maximum agility; add the AI
engineer and a second frontend in Phase 3 when the editor, taxonomy, and AI enrichment land.
The Core team keeps the same phase sequence as the [Roadmap](08-roadmap.md) but on the longer
(core/lean) calendar. Roles ramp: Phase 0–1 is backbone-and-pipeline heavy (backend,
platform, media); frontend and classification grow in Phase 2; AI joins in Phase 3.

## 2. Effort estimate by area

Order-of-magnitude engineering effort in **person-weeks (PW)**, summed across the build to
v1.0 GA. Ranges reflect uncertainty; the mid-point feeds the totals.

| Area | PW (low–high) | Notes |
|------|:-------------:|-------|
| Foundations / platform (Ph0) | 26–40 | Backbone, service template, CI/CD, IaC, observability, **offline install bundles** (air-gapped). |
| IAM | 10–16 | Incl. SSO/MFA in Ph3. |
| RIM (ingest/recording) | 14–22 | Recording/segmentation adds late. |
| HSM | 16–26 | Near-line/offline + integrity sweeps are the heavy part. |
| MTS (transcode) | 16–26 | Profiles, auto-scale, GPU; cloud burst only where connected. |
| MAM | 22–34 | Relational+document+search+cache, schema editor, versioning. |
| Classification & discovery | 10–16 | **New:** tags, categories, subjects/vocabularies, **people/cast register**, faceted search. |
| BMS (workflow engine) | 20–32 | Durable orchestration + authoring UI. |
| Scheduling | 14–22 | Validation, rights, send-to-air export incl. **MCRList/standard playlist**. |
| Newsroom | 12–20 | v1.0 scope (rundowns/stories/scripts). |
| Notifications & Messaging | 8–14 | Inbox, chat, notifications. |
| Integration / Feeds | 16–26 | Inbound + outbound + EPG/HbbTV/social connectors. |
| AI Enrichment | 12–20 | **Online-first** ([D4](../01-technical-brief.md#9-resolved-decisions)): provider abstraction + cloud integration, face-matching; the optional small offline model is a later add-on, not core build. |
| Logging & Analytics | 10–16 | Audit + reports/statistics. |
| Studio (all pages + editor) | 46–72 | Largest area; **editor is now three editors** (video basic-NLE + audio + image). |
| Cross-cutting: security, HA, perf, a11y, i18n | 20–34 | Continuous + GA hardening. |
| QA automation & test infra | 20–32 | Framework + growing suites. |
| **Total** | **≈ 305–490 PW** | Mid ≈ **395 PW** (before any AI-assisted-development speedup — see [§8](#8-ai-assisted-development)). |

**Sanity check against calendar.** At the standard team's ~10 effective engineering FTE
(excluding part-time PM/UX), 400 PW ÷ 10 ≈ **40 calendar weeks of pure build**; with
coordination, ramp, and hardening this lands near the **~62-week** GA reference in the
[Roadmap](08-roadmap.md). The **Core team (~5 effective FTE)** — the recommended agile
start — stretches the same scope to roughly **~20 months** to full v1.0 GA, but reaches a
usable **MVP in ~7–8 months**. Agility is the trade for calendar length; keep scope
ruthlessly MoSCoW-prioritized.

## 3. Timeline {#timeline}

Same scope, different team size. Relative weeks/months from T0. **Core is the recommended
plan** ([A7](../README.md#assumptions-register)); Standard shows what more people buys you;
Lean (~8) sits between the two.

| Milestone | **Core (~5–6, recommended)** | Standard (~13–14) |
|-----------|:----------------------------:|:-----------------:|
| Foundations | ~2 mo | T6 (~1.5 mo) |
| **MVP** | **~7.5–8 mo** | T22 (~5 mo) |
| **Beta** | ~13–14 mo | T38 (~9 mo) |
| **v1.0 feature-complete** | ~19 mo | T56 (~13 mo) |
| **v1.0 GA** | **~20–21 mo** | T62 (~14 mo) |

The Core team reaches a usable **MVP in ~7.5–8 months** and stretches progressively on the
broader v1.0 surface, where extra hands parallelize best. **Recommendation:** run the **Core
team through MVP** for agility, then add the **AI engineer and a second frontend** in Phase 3
when the editor, taxonomy/people, and AI enrichment land. Don't staff up before the work
exists — that's the whole point of A7.

## 4. Cost scenarios {#cost}

Costs use a **blended fully-loaded day rate** placeholder — replace with your real rates.
Person-months (PM) derived from the timeline × headcount; 1 PM ≈ 20 working days.

**Illustrative blended day rates** (swap these):

| Rate band | €/day (loaded) | Typical region/seniority |
|-----------|:--------------:|--------------------------|
| Low | €350 | Lower-cost region, mixed seniority |
| Mid | €600 | Mixed region, standard team |
| High | €1,000 | High-cost region / senior-heavy |

**Effort in person-months to GA** (headcount × months, approx.):

| Scenario | Peak FTE | Duration | ~Person-months |
|----------|:--------:|:--------:|:--------------:|
| **Core (recommended)** | 5–6 | ~20–21 mo (ramped avg ~4.5–5) | ~100 PM |
| Standard | 13–14 | ~14 mo (ramped avg ~11) | ~155 PM |

**Indicative labour cost to v1.0 GA** (PM × 20 days × day-rate):

| | Low (€350) | Mid (€600) | High (€1,000) |
|---|:---:|:---:|:---:|
| **Core** (~100 PM) | ≈ €0.70M | ≈ €1.20M | ≈ €2.0M |
| **Standard** (~155 PM) | ≈ €1.09M | ≈ €1.86M | ≈ €3.1M |

> These are **labour only**. Read them as a broad band, not a quote. The Core team is cheaper
> in total (fewer people, even over a longer calendar) — the trade is a later GA. The figure
> depends on your rates and how much Should/Could scope you defer.

**Non-labour costs (annual, order-of-magnitude):**

| Item | Notes |
|------|-------|
| Infrastructure (dev/CI/staging) | Cloud or on-prem lab; modest until perf/HA phases. |
| Production hardware | Per [Hardware doc](../requirements/07-hardware-requirements.md); customer-funded in on-prem sales, vendor capex/opex in SaaS. |
| SaaS hosting & egress (if offered) | Only in the [managed-service model](../architecture/02-system-architecture.md#saas): cloud compute/storage plus **media egress** to the control-room site — recurring opex the vendor carries and recovers via subscription. Sized per subscriber's ingest/playout volume. |
| Transcode compute / GPU | Scales with ingest volume; cloud burst is opex **only in connected deployments**. |
| AI — online tier (primary) | **Opex**: cloud/vendor AI per-minute/per-asset ([D4](../01-technical-brief.md#9-resolved-decisions)). No local GPU needed. Scales with enrichment volume. |
| AI — offline tier (optional) | Small **capex**: a single small GPU (or CPU) for air-gapped suggestions/simple tasks. Not needed unless an air-gapped site wants local AI. |
| AI-assisted dev tooling | Per-seat coding-assistant/agent subscriptions ([§8](#8-ai-assisted-development)); small opex, large leverage. |
| Software licensing | Prefer OSS stack (Postgres/Mongo/OpenSearch/NATS/MinIO/FFmpeg) to minimize this; commercial DB/broker optional. |
| Security (pen test, audits) | Per release + annual. |
| Tooling (CI, observability, error tracking) | Per-seat/usage SaaS or self-hosted. |

## 5. Cost-to-MVP (for a smaller first commitment)

If the goal is to **fund the MVP first**, then decide on the rest:

| | Core team to MVP (~7.5–8 mo) | Standard team to MVP (~5 mo) |
|---|:---:|:---:|
| ~Person-months | ~35 PM | ~45 PM |
| Labour @ Mid (€600) | ≈ €0.42M | ≈ €0.54M |

MVP needs only the [minimum viable footprint](../requirements/07-hardware-requirements.md#9-minimum-viable-footprint-for-the-mvp-milestone),
keeping infra cost low for a pilot. This is the recommended way to de-risk with the Core team:
prove the ingest-to-schedule spine with a real workflow, then commit to Beta/v1.0 and add the
AI/second-frontend specialists.

## 5a. Scope delta — the production-lifecycle expansion {#lifecycle-delta}

All figures above cover **v1.0 only** (the automation spine). The
[lifecycle expansion](../strategy/19-production-lifecycle-scope.md) — pre-production planning,
production support, project-based web editor, and standards conformance — is scoped as
**[v2.0](08-roadmap.md#v2)** and costed separately here so the v1.0 plan stays intact.

| Expansion area | PW (low–high) | Note |
|----------------|:-------------:|------|
| Planning & resource scheduling | 30–45 | CRUD + interval-conflict logic; well-understood ([service](../architecture/services/planning.md)) |
| Production support | 15–25 | Largely reuses RIM/MAM/BMS |
| **Editorial (web editor + interchange)** | **60–100** | **The dominant cost and risk** ([service](../architecture/services/editorial.md)) |
| Standards & FIMS conformance | 20–35 | Facade + adapters ([doc 17](../integrations/20-standards-and-fims.md)) |
| **Total expansion** | **≈ 125–205 PW** | **≈ +35–45%** on the ≈305–490 PW v1.0 baseline |

**Calendar impact (Core team, AI-assisted):**

| Plan | MVP | v1.0 GA | Lifecycle complete |
|------|:---:|:-------:|:------------------:|
| **v1.0 first, then v2.0 (recommended)** | ~6 mo | **~16–18 mo** | ~26–32 mo |
| Everything in one release (not recommended) | ~6 mo | — | **~24–30 mo** |

Both paths reach the full vision at a similar time — but the recommended one **ships a sellable
product 8–14 months earlier**, funds the expansion from revenue, and lets real production
feedback shape the v2.0 build. That is the whole argument for sequencing.

**Team impact.** The expansion needs roles the v1.0 Core team doesn't have: a **second frontend
engineer** (the editor UI is substantial) and, for the editorial phase, someone comfortable with
**media timeline/interchange formats**. Plan the Core team growing to ~8 during v2.0-c rather
than staffing up earlier.

## 6. Stack rationale {#stack-rationale}

Why the recommended stack ([A2](../README.md#assumptions-register)) and its effect on cost:

- **One primary stack: Node.js (LTS) + TypeScript** — NestJS for domain/control-plane
  services, Fastify for the thin high-throughput edges. Atlas's backend is overwhelmingly
  **IO-bound orchestration** (databases, broker, FFmpeg supervision, event fan-out), which is
  Node's strongest ground; the per-service picks are in
  [Service Catalog §Recommended implementation stack](../architecture/03-service-catalog.md#recommended-implementation-stack).
- **Cost/agility effect — this is the main reason it's the recommendation.** A single language
  end to end (backend + the Angular Studio share contract/DTO/type packages) means **less
  context-switching, one hiring profile, and a huge TypeScript talent pool**. For the
  [Core team](#1-team-shape) it keeps the "smallest agile team"
  ([A7](../README.md#assumptions-register)) viable across more of the surface — engineers move
  between services and between front and back end without a language wall.
- **Narrow escape hatch, not a second stack.** Only two spots leave pure Node, and only when
  profiling justifies it: HSM hashing/byte-movement (native addon via napi-rs, or a small
  Go/Rust file-mover) and extreme WebSocket fan-out. Offline ML inference runs as a
  Python/ONNX **sidecar**, not a rewrite. This keeps the cost of "polyglot" contained to a
  couple of small, well-bounded components.
- **Angular (given)** for Studio — matches the draft; a big but well-understood area, and it
  shares TypeScript types with the backend.
- **OSS data plane** (Postgres, Mongo, OpenSearch, NATS/RabbitMQ, MinIO, Redis, FFmpeg) —
  minimizes licensing; ops cost is the trade-off, absorbed by the platform/SRE role.
- **If the team were strongest elsewhere** (.NET/Go/Java) the architecture and effort don't
  change materially — contracts are language-agnostic — but team fluency beats theoretical
  fit, and here the team's fluency *is* TypeScript, so the choice compounds.

## 7. Estimate confidence & how to tighten it

| Driver | Current basis | To firm up |
|--------|---------------|-----------|
| Editor depth | **Resolved** ([D3](../01-technical-brief.md#9-resolved-decisions)): basic-NLE across video/audio/image | Confirm image-layers stays a Could; validate render performance early. |
| AI approach | **Resolved** ([D4](../01-technical-brief.md#9-resolved-decisions)): online-first; optional limited offline tier | Pick the cloud/vendor provider(s); confirm which air-gapped sites want the small local model. |
| AI-assisted development | Assumed in use ([A12](../README.md#assumptions-register), [§8](#8-ai-assisted-development)) | Confirm tooling/policy; recalibrate the speedup after the first phase's actuals. |
| Playout integration | **Resolved** ([D1](../01-technical-brief.md#9-resolved-decisions)): export standard formats (MCRList) | Confirm the target playout system's exact format(s). |
| Legacy migration | **Resolved** ([D2](../01-technical-brief.md#9-resolved-decisions)): out of scope | — (excluded from all estimates). |
| Launch customer scale | **Resolved** ([A6](../README.md#assumptions-register)): 1–3 channels, ≤100 users | Confirm library size for storage sizing. |
| Team & rates | Core team ([A7](../README.md#assumptions-register)) + placeholder rate bands | Insert real day-rates and confirm the Core roster. |
| Air-gapped packaging | Assumed offline install bundle ([A9](../README.md#assumptions-register)) | Confirm which sites are air-gapped; test an offline install before v1.0. |

Recommended cadence: **re-estimate at each phase exit** with actuals from the prior phase
(velocity, transcode throughput, defect rates) to converge the range.

## 8. AI-assisted development {#ai-assisted-development}

The estimates above are **before** any productivity gain from AI coding tools. Used well —
completion assistants, agentic coding for scaffolding and refactors, AI-assisted review and
test generation — these compress the calendar, especially for the **Core team** where the
constraint is headcount, not scope. Per [A12](../README.md#assumptions-register) we assume the
team uses them.

**The gain is real but uneven.** It helps most where Atlas has the most volume, and least
where the hard problems live:

| Work type | Share of build | Typical speedup | Examples |
|-----------|:--------------:|:---------------:|----------|
| High-leverage | ~40% | **30–50%** | CRUD services, DTOs/contracts, feed mappers, config, boilerplate, straightforward Studio components, unit-test scaffolding, docs |
| Moderate | ~35% | **15–25%** | Business logic, workflow engine, integration glue, search queries, moderate UI |
| Low / none | ~25% | **0–10%** | Novel architecture, distributed-systems debugging, FFmpeg/codec edge cases, perf/HA/chaos, security, **QA against real media**, on-site & air-gapped deployment, stakeholder decisions, coordination |

Blending those gives roughly a **20–30% reduction in engineering calendar for the build**,
and — because coordination, hardening, real-media QA, deployment, and decision latency don't
compress — an **effective ~15–20% reduction across the whole program**. Treat these as
planning figures, not guarantees.

**Accelerated timeline** (applying the whole-program reduction to [§3](#3-timeline)):

| Milestone | Core, baseline | **Core, AI-assisted** | Standard, AI-assisted |
|-----------|:--------------:|:---------------------:|:---------------------:|
| **MVP** | ~7.5–8 mo | **~6–6.5 mo** | ~4 mo |
| **Beta** | ~13–14 mo | **~11–12 mo** | ~7.5 mo |
| **v1.0 GA** | ~20–21 mo | **~16–18 mo** | ~11–12 mo |

So the recommended path — **Core team + AI-assisted development** — targets an **MVP in ~6
months and v1.0 GA in ~16–18 months**, versus ~8 and ~20 without.

**Caveats — don't over-claim the speedup:**
- AI-generated code still needs **human review, tests, and ownership**. The gain is throughput
  per engineer, not fewer engineers who understand the system.
- **Security- and correctness-critical code** (IAM/token handling, HSM file ops, playout
  export, air-gapped installs) needs *more* scrutiny, not less — net speedup there is small.
- Gains **depend on the stack and codebase maturity**; they rise after Phase 0 once patterns
  and the service template exist for the tools to imitate.
- **Recalibrate with actuals** at the first phase exit rather than banking the full 30% up
  front — if the measured gain is lower, the baseline ([§3](#3-timeline)) still holds.

**Second-order effect:** because AI raises per-engineer throughput, the **Core team stays
viable for more of the surface** before needing the Lean/Standard headcount — reinforcing the
A7 "smallest agile team" intent rather than replacing it.

---
_Next: [Third-Party Developer Guide](../integrations/10-third-party-developer-guide.md)._
