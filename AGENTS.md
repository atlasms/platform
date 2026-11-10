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
- `scripts/` — GitHub project/backlog automation, the CI checks (`api:check`, `graph:check`, `tier0:check`, `schema:check`, and `check-changelog` on pull requests), and **`setup.sh` / `setup.ps1`** — a new machine from nothing to smoke-green, requirements check first ([`SETUP.md`](SETUP.md)).
- `tools/` — local Nx generators. **`npx nx g service <name>` is how a service starts** ([`tools/generators/README.md`](tools/generators/README.md)).

## 2. Orient yourself in ~10 minutes

(A new machine? [`SETUP.md`](SETUP.md) — requirements, every manual step, and the script that does them.)

Read these four, in order. Do **not** read the whole `docs/` tree.

| #   | File                                                                                             | Why                                                                   |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 1   | [`docs/roadmap/20-delivery-process.md`](docs/roadmap/20-delivery-process.md)                     | How we work: cadence, board, **Definition of Done**, commit/PR rules. |
| 2   | [`docs/roadmap/21-epic-breakdown.md`](docs/roadmap/21-epic-breakdown.md)                         | **The backlog.** 46 epics; Phases 0–2 storied. Your task is in here.  |
| 3   | [`docs/roadmap/16-system-implementation-plan.md`](docs/roadmap/16-system-implementation-plan.md) | Build order, foundations, cross-cutting engineering standards.        |
| 4   | [`docs/README.md`](docs/README.md)                                                               | Index of every other doc + the **Assumptions Register** (A1–A12b).    |

Then read **only** the specific docs your task touches — e.g.
[`docs/architecture/services/<service>.md`](docs/architecture/services/) plus its
[build plan](docs/roadmap/services/) and [OpenAPI stub](docs/architecture/openapi/).

## 3. Where the project stands

**Phase 1 (MVP) is built** — the ingest → validate → transcode → metadata → search → schedule
spine is on `main`, held by the smoke suite, the MVP acceptance journey, a performance sanity
check and a rehearsed restore drill (EP-21). **Phase 2 is storied and under way**: BMS (EP-22) and
its workflow designer (EP-23) are done; Notifications (EP-25) and MTS/MAM v2 work are in progress.
The nine Phase-2 product decisions were taken on 2026-10-12 (doc 21's Phase-2 table).

| Item | State |
| --- | --- |
| Design docs | ✅ Complete |
| GitHub backlog | org project **#2** — Phases 0–2 storied |
| Tests | green across the Nx projects; smoke + acceptance + isolation suites against a live kind cluster |

**The per-epic state — what each `EP-nn` has shipped, the defects found on the way, the test
counts, and the current suggested next tasks — lives in [`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md).**
Read the row for the epic your task touches; it moves whenever the project does, so most sessions
never load the full status.

**Start here to understand how it fits together:** [`apps/walking-skeleton`](apps/walking-skeleton/)
wires the whole spine in one process and proves it end to end — gateway auth → service authorization
→ atomic outbox → relay → broker → permission-checked fan-out, one correlation id through every hop.
Reading that test file is the fastest way to see how the pieces compose.

### Process and cross-cutting rules

**CI blocks merge.** It runs on every PR (`nx affected`) and on `main` (everything); `main` is
enforced ([.github/rulesets](.github/rulesets/README.md)) — PR required, `lint · typecheck · test`
green, no force-push, no bypass for anyone. Run `npx nx run-many -t lint typecheck test` before a PR,
or enable the local hook (`git config core.hooksPath .githooks`).

⚠️ **Public repo.** Everything you commit is world-readable, history included. Secret scanning catches
_provider_ patterns only — not a customer name, an internal hostname or a credential in a novel format.

**The dev cluster runs the real spine** (Postgres, NATS, OpenSearch, every service, Temporal,
gateway): `npm run k8s:up`, then `npm run smoke` asserts login → atomic write → relayed event → audit
history through the gateway. Studio signs in for real via `npm start -w @atlas/studio`. Real servers
for local unit work: `docker compose -f infra/docker-compose.dev.yml up -d` (Postgres, NATS).

⚠️ **Enforcing authorization: call `canEnforce`, never `can`.** Lenient `can()` treats a predicate it
cannot check as "any", so an incomplete context yields a WIDER grant
([authorization-model §5.1](docs/architecture/authorization-model.md)).

⚠️ **Every state-changing consumer is idempotent.** Call the durable `SeenStore`'s `mark(tx, id)`
INSIDE the handler's unit of work (the audit sink, MAM's FileRef mirror and MTS's command consumer
are the precedents). The per-replica WebSocket bridge is the one exception — it fans out, so
per-replica dedup is all it can use. See [`libs/messaging/README.md`](libs/messaging/README.md).

**Adapters are separate packages, held to shared conformance suites.** `@atlas/messaging` /
`@atlas/data` define the rules with ~zero deps; `@atlas/messaging-nats` / `@atlas/data-pg` implement
them against real servers. The suites run in CI against **both** the in-memory/sqlite doubles AND
real Postgres/JetStream. **Add a behaviour to the suite, not to one implementation**, and every test
must still pass against `node:sqlite` + `InMemoryBroker`. A domain service is **async end to end**.

**The foundation libs are leaf nodes**; edges live above: `data → messaging`,
`api-gateway → contracts, service-kit`, `iam → contracts, policy, service-kit`,
`websocket → contracts, messaging, policy, service-kit`.

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
3. **`channelId` on every row and every message.** Queries are channel-scoped by default. `schema:check` holds every `CREATE TABLE` to it: `channel_id … NOT NULL`, or a reason in [`tables.json`](docs/architecture/schemas/tables.json). Every service owns ONE Postgres schema named after it (EP-07.6) — a table name is unique per owner, never shared across services.
4. **Every write goes out through the outbox**; every consumer is **idempotent**.
5. **Authorization is enforced server-side** via `can()` from `@atlas/policy`. Client-side checks are
   UX only, never the boundary.
6. **Mutating actions emit an audit event with a field-level delta.** That event is [`audit.recorded`](docs/architecture/schemas/events/audit.recorded.payload.schema.json), in the SAME transaction as the change, and MAM's `commitWith` is the pattern: every write, including the ones that announce no domain event. This was not true until EP-19.2 — `asset.updated` named the changed fields and nothing carried the values.
7. **Correctness-critical code — HSM file operations, send-to-air export, the authorization
   evaluator — needs 2 reviewers + pairing and is explicitly NOT AI-fast-tracked.** If your task
   touches these, say so and slow down.

## 6. Toolchain — and traps already paid for

**Stack:** Node LTS + TypeScript, **ESM only**, built-in `node:test` runner, `tsx` for execution.
**Libraries have no build step** — `exports` points straight at `./src/index.ts`.

Do not "modernise" any of the below. Each was decided or discovered the hard way:

| Trap                                                                         | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Imports carry explicit `.ts` extensions**                                  | Correct — required by the no-build-step design. `allowImportingTsExtensions` is on. Don't strip them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Cross-package imports must use `@atlas/*`, never relative paths**          | `reference/` uses `../../contracts/src/index.ts` because it predates workspaces. **Rewrite on lift** and declare the dep in `package.json` — BOTH halves matter: with `useInferencePlugins: false` Nx builds this graph from `package.json` declarations, so an undeclared `@atlas/*` import produces **no graph edge** even though it resolves and typechecks, and a relative one never could. Either silently disables consumer-fanout CI for that package. **Enforced**: `npm run graph:check` (in `verify` and in CI, ahead of `nx affected`) diffs every import in `src/` and `test/` against the graph Nx actually computes, and names the fix.                                                                                                |
| **`ajv` must be imported by full specifier**                                 | Use `ajv/dist/2020.js` for **both** value and types. A bare `'ajv'` can resolve to an **ajv 6** copy (pulled in by eslint), whose `export =` typings are incompatible with v8's class. Runtime is fine; it fails only at type-time. Which copy is hoisted **changes with any dependency update** — ajv@8 sits at the root today, ajv@6 did before — so keep the full specifier regardless of what `node_modules` currently looks like. See [`libs/contracts/README.md`](libs/contracts/README.md).                                                                                                                                                                                                                                                   |
| **`docs/` is excluded from prettier**                                        | Deliberate — the markdown has hand-aligned tables that prettier would reflow. Don't remove it from `.prettierignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **A missing graph edge can be correct**                                      | `messaging` genuinely does not import `contracts` (it is schema-agnostic). Don't "fix" it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Nx Cloud is off**                                                          | Required: the build must work air-gapped ([FR-PLat-7](docs/requirements/05-functional-requirements.md#platform)). Keep caching local. `nx.json` says `neverConnectToCloud: true` — without it Nx 24 POSTs to the Nx Cloud API on EVERY run (a GitHub remote is enough) to mint the `cloud.nx.app/connect/…` link at the foot of its performance report. `affected.legacy: true` keeps `nx affected` selecting whole projects (Nx 24 picks tasks), which is what 01.3's consumer fanout is written against.                                                                                                                                                                                                                                           |
| **Every message id must be globally unique (a ULID)**                        | JetStream dedupes on `msgID` across the **whole stream**, not per subject. Reuse an id — a counter, a natural key, `'m1'` in a test — and `publish()` resolves successfully while the message is **silently discarded**. Pinned by a test in [`libs/messaging-nats`](libs/messaging-nats/).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **A JetStream durable is a shared cursor**                                   | Durables are named per **(service, pattern)**. Two instances of one service sharing a durable is right (work splits). Two _different_ services sharing one means each steals half the other's events. Never name a durable after the pattern alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Consumer dedup depends on what the consumer DOES**                         | There is no single right `SeenStore`, and the two wrong choices fail in opposite directions. A consumer that **writes to a database** needs a durable store whose mark commits **inside the handler's transaction** (`SqliteSeenStore`/`PgSeenStore.mark(tx, id)`): claim on a separate connection, crash mid-handler, and the id is marked for an effect that never happened — every redelivery is then suppressed and the message is lost. A consumer that **fans out to its own connections** (the websocket bridge) needs the per-process `InMemorySeenStore`: sharing dedup across those replicas means replica A claims the message and replica B's clients silently never receive it. Neither mistake shows up in a single-replica unit test. |
| **`@types/node` tracks the RUNTIME, not `latest`**                           | We run Node **24** (engines, CI `node-version`, `node:24-alpine`), so the types are pinned `^24`. Dependabot will offer 26; that is one major AHEAD and types APIs the runtime does not have. Two majors behind is equally wrong — it hides APIs that exist. Move this pin when the runtime moves, not before.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **`npm run verify` must include `npm ci --dry-run`**                         | CI installs with `npm ci`, which REFUSES a `package-lock.json` out of sync with `package.json`. Nothing else locally does — `npm install` silently reconciles the two, so an override or a dep edit passes every local check and fails CI in 6 seconds. That is what `lock:check` is for; do not drop it from `verify`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **No `baseUrl`/`paths` in any tsconfig**                                     | `baseUrl` is deprecated in TS 6 and stops working in 7. It only ever anchored `paths`, and `paths` was dead config: these are npm workspaces, so `@atlas/foo` resolves via the `node_modules` symlink and that package`s own `exports`. Do not add either back to "fix" an import — fix the workspace dep instead.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Studio runs its own toolchain — don't unify it**                           | `@atlas/studio` needs TypeScript **6.0** (Angular 22) while the libs are on **5.9**, uses **vitest** not `node:test` (component tests need a DOM), and has its own `tsconfig.json` rather than extending `tsconfig.base.json`. The strictness is reproduced there explicitly. See [its README](apps/studio/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Studio is the only project that emits**                                    | So `allowImportingTsExtensions` alone is illegal there; it also needs `rewriteRelativeImportExtensions`. And ignore patterns must be `**/dist/**`, not `dist/**`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Never use a constructor parameter property**                               | Containers run `node src/main.ts` on Node's **strip-only** TypeScript support, which refuses syntax that _emits_ code — parameter properties, enums, namespaces. One anywhere in a service's import graph breaks **every** container at startup while every test still passes. Enforced by eslint.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Temporal's worker needs glibc — BMS is not on Alpine**                     | The TypeScript SDK's native core (`@temporalio/core-bridge`) ships linux **gnu** builds only. On `node:24-alpine` it fails to load (`ld-linux-x86-64.so.2` missing); with `gcompat` it fails to relocate (`gnu_get_libc_version`). Measured, not assumed — ADR-0010 evidence, `spikes/temporal/run.sh`. BMS builds on `node:24-slim`; every other service stays Alpine. Do not "unify" the base image, and do not add `gcompat` and call it fixed.                                                                                                                                                                                                                                                                                                   |
| **BMS's worker prefers the build-time workflow bundle**                      | `bundle.mjs` writes `apps/bms/dist/workflow-bundle.js` at image build, and the worker loaded it whenever it EXISTED — so a bundle left on a laptop by an earlier run made every test against a local Temporal run THAT day's workflow code against today's activities, and pass (found in EP-22.4: a week-old bundle). It now loads the bundle only when it is newer than every file in `apps/bms/src` (always, in the image) and logs when it falls back to bundling from source. Don't "optimise" the check away. Related: an activity's error reaches the workflow as `ActivityFailure` ("Activity task failed") — unwrap its `cause` where a person will read the reason.                                                                        |
| **A just-registered Temporal namespace is not usable for seconds**           | BMS registers its namespace at start-up, and the frontend's namespace cache answers `NamespaceNotFound` for a few seconds afterwards — a start in that window failed CI once (#531) and would fail a fresh install's first start. `start()` retries `NamespaceNotFoundError` for a bounded 10 s, then rethrows. Do not widen it to other errors: a namespace that is really missing must still fail.                                                                                                                                                                                                                                                                                                                                                 |
| **Temporal's SQL pools are capped — keep them capped**                       | `temporalio/server`'s defaults (20 per pool, idle connections kept) held **65 of the platform Postgres's 100** on the dev cluster once warm; every service then met `too many clients already` at random — the isolation suite (EP-30.2) found it as a 500 from Notifications' inbox, not a Temporal error. `SQL_MAX_CONNS`/`SQL_MAX_IDLE_CONNS`/`SQL_VIS_*` in `infra/k8s/base/temporal.yaml` (and so the chart). A new service with a pool adds to the same 100: count before raising either.                                                                                                                                                                                                                                                      |
| **The internal signing-key Secrets are OPTIONAL to the chart**               | `hsm-internal-keys`, `rim-internal-keys`, `hsm-read-keys` and `iam-read-keys` (ADR-0008) are referenced `optional: true`, so an install without them STARTS — and then refuses every placement in HSM, every recording hand-off, availability checks and role/group inbox resolution. The dev overlay generates them; a site creates them before the first install ([helm README](infra/helm/README.md)). A new signed pair adds its Secret there, to the dev overlay and to that table.                                                                                                                                                                                                                                                             |
| **An image installs ONE workspace's dependencies**                           | The Dockerfile runs `npm ci --workspace=@atlas/<service>`: the service, the `@atlas/*` libraries it DECLARES and their dependencies — nothing a sibling needs. It is why no image but BMS carries Temporal's SDK (176 MB). The flip side: a package a service imports without declaring it resolves on a laptop (the whole tree is installed there) and is MISSING in the image. `graph:check` catches an undeclared `@atlas/*` import; a third-party one shows only in the image — declare it (`feelin` in BMS was one).                                                                                                                                                                                                                            |
| **Container images copy nested `node_modules`**                              | Not just the root. `ajv@8` lives in `libs/contracts/node_modules` because eslint hoists an incompatible `ajv@6` to the root; an image with only the root tree dies on a package npm installed correctly. See [`infra/docker/Dockerfile`](infra/docker/Dockerfile).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **In Studio, lenient `can()` is CORRECT**                                    | The opposite of the service rule. Studio decides what to _show_; the service enforces. `canEnforce` in the UI would hide legitimate controls whenever a check runs before the resource loads. Use `canStrict()` only for destructive actions with full context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **An undefined CSS token fails SILENTLY**                                    | `var(--nope)` is invalid at computed-value time, so it falls back to the INHERITED value rather than erroring. Three Studio panels shipped reading 14 tokens `styles.scss` never declared — invisible buttons, un-red errors, and lint/typecheck/tests green throughout. Declare every token in BOTH palettes. `--color-<s>` is a foreground and `--color-<s>-bg` its tint; never fill a control with a status colour and write on it in `white`, because the palette inverts between themes.                                                                                                                                                                                                                                                        |
| **`dir="rtl"` mirrors the whole grid**                                       | Grid and flex tracks run along the INLINE axis, so RTL moves Studio's activity bar and side bar to the right of the screen. Anything measured in physical pixels must flip with it — the side-bar drag delta and its arrow keys multiply by `direction() === 'rtl' ? -1 : 1`, or the side bar shrinks when you drag it open. Prefer logical properties; `box-shadow` has no logical form and needs a `[dir='rtl']` rule.                                                                                                                                                                                                                                                                                                                             |
| **Studio's i18n is RUNTIME, not `$localize`**                                | `LocaleService` fetches `/locales/<l>.json` and switches on a signal. Angular's `i18n` block in `angular.json` is the opposite — BUILD-time, one bundle per locale from XLIFF/ARB — so do not add one: a stale `i18n.locales.ar` pointing at the runtime map was dead config that `ng build --localize` would reject. The **assets** entry copying `src/locales` is what makes translations work, and a missing key renders as the key itself rather than as an error.                                                                                                                                                                                                                                                                               |
| **A file in `generated/` must be in `SPECS`**                                | `rim.types.ts` carried the `GENERATED … DO NOT EDIT` banner while `scripts/generate-api-types.mjs` listed only iam and mam, so `api:check` never compared it for a month — and it had drifted, typing three optional contract fields as required (hence `NaN GB` in the ingest queue). Adding a Studio client for a service means adding its contract to `SPECS` in the same change.                                                                                                                                                                                                                                                                                                                                                                 |
| **Never read back inside a transaction**                                     | On `node:sqlite` an uncommitted write is visible to the same connection; on Postgres it is not visible outside the transaction's own client. A read-after-write inside the unit of work therefore **passes every test and returns stale data in production**. Read before the transaction, or through the tx client.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **`await` the handler inside its `try`**                                     | `return fn()` from a `try` settles the promise after the `catch` is out of scope, so every rejection escapes to Fastify's default handler as a bare 500 — losing the problem document, the status code and the correlation id. `return await fn()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **The gateway forwards BYTES; it must not parse a body**                     | Fastify's default JSON parser rejects an EMPTY body, and `POST /assets/{id}/approve` with `content-type: application/json` and no body is the normal case — it 500'd at the gateway before ever reaching MAM. It also re-serialized (breaking any checksum) and refused every non-JSON upload. Catch-all buffer parser.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Log every 5xx where it is raised**                                         | A 500 is deliberately opaque to the caller, so it is invisible to the operator too unless the service logs it with the same correlation id. An unlogged 500 in a cluster is undebuggable — you cannot even tell which pod raised it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Wait for the database at startup, within a budget**                        | Exiting when Postgres is not up yet hands the problem to Kubernetes' restart backoff, which grows to 5 minutes: measured, 7 restarts and 16 minutes to ready on a fresh install. Retry — but bounded, or a wrong password retries forever and never reports itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Refresh the token SINGLE-FLIGHT**                                          | IAM rotates refresh tokens and treats a reused one as a breach signal, revoking the whole family — every session, everywhere. Two concurrent refreshes is the NORMAL case when a token expires mid-load, so an in-flight refresh must be shared, never restarted. Same shape as MAM`s `PolicyClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Studio never persists a token**                                            | `localStorage`/`sessionStorage` are readable by any script on the origin, so persisting the REFRESH token gives one XSS a long-lived credential. A reload signing the user out is the deliberate, safer trade; the real fix is an httpOnly cookie from IAM and it is a server change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Every login path does ONE argon2 verification**                            | Returning early for a refused account — locked, disabled, SSO-only — costs microseconds while a wrong password costs ~100ms, so the timing says "this account exists" even though the response is identical. Lockout (#240) made it worse: an attacker can CAUSE the lock and read the timing to confirm a username. Verify first, branch after. Pinned by a test that fails if the order is restored.                                                                                                                                                                                                                                                                                                                                               |
| **A client-settable header is INPUT, even an "internal" one**                | `x-correlation-id` is the one internal header the gateway adopts from the client, and it was adopted verbatim — any string, straight into every service's log line for that request, the outbox headers and an audit record whose contract says ULID. A test even pinned `'corr-from-studio'` as the expected value, and another had loosened `isUlid(...)` to `\|\| length > 0` around it. Validate the shape at the edge and mint on failure; do not widen the assertion.                                                                                                                                                                                                                                                                          |
| **The broker body is the ENVELOPE, and the payload is inside it**            | Every producer publishes `body: buildEnvelope({ type, channelId, payload })`, so a consumer reads `body.payload.<field>`, never `body.<field>`. The websocket bridge read one level too high, and its test — which published a bare payload — agreed with it. Type the body as `Envelope<EventPayloads['<type>']>` (generated, EP-02.3) and the level is a compile error; and make a consumer test publish through `buildEnvelope`, so it can only pass against what a producer actually sends.                                                                                                                                                                                                                                                      |
| **Studio's specs share ONE jsdom — and one `localStorage`**                  | `@angular/build:unit-test` defaults `isolate: false` "to align with the Karma/Jasmine experience", so every spec file runs in the same environment. `EditorStore` persists the workspace to `localStorage` and restores it on construction, so a tab one spec file opens is silently already open when the next file starts — which files share a worker is scheduling, so it passed on every PR and failed on `main` (`expected 1 to be 2`). `src/test-setup.ts` clears storage before every test; a spec cannot guard against what another file left behind, so do not fix a leak like this in one spec.                                                                                                                                           |
| **A route table nothing builds a `Router` from is untested**                 | `app.routes.ts` carried `canMatch` on the `''` redirect since EP-11.2; Angular 22 refuses the pair at router construction (NG04014 — a redirect happens before any guard runs) and Studio crashed at startup while every spec stayed green, because each panel spec drives its component and the guards were tested as functions: nothing ever handed the real `routes` to `provideRouter`. `app.routes.spec.ts` now does, and navigates the three cases (signed out → `/signin`, granted → `/media`, ungranted → the catch-all). A config the framework validates at construction is only tested by constructing it.                                                                                                                                |
| **`rollout status` returning is not "reachable through the Service"**        | The pod is Ready a few hundred ms to a couple of seconds before kube-proxy has programmed its endpoint; a request through the gateway in that window is `502 upstream "mam" unreachable`. Smoke went red on `main` on a docs-only commit: MAM listening at :10.995, the suite's first MAM-bound request at :11.978, three 502s, then green — 0 restarts. Gate on the upstream answering THROUGH the gateway (the smoke suite's third test), not on `kubectl` saying Available.                                                                                                                                                                                                                                                                       |
| **An `enum` in a schema is a Tier-0 decision; make it once, in `common`**    | Code branches on a Tier-0 enum; an operator manages a Tier-1/2 list. An `enum` keyword looks identical either way, so the decision is written down: `docs/architecture/schemas/tier0-enums.json`, by pointer, with the reason — and `tier0:check` fails on a new enum that is not there. A shared enum is ONE `$def` in `common.schema.json`, `$ref`'d from every site: "task kind" was three inline copies with two value sets, and the BMS event could not express a task the BMS workflow definition allowed. If the honest reason is "an operator should manage this", it is not an enum.                                                                                                                                                        |
| **The gateway's routing table is `productionRoutes`, held to the contracts** | The production table is `productionRoutes` in `apps/api-gateway/src/routing.ts`; `defaultRoutes` beside it is a TEST fixture listing services that do not exist. EP-19.1 added a route to the fixture only and found it when smoke got the gateway's own `no route` 404; EP-21.1 found MAM's `/search`, `/tags` and `/field-schemas` had NO route at all while Studio called them. Now `test/routes.test.ts` reads every deployed service's OpenAPI contract and fails on a declared path that does not reach its owner — a new service means its contract in that test's `DEPLOYED` and its prefixes in `productionRoutes`.                                                                                                                         |
| **A comma ends an unquoted value inside `{ … }` in YAML**                    | The OpenAPI stubs use flow mappings, and in one `{ type: string, description: Why it failed, or why not. }` is a description of "Why it failed" plus a KEY named "or why not." with a null value. Nothing breaks — JSON Schema ignores unknown keywords — so the contract and every doc comment generated from it silently say half of what was written. Seventeen sat in four contracts. Quote any description with a comma in a flow mapping; `api:check` now fails on a key with no value in ANY contract.                                                                                                                                                                                                                                        |
| **An `effect` that calls `EditorStore.setDirty` must write `untracked`**     | `setDirty` READS the layout signal it writes, so an `effect(() => editors.setDirty(tab, dirty()))` depends on its own write and never settles — the designer's spec hung its worker for six minutes with no error and `tests 0ms`. The other editors call `setDirty` imperatively; an effect reads its inputs, then writes inside `untracked(() => …)` (`workflow-editor.ts`). Related: jsdom has no `ResizeObserver`, which Foblex Flow constructs for every node — `test-setup.ts` stubs one.                                                                                                                                                                                                                                                      |
| **No identity is ever a metric label**                                       | `/metrics` is unauthenticated, so a `username` label publishes the account list to anyone who can reach the port — and a login spray writes its guesses into a document it can read back. It is the same bug as the cardinality one: a series per guess. Who failed is an AUDIT question; how many failed is the metrics question, and its label set is closed (#205).                                                                                                                                                                                                                                                                                                                                                                               |

## 7. Commands

```bash
npm install                       # workspace install (npm workspaces)

npx nx run-many -t lint typecheck test    # verify everything
npx nx test @atlas/contracts              # one project
npx nx affected -t test                   # only what your change impacts
npx nx show projects
npm run format                            # prettier --write
npm run graph:check                       # every cross-package import is a graph edge (consumer fanout)
npm run tier0:check                       # every schema enum is inventoried (Tier 0) and defined once
npm run schema:check                      # every table has one owner, both adapters, channel_id or a written reason
npx nx g service <name> --db --broker     # a new service, compliant and wired in (tools/generators/README.md)
npm run verify                            # lock, format, api, graph, lint, typecheck, test — what CI runs
npm run smoke && npm run acceptance       # against a deployed cluster: every hop, then the MVP journey (EP-21.1)
npm run isolation                         # channel isolation: a rival in ch99 reaches nothing of ch12 (EP-30.2)
npm run perf                              # performance sanity against the MVP NFRs (EP-21.4)
npm run crash:bms                         # ADR-0010 check 4: kills Temporal + BMS mid-timer; the instance must finish
npm run drill -- --yes                    # restore drill — DESTROYS the kind namespace, restores, verifies (EP-21.3)
npm run triage                            # pilot/bug triage: waiting, past their severity clock, escaped (EP-21.5)

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

_Maintained by hand. The live per-epic status is [docs/roadmap/STATUS.md](docs/roadmap/STATUS.md) — update it when state moves; this file changes only when a rule or the toolchain does._
