# AGENTS.md — how to continue this project

**Read this file first. It is the entry point.** It exists so you can pick up work without
reading the whole repository. Everything below is current as of the last commit on
`feat/delivery-process-and-backlog`.

---

## 1. What this is

**Atlas Automation** — a service-based media/broadcast automation platform (TV, radio, news, live
events): ingest → transcode → catalogue → review/approve → schedule → send-to-air, plus newsroom,
workflow, feeds and AI enrichment.

This repo (`atlasms/platform`) is **one Nx monorepo** holding the design docs _and_ the code.

- `docs/` — the design. Extensive and authoritative. **It is the source of truth, not the code.**
- `libs/` — shared TypeScript libraries (`@atlas/*`).
- `apps/` — one deployable per service (none built yet).
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

| Item                             | State                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Design docs                      | ✅ Complete                                                                                    |
| GitHub backlog                   | ✅ 175 issues on org project **#2**                                                            |
| **EP-01** foundations            | ✅ Monorepo, CI (`nx affected`), CODEOWNERS. ⬜ 01.4 containers, 01.5 IaC, 01.7 offline bundle |
| **EP-02** `@atlas/contracts`     | ✅ 8 tests — loads all 53 schemas from `docs/`. ⬜ 02.2–02.6                                   |
| **EP-03** `@atlas/messaging`     | ⚠️ In-memory broker only (6 tests). Real broker blocked on the **EP-03.0 spike**               |
| **EP-04** `@atlas/service-kit`   | ✅ 8 tests. ⬜ 04.2–04.9                                                                       |
| **EP-05** `@atlas/policy`        | ✅ 13 tests. ⬜ 05.5/05.6 need the Studio shell                                                |
| **EP-06** `@atlas/reference`     | ✅ 17 tests. ⬜ 06.6 seed loader (Node-only, cannot live in a browser-safe entry point)        |
| **EP-07** `@atlas/data`          | ✅ 6 tests. ⬜ 07.4–07.6                                                                       |
| **EP-08** `api-gateway`          | ✅ 13 tests. ⬜ 08.3 rate limiting, 08.5 reference aggregation                                 |
| **EP-09** `websocket`            | ✅ 16 tests. ⬜ 09.4 reconnect/polling (client-side, needs Studio)                             |
| **EP-10** `iam`                  | ✅ 20 tests. ⬜ 10.4 CRUD, 10.6 event emission                                                 |
| **EP-13** walking skeleton       | ✅ 9 tests — **the Phase 0 exit criteria, executable**                                         |
| **EP-11** Studio shell (Angular) | ⬜ Not started — the last big Phase 0 piece, and a different stack                             |
| **EP-12** observability          | ⬜ Not started                                                                                 |

**116 tests across 10 projects, all green**, merged to `main` (PRs #176–#187).

> **Start here to understand how it fits together:**
> [`apps/walking-skeleton`](apps/walking-skeleton/) wires the whole spine in one process and proves
> it end to end — gateway auth → service authorization → atomic outbox → relay → broker →
> permission-checked fan-out, with one correlation id threaded through every hop. Reading that test
> file is the fastest way to see how the pieces compose.

**CI runs on every PR** (`nx affected`) and on `main` (everything). But ⚠️ **it does not block
merge** — branch protection needs a paid GitHub plan on a private repo. The ruleset is written and
one command away: [`.github/rulesets/README.md`](.github/rulesets/README.md). So **run
`npx nx run-many -t lint typecheck test` yourself before opening a PR.**

**Suggested next tasks:** `EP-03.0` (broker spike — **needs a human decision**; the skeleton is
honest only while the broker stays in-memory) · `EP-11` (Studio shell, Angular) · `EP-12`
(observability) · `EP-17` (MAM — first real Phase 1 service).

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

| Trap                                                                | What to do                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Imports carry explicit `.ts` extensions**                         | Correct — required by the no-build-step design. `allowImportingTsExtensions` is on. Don't strip them.                                                                                                                                                                                               |
| **Cross-package imports must use `@atlas/*`, never relative paths** | `reference/` uses `../../contracts/src/index.ts` because it predates workspaces. **Rewrite on lift** and declare the dep in `package.json`. Nx builds its graph from specifiers; a relative import compiles fine but produces **no graph edge**, silently disabling consumer-fanout CI.             |
| **`ajv` must be imported by full specifier**                        | Use `ajv/dist/2020.js` for **both** value and types. A bare `'ajv'` can resolve to the hoisted **ajv 6** (pulled in by eslint), whose `export =` typings are incompatible with v8's class. Runtime is fine; it fails only at type-time. See [`libs/contracts/README.md`](libs/contracts/README.md). |
| **`docs/` is excluded from prettier**                               | Deliberate — the markdown has hand-aligned tables that prettier would reflow. Don't remove it from `.prettierignore`.                                                                                                                                                                               |
| **A missing graph edge can be correct**                             | `messaging` genuinely does not import `contracts` (it is schema-agnostic). Don't "fix" it.                                                                                                                                                                                                          |
| **Nx Cloud is off**                                                 | Required: the build must work air-gapped ([FR-PLat-7](docs/requirements/05-functional-requirements.md#platform)). Keep caching local.                                                                                                                                                               |

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
