# ADR-0010 — BMS runs workflows on Temporal

- **Status:** Accepted — chosen by the product owner, 2026-10-12, on the design's case without
  running the comparison spike; checks 1–3 of *Evidence* run and passed the same day (BMS's image is
  `node:24-slim`, not Alpine), check 4 owed
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

What EP-22.3 must establish, and record here, before BMS is deployed beyond the dev cluster — four
checks. **Checks 1–3 were run on 2026-10-12** against real containers (Temporal server 1.32.1, the
TypeScript SDK 1.24.0, Node 24.21.0, the dev compose Postgres 17); the harness is
[`spikes/temporal/run.sh`](../../spikes/temporal/run.sh) and reproduces every line below from scratch.

### 1. The worker in our image — **not on Alpine; on `node:24-slim`, yes**

The SDK's native core (`@temporalio/core-bridge`) ships prebuilt binaries for linux-x64/arm64 **gnu**,
macOS and Windows — no musl build. On our base image it does not load:

| Base | Result |
|---|---|
| `node:24-alpine` (every service's today) | `Error loading shared library ld-linux-x86-64.so.2 … (needed by …/core-bridge/releases/x86_64-unknown-linux-gnu/index.node)` |
| `node:24-alpine` + `gcompat` | `Error relocating …/index.node: gnu_get_libc_version: symbol not found` |
| **`node:24-slim`** (Debian, glibc) | **worker ready in 737–926 ms; an activity and a durable timer ran** |

The slim run was in our container shape: **read-only root filesystem** (`/tmp` a tmpfs), **non-root**
(`node`), `node src/worker.ts` on Node's strip-only TypeScript — no tsx, no bundler at start.

### 2. Workflow code bundled at image build — **yes**

`bundleWorkflowCode` runs in the image build (`RUN node bundle.mjs`: 1.56 MB, 2.2 s of webpack, 3.3 s
in all) and the worker loads the file (`workflowBundle: { codePath }`), so webpack never runs in a
pod and start-up stays under a second. The workflow source is TypeScript; the SDK's own swc compiles
it in the bundle, so the strip-only rule (no emitting syntax) binds only the worker's side.

### 3. Temporal's state on our Postgres — **yes, and it is the only copy**

- Two databases of their own in the platform's Postgres, **`temporal`** and **`temporal_visibility`**,
  created and migrated by Temporal's admin tool (`temporalio/admin-tools`, `temporal-sql-tool
  --plugin postgres12`: `create-database`, `setup-schema -v 0.0`, `update-schema -d
  …/postgresql/v12/{temporal,visibility}/versioned`) — schema 1.19 and 1.14. The `postgres12` plugin
  is the one for Postgres ≥ 12; ours is 17. Visibility needs no Elasticsearch.
- The server (`temporalio/server`, env `DB=postgres12`, `POSTGRES_SEEDS`, `DBNAME`,
  `VISIBILITY_DBNAME`) **refuses to start without a dynamic-config file** —
  `DYNAMIC_CONFIG_FILE_PATH` must name one (a ConfigMap in the cluster).
- A namespace is created once per install (`temporal operator namespace create --namespace atlas`).
- An instance started and left WAITING on a signal (one row in `executions`) survived the server
  container being **deleted and recreated** and the worker being restarted: on the fresh server it
  took the signal and completed, its 15-event history replayed from Postgres.

### 4. A crash test — **owed** (EP-22.7's preset, killing the worker and the server mid-wait, and the
restore drill restoring a waiting instance)

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

- **BMS's image is `node:24-slim`, not Alpine** (check 1): the shared Dockerfile's base becomes a
  per-service build argument, and BMS's `k8s:build` line passes the glibc one. Every other service
  stays on Alpine. The SDK carries 176 MB of `node_modules` (native builds for every platform);
  EP-22.3 prunes the other platforms' from the image.
- The install gains Temporal's steps: the two databases and their schema by the admin tool (an init
  Job, like the services' own migrations), a dynamic-config ConfigMap, the namespace.
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
