# ADR-0010 — BMS runs workflows on Temporal

- **Status:** Accepted — chosen by the product owner, 2026-10-12, on the design's case without
  running the comparison spike (see *Evidence*)
- **Date:** 2026-10-12
- **Stories:** EP-22.1 (this ADR); built by EP-22.2 – EP-22.10
  ([#22](https://github.com/atlasms/platform/issues/22))
- **Design:** [BMS](../architecture/services/bms.md),
  [workflow DSL & designer §10](../architecture/bms-workflow-dsl-and-designer.md#10-temporal-interpreter)

## Context

BMS orchestrates multi-step media workflows: a definition (the JSON DSL, convertible to BPMN) is
run as an instance that issues commands to other services, waits for their completion events,
waits for people (review, tasks), sleeps on timers that may span days (expiry, escalation),
retries, compensates — and must survive restarts, rolling updates and node loss at every one of
those points (FR-BMS-1…6).

The design named two ways to make that durable and left the choice to a spike
([02-system-architecture](../architecture/02-system-architecture.md),
[service catalog](../architecture/03-service-catalog.md)):

| Option | What it is |
|---|---|
| **Temporal** (TypeScript SDK) | A durable-execution server; one generic workflow interprets any definition, its history replayed after a crash |
| **Broker-backed saga** | Instance state in BMS's own Postgres tables, timers as leased rows, the same pattern as MTS's job table and RIM's recorders |

The interpreter's control flow already sits behind an `Effects` interface (emit / wait / sleep /
evalFeel / runChild / appendHistory), built and tested with an in-memory driver in
[`reference/bms-workflow`](../../reference/bms-workflow/README.md) — so either runtime is an adapter
under logic that does not change.

## Options

**Temporal.** Durable timers, retries with backoff, signals, child workflows, history and replay
are the product, not code we write. The DSL design (§10) is written against it, binding every
`Effects` method to a Temporal primitive. Cost: a stateful server in every installation (frontend,
history, matching and worker roles, one process at our scale) with its own schema, and an
operational surface operators must learn; the TS SDK carries a native core.

**Broker-backed saga.** No new infrastructure: everything is Postgres and NATS, which every install
already runs and the restore drill already covers. Cost: we build and own durable timers, retry,
idempotent resumption, history and child-flow semantics — the part of a workflow engine that is
hard to get right and expensive to test — and the design's §10 is rewritten.

## Evidence

No comparison spike was run. The product owner chose on the design's case: the hard part of BMS
is the engine semantics, Temporal supplies them, and the `Effects` boundary keeps the fallback cheap —
were Temporal to prove unworkable for an air-gapped install, the saga is an adapter under the same
tested interpreter, not a rewrite.

What EP-22.3 must establish, and record here, before BMS is deployed beyond the dev cluster:

1. **The worker runs in our image.** The TypeScript SDK's worker loads a native core (Rust); our
   images are `node:24-alpine`. Whether a musl build is published for the SDK version we pin decides
   whether BMS's image takes a glibc base (`node:24-slim`) — the shared Dockerfile's `BASE` would
   become per-service.
2. **Workflow code under strip-only TypeScript.** The worker bundles workflow code for its
   deterministic sandbox; the bundle is built at image build time, not at start-up, and the rule
   against emitting syntax (parameter properties, enums) still holds.
3. **Persistence on our Postgres.** Temporal's default and visibility stores on the platform's
   Postgres, in a database of their own, schema applied by Temporal's admin tool as an install step.
4. **A crash test.** The canonical ingest-to-air preset (EP-22.7) survives killing the BMS worker
   and the Temporal server mid-wait, and the restore drill restores an instance that was waiting.

## Decision

1. **Temporal is BMS's durable runtime**, through the TypeScript SDK, behind the existing `Effects`
   interface. One generic workflow interprets any published definition (§10); no per-flow code.
2. **Self-hosted, in-cluster, air-gap safe.** The Temporal server runs as a workload of the
   platform (manifests in `infra/k8s/base`, so the generated Helm chart carries it — ADR-0006);
   its images are in the offline bundle; no Temporal Cloud, nothing reaching out.
3. **Its state lives in the platform's Postgres**, in its own database (not a schema of a service's),
   so backups and the restore drill cover it; quiescing for a drill stops BMS's workers before the
   dump. Temporal owns those tables: they are outside `schema:check`, which holds the tables our code
   creates.
4. **One Temporal namespace per installation.** Channel isolation is the platform's, not
   Temporal's: every instance carries its `channelId` (workflow memo + search attribute), and BMS's
   API authorizes on it like any service.
5. **The platform's rules hold at the boundary.**
   - A command step's activity writes the command to **BMS's outbox** (and its `step_history` row)
     in one transaction — never publishes directly (AGENTS.md rule 4).
   - Completion events reach a waiting instance through BMS's **event router**, a durable consumer
     that signals the instance; signals are at-least-once and the interpreter dedupes on
     `(instanceId, stepId, messageId)` (§9.3).
   - Every state change BMS records (definitions, instance mirror, task creation) emits
     `audit.recorded` in its transaction; Temporal's own history is the engine's, not the audit log.
6. **Version pins.** The Temporal server and SDK versions are pinned like any dependency; interpreter
   code changes use Temporal's `patched()` / worker versioning (§10.6) so running instances replay.

## Consequences

- One more stateful component to install, monitor (its metrics into the observability overlay) and
  upgrade; the operations runbook gains its section with EP-22.3.
- The pilot profile's sizing (doc 07 §9, `infra/helm/profiles/pilot.yaml`) grows by Temporal's
  footprint; `k8s:check`'s fit test catches it.
- Long timers (expiry re-review, escalations) are Temporal timers — cheap, durable, and visible in
  the instance overlay.
- The saga stays a viable fallback for as long as nothing outside the adapter imports Temporal.

## Revisit when

- Any of the four EP-22.3 checks fails in a way that cannot be met with a base-image change.
- A customer install cannot run the server (a platform where the extra stateful workload is refused).
- Temporal's licence or its self-hosted distribution changes.
