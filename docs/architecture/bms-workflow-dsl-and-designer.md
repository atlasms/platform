# BMS Workflow DSL, Designer, Engine & BPMN Converter — Technical Design

> The implementation-level blueprint behind [BMS](services/bms.md) §3.2/§3.3: the exact
> definition model, step-kind catalog, expression language, validation, persistence, the Temporal
> interpreter, the BPMN 2.0 converter, and the Foblex Flow canvas. Machine-readable contract:
> [`workflow-definition.schema.json`](schemas/workflow-definition.schema.json). Build plan:
> [bms-plan](../roadmap/services/bms-plan.md).
>
> Goal: enough precision that the schema, converter, engine, and canvas can be built in parallel
> against frozen contracts.

## 0. Component map

```mermaid
graph LR
    subgraph Studio [Studio - Angular]
        Canvas[Workflow Designer - Foblex Flow]
        Forms[Property forms - JSON-Schema driven]
    end
    subgraph contracts [libs/contracts]
        Schema[WorkflowDefinition schema + TS types]
        Conv[BPMN converter - bpmn-moddle]
        Feel[FEEL sandbox - feelin]
    end
    subgraph BMS [BMS service - NestJS]
        API[Authoring/validate/publish/export/import API]
        Val[Validator]
        Interp[Temporal interpreter + activities]
        Router[Event router - correlation -> signal]
    end
    Temporal[(Temporal)]
    Broker[(Broker)]
    Canvas --> API
    Forms --> Schema
    API --> Val --> Schema
    API --> Conv
    Interp --> Temporal
    Interp --> Broker
    Broker --> Router --> Temporal
    Val --> Feel
    Interp --> Feel
```

Three deployables share **one contracts package**: the Angular canvas, the BMS backend, and the
pure converter/FEEL libs used by both.

## 1. Definition model

The [`WorkflowDefinition`](schemas/workflow-definition.schema.json) is a directed graph:
`steps[]` (nodes) + `transitions[]` (edges) + `vars[]` (typed instance state). It is the **single
source of truth** — edited by the canvas, stored as `jsonb`, executed by the interpreter,
converted to/from BPMN. Generate `libs/contracts` TS types from the schema (`json-schema-to-typescript`)
so canvas and backend share `WorkflowDefinition`, `Step`, `Transition`, per-kind config types.

**Invariants** (enforced by schema + validator, §6):

- Exactly one `start`; ≥1 `end`. Every `Step.id`/`Transition.id` unique. Every `from`/`to`
  references an existing step.
- `position` is presentation-only; the engine never reads it (so re-layout can't change behavior).
- A published version is **immutable**; edits create a new draft → new version on publish. Running
  instances carry their own frozen copy (§10.6), so editing never disturbs them.

## 2. Step-kind catalog

Each kind = one canvas node type = one config `$def` = one BPMN element = one interpreter handler.

| kind | BPMN element | Config (`$def`) | Waits? |
|------|--------------|-----------------|:------:|
| `start` | Start Event | `StartConfig` (optional event trigger) | on trigger |
| `end` | End Event | `EndConfig` (terminate?/status) | — |
| `command` | Service Task | `CommandConfig` (request + optional await) | if `await` |
| `human-task` | User Task | `HumanTaskConfig` (assignee, dueIn, escalation) | yes |
| `wait-event` | Message/Signal Catch Event | `WaitEventConfig` (event + correlate) | yes |
| `timer` | Timer Event | `TimerConfig` (duration/date/cron) | yes |
| `branch` | Exclusive (XOR) Gateway | `BranchConfig` (default edge) | — |
| `parallel` | Parallel (AND) Gateway | `ParallelConfig` (split/join) | at join |
| `sub-flow` | Call Activity | `SubFlowConfig` (workflowId/version) | yes |

### 2.1 `command` — Service Task

Emits a command event and (optionally) awaits its completion. The common request/response step.

```jsonc
{ "id": "s_transcode", "kind": "command", "name": "Transcode",
  "retry": { "maxAttempts": 3, "backoff": { "type": "exponential", "initial": "PT30S", "factor": 2, "max": "PT10M" } },
  "onError": "compensate",
  "config": {
    "action": "transcode",
    "request": { "event": "transcode.job.create",
                 "input": { "profile": "= vars.profile", "assetId": "= vars.assetId" } },
    "await":   { "event": "transcode.completed",
                 "output": { "vars.renditions": "= incoming.renditions" } } } }
```

Runtime (§10.3): activity publishes `request.event` with envelope `correlationId = instanceId::stepId`
and `input` evaluated via FEEL; the interpreter then blocks on a signal correlated by that id;
`await.output` maps the completion payload into `vars`. No `await` ⇒ fire-and-forget.

### 2.2 `human-task` — User Task

```jsonc
{ "id": "s_review", "kind": "human-task", "name": "Review & approve",
  "config": { "taskType": "approve", "assignee": { "role": "editor" },
              "reviewPointId": "pre-schedule", "dueIn": "PT4H",
              "escalation": { "after": "PT2H", "action": "notify", "to": { "role": "chief-editor" } } } }
```

Runtime: activity emits `workflow.task.created` (→ Notifications) with `assignee`, `reviewPointId`,
`dueAt = now + dueIn`; the interpreter waits for the task's completion (`POST /tasks/{id}/complete`
in Notifications → `task.updated`). **A step with a `reviewPointId` is a REVIEW step** (EP-22.6,
decided 2026-10-16; [review loop](../roadmap/15-review-lifecycle-implementation-plan.md#ws-g--bms-multi-point-review-step)):
its `taskType` is `approve`, and it is resolved by MAM's verdict on the instance's asset —
`asset.approved`/`asset.rejected` naming that point, or naming none — not by its task, which
Notifications refuses to complete by hand and closes when BMS says the verdict came
(`workflow.task.resolved`). The step's `incoming` is `{ outcome: approved|rejected, by, taskId,
assetId, reviewPointId?, reason?, expiresAt? }`, so `= incoming.outcome` maps either path. Each point
in a flow is distinct, so MAM's verdict history says where each decision was made. As built: bms.md
§13f. `dueIn`/`escalation` arm Temporal timers.

### 2.3 `wait-event` — Message/Signal Catch

Blocks for an event **not** triggered by a prior command (e.g. an approval done elsewhere). BMS
registers a correlation subscription `{event, correlateKey}` → `instanceId::stepId` (§9.2); the
router signals when a matching event arrives. `timeout` (step-level) → BPMN boundary timer.

As decided 2026-10-16 (EP-22.6) and 2026-10-17 (EP-22.7): `event` is one of a CLOSED list (`WORKFLOW_EVENTS` in
`@atlas/contracts/workflow` — `asset.ready`, `asset.approved`, `asset.rejected` to start), and
`correlate` is equality KEYS — `incoming.<field> = <expr>`, joined with `and`, where `<expr>` does
not read `incoming`. The workflow evaluates each `<expr>` when the step starts waiting; the keys are
what the router matches. An event published BEFORE the step starts waiting, but since its instance
started, is taken from BMS's buffer (EP-22.7, kept 7 days) — the earliest that matches and has not
already moved the instance; one from before the instance started is not (bms.md §13g).

### 2.4 `timer` — Timer Event

`mode: duration` → `wf.sleep(ISO8601)`, `date` → sleep until, `cron` → next-fire via a durable
schedule. Deterministic through Temporal's timer API only.

### 2.5 `branch` — Exclusive (XOR) Gateway

Diverging: evaluate outgoing transitions' `when` (FEEL boolean) **in authored order**; take the
first true; else `config.default`. Validator requires either full coverage or a default (§6).
Converging (many in-edges, one out): pass-through.

### 2.6 `parallel` — Parallel (AND) Gateway

`mode: split` starts every outgoing path concurrently; `mode: join` waits for **all** incoming
paths. Interpreter uses `Promise.all` over sub-paths (§10.4). A split must be matched by a join
(validator checks structured pairing; unstructured graphs are rejected with a clear message).

### 2.7 `sub-flow` — Call Activity

`await wf.executeChild(atlasWorkflow, { args: [childDef, mappedInput] })`; `output` maps child
result into parent `vars`. `version: "latest"` resolves at **publish** time and is frozen into the
parent version (so the parent stays deterministic).

## 3. Expression language — FEEL

All expressions (`when`, every `DataMapping` value, `correlate`, `assignee.expression`,
`trigger.filter`) are **FEEL** (Friendly Enough Expression Language, the DMN/BPMN standard),
prefixed `=` by convention. Chosen because a FEEL string **is** a legal BPMN
`conditionExpression language="feel"` — conditions round-trip to BPMN with zero translation.

- **Engine:** a JS FEEL library (e.g. `feelin`, bpmn.io). Wrapped in `libs/contracts/feel` and
  used by both the validator (compile-check) and the interpreter (evaluate).
- **Context** exposed to every expression:
  `{ vars, incoming (the event/task payload), steps (map of prior step outputs), now, instance }`.
- **Sandboxed & deterministic:** no host access, no I/O, no wall-clock except `now` (Temporal time);
  pure function of context. Compile every expression at **validate** time; a parse error is a
  publish-blocking error bound to the owning step/edge.

**The subset (decided 2026-10-12, EP-23.6).** Expressions are a restricted subset of FEEL — still
legal FEEL, so BPMN round-trips unchanged, but small enough for the editor to offer and the
validator to explain:

| Allowed | |
|---|---|
| Literals | number, string, boolean, `null`; `date()`, `time()`, `date and time()`, `duration()` |
| Paths | into `vars`, `incoming`, `steps`, `instance` (`steps.probe.output.durationMs`) |
| Operators | `=` `!=` `<` `<=` `>` `>=`, `between … and …`, `in [ … ]`, `and` `or` `not()`, `+` `-` `*` `/` |
| Conditional | `if … then … else …` |
| Functions | `count()`, `contains()`, `starts with()`, `ends with()`, `string length()`, `upper case()`, `lower case()`, `now()` (Temporal time) |

Everything else — function definitions, `for` / `some` / `every`, list filters (`xs[ … ]`), context
construction — is refused when a definition is published, with the construct named. Widening the
list is a decision recorded here, not a library upgrade. The roots are declared to the parser as context names: FEEL
reads a bare `instance` as the start of `instance of`, so without that the `instance` root would not
parse — and with it, `instance of` (outside the subset anyway) does not.

**The editor (EP-23.6, as built).** Studio's `atlas-feel-input` is every FEEL field in the designer
— a config field the palette marks `x-atlas-type: feel`, every data-mapping value, a branch edge's
`when`. It judges the expression AS IT IS TYPED with the same checker publish runs:
`@atlas/contracts/workflow-feel` is the subset checker on its own subpath (feelin's parser, no file
system), so the browser and BMS cannot disagree, and it works offline (§12.5). Three states: a
parse error or a construct outside the subset (publish's own words, `aria-invalid`), a `vars.<name>`
the workflow does not declare (a warning — publish's `UNBOUND_VAR`), or clean. *Insert…* offers the
subset by name — the four roots, the workflow's declared vars, the allowed functions — at the caret,
beginning an empty field with `= `. A verdict is a hint, never a block: a draft saves whatever it
holds. The parser costs the designer's lazy chunk ~55 kB gzipped; nobody else loads it.

## 4. Variables & data flow

- A start step's `trigger.output` (EP-22.7) maps the triggering event — the start step's `incoming`
  — into vars when the trigger starts the instance (`{ "vars.assetId": "= incoming.assetId" }`); a
  start through the API gives its vars itself and the mapping is not applied.

- `vars[]` declares typed, named instance state with optional `initial`.
- Data moves only through **`DataMapping`** (`{ "targetPath": "= feelExpr" }`): `command.request.input`
  (into the command payload), `*.output` (from a completion/task payload into `vars`), `sub-flow`
  input/output. Target paths are dotted into `vars` (`"vars.renditions"`).
- The interpreter holds `vars` in workflow state (Temporal-persisted); mutations happen only via
  mappings, so state changes are auditable and replay-deterministic.

## 5. Palette contract

`GET /workflows/palette` returns, per kind: `{ kind, label, icon, category, configSchema }` where
`configSchema` is the JSON-Schema `$def` for that kind's config (sliced from the definition schema).
The canvas renders the palette from this and generates **property forms from `configSchema`**
(§12.3), so adding a kind is: new `$def` + interpreter handler + BPMN mapping — **no canvas code**.


**As built (EP-23.1):** `palette()` in `@atlas/contracts/workflow` builds it from
`workflows/palette.json` (display metadata) and `workflow-definition.schema.json` (the config
`$def`s, every `$ref` — local and `common.schema.json`'s — inlined, so a property panel needs no
resolver), adding `choices` from the closed lists: `start` → `triggers`, `command` → `commands`
(`event`, `target`, `completes`, `fails`, `requires`), `wait-event` → `events`. A contracts test
validates every preset step's config against its kind's resolved schema. Container images copy
`docs/architecture/workflows` for it.
## 6. Validation

Run on `POST /workflows/{id}/validate` (live, non-blocking feedback) and again inside `publish`
(blocking). Two tiers:

**Tier 1 — schema.** Ajv (2020-12) against `workflow-definition.schema.json`. Structural: kinds,
required per-kind config, id patterns, `maxContains:1` on `start`.

**Tier 2 — graph & semantic** (custom, returns `{stepId|transitionId, severity, message}[]`):

| Rule | Severity |
|------|----------|
| Every `transition.from/to` resolves to a step | error |
| Exactly one `start`; ≥1 `end` | error |
| **Reachability** — every step reachable from `start` (BFS) | error (unreachable) |
| Every non-`end` step has ≥1 outgoing edge; no dangling | error |
| `branch` outgoing edges cover all cases or define `default` | error |
| `parallel split` is matched by a `parallel join` (structured) | error |
| Every FEEL expression compiles; referenced `vars`/paths are declared | error / warning |
| `command.request.event` is a command a workflow may issue — `WORKFLOW_COMMANDS` (`UNKNOWN_COMMAND`, EP-22.4) | error |
| `command.request.input` keys are fields of that command's payload, and its required fields are given (`COMMAND_INPUT`); a dotted key builds a nested field | error |
| `command.await.event` answers the command (`AWAIT_EVENT`); `command.await.correlate` is refused — the answer is matched by correlation id (`CORRELATE_UNSUPPORTED`) | error |
| `retry` only on a `command` step (`RETRY_NOT_COMMAND`, EP-22.9); an `onError.transitionTo` target and a `compensation` handler count as reachable | error |
| `start.trigger.event` is an event a workflow may start on — `WORKFLOW_TRIGGERS`, a closed list (`UNKNOWN_TRIGGER`, EP-22.7) | error |
| `wait-event.event` is an event a workflow may wait for — `WORKFLOW_EVENTS`, a closed list (`UNKNOWN_EVENT`, EP-22.6) | error |
| `wait-event.correlate` is equality keys, `incoming.<field> = <expr>` joined with `and`, the other side not reading `incoming` (`CORRELATE_SHAPE`), on fields the event's payload has (`CORRELATE_FIELD`) | error |
| A `human-task` with a `reviewPointId` is an approval (`REVIEW_TASK_TYPE`), and no two steps share a point (`DUP_REVIEW_POINT`) | error |
| `sub-flow.workflowId` exists and is published | error |
| `compensation` references an existing step | error |
| Unreachable-after-terminate, unused `vars` | warning |

Algorithm: build adjacency from `transitions`; BFS from `start` for reachability; walk gateway
pairing with a stack; compile every expression through the FEEL wrapper collecting diagnostics.

## 7. Persistence (PostgreSQL)

Definitions are versioned; the running state of record lives in **Temporal**, mirrored here for
query/visibility.

```sql
-- Definition header (one row per logical workflow) + immutable versions.
CREATE TABLE workflow (
  id          text PRIMARY KEY,            -- ULID
  channel_id  text NOT NULL,
  name        text NOT NULL,
  scope       jsonb NOT NULL DEFAULT '{}', -- {categoryId?, mediaType?, usage?}
  latest_version integer NOT NULL DEFAULT 0
);
CREATE TABLE workflow_version (
  workflow_id text NOT NULL REFERENCES workflow(id),
  version     integer NOT NULL,
  status      text NOT NULL CHECK (status IN ('draft','published')),
  graph       jsonb NOT NULL,              -- the full WorkflowDefinition
  created_by  text, created_at  timestamptz NOT NULL DEFAULT now(),
  published_by text, published_at timestamptz,
  PRIMARY KEY (workflow_id, version)
);
CREATE UNIQUE INDEX one_draft_per_wf ON workflow_version (workflow_id)
  WHERE status = 'draft';                  -- at most one open draft

-- Instance mirror (Temporal is authoritative; this powers list/search + the overlay).
CREATE TABLE workflow_instance (
  id           text PRIMARY KEY,           -- = Temporal workflowId
  workflow_id  text NOT NULL, version integer NOT NULL,
  channel_id   text NOT NULL, asset_id text,
  state        text NOT NULL,              -- running|waiting|compensating|completed|failed
  current_steps jsonb NOT NULL DEFAULT '[]',
  started_at   timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  FOREIGN KEY (workflow_id, version) REFERENCES workflow_version(workflow_id, version)
);

CREATE TABLE human_task (
  id text PRIMARY KEY, instance_id text NOT NULL REFERENCES workflow_instance(id),
  step_id text NOT NULL, channel_id text NOT NULL,
  assignee text, task_type text, review_point_id text,
  state text NOT NULL DEFAULT 'open',      -- open|completed|escalated|cancelled
  due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);

-- Append-only; powers the "where is this asset in its flow" overlay (FR-BMS-6).
CREATE TABLE step_history (
  id bigserial PRIMARY KEY, instance_id text NOT NULL, step_id text NOT NULL,
  event text NOT NULL,                     -- entered|awaiting|completed|failed|compensated
  at timestamptz NOT NULL DEFAULT now(), result jsonb
);
CREATE INDEX ix_step_history_instance ON step_history (instance_id, at);
```

## 8. REST API (concrete)

Beyond [`bms.yaml`](openapi/bms.yaml), the concrete request/response shapes:

```http
POST /api/v1/workflows/{id}/validate        # body: WorkflowDefinition (draft)
200 { "valid": false, "issues": [
       { "stepId": "s_gate", "severity": "error", "message": "branch has no default and edges don't cover all cases" },
       { "transitionId": "t_ok", "severity": "error", "message": "FEEL parse error at col 7" } ] }

POST /api/v1/workflows/{id}/publish
200 { "workflowId": "01J9...", "version": 4, "publishedAt": "2026-07-24T10:00:00Z" }
422 { "code": "VALIDATION_FAILED", "issues": [ ... ] }        # never publishes an invalid graph

GET  /api/v1/workflows/{id}/export?format=bpmn   ->  application/xml (BPMN 2.0 + DI + atlas: ext)
POST /api/v1/workflows/import  (application/xml)  ->  201 WorkflowDefinition (draft) | 422 {unsupported:[...]}
```

## 9. Command/event integration

### 9.1 Correlation by envelope echo (command steps)
BMS emits a command with `envelope.correlationId = "{instanceId}::{stepId}"`. Platform convention
([messaging](04-messaging-and-data.md)): a service **echoes `correlationId`** on its completion
event. The **event router** consumes completion subjects, parses `correlationId → (instanceId,
stepId)`, and `signalWorkflow(instanceId, "completion", {stepId, payload})`. No correlation store
needed for the request/response case.

### 9.2 Correlation by subscription (wait-event)
For events with no originating command, when a `wait-event`/approval step activates the interpreter
registers `{channelId, event, correlateKey}` → `instanceId::stepId` in a `correlation` table (or
Redis). The router evaluates the step's `correlate` FEEL over each incoming event, finds the
subscription, and signals. Subscriptions are removed when the step completes or times out.

As built (EP-22.6, bms.md §13f): the table is `event_awaits` — the keys as evaluated (`match`), the
asset among them as an indexed column — and the router never evaluates FEEL: it reads the open
awaits of the event's type in its channel, narrowed to the event's asset, and compares keys. An
await is answered at most once; a review step's two verdict rows are answered together.

### 9.3 Idempotency
Command activities carry an idempotency key `{instanceId}:{stepId}:{attempt}`; services dedupe.
The router de-dupes signals on `(instanceId, stepId, messageId)` — at-least-once delivery is safe.

## 10. Temporal interpreter

One **generic** Temporal Workflow interprets any definition; there is no per-flow code generation.

### 10.0 The `Effects` boundary (built + tested)

The interpreter's **control-flow logic is separated from Temporal** behind an `Effects` interface
(emit / wait / sleep / evalFeel / runChild / appendHistory). The pure interpreter goes through it
and never touches broker/DB/clock/Temporal directly — which makes it deterministic and unit-testable
with a simulated driver, **no Temporal server needed**. This is implemented and green in
[`reference/bms-workflow/src/engine/`](../../reference/bms-workflow/README.md): `interpreter.ts`
(pure) + `sim.ts` (in-memory driver) with tests covering happy/reject paths, retry+backoff,
compensation-in-reverse, await-timeout, parallel split/join, sub-flow, and human-task escalation.

Production supplies a **Temporal adapter** implementing the same `Effects`:

| `Effects` method | Temporal binding |
|------------------|------------------|
| `emitCommand` | an **activity** that publishes the command (envelope `correlationId = instanceId::stepId:attempt`) |
| `waitForCompletion` / `waitForEvent` / `waitForTask` | `await wf.condition(() => inbox.has(stepId), timeout)`; `inbox` filled by a **signal** the event router sends |
| `sleep` | `wf.sleep(ms)` (durable timer) |
| `now` | `wf.now()` (deterministic) |
| `createTask` / `escalate` | activities emitting `workflow.task.created` / escalation notifications |
| `runChild` | `wf.executeChild(atlasWorkflow, { args: [childDef, input] })` |
| `appendHistory` | activity writing `step_history` (feeds the FR-BMS-6 overlay) |

The interpreter is passed `def` as a workflow **argument** (pinned per instance, §10.6); only the
adapter is Temporal-specific, so the tested logic ships unchanged.

> **As built (EP-22.3)** — `apps/bms/src/engine` (the interpreter, lifted) and `src/temporal`
> (the adapter); [bms.md §13b](services/bms.md). Where it differs from the sketch below:
> - **One signal, `step`** (`{ stepId, payload }`), feeding one inbox — not separate completion and
>   task signals. A completion, a task outcome and an external event all release a waiting step the
>   same way, and one arriving before its step waits is kept.
> - **`appendHistory` is an awaited activity**, keyed by the instance's own sequence number, so a
>   retried write lands on the same row; every other activity commits behind a deterministic key
>   in the seen-mark table (§9.3's idempotency, at the activity).
> - The expression context has the **`steps` root** (`steps.<id>.output`, each step's `incoming`
>   when it completed) and `instance.id`; a human task's `assignee.expression` is evaluated before
>   the task is created.
> - A command step records `workflow.step.requested`; issuing the target's own command is EP-22.4.

### 10.1 Shape
```ts
// workflow (deterministic). def is passed in and frozen for this instance's life.
export async function atlasWorkflow(def: WorkflowDefinition, startCtx: StartContext) {
  const vars = initVars(def.vars, startCtx);
  const inbox = new Map<string, any>();                 // stepId -> completion payload
  wf.setHandler(completionSignal, ({ stepId, payload }) => inbox.set(stepId, payload));
  wf.setHandler(taskSignal,       ({ stepId, payload }) => inbox.set(stepId, payload));
  const compensations: string[] = [];                    // saga stack of completed step ids
  await runFrom(def, findStart(def), { vars, inbox, compensations });
}
```
Activities (non-deterministic I/O) are thin: `emitCommand`, `emitTaskCreated`, `mirrorState`,
`appendHistory`. All broker/DB access is in activities; the workflow body is pure control flow.

### 10.2 Step loop
`runFrom(step)` dispatches on `step.kind`, records `entered`/`completed` history (via activity),
maps outputs into `vars`, then follows outgoing transitions. Waiting steps use
`await wf.condition(() => inbox.has(step.id), toMs(step.timeout))`; a false return = timeout →
`onError`.

### 10.3 command
```ts
await retry(step.retry, async () => {
  await acts.emitCommand({ event: cfg.request.event, correlationId: `${wfId}::${step.id}`,
                           payload: feelObject(cfg.request.input, ctx) });
  if (cfg.await) {
    const got = await wf.condition(() => inbox.has(step.id), toMs(step.timeout));
    if (!got) throw new StepTimeout(step.id);
    applyMapping(cfg.await.output, inbox.get(step.id), vars);
  }
});
compensations.push(step.id);
```

### 10.4 parallel / branch / sub-flow
- **branch:** pick edge by FEEL `when` order → default; continue on the chosen edge.
- **parallel split→join:** `await Promise.all(outEdges.map(e => runPath(e.to, stopAtJoin)))`.
- **sub-flow:** `const r = await wf.executeChild(atlasWorkflow, { workflowId: childId(), args:[childDef, feelObject(cfg.input, ctx)] }); applyMapping(cfg.output, r, vars);`

### 10.5 determinism rules
Definition is a workflow **argument** (not fetched inside); FEEL eval is pure; time only via
`wf.now()`; ids via `wf.uuid4()`; all side effects in activities. This guarantees replay-safe
history.

### 10.6 versioning & pinning
Instance carries its **own frozen `def`** (started with it), so editing/publishing a new version
never affects running instances. Interpreter **code** changes use Temporal `patched()`/Worker
Versioning so long-running instances replay on the code they started with.

### 10.7 compensation (saga)
On unrecoverable failure, pop `compensations` in reverse and run each step's `compensation` handler
(itself a `command`), then move the instance to `Failed`. `onError: "fail"` skips compensation;
`onError: { transitionTo }` routes to an explicit error path instead.

As built (EP-22.9, bms.md §13h): a WAITING step's timeout — a human step's, a wait-event's — is a
failure that goes to its `onError` exactly as a command's exhausted retries do; `retry` is a
command's only. A task left open by a timeout, or by the run failing, is cancelled; a run that ends
`Failed` raises `alert.raised` (`workflow-failed`).

## 11. BPMN 2.0 converter (`libs/contracts/bpmn`)

Pure, dependency-light (server + browser). Uses **`bpmn-moddle`** to read/write BPMN 2.0 XML with a
custom **`atlas:` moddle extension** for engine policy. `bpmn-js` is **not** required (we render on
Foblex Flow); moddle alone does XML↔object.

### 11.1 Element mapping (DSL ⇄ BPMN)
| DSL | BPMN element | Notes |
|-----|--------------|-------|
| `start` (+trigger) | `bpmn:startEvent` (+`bpmn:messageEventDefinition`) | trigger event → message ref; `trigger.output` → the start event's `atlas:Io` out-mappings, as every step's output (EP-22.7) |
| `end` (terminate?) | `bpmn:endEvent` (+`bpmn:terminateEventDefinition`) | |
| `command` | `bpmn:serviceTask` | request/await/input/output in `atlas:` ext |
| `human-task` | `bpmn:userTask` | assignee/dueIn/escalation in `atlas:` ext |
| `wait-event` | `bpmn:intermediateCatchEvent` + message/signal def | |
| `timer` | `bpmn:*` timer event (`bpmn:timerEventDefinition`) | duration/date/cron |
| `branch` | `bpmn:exclusiveGateway` | `default` → gateway `default` attr |
| `parallel` | `bpmn:parallelGateway` | split/join as `gatewayDirection` (`Diverging`/`Converging`); a file that leaves it unspecified is read by degree |
| `sub-flow` | `bpmn:callActivity` (`calledElement`) | version in `atlas:` ext |
| `transition` | `bpmn:sequenceFlow` | `when` → `bpmn:conditionExpression` (feel) |
| `position` | `bpmndi:BPMNShape` bounds / `BPMNEdge` waypoints | see §11.3 |

**ID rule (NCName safety).** BPMN/XML `id` attributes must be valid `NCName`s — they **cannot start
with a digit**, so a raw ULID (`01J9…`) is an *illegal* BPMN id. The converter therefore prefixes on
export — process id `wf_{ulid}`, and any step/transition id that starts with a digit (the presets'
`s_*`/`t*` start with a letter and pass through; a ULID the designer mints does not) — and strips the
prefix on import. (Verified: the golden fixture round-trips through
`bpmn-moddle` with **zero warnings** only after this prefixing.) The real ULID remains the canonical
id in the DSL and in `workflow_version`.

### 11.2 Extension elements (moddle descriptor)
Engine-only policy with no native BPMN control-flow lives under `atlas:` so standard tools still
open the diagram:
```jsonc
// atlas.moddle.json (registered with bpmn-moddle)
{ "name": "Atlas", "prefix": "atlas", "uri": "http://atlas.example/bpmn",
  "types": [
    { "name": "Retry", "superClass": ["Element"],
      "properties": [ {"name":"maxAttempts","isAttr":true,"type":"Integer"},
                      {"name":"backoffType","isAttr":true,"type":"String"},
                      {"name":"initial","isAttr":true,"type":"String"},
                      {"name":"max","isAttr":true,"type":"String"},
                      {"name":"factor","isAttr":true,"type":"Real"} ] },
    { "name": "Io", "superClass": ["Element"],
      "properties": [ {"name":"mappings","type":"Mapping","isMany":true} ] },
    { "name": "Mapping", "properties": [ {"name":"target","isAttr":true,"type":"String"},
                                         {"name":"source","isAttr":true,"type":"String"} ] },
    { "name": "Await", "superClass": ["Element"],
      "properties": [ {"name":"event","isAttr":true,"type":"String"},
                      {"name":"correlate","isAttr":true,"type":"String"} ] },
    { "name": "Assignment", "superClass": ["Element"],
      "properties": [ {"name":"userId","isAttr":true,"type":"String"},
                      {"name":"role","isAttr":true,"type":"String"},
                      {"name":"reviewPointId","isAttr":true,"type":"String"},
                      {"name":"dueIn","isAttr":true,"type":"String"} ] } ] }
```
Attached to each element's `bpmn:extensionElements`. A vanilla BPMN tool ignores `atlas:*` but keeps
it on save (moddle preserves unknown-but-declared extensions), so **round-trips through third-party
tools stay lossless**.

### 11.3 Diagram interchange (layout)
`position.{x,y}` → `bpmndi:BPMNShape/dc:Bounds` (fixed per-kind width/height); transitions →
`bpmndi:BPMNEdge` with `di:waypoint`s (default straight source→target, overridable). Import reads
bounds back into `position`.

**As built (EP-23.2):** sizes are events 36×36, tasks 100×80, gateways 50×50. `position.x` is the
shape's LEFT edge and `position.y + 18` its vertical CENTRE, so steps of every kind placed on one
`y` line up on their centres (the golden fixture's layout); import inverts it from the bounds it
reads, whatever their size. An edge leaves its source's right side and enters its target's left —
straight on a shared centre line, one elbow half-way across otherwise. The DSL keeps no bend points,
so "overridable" is not built: an edge is drawn from where its ends are. A step with no `position`
(a definition written by an API client) is placed by its distance from the start (180 px columns,
120 px lanes); a file with no DI imports with no positions rather than invented ones.

### 11.4 Import validation & round-trip guarantee
Import parses via moddle, maps recognized elements, reads `atlas:` ext; **unsupported BPMN
constructs** (e.g. event sub-processes, complex/inclusive gateways not in our subset) produce a
`422` listing them rather than silently dropping. **Contract test:** `dsl → toBPMN → fromBPMN → dsl`
is deep-equal after canonicalization (id/order-normalized) — a CI gate on every DSL change (§14).

**As built (EP-23.2)** — `@atlas/contracts/bpmn` (`exportBpmn(def)`, `importBpmn(xml, { channelId })`,
`ImportFailure`), lifted from `reference/bms-workflow/src/bpmn`:

- **Node, not the browser.** The `atlas:` descriptor is read from
  `docs/architecture/workflows/atlas.moddle.json` (the single source, as the schemas are), so the
  converter runs where BMS runs; Studio imports and exports through BMS's `/workflows/import` and
  `/workflows/{id}/export` (EP-23.8). A subpath, so bpmn-moddle loads only where it is used.
- **What the file carries** is the graph, its layout, `description` (`bpmn:documentation`) and
  `scope` (`atlas:Scope`). What is the RECORD's — `channelId`, `version`, `status`, `metadata` — is
  not written: an import is a new draft (version 1) in the caller's channel, never the file's.
- **Lossless, now for every field the schema holds.** The reference dropped `timeout` and
  `compensation`, wrote `onError`/`retry` for command steps only, stringified var `initial`s and
  turned an absent sub-flow version into `latest`. The lift writes the step policy for every kind
  (`atlas:Retry`, `atlas:Timeout`, `atlas:OnError` with `compensation`), a form as `atlas:Form`
  (JSON), a non-string `initial` as JSON (read back by the var's declared type) and a var's
  `description`. The round-trip test holds all four presets, positions included, and a definition
  that uses every one of those fields.
- **Every id is an NCName**: an id starting with a digit — a ULID, which the designer mints — is
  written `wf_<id>`, and so is one already starting `wf_`, so reading strips exactly what writing
  added (a bijection, tested).
- **Refused, element by element** (`UNSUPPORTED_BPMN`): any flow node outside the eight (inclusive
  gateways, boundary events, sub-processes, script tasks…), an event definition a node cannot carry
  (a timer START, an error end), a catch event without exactly one message or timer, loops and
  multi-instance, lanes, a second process, a collaboration of more than one pool or with message
  flows, a sequence flow without both ends. A file that is not BPMN is `MALFORMED_XML`. A service
  task without `atlas:command` IMPORTS — mapping is not judging; the validator then says what it
  lacks, and publish gates it.
- **Over the wire (EP-23.8):** BMS's `POST /workflows/import` makes a file a NEW workflow's draft and
  `GET /workflows/{id}/export` writes a version out (bms.md §4); a refusal is the platform's 422
  problem with the converter's report as `details`. Studio's **Workflows** panel lists the
  channel's workflows, imports a file (`workflow:admin`) and downloads an export (any reader).

### 11.5 Example (excerpt)
```xml
<bpmn:serviceTask id="s_transcode" name="Transcode">
  <bpmn:extensionElements>
    <atlas:Retry maxAttempts="3" backoffType="exponential" initial="PT30S" factor="2" max="PT10M"/>
    <atlas:Await event="transcode.completed"/>
    <atlas:Io><atlas:Mapping target="vars.renditions" source="= incoming.renditions"/></atlas:Io>
  </bpmn:extensionElements>
  <bpmn:incoming>t1</bpmn:incoming><bpmn:outgoing>t2</bpmn:outgoing>
</bpmn:serviceTask>
<bpmn:sequenceFlow id="t_ok" sourceRef="s_gate" targetRef="s_end_ok">
  <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="feel">= vars.verdict = "approved"</bpmn:conditionExpression>
</bpmn:sequenceFlow>
```

## 12. Studio canvas (Angular + Foblex Flow)

> **Projection layer built + tested.** The library-agnostic core — a `GraphView` view-model
> (`toGraph`), pure edit operations (`addStep`/`connect`/`moveStep`/`setStepConfig`/`removeStep`/…,
> each returning a new definition), schema-driven property forms (`formFor`), and
> validation/status overlays (`applyIssues`/`applyStatus`) — is implemented and green in
> [`reference/bms-workflow/src/canvas/`](../../reference/bms-workflow/README.md) (8 tests: projection,
> build-a-valid-flow-via-ops, position-is-presentation-only, edge/step removal, schema-derived forms,
> marker overlay). Only the **thin Foblex binding + Angular shell** below remains app-side.

### 12.1 Architecture
A standalone `WorkflowDesignerComponent`. The **`WorkflowDefinition` is the source of truth** held
in an Angular **signal**; the Foblex Flow node/edge model is a *projection* of the `GraphView` kept
in two-way sync. Swapping the library later means re-mapping only `GraphView → Foblex`, never the
definition.

```
WorkflowDesignerComponent
├── PaletteComponent          # GET /workflows/palette -> draggable step kinds
├── FlowCanvas (@foblex/flow)  # nodes/edges <- projection of definition signal
│   └── StepNode (per kind)    # template chosen by kind; shows name + state color
├── PropertyPanelComponent    # dynamic form from the kind's configSchema (§12.3)
├── ValidationGutter          # issues from /validate, mapped to node/edge ids
└── Toolbar                    # validate · publish · export/import BPMN · versions
```

### 12.2 Model binding
- Drop from palette → append a `Step` (default config from schema, `position` = drop point) → signal
  update → Foblex renders the node.
- Foblex "connect" event → append a `Transition {from,to}`; a branch's out-edges expose a FEEL
  `when` editor.
- Node drag → write `position` back (presentation-only).
- Debounced (~400 ms) `POST /validate` → paint error/warn markers on nodes/edges; **Publish**
  disabled while any `error`.

**As built (EP-23.4)** — `apps/studio/src/app/editors/workflow-editor.ts`, an editor tab
(`workflow:<id>`) opened from the Workflows panel, over `workflow-graph.ts` (the reference's
projection and edit operations, typed by `@atlas/contracts/workflow-types`):

- **The definition is the one signal; Foblex Flow 19 renders it** in its classic (app-owned)
  mode — every gesture (`fCreateConnection`, `fMoveNodes`, `fSelectionChange`, `fDeleteSelected`)
  is a pure operation returning a new definition. Each step has one OUT connector (`out:<id>`,
  none on an end) and one IN (`in:<id>`, none on a start), so a connection maps back to a
  transition exactly.
- **Adding** is a palette button (the kinds `GET /workflows/palette` serves, labels localized),
  placed one column right of the rest; dragging a palette item onto the canvas is not built.
  Configuration is 23.5, a condition's FEEL 23.6.
- **Refused at once** — what the canvas can know for certain: an edge into a start, out of an end,
  onto itself, or twice. Everything else is the validator's, asked 400 ms after the last edit
  (only the latest run paints).
- **Removing** a selection takes every edge that touched it; a branch whose default edge went
  keeps no dangling `default`.
- **Positions**: every canvas node is one row (36 px) tall, so `position` — the BPMN layout's left
  edge and centre line (§11.3) — is also the node's top-left, and a diagram looks the same in
  Studio and in a BPMN tool.
- **Save** is the whole graph over the revision read; a 409 reads the workflow again (never a
  retry). With no draft open the latest published version is shown and saving opens the next.
  Read-only without `workflow:admin` or once archived.
- **Publish (EP-23.7)** is offered only on a graph BMS has judged clean — never while a judgement
  is pending (from the edit on, through the debounce) or has found an error. With unsaved edits it
  is *Save and publish*: the save first, then the publish over the revision that save returned.
  BMS judges it again: a 422's `details.issues` are painted on the canvas, a 403 is its reason (a
  command step's `requires`, authorization-model §8.1), a 409 a re-read. Warnings go with the new
  version and are counted in the notice.
- **Versions**: a picker of the editable definition (the draft, or the latest version when none is
  open) and every other published version, newest first, with who published it and when; a
  published version is shown READ-ONLY. Not while there are unsaved edits.
- **Lifecycle**: deactivate (active), activate (inactive), archive (either — final, so it takes a
  second click), each over the revision read; refused while instances run, the count from BMS's
  `details.running` shown.
- **Theme**: only Foblex's canvas and connection styles, their `--ff-*` properties set from
  Studio's tokens (`editors/flow-theme.scss`), loaded with the designer's lazy chunk — not in
  every user's first load.

### 12.3 Property forms from JSON Schema
Property panels are generated from each kind's `configSchema` (e.g. `@ngx-formly` with a
JSON-Schema preset, or a small custom renderer). FEEL fields get a FEEL input with client-side
parse hints (reuse the `feel` lib). **New step kind ⇒ zero canvas code** — the palette + schema
drive the form.

**As built (EP-23.5)** — a small custom renderer (`editors/schema-field.ts` over the pure
`schema-form.model.ts`), not formly: the schemas are a narrow, known subset, and one recursive
component reads them all.

- **What a field is comes from its schema alone.** Inlining (EP-23.1) erases what a `$ref` said,
  so `palette()` ANNOTATES: `x-atlas-type: feel | duration` where the field was a `Feel` or a
  `Duration`, and `x-choices: <key>` on the field a closed list constrains (a start's
  `trigger.event`, a wait-event's `event`, a command's `request.event`). Annotations, never
  `enum`: a draft may hold a value the list no longer has (an import, a retired command) — the
  select shows it, and publish is what refuses it.
- Fields: an object's properties (each its own field, nested ones grouped, required ones
  marked), a data mapping (rows of target → FEEL: add, rename in place, remove), an enum or a
  closed list (a select), FEEL (the expression editor, §3), a duration, text,
  a number, a boolean, a sub-flow version (a whole number or `latest`), and JSON for anything else
  (a human task's `form`), so nothing the schema allows is out of reach.
- Every edit emits the field's WHOLE new value up the tree; the designer replaces the step's
  `config` (`setStepConfig`) — one immutable definition signal, as for the canvas. An emptied
  optional field is ABSENT, not `''`.
- A selected EDGE has its own panel: its name, and — leaving a branch — its condition and
  whether it is the branch's default (one default per branch: the flag and the branch's
  `config.default` move together, as BPMN keeps them on the gateway).
- The palette is `workflow:admin`'s (EP-23.1), so a reader sees a step's configuration as JSON.
  Step-level policy (`timeout`, `retry`, `onError`, `compensation`) is not in the kinds' config
  schemas and has no panel yet.

### 12.4 Live-instance overlay (FR-BMS-6)
Open an instance → subscribe over [WebSocket](services/websocket.md) to its `step_history`; color
nodes (done/active/waiting/failed) on the **same** definition graph. Read-only mode.

**As built (EP-23.9).** The designer's *Instance* picker lists the workflow's recent runs
(`GET /instances?workflowId=`); picking one paints it on the version it is PINNED to (not the
draft), read-only, the validator's markers off. A step's status is its LAST history event in
sequence order (`entered` → active, `awaiting`/`escalated` → waiting, `completed` → done,
`failed`, `compensated`) — a loop shows its latest pass — and a step in the instance's
`currentSteps` is waiting whatever the mirror last wrote; a step never reached is uncoloured. The
side panel shows the run (state, who started it, when, its error) and its history in order.

**Not over a socket, as first written:** BMS publishes no event per step — the history is written
by its activities into its own mirror, not onto the bus. So a live run (`running`/`waiting`) is
re-read every 3 s, and at once when a `workflow.*` event names it (`workflow.step.requested`,
`workflow.task.created`, `workflow.completed`, read under `workflow:read`); following stops when
the run ends, or the overlay is left.

### 12.5 Offline
Canvas, validation (schema + FEEL parse can run client-side), and the BPMN converter are pure JS —
they work air-gapped. Only publish/persist needs the backend.

## 13. Observability (designer/engine specifics)

Beyond [bms.md §12](services/bms.md#12-observability): `validate` calls + error rates, publish
rate + rejected-publish count, BPMN import/export counts + unsupported-element hits, interpreter
signal-wait durations per step kind, timeout/compensation counts, correlation-store size, child-flow
depth. Every step transition → `step_history` + structured log with `correlationId`.

## 14. Testing

| Level | Target |
|-------|--------|
| Unit | validator rules (each row in §6); FEEL sandbox (determinism, no host access); mapping application. |
| Schema | golden valid/invalid definitions vs `workflow-definition.schema.json` (see scratch validator). |
| **BPMN round-trip** | `dsl→BPMN→dsl` deep-equal (canonicalized); exported XML opens in a stock BPMN tool; third-party BPMN import maps or fails-with-report. |
| Interpreter | Temporal `TestWorkflowEnvironment`: command await/timeout/retry/compensation; branch/parallel/sub-flow; **replay determinism** on recorded histories. |
| Correlation | envelope-echo and subscription paths; duplicate-signal idempotency. |
| Canvas | projection sync (definition⇄Foblex), validation marker mapping, publish-gating, overlay coloring. |
| E2E | author in canvas → publish → run the canonical flow on Temporal → overlay reflects progress; export→import elsewhere. |

## 15. Build order & module inventory

1. **Contracts:** `workflow-definition.schema.json` (done) → generated TS types → FEEL wrapper.
2. **Validator** (Tier 1 Ajv + Tier 2 graph) — pure lib, testable headless.
3. **BMS authoring API** (`/workflows`, `/palette`, `/validate`, `/publish`) + persistence (§7).
4. **Interpreter + activities + event router** on Temporal (§10, §9).
5. **BPMN converter** + `atlas.moddle.json` + round-trip tests (§11).
6. **Canvas** (Foblex Flow projection, palette forms, validation, overlay, export/import) (§12).

Each layer is independently testable against the frozen schema, so 2/3/4/5/6 parallelize after 1.

**Reference files (validated fixtures to build against):** [`workflows/`](workflows/README.md) —
preset definitions (all 9 kinds), [`palette.json`](workflows/palette.json),
[`atlas.moddle.json`](workflows/atlas.moddle.json), and the golden
[`canonical-ingest-to-air.bpmn`](workflows/fixtures/canonical-ingest-to-air.bpmn) (bpmn-moddle
round-trip: 0 warnings).

**Working reference implementation:** [`reference/bms-workflow/`](../../reference/bms-workflow/README.md)
implements steps 1–6 as **tested code** (29 passing tests) — the types, the Tier-1+Tier-2 validator,
the FEEL parse-check, the DSL⇄BPMN converter (**lossless `DSL → BPMN → DSL` round-trip** on all three
presets), the **pure interpreter** over the `Effects` boundary (§10.0; happy/reject paths, retry,
compensation, timeout, parallel, sub-flow, escalation), and the **library-agnostic canvas core**
(§12; projection, edit ops, schema-driven forms). Lift it into `libs/contracts` + the BMS service +
the Studio canvas.

---
_Related: [BMS spec](services/bms.md) · [BMS plan](../roadmap/services/bms-plan.md) ·
[WorkflowDefinition schema](schemas/workflow-definition.schema.json) ·
[Workflow assets](workflows/README.md) ·
[Review Lifecycle plan](../roadmap/15-review-lifecycle-implementation-plan.md)._
