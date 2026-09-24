# @atlas/generators — `nx g service <name>`

A new service that passes the repo's own bar on its first run, wired into the build, the images
and the cluster. EP-04.9.

```sh
npx nx g service scheduling --db --broker --description "The program table."
npx nx g service audit-log --db --broker --dry-run     # see what it would write
npx nx test @atlas/scheduling                          # 6 tests, in memory, before a line is written
```

## What you get

```
apps/<name>/
  src/app.ts        build<Name>App(): correlation, tracing, golden signals, access log, the problem
                    document from every error, /healthz /readyz /metrics, one example route
  src/main.ts       config, logger, tracer, health (IAM critical), listen, drain on SIGTERM
                    --db      pool; migrations that WAIT for Postgres within a 120 s budget; readiness
                    --broker  NatsBroker that retries rather than crash-loops; with --db, the outbox relay
  src/index.ts, test/<name>.test.ts, README.md, package.json, tsconfig.json
infra/k8s/base/<name>.yaml                       Deployment + Service, non-root, read-only fs, probes
```

And four one-line edits in files a new service's author has no reason to open:
`k8s:build` and `k8s:load` in `package.json`, the manifest in `infra/k8s/base/kustomization.yaml`,
the image tag in `infra/k8s/overlays/dev/kustomization.yaml`. Then run `npm run helm:build`: the
Helm chart is generated from `infra/k8s/base` (ADR-0006), and `npm run k8s:check` fails until the
new manifest is in it. **That list is why this exists.** #296
shipped a manifest for a service whose image `k8s:build` never built; `npm run k8s:up` deployed an
`ImagePullBackOff`, and every unit test was green.

## Why the template looks the way it does

It is **derived, not designed** — what `iam`, `mam`, `websocket` and `api-gateway` agree on, after
#313 brought the fourth into line with the other three. Deriving it is what found that drift: one
service sent a private `{ error }` shape, minted a non-ULID correlation id and adopted any value a
client sent. A fifth service written by hand copies whichever of the four it is nearest to.

The six tests that come with the scaffold are the definition of "compliant". They stay.

## How it is kept honest

- `tools/generators/test/` runs the generator against a virtual tree: files, wiring, refusals.
- CI's **Generated service passes the bar** step runs it for real on every PR, then holds the
  output to lint, strict typecheck, its own tests, and `node --check` on `main.ts` (the container
  runs `node src/main.ts` with no transform — a constructor parameter property anywhere in the
  import graph would fail there and nowhere else). A template nothing imports is the file most
  likely to rot; this is what stops it.

## After generating

1. **Contracts first** (AGENTS.md §5.1): `docs/architecture/openapi/<name>.yaml` before or with each
   route; add it to `SPECS` in `scripts/generate-api-types.mjs` when Studio needs a client.
2. Every table carries `channel_id`; every write goes out through the outbox (`--db --broker`
   gives you the store and the relay).
3. To route through the gateway: an origin in the gateway's config and a row in its table — **both in
   `apps/api-gateway/src/main.ts`** (`routing.ts`'s `defaultRoutes` is a test fixture that lists services
   which do not exist; a row there alone is a route the deployed gateway has never heard of) — the env
   in `infra/k8s/base/api-gateway.yaml`, then a probe in the smoke suite's upstream gate.
4. `npm run k8s:up` builds and deploys it with the rest. `kubectl -n atlas rollout restart
deployment/<name>` after a rebuild — `IfNotPresent` keeps the old pod otherwise.

## Implementation notes

Strip-only TypeScript loaded by Nx under Node 24's native type stripping: no build step, no `tsx`,
and the same eslint rule against emitting syntax as every service. Templates are EJS
(`<%= name %>`, `<% if (db) { %>`), suffixed `__tmpl__` so nothing lints or type-checks them as
source — they are checked by generating from them. `@nx/devkit` is pinned to the workspace's Nx.
