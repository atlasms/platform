# BMS — Business Process Management System — Implementation Plan

> Build plan for the workflow engine that **orchestrates** the other services and human steps —
> preset and author-able flows, with retries, timeouts, and human-in-the-loop approval/tasks.
> Spec: [bms](../../architecture/services/bms.md) · **Technical design:**
> [Workflow DSL, Designer, Engine & BPMN Converter](../../architecture/bms-workflow-dsl-and-designer.md)
> (definition model, FEEL, validator, Temporal interpreter, BPMN converter, canvas) · Contract:
> [`workflow-definition.schema.json`](../../architecture/schemas/workflow-definition.schema.json) ·
> Stack: **Node + NestJS + Temporal (TS SDK)** (or a broker-backed saga) · Ships: **Phase 2 (v1)** →
> **Phase 3 (authoring)**. Critical path for automated flows (the manual path can bypass it).
>
> **Head start:** [`reference/bms-workflow/`](../../../reference/bms-workflow/README.md) already
> implements the types, validator (schema + graph + FEEL), the lossless DSL⇄BPMN converter, the
> **pure workflow interpreter** (over an `Effects` boundary), and the **library-agnostic canvas core**
> (projection + edit ops + schema-driven forms) as **tested code** (29 passing tests) — lift it into
> `libs/contracts` + the authoring service + Studio; add the Temporal adapter behind `Effects` and the
> Foblex Flow binding over `GraphView`.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 2 | Preset flows incl. the **canonical ingest-to-air** flow; orchestration with retries/timeouts; **human-in-the-loop** steps (approval, task assignment); the reusable **manual-review step**. |
| v2 | 3 | **Visual drag-and-drop designer** in Studio ([Foblex Flow](https://flow.foblex.com/); author/duplicate/modify flows, [FR-BMS-7…9](../../requirements/05-functional-requirements.md#workflow)); **BPMN 2.0 export/import** ([FR-BMS-10](../../requirements/05-functional-requirements.md#workflow)); **flow-position visibility**; SLA timers. |

**Non-goals.** No domain data ownership — BMS issues commands and reacts to events; the services do the
work. Manual operation must remain possible without BMS.

## 2. Build sequence

1. **Durable runtime (v1)** — adopt **Temporal (TS SDK)** for durable timers/retries/human waits (or a
   broker-backed saga if Temporal is ruled out); one workflow = one orchestration instance.
2. **Command/event adapters** — issue each target service's own command for a command step (e.g.
   `transcode.job.create`), record it as `workflow.step.requested`, and **await** the service's
   completion event; map timeouts/retries.
3. **Canonical flow (v1)** — encode ingest → transcode → catalog → review → schedule → send-to-air as a
   preset; drive it end-to-end.
4. **Human-in-the-loop steps (v1)** — emit `workflow.task.created` (assign to user/role); **wait** on a
   correlated completion. The **manual-review step** carries a `reviewPointId` and resolves on
   `asset.approved`/`asset.rejected` — placeable at **multiple points** (see
   [Review Lifecycle plan §WS-G](../15-review-lifecycle-implementation-plan.md#ws-g--bms-multi-point-review-step)).
5. **Instance visibility (v2)** — `GET /instances/{id}` running state; **show each asset's position** in
   its flow; SLA timers + escalation.
6. **Definition schema + validation (v2)** — publish the `WorkflowDefinition` JSON schema in the
   shared `contracts` package, with step kinds designed as a **BPMN 2.0 subset** from day one
   ([designer = engine model](../../architecture/services/bms.md#32-definition--designer-model),
   [BPMN alignment](../../architecture/services/bms.md#33-bpmn-20-alignment--interop)); a
   **palette endpoint** (`GET /workflows/palette`) exposing step kinds + config schemas; a
   `POST /workflows/{id}/validate` (reachability, unbound refs, type-correct edges) reused by
   `publish`.
7. **BPMN converter (v2)** — a pure library in `contracts` doing **lossless DSL ↔ BPMN 2.0**
   (elements + `conditionExpression` + **DI layout**; engine policy in namespaced **extension
   elements**), using [bpmn-js](https://bpmn.io/toolkit/bpmn-js/) to serialize/parse XML. Surfaced
   as `GET /workflows/{id}/export?format=bpmn` and `POST /workflows/import`.
8. **Visual designer (v2, Studio)** — an Angular canvas on **Foblex Flow**, kept **thin** over the
   definition: reads/writes it, drives the palette + property panels from the schemas, calls
   validate/publish/export/import, and renders the **live-instance overlay** (colored by
   `StepHistory`) for [FR-BMS-6](../../requirements/05-functional-requirements.md#workflow).
9. **Re-review re-entry** — wire `asset.expired` to auto-open a fresh manual-review task (closes the
   expiry loop).

### Designer & format — decisions

**Canvas: [Foblex Flow](https://flow.foblex.com/)** (`@foblex/flow`, MIT npm) — Angular-native,
signals-based, built for workflow builders (drag-to-connect, minimap, snapping, waypoints). Kept
**thin over our definition schema** so semantics stay in the definition + engine and the library
remains swappable. *(MIT package ships; full source is a separate paid license.)* Alternatives
considered and not chosen: [ngx-vflow](https://www.ngx-vflow.org/) (MIT, lighter),
[Rete.js](https://retejs.org/) (MIT, typed ports), [JointJS](https://www.jointjs.com/) core
(MPL-2.0; workflow UI is commercial), [Sequential Workflow Designer](https://nocode-js.com/) (MIT;
best only if flows stay strictly sequential).

**Format: own JSON DSL, BPMN-2.0-convertible (decided).** The DSL is the internal model (ergonomic
for the canvas + clean Temporal mapping + offline); a pure **converter** does lossless BPMN 2.0
export/import so Atlas stays modular and interoperable with standard BPMN tools. The enabling
constraint: **design the DSL step kinds as a BPMN subset from the start** (mapping table in
[spec §3.3](../../architecture/services/bms.md#33-bpmn-20-alignment--interop)); engine-only policy
rides in namespaced **extension elements**; layout maps to **BPMN DI**. BPMN is an
**export/interop** format, not the internal model.

## 3. Components / modules

- `runtime` (Temporal client/workers), `definitions` (schema + authoring + versioning + **validation**),
  `palette` (step-kind registry + config schemas), **`bpmn-converter`** (lossless DSL ↔ BPMN 2.0,
  in `contracts`), `instances` (running state), `steps` (command adapters + human steps),
  `timers/sla`, `review-step`, **`designer`** (Studio Angular canvas on Foblex Flow — a Studio
  deployable, not a backend module).

## 4. Data plane & migrations

- **Relational:** workflow definitions + running instance state; **durable timers** (Temporal-managed or
  DB-backed). Additive migrations; definitions are versioned.

## 5. APIs & events

- REST: [`bms.yaml`](../../architecture/openapi/bms.yaml) — `/workflows`, `/workflows/palette`,
  `/workflows/{id}/validate`, `/workflows/{id}/publish`, `/workflows/{id}/export?format=bpmn`,
  `/workflows/import`, `/instances`, `/instances/{id}`.
- **Emits:** [`workflow.step.requested`](../../architecture/schemas/events/workflow.step.requested.payload.schema.json)
  (a command step issues the target's own command, e.g. `transcode.job.create`),
  [`workflow.completed`](../../architecture/schemas/events/workflow.completed.payload.schema.json),
  [`workflow.task.created`](../../architecture/schemas/events/workflow.task.created.payload.schema.json).
  **Consumes:** the completion events of every orchestrated service.

## 6. Dependencies & integration points

- **Requires first:** the services it orchestrates ([RIM](rim-plan.md), [MTS](mts-plan.md),
  [MAM](mam-plan.md), [Scheduling](scheduling-plan.md)), broker. **Consumed by:**
  [Notifications](notifications-plan.md) (tasks), Studio (flow visibility).

## 7. Testing focus

- **Durable recovery** — an instance survives worker restart / broker blip and resumes exactly once.
- Retry/timeout/compensation semantics; no duplicate side effects on redelivery.
- Human-step correlation (right task ↔ right instance ↔ right `reviewPointId`), including **multiple**
  review points in one flow.
- Canonical flow e2e; authored-flow validation (v2).
- **Designer round-trip:** definition → canvas → edit → publish → engine runs the intended graph;
  `position` metadata never alters execution; validation catches unreachable/unbound/mis-typed graphs
  before publish; a published version is immutable while running instances stay pinned.
- **BPMN round-trip:** DSL → BPMN 2.0 → DSL is **lossless** (elements, conditions, layout/DI, and
  extension-element policy preserved); the exported XML **imports into a standard BPMN tool**; an
  imported third-party BPMN maps to a valid draft (or fails with a clear unsupported-element report).

## 8. Scaling & deployment

- **Stateful engine; partition instances**; scale Temporal workers. Config: preset flows, retry/timeout
  policies, SLA thresholds, per-scope flow assignment.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Orchestration state lost on failure | Durable runtime (Temporal) — the core reason for the choice. |
| Duplicate side effects | Idempotent commands + activity idempotency keys. |
| BMS becomes a hard dependency | Keep the **manual path** working without BMS (bypass). |
| Author-able flows create invalid graphs | Definition validation + publish gate + versioning. |
| Canvas library lock-in / churn | Keep the editor **thin over our schema**; semantics live in the definition + engine, so the library is swappable. |
| Designer scope creep (toward a full BPMN suite) | Start with our step palette + JSON DSL; treat BPMN as optional export, not the internal model. |
| BPMN drift makes conversion lossy | Keep DSL kinds a **strict BPMN subset**; a round-trip test in CI gates every DSL change; unsupported imported elements fail loudly. |
| Third-party BPMN uses unsupported elements | Import validates against our subset and reports unsupported constructs rather than silently dropping them. |
