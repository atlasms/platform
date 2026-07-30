# `libs/` — shared libraries

Shared code consumed by the services in [`apps/`](../apps/) **and** by Studio. Everything here is
versioned carefully: a change fans out, which is why CI runs **all consumers** of a changed lib
([EP-01.3](../docs/roadmap/21-epic-breakdown.md)).

## Planned libraries

| Lib            | Purpose                                                                                                              | Lifted from                                                                | Epic     |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| ✅ `contracts` | Types + envelope build/validate + a payload validator for every event. **The single source of cross-service truth.** | [`reference/contracts`](../reference/contracts/README.md) (8 tests)        | EP-02    |
| ✅ `messaging` | Broker client: publish-with-outbox, subscribe-with-idempotency, retry/DLQ, correlation.                              | [`reference/messaging`](../reference/messaging/README.md) (6 tests)        | EP-03    |
| `service-kit`  | The service template: health/readiness, logging, **bootstrap** config, JWT/JWKS, errors, tracing.                    | [`reference/service-kit`](../reference/service-kit/README.md) (8 tests)    | EP-04    |
| `policy`       | The pure authorization evaluator `can()` — zero runtime deps, **browser-safe**.                                      | _(new)_                                                                    | EP-05    |
| `reference`    | Admin-editable runtime config: descriptors, validation, scope resolution, snapshot client.                           | _(new)_                                                                    | EP-06    |
| `data`         | Store clients, migration-runner conventions, `withTransaction`, SQL-backed outbox.                                   | [`reference/data`](../reference/data/README.md) (6 tests)                  | EP-07    |
| `bms-workflow` | Workflow DSL validator, DSL⇄BPMN converter, interpreter, canvas core.                                                | [`reference/bms-workflow`](../reference/bms-workflow/README.md) (29 tests) | EP-22/23 |

> `libs/reference` (the config library) is a different thing from the top-level
> [`reference/`](../reference/) directory (the validated prototype code). The prototype is lifted
> _into_ `libs/` package by package; it is not itself a workspace member.

## Conventions

- **Package name** `@atlas/<name>`, matching the path alias in
  [`tsconfig.base.json`](../tsconfig.base.json).
- **ESM only** (`"type": "module"`), TypeScript sources exported directly
  (`"exports": { ".": "./src/index.ts" }`) — libraries have **no build step**.
- **Tests** use the built-in runner: `node --import tsx --test test/*.test.ts`, exposed as the
  package's `test` script so `nx run-many -t test` picks it up.
- **Dependency direction stays acyclic.** `contracts` depends on nothing; `policy` depends only on
  contract types; services depend on libs, never the reverse.
- **Cross-package imports use the `@atlas/*` specifier, never a relative path.** The
  [`reference/`](../reference/) prototype reaches across packages with `../../contracts/src/index.ts`
  because it predates workspace resolution. **Rewrite those on lift**, and declare the dependency in
  the importing package's `package.json`. This is what Nx builds its dependency graph from, and the
  graph is what makes `nx affected` (the [consumer-fanout CI](../docs/roadmap/21-epic-breakdown.md)
  requirement) actually work. A relative cross-package import compiles fine and silently produces
  **no graph edge** — so a breaking change in a lib would not run its consumers' tests.
- **A missing edge can be correct.** `messaging` deliberately does _not_ import `contracts`: it is
  broker- and schema-agnostic, and the domain envelope travels through it as an opaque `body`. The
  graph having no `messaging → contracts` edge is the design working, not a lift defect.
- `policy` and `reference` must stay **browser-safe** — Studio imports them, so no Node built-ins,
  no DB drivers, no server-only dependencies.

---

_Structure: [System Implementation Plan §3.1](../docs/roadmap/16-system-implementation-plan.md#31-monorepo--shared-libraries)._
