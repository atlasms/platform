# AGENTS.md — how to continue this project

**Read this file first. It is the entry point.** It exists so you can pick up work without
reading the whole repository. Everything below is current as of the last commit on `main`.

---

## 1. What this is

**Atlas Automation** — a service-based media/broadcast automation platform (TV, radio, news, live
events): ingest → transcode → catalogue → review/approve → schedule → send-to-air, plus newsroom,
workflow, feeds and AI enrichment.

This repo (`atlasms/platform`) is **one Nx monorepo** holding the design docs _and_ the code.

- `docs/` — the design. Extensive and authoritative. **It is the source of truth, not the code.**
- `libs/` — shared TypeScript libraries (`@atlas/*`).
- `apps/` — one deployable per service, plus `studio` (the Angular SPA) and `walking-skeleton`.
- `reference/` — a **frozen, validated prototype** (84 passing tests) that is being lifted into
  `libs/` package by package. Do not develop here; lift from it.
- `scripts/` — GitHub project/backlog automation.

## 2. Orient yourself in ~10 minutes

Read these four, in order. Do **not** read the whole `docs/` tree.

| #   | File                                                                                             | Why                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | [`docs/roadmap/20-delivery-process.md`](docs/roadmap/20-delivery-process.md)                     | How we work: cadence, board, **Definition of Done**, commit/PR rules.      |
| 2   | [`docs/roadmap/21-epic-breakdown.md`](docs/roadmap/21-epic-breakdown.md)                         | **The backlog.** 46 epics; Phases 0–1 fully storied. Your task is in here. |
| 3   | [`docs/roadmap/16-system-implementation-plan.md`](docs/roadmap/16-system-implementation-plan.md) | Build order, foundations, cross-cutting engineering standards.             |
| 4   | [`docs/README.md`](docs/README.md)                                                               | Index of every other doc + the **Assumptions Register** (A1–A12b).         |

Then read **only** the specific docs your task touches — e.g.
[`docs/architecture/services/<service>.md`](docs/architecture/services/) plus its
[build plan](docs/roadmap/services/) and [OpenAPI stub](docs/architecture/openapi/).

## 3. Where the project currently stands

**Phase 0 (Foundations), iteration S01.** Planning is complete; the build has just started.

| Item                             | State                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design docs                      | ✅ Complete                                                                                                                                                                                                                                     |
| GitHub backlog                   | ✅ 175 issues on org project **#2**                                                                                                                                                                                                             |
| **EP-01** foundations            | ✅ **Complete** — monorepo, CI, CODEOWNERS, containers, K8s ([ADR-0002](docs/adr/0002-deployment-target.md)), [offline bundle](docs/operations/offline-bundle.md)                                                                               |     |
| **EP-02** `@atlas/contracts`     | ✅ 8 tests — loads all 53 schemas from `docs/`. ⬜ 02.2–02.6                                                                                                                                                                                    |
| **EP-03** `@atlas/messaging`     | ✅ 13 tests + `@atlas/messaging-nats` on **real JetStream** (13), on the `@nats-io/*` client (#207). [ADR-0001](docs/adr/0001-message-broker.md). ⬜ 03.4 DLQ tooling, 03.7 relay pipelining                                                    |
| **EP-04** `@atlas/service-kit`   | ✅ 34 tests — errors, config, auth, health, logging, **metrics + alerts**. ⬜ 04.7 tracing                                                                                                                                                      |
| **EP-05** `@atlas/policy`        | ✅ 13 tests, now also driving Studio rendering. ⬜ 05.5/05.6                                                                                                                                                                                    |
| **EP-06** `@atlas/reference`     | ✅ 17 tests. ⬜ 06.6 seed loader (Node-only, cannot live in a browser-safe entry point)                                                                                                                                                         |
| **EP-07** `@atlas/data`          | ✅ 11 tests + `@atlas/data-pg` on **real Postgres** (8). ⬜ 07.4–07.6                                                                                                                                                                           |
| **EP-08** `api-gateway`          | ✅ 36 tests, routes MAM, proxies bodies byte-transparently, **08.3 rate limiting + size caps** (per replica — see README). ⬜ 08.5 reference aggregation                                                                                        |
| **EP-09** `websocket`            | ✅ 16 tests. ⬜ 09.4 reconnect/polling (client-side, needs Studio)                                                                                                                                                                              |
| **EP-10** `iam`                  | ✅ 55 tests, incl. `/metrics` + auth signals (#205) and failed-attempt lockout (#240). ⬜ 10.4 CRUD, 10.6 event emission                                                                                                                        |
| **EP-13** walking skeleton       | ✅ 11 tests + **13.4 smoke suite green against a real cluster** (13/13, now including MAM)                                                                                                                                                      |
| **EP-11** Studio shell (Angular) | ✅ 11.1 skeleton, **11.2 real sign-in against IAM**, 11.3 the workbench, 11.7 `can()` rendering — 57 tests. ⬜ 11.4 ws, 11.5 clients, 11.6 i18n/RTL                                                                                             |
| **EP-17** `mam` (Phase 1)        | ✅ 238 tests — asset core, lifecycle, metadata gate, outbox events, Postgres, deployed, **17.2 extensible metadata**, **17.3 free-form tags**, **17.4 search**, field-group scoping (#225). ⬜ 17.7, 17.8 (need services that do not exist yet) |
| **EP-12** observability          | ✅ 12.4 alerts + golden signals on **every deployed service** (#205 closed the IAM gap); **[ADR-0003](docs/adr/0003-observability-stack.md) decided** (Prometheus/Loki/Grafana/Alloy, optional overlay). ⬜ 12.1–12.3 implementation            |

**422 tests across 14 projects, all green** (counted from `nx run-many -t test`, not carried
forward), merged to `main`. A further **54 need real infrastructure** — 34 in `mam`, 12 in
`messaging-nats`, 8 in `data-pg` — and **CI now runs those too**, against a Postgres service and a
JetStream container the workflow provides. They still skip on a laptop without Docker, but a
missing `ATLAS_PG_URL` / `ATLAS_NATS_URL` **in CI is a hard failure**, so the infrastructure cannot
be removed without the build saying so. Plus **13 smoke tests** against a deployed cluster (not in
CI — there is no cluster there, #126).

> **Start here to understand how it fits together:**
> [`apps/walking-skeleton`](apps/walking-skeleton/) wires the whole spine in one process and proves
> it end to end — gateway auth → service authorization → atomic outbox → relay → broker →
> permission-checked fan-out, with one correlation id threaded through every hop. Reading that test
> file is the fastest way to see how the pieces compose.

**CI runs on every PR** (`nx affected`) and on `main` (everything), and it now **blocks merge**.
The repository is public, which is what unblocked rulesets, and
[`main` is enforced](.github/rulesets/README.md): PR required, `lint · typecheck · test` green,
no force-push, no deletion, **no bypass for anyone including admins**. A direct push to `main` is
refused server-side.

Run `npx nx run-many -t lint typecheck test` before opening a PR anyway — or enable the local hook
(`git config core.hooksPath .githooks`), which fails in ~1 minute instead of after a push, a PR and
a CI run.

⚠️ **Public repo.** Everything you commit is world-readable, including history. Secret scanning and
push protection are on, but they only catch _provider_ patterns — they will not save you from
committing a customer name, an internal hostname or a real credential in a novel format.

**The dev cluster now runs the real spine:** Postgres + NATS + IAM + MAM + gateway, with
`npm run smoke` asserting the whole path from login to an atomic write and its relayed event.
Studio signs in against it for real — `npm run k8s:up`, then `npm start -w @atlas/studio`, which
proxies `/auth` and `/api` to the gateway.

**Suggested next tasks:** `EP-12.1/12.2/12.3` (build the stack [ADR-0003](docs/adr/0003-observability-stack.md)
decided — every service now emits the signals it consumes) ·
`EP-11.5` (generated API clients, so Studio panels can show real assets) · `EP-03.4` (DLQ tooling) ·
`EP-08.5` (aggregated `GET /reference`).

> **Adapters are separate packages, held to shared conformance suites.** `@atlas/messaging` and
> `@atlas/data` keep zero (or near-zero) runtime dependencies and define the rules;
> `@atlas/messaging-nats` and `@atlas/data-pg` implement them against real servers. The suites
> (`@atlas/messaging/conformance`, `@atlas/data/conformance`, `@atlas/mam/store-conformance`) run in
> CI against **both** — the in-memory / sqlite doubles _and_ real Postgres and JetStream, which the
> workflow provides. **Add a behaviour to the suite, not to one implementation.**
>
> A service's persistence follows the same shape: `MamService` talks to an async `AssetStore` port
> with a sqlite and a Postgres adapter. **A domain service must be async end to end** — a sync
> driver can satisfy an async contract, never the reverse, and production is Postgres.

> **Real servers are available for local work:** `docker compose -f infra/docker-compose.dev.yml up -d`
> gives Postgres, NATS and RabbitMQ on non-default ports ([infra/README.md](infra/README.md)).
> **CI runs Postgres and JetStream too**, on the default ports, via the workflow — so an adapter
> change is verified against the real server on every PR, not only when whoever wrote it happened
> to have Docker running. Locally those suites still _skip_ without `ATLAS_PG_URL` /
> `ATLAS_NATS_URL`; in CI a missing one is a hard failure, because a silent skip there is
> indistinguishable from a passing suite. **Every test must still pass against `node:sqlite` and
> `InMemoryBroker`** — the doubles are the fast path, not a lesser one. RabbitMQ is not in CI: it
> exists only for the spike behind ADR-0001, which rejected it.

> **⚠️ If you enforce authorization, call `canEnforce`, never `can`.** Lenient `can()` treats a
> predicate it cannot check as "any", so an **incomplete context yields a WIDER grant**.
> [authorization-model.md §5.1](docs/architecture/authorization-model.md) is normative.

> **All the foundation libs are leaf nodes**; the edges live above them:
> `data → messaging`, `api-gateway → contracts, service-kit`,
> `iam → contracts, policy, service-kit`, `websocket → contracts, messaging, policy, service-kit`.

## 4. Find and claim your task

The backlog is on GitHub. `gh` must be authenticated with the **`project`** scope.

```bash
# What is ready to work on
gh issue list --repo atlasms/platform --state open --limit 20

# One story's full detail (goal, DoD, refs)
gh issue view <number> --repo atlasms/platform

# The board
gh project item-list 2 --owner atlasms
```

Issue titles are `EP-nn — Epic title` and `EP-nn.s — Story title`, matching
[doc 21](docs/roadmap/21-epic-breakdown.md) exactly. **Stories are sub-issues of their epic.**

> ⚠️ **Never guess an issue number.** Epic `EP-01` is `#1`, but story `EP-01.1` is `#47` — they are
> nowhere near each other. Always resolve the number with `gh issue list` before writing
> `Closes #n`. This has been got wrong twice.

## 5. Non-negotiable rules

These come from [the Definition of Done](docs/roadmap/20-delivery-process.md#7-definition-of-done).
Violating them silently breaks the architecture:

1. **Contracts first.** Update the [OpenAPI stub](docs/architecture/openapi/) and/or the
   [event payload schema](docs/architecture/schemas/) **before or with** the implementation. The
   schemas in `docs/` are loaded at runtime by `@atlas/contracts` — they are live code, not
   documentation.
2. **Docs ship in the same PR as the code.** The docs are the design memory; a PR that changes
   behaviour without changing docs is incomplete.
3. **`channelId` on every row and every message.** Queries are channel-scoped by default.
4. **Every write goes out through the outbox**; every consumer is **idempotent**.
5. **Authorization is enforced server-side** via `can()` from `@atlas/policy`. Client-side checks are
   UX only, never the boundary.
6. **Mutating actions emit an audit event with a field-level delta.**
7. **Correctness-critical code — HSM file operations, send-to-air export, the authorization
   evaluator — needs 2 reviewers + pairing and is explicitly NOT AI-fast-tracked.** If your task
   touches these, say so and slow down.

## 6. Toolchain — and traps already paid for

**Stack:** Node LTS + TypeScript, **ESM only**, built-in `node:test` runner, `tsx` for execution.
**Libraries have no build step** — `exports` points straight at `./src/index.ts`.

Do not "modernise" any of the below. Each was decided or discovered the hard way:

| Trap                                                                | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Imports carry explicit `.ts` extensions**                         | Correct — required by the no-build-step design. `allowImportingTsExtensions` is on. Don't strip them.                                                                                                                                                                                                                                                                                                                                                                                              |
| **Cross-package imports must use `@atlas/*`, never relative paths** | `reference/` uses `../../contracts/src/index.ts` because it predates workspaces. **Rewrite on lift** and declare the dep in `package.json`. Nx builds its graph from specifiers; a relative import compiles fine but produces **no graph edge**, silently disabling consumer-fanout CI.                                                                                                                                                                                                            |
| **`ajv` must be imported by full specifier**                        | Use `ajv/dist/2020.js` for **both** value and types. A bare `'ajv'` can resolve to an **ajv 6** copy (pulled in by eslint), whose `export =` typings are incompatible with v8's class. Runtime is fine; it fails only at type-time. Which copy is hoisted **changes with any dependency update** — ajv@8 sits at the root today, ajv@6 did before — so keep the full specifier regardless of what `node_modules` currently looks like. See [`libs/contracts/README.md`](libs/contracts/README.md). |
| **`docs/` is excluded from prettier**                               | Deliberate — the markdown has hand-aligned tables that prettier would reflow. Don't remove it from `.prettierignore`.                                                                                                                                                                                                                                                                                                                                                                              |
| **A missing graph edge can be correct**                             | `messaging` genuinely does not import `contracts` (it is schema-agnostic). Don't "fix" it.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Nx Cloud is off**                                                 | Required: the build must work air-gapped ([FR-PLat-7](docs/requirements/05-functional-requirements.md#platform)). Keep caching local.                                                                                                                                                                                                                                                                                                                                                              |
| **Every message id must be globally unique (a ULID)**               | JetStream dedupes on `msgID` across the **whole stream**, not per subject. Reuse an id — a counter, a natural key, `'m1'` in a test — and `publish()` resolves successfully while the message is **silently discarded**. Pinned by a test in [`libs/messaging-nats`](libs/messaging-nats/).                                                                                                                                                                                                        |
| **A JetStream durable is a shared cursor**                          | Durables are named per **(service, pattern)**. Two instances of one service sharing a durable is right (work splits). Two _different_ services sharing one means each steals half the other's events. Never name a durable after the pattern alone.                                                                                                                                                                                                                                                |
| **`@types/node` tracks the RUNTIME, not `latest`**                  | We run Node **24** (engines, CI `node-version`, `node:24-alpine`), so the types are pinned `^24`. Dependabot will offer 26; that is one major AHEAD and types APIs the runtime does not have. Two majors behind is equally wrong — it hides APIs that exist. Move this pin when the runtime moves, not before.                                                                                                                                                                                     |
| **`npm run verify` must include `npm ci --dry-run`**                | CI installs with `npm ci`, which REFUSES a `package-lock.json` out of sync with `package.json`. Nothing else locally does — `npm install` silently reconciles the two, so an override or a dep edit passes every local check and fails CI in 6 seconds. That is what `lock:check` is for; do not drop it from `verify`.                                                                                                                                                                            |
| **No `baseUrl`/`paths` in any tsconfig**                            | `baseUrl` is deprecated in TS 6 and stops working in 7. It only ever anchored `paths`, and `paths` was dead config: these are npm workspaces, so `@atlas/foo` resolves via the `node_modules` symlink and that package`s own `exports`. Do not add either back to "fix" an import — fix the workspace dep instead.                                                                                                                                                                                 |
| **Studio runs its own toolchain — don't unify it**                  | `@atlas/studio` needs TypeScript **6.0** (Angular 22) while the libs are on **5.9**, uses **vitest** not `node:test` (component tests need a DOM), and has its own `tsconfig.json` rather than extending `tsconfig.base.json`. The strictness is reproduced there explicitly. See [its README](apps/studio/README.md).                                                                                                                                                                             |
| **Studio is the only project that emits**                           | So `allowImportingTsExtensions` alone is illegal there; it also needs `rewriteRelativeImportExtensions`. And ignore patterns must be `**/dist/**`, not `dist/**`.                                                                                                                                                                                                                                                                                                                                  |
| **Never use a constructor parameter property**                      | Containers run `node src/main.ts` on Node's **strip-only** TypeScript support, which refuses syntax that _emits_ code — parameter properties, enums, namespaces. One anywhere in a service's import graph breaks **every** container at startup while every test still passes. Enforced by eslint.                                                                                                                                                                                                 |
| **Container images copy nested `node_modules`**                     | Not just the root. `ajv@8` lives in `libs/contracts/node_modules` because eslint hoists an incompatible `ajv@6` to the root; an image with only the root tree dies on a package npm installed correctly. See [`infra/docker/Dockerfile`](infra/docker/Dockerfile).                                                                                                                                                                                                                                 |
| **In Studio, lenient `can()` is CORRECT**                           | The opposite of the service rule. Studio decides what to _show_; the service enforces. `canEnforce` in the UI would hide legitimate controls whenever a check runs before the resource loads. Use `canStrict()` only for destructive actions with full context.                                                                                                                                                                                                                                    |
| **Never read back inside a transaction**                            | On `node:sqlite` an uncommitted write is visible to the same connection; on Postgres it is not visible outside the transaction's own client. A read-after-write inside the unit of work therefore **passes every test and returns stale data in production**. Read before the transaction, or through the tx client.                                                                                                                                                                               |
| **`await` the handler inside its `try`**                            | `return fn()` from a `try` settles the promise after the `catch` is out of scope, so every rejection escapes to Fastify's default handler as a bare 500 — losing the problem document, the status code and the correlation id. `return await fn()`.                                                                                                                                                                                                                                                |
| **The gateway forwards BYTES; it must not parse a body**            | Fastify's default JSON parser rejects an EMPTY body, and `POST /assets/{id}/approve` with `content-type: application/json` and no body is the normal case — it 500'd at the gateway before ever reaching MAM. It also re-serialized (breaking any checksum) and refused every non-JSON upload. Catch-all buffer parser.                                                                                                                                                                            |
| **Log every 5xx where it is raised**                                | A 500 is deliberately opaque to the caller, so it is invisible to the operator too unless the service logs it with the same correlation id. An unlogged 500 in a cluster is undebuggable — you cannot even tell which pod raised it.                                                                                                                                                                                                                                                               |
| **Wait for the database at startup, within a budget**               | Exiting when Postgres is not up yet hands the problem to Kubernetes' restart backoff, which grows to 5 minutes: measured, 7 restarts and 16 minutes to ready on a fresh install. Retry — but bounded, or a wrong password retries forever and never reports itself.                                                                                                                                                                                                                                |
| **Refresh the token SINGLE-FLIGHT**                                 | IAM rotates refresh tokens and treats a reused one as a breach signal, revoking the whole family — every session, everywhere. Two concurrent refreshes is the NORMAL case when a token expires mid-load, so an in-flight refresh must be shared, never restarted. Same shape as MAM`s `PolicyClient`.                                                                                                                                                                                              |
| **Studio never persists a token**                                   | `localStorage`/`sessionStorage` are readable by any script on the origin, so persisting the REFRESH token gives one XSS a long-lived credential. A reload signing the user out is the deliberate, safer trade; the real fix is an httpOnly cookie from IAM and it is a server change.                                                                                                                                                                                                              |
| **Every login path does ONE argon2 verification**                   | Returning early for a refused account — locked, disabled, SSO-only — costs microseconds while a wrong password costs ~100ms, so the timing says "this account exists" even though the response is identical. Lockout (#240) made it worse: an attacker can CAUSE the lock and read the timing to confirm a username. Verify first, branch after. Pinned by a test that fails if the order is restored.                                                                                             |
| **No identity is ever a metric label**                              | `/metrics` is unauthenticated, so a `username` label publishes the account list to anyone who can reach the port — and a login spray writes its guesses into a document it can read back. It is the same bug as the cardinality one: a series per guess. Who failed is an AUDIT question; how many failed is the metrics question, and its label set is closed (#205).                                                                                                                             |

## 7. Commands

```bash
npm install                       # workspace install (npm workspaces)

npx nx run-many -t lint typecheck test    # verify everything
npx nx test @atlas/contracts              # one project
npx nx affected -t test                   # only what your change impacts
npx nx show projects
npm run format                            # prettier --write

node scripts/seed-github-backlog.mjs      # dry run; --execute to create issues
```

**Always run `npx nx run-many -t lint typecheck test` before committing.** Strict TS
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) catches real bugs
in lifted code — expect a few, and fix them properly rather than loosening the config.

## 8. How to lift a package from `reference/`

This is the dominant task shape in Phase 0. Recipe:

1. `cp -r reference/<pkg>/{src,test,README.md} libs/<pkg>/`
2. Add `package.json` (name `@atlas/<pkg>`, `type: module`, `exports` → `./src/index.ts`, scripts
   `test` / `typecheck` / `lint`) and `tsconfig.json` extending `../../tsconfig.base.json`.
   Copy an existing one from [`libs/contracts`](libs/contracts/) — do not invent a new shape.
3. **Rewrite relative cross-package imports to `@atlas/*`** and declare those deps in `package.json`.
4. `npm install`, then `npx nx run-many -t lint typecheck test`.
5. Fix strict-mode findings properly. Run `npm run format`.
6. Mark the row ✅ in [`libs/README.md`](libs/README.md).
7. Verify the graph picked up the new edges:
   `npx nx graph --file=graph.json` and inspect `graph.dependencies`.

Paths note: `reference/<pkg>/src/` and `libs/<pkg>/src/` are the **same depth** from the repo root,
so `../../../docs/...` references keep working unchanged.

## 9. Committing

- Branch off `main`: `<type>/<issue-number>-<slug>`. Never commit directly to `main`.
- **Conventional commits**, scoped to the story: `feat(EP-04.1): lift service-kit into libs/`.
  Types are the usual set plus **`spike`** (a spike is a first-class work item here, and CI
  enforces the list — see [`ci.yml`](.github/workflows/ci.yml)).
- Explain **why** in the body, not just what — especially any decision or trade-off.
- `Closes #<number>` — only if the story is _fully_ done. If partial, use `Refs #<n>` and say what
  remains. (EP-03 closed only `#66` for exactly this reason.)
- End with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## 10. When you are unsure

- **A design question** → the answer is almost certainly already in `docs/`. Search before deciding.
- **A genuine gap in the design** → resolve it in the docs _first_, then implement. Don't encode a
  decision only in code.
- **An architectural choice with lasting consequences** (broker, storage engine, framework) → stop
  and ask the human. Spikes exist for this: they are time-boxed and **must produce a written
  artifact**, never just "we looked into it".
- **Report honestly.** If tests fail, say so with output. If you did part of a story, say which part.
  Never mark something done that you have not verified.

---

_Maintained by hand — update §3 whenever the project state moves._
