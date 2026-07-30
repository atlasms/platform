# BMS Workflow Assets

> Concrete, **validated** artifacts for the BMS visual designer + engine: preset flow definitions,
> the designer palette, the BPMN `atlas:` extension descriptor, and a golden BPMN fixture.
> Design: [BMS Workflow DSL, Designer, Engine & BPMN Converter](../bms-workflow-dsl-and-designer.md) ·
> Contract: [`workflow-definition.schema.json`](../schemas/workflow-definition.schema.json).

## Contents

| File | What it is | Status |
|------|-----------|--------|
| [`palette.json`](palette.json) | Reference payload for `GET /workflows/palette` — one entry per step kind (label, icon, BPMN element, config-schema pointer). | — |
| [`atlas.moddle.json`](atlas.moddle.json) | The `bpmn-moddle` extension descriptor for the `atlas:` namespace (engine policy carried in BPMN `extensionElements`). | round-trips clean |
| [`presets/canonical-ingest-to-air.workflow.json`](presets/canonical-ingest-to-air.workflow.json) | Ingest → transcode → ready → review → schedulable/rejected. Uses command+await, wait-event, human-task, branch. | schema+graph valid |
| [`presets/simple-approval.workflow.json`](presets/simple-approval.workflow.json) | Minimal approve/reject → publish. | schema+graph valid |
| [`presets/post-approval-distribution.workflow.json`](presets/post-approval-distribution.workflow.json) | Parallel fan-out to web/social/archive, then a settle timer. Uses parallel split/join, sub-flow, timer. | schema+graph valid |
| [`fixtures/canonical-ingest-to-air.bpmn`](fixtures/canonical-ingest-to-air.bpmn) | Golden **BPMN 2.0** export of the canonical preset (with `atlas:` ext + DI layout). The converter round-trip test target. | moddle: 0 warnings |

Across the three presets, **all nine step kinds** are exercised (start, end, command, human-task,
wait-event, timer, branch, parallel, sub-flow).

## Verified

These aren't sketches — they were checked:

- **Definitions:** validated with Ajv (2020-12) against
  [`workflow-definition.schema.json`](../schemas/workflow-definition.schema.json), plus Tier-2 graph
  checks (unique ids, resolvable `from`/`to`, exactly one `start`, reachability from `start`, every
  non-`end` step has an outgoing edge, branch has a default). All three PASS.
- **Golden BPMN:** parsed and re-serialized with `bpmn-moddle` + [`atlas.moddle.json`](atlas.moddle.json)
  — **0 warnings**; the `atlas:` engine policy (retry, await, IO mappings, user-task assignment,
  declared vars) reads back intact, the FEEL `conditionExpression` is preserved verbatim, and the
  round-trip is stable.
- **Gotcha baked in:** BPMN/XML ids must be `NCName`s (no leading digit), so the process id is
  `wf_{ulid}` — a raw ULID is illegal BPMN. See
  [design §11.1](../bms-workflow-dsl-and-designer.md#111-element-mapping-dsl--bpmn).

## Notes

- Preset definitions **omit a top-level `$schema` key** on purpose — the definition schema sets
  `additionalProperties:false`, so the schema is referenced here, not embedded in instances.
- These files are the fixtures the [converter round-trip test](../bms-workflow-dsl-and-designer.md#114-import-validation--round-trip-guarantee)
  and the [preset seed](../../roadmap/services/bms-plan.md) build against.
