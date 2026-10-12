# Temporal spike — ADR-0010's checks

Evidence for [ADR-0010](../../docs/adr/0010-bms-durable-runtime.md) (BMS on Temporal), checks 1–3:
does the TypeScript SDK's worker run in our image shape, can its workflow code be bundled at image
build time, and does the server keep its state in our Postgres. `run.sh` reproduces all three; the
results are in the ADR's _Evidence_ section.

Not a workspace package — deliberately: `@temporalio/*` brings webpack, swc and a native core
(176 MB of `node_modules`), and a spike should not put that into everyone's install. `worker/` has
its own `package.json` and lockfile and is installed only inside the images `run.sh` builds.
EP-22.3 brings the SDK into `apps/bms` for real.

| File                       |                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `run.sh`                   | Schema → server → the worker on three bases → a waiting instance across a server replacement |
| `Dockerfile`               | The worker on `BASE` (+ `APK` packages), its workflows bundled in the build                  |
| `dynamicconfig/atlas.yaml` | The server refuses to start without a dynamic-config file                                    |
| `worker/`                  | Workflows, activities, the build-time bundler, the worker and a client                       |
