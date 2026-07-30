# Atlas Reference Implementations

Working, **tested** code that realizes the design docs — drop-in starting points for the monorepo's
`libs/` and services. Everything reads the single-source contracts in
[`docs/architecture`](../docs/architecture) and ships **source only** (`node_modules` is git-ignored).

**Run:** `npm install` once here at `reference/` (the shared dependency root), then run any package's
tests, e.g. `cd contracts && node --import tsx --test test/*.test.ts`. (`contracts`, `messaging`, and
`service-kit` also carry their own `package.json` and can be installed standalone.)

| Package | What it is | Tests | Maps to |
|---------|-----------|:-----:|---------|
| [`contracts/`](contracts/README.md) | Executable message contracts: envelope build/validate + a payload validator for every event, ULID, subjects. | 8 | `libs/contracts` (system plan §3.1) |
| [`messaging/`](messaging/README.md) | Broker-agnostic transport: in-memory broker (dev/test), retry+DLQ, transactional outbox, idempotent consumers. | 6 | `libs/messaging` |
| [`service-kit/`](service-kit/README.md) | Per-service template: config, error taxonomy, correlation context, health, logger, JWT/JWKS. | 8 | `libs/service-kit` |
| [`data/`](data/README.md) | Data plane over `node:sqlite`: migration runner, `withTransaction`, JSON repo, SQL-backed outbox (the real transactional outbox). | 6 | `libs/data` |
| [`bms-workflow/`](bms-workflow/README.md) | The BMS workflow core: schema types, validator, lossless DSL⇄BPMN converter, pure interpreter, canvas core. | 29 | `libs/contracts` + BMS + Studio |
| [`mam-service/`](mam-service/README.md) | **Assembled service**: a MAM slice (ingest→create→ready→approve/reject/expire) built from the three libs. | 7 | how a service wires the libs |
| [`scheduling-service/`](scheduling-service/README.md) | **Second service + cross-service flow**: consumes MAM's lifecycle, enforces the approved-and-not-expired air guard; carries the two-service integration test. | 7 | how services integrate |
| [`notifications-service/`](notifications-service/README.md) | **Third consumer + fan-out**: turns `workflow.task.created`/`asset.expired` into per-user inboxes; carries the three-service fan-out test. | 6 | event fan-out |
| [`http-edge/`](http-edge/README.md) | **The HTTP edge** on mam-service: Fastify + JWT auth + permission checks + correlation + `toProblem`; tested via `inject()`. | 7 | the service's sync edge |

**Total: 84 passing tests.**

## How they compose

```
service-kit  ─ config/auth/health/logging/errors ─┐
contracts    ─ build & validate the envelope ──────┤
data         ─ persistence + transactional outbox ─┼→ a domain service (mam / scheduling / notifications)
messaging    ─ outbox → broker → idempotent consume ┘
bms-workflow ─ (BMS only) validate/convert/run workflows

                                  ┌─▶ scheduling-service  (pulls it from air)
mam-service ── asset.expired ─────┤                                            one event, many consumers
                                  └─▶ notifications-service (raises re-review)
```

The three service slices are the worked examples: each boots with `service-kit`, models events with
`contracts`, moves them with `messaging` (outbox + idempotent consumers). Their integration tests prove
the review lifecycle **across services** — MAM approves → Scheduling can air; MAM expires → Scheduling
pulls it **and** Notifications alerts the approver ([two-service](scheduling-service/test/integration.test.ts),
[three-service fan-out](notifications-service/test/fanout.test.ts)).

## Conventions

- **Node LTS + TypeScript, ESM.** Tests run via `tsx` + `node --test` (no build step).
- **Single-source contracts.** Packages read the JSON Schemas / fixtures under `docs/architecture`,
  so code and docs can't drift.
- **Everything committed is tested.** Pieces that need a live host to run — the **Temporal adapter**
  (Temporal server) and the **Foblex Flow + Angular canvas** (Studio app) — are documented as thin
  bindings over the proven `Effects` and `GraphView` cores, not shipped here.
- **Building this code surfaced real doc fixes**: the BPMN NCName-id rule, gaps in the `atlas:` moddle
  descriptor, and the envelope `type` pattern bug — each corrected in the docs.
