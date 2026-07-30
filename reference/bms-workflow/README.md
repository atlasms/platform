# @atlas/bms-workflow — reference implementation

Working, tested reference code for the BMS workflow contract. It turns the
[design](../../docs/architecture/bms-workflow-dsl-and-designer.md) into running code you can lift
into the monorepo's `libs/contracts` + BMS service.

**What's here**

| Module | Responsibility |
|--------|----------------|
| [`src/types.ts`](src/types.ts) | TS types mirroring [`workflow-definition.schema.json`](../../docs/architecture/schemas/workflow-definition.schema.json). *(In the monorepo: generate these from the schema.)* |
| [`src/schema.ts`](src/schema.ts) | Tier-1 validation (Ajv 2020-12 against the schema). |
| [`src/feel.ts`](src/feel.ts) | FEEL parse-check + `vars.*` reference extraction (via `feelin`). |
| [`src/validate.ts`](src/validate.ts) | Tier-2 graph & semantic validator → `ValidationIssue[]` (design §6). |
| [`src/bpmn/export.ts`](src/bpmn/export.ts) | DSL → BPMN 2.0 XML (`bpmn-moddle` + the `atlas:` extension). |
| [`src/bpmn/import.ts`](src/bpmn/import.ts) | BPMN 2.0 → DSL, rejecting out-of-subset constructs. |
| [`src/engine/interpreter.ts`](src/engine/interpreter.ts) | The **pure** workflow interpreter over an [`Effects`](src/engine/effects.ts) boundary (design §10). |
| [`src/engine/sim.ts`](src/engine/sim.ts) | In-memory `Effects` driver (virtual clock + responders) for deterministic tests. |
| [`src/canvas/`](src/canvas/) | Library-agnostic designer core: `GraphView` projection, pure edit ops, schema-driven property forms, marker/status overlays (design §12). |

The interpreter's **control flow is separate from Temporal** — it goes through `Effects`
(emit/wait/sleep/evalFeel/runChild), so it runs and is tested here with `sim.ts` and no Temporal
server. Production supplies a thin Temporal adapter implementing the same interface
([design §10.0](../../docs/architecture/bms-workflow-dsl-and-designer.md#100-the-effects-boundary-built--tested)).
The canvas core (`src/canvas/`) is likewise **library-agnostic** — it emits a `GraphView` and pure
edit ops; only the thin Foblex Flow binding + Angular shell live in Studio.

## Run it

```bash
npm install
npm test         # node --test via tsx — 29 tests
npm run typecheck
```

Source and fixtures are single-sourced from the docs tree
([`../../docs/architecture/schemas`](../../docs/architecture/schemas) and
[`../../docs/architecture/workflows`](../../docs/architecture/workflows)) — the reference impl reads
the same schema, `atlas.moddle.json`, presets, and golden BPMN the docs define, so they can't drift.

## What the tests prove (all green)

- **Validator:** the 3 presets validate clean; a broken transition target, an unbalanced FEEL
  expression, a defaultless all-conditional branch, and an undeclared `vars.*` reference are each
  caught with the right code/severity.
- **BPMN converter:**
  - the golden fixture round-trips through `bpmn-moddle` with **0 warnings**;
  - `import(golden BPMN)` reproduces the canonical DSL graph exactly;
  - `export(DSL)` yields parseable BPMN carrying the `atlas:` policy + FEEL conditions;
  - **`DSL → BPMN → DSL` is lossless** (graph-equal) for **all three presets** — the interop guarantee;
  - importing out-of-subset BPMN (e.g. an inclusive gateway) throws `ImportFailure` with an
    `unsupported[]` report rather than silently dropping.
- **Interpreter** (via the `sim.ts` driver): the canonical flow runs end-to-end (command input/output
  mapped via FEEL, branch chosen by verdict); the reject path takes the default edge; a command
  **retries with exponential backoff** then succeeds; exhausted retries with `onError: compensate`
  run **compensation in reverse**; an await **timeout** fails the run; **parallel split/join +
  sub-flow + timer** all execute; and **human-task escalation** fires when the task is slow.
- **Canvas core:** a definition projects to a `GraphView`; a **complete valid flow is built purely
  through edit operations** (then passes the validator); `moveStep` changes only position (execution
  unaffected); `removeStep` drops connected edges; **property forms derive from the schema `$defs`**;
  validation issues + live status overlay onto node/edge markers.

"Graph-equal" = `vars` + `steps` (minus canvas `position`) + `transitions`. Workflow header fields
(`id`, `channelId`, `version`, `status`, `scope`) are DB-side metadata (`workflow_version`), carried
on export as the process id (`wf_{ulid}`) / name, not required to survive the graph round-trip.

## CI wiring

The BPMN round-trip is a real committed test ([`test/bpmn.test.ts`](test/bpmn.test.ts)). Gate every
change to the schema, the `atlas:` descriptor, or the converter on it:

```yaml
# .github/workflows/bms-workflow.yml
name: bms-workflow
on:
  pull_request:
    paths: ['reference/bms-workflow/**', 'docs/architecture/schemas/**', 'docs/architecture/workflows/**']
jobs:
  test:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: reference/bms-workflow } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
```

## Notes / next

- `node_modules` is not committed — run `npm install` first.
- Known simplifications vs. the full design: the exporter omits BPMN **DI** (canvas positions), which
  the golden fixture shows by hand and the graph round-trip ignores; header fields carry as noted
  above. The interpreter is proven via the `sim.ts` driver; the **Temporal adapter** (binding
  `Effects` to real activities/signals/timers) is documented in
  [design §10.0](../../docs/architecture/bms-workflow-dsl-and-designer.md#100-the-effects-boundary-built--tested)
  but not run here (needs a Temporal server). Neither affects the logic these tests prove.
- Next: generate `types.ts` from the schema in the build; wire the Temporal adapter + a
  `TestWorkflowEnvironment` smoke test in CI; build the Foblex Flow canvas against the palette.
