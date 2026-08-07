# Observability stack spike (EP-12.1 / 12.2 / 12.3)

Measures what it costs to ship a self-contained observability stack in the offline bundle, and
proves that removing it leaves Atlas fully monitorable by somebody else's tooling.

**Outcome:** [ADR-0003](../../docs/adr/0003-observability-stack.md).

## The question this answers

Atlas installs air-gapped on customer hardware, so it must arrive **self-contained** — a site with
no monitoring at all still needs dashboards and log search. But some sites already run monitoring,
and Atlas must not fight it.

Those two requirements only conflict if the stack is load-bearing. The design already says it is
not: [logging-analytics.md §1](../../docs/architecture/services/logging-analytics.md) puts infra
scraping and tracing backends **out of scope**, and Studio's Logs/Analytics pages are served by the
Logging & Analytics **domain service** (OpenSearch, hash-chained audit records, permission-filtered)
— not by Grafana. The observability stack is for operators debugging a site, nothing more.

So the shape under test is: **standard protocols are the product, the bundled stack is one
consumer of them.**

| Signal      | Integration surface             | Already true?                                             |
| ----------- | ------------------------------- | --------------------------------------------------------- |
| **Metrics** | `/metrics`, Prometheus text     | ✅ `@atlas/service-kit` emits it, cardinality-capped      |
| **Logs**    | structured JSON on **stdout**   | ✅ `createLogger` — any shipper collects container stdout |
| **Traces**  | OTLP to a configurable endpoint | ⬜ EP-04.7                                                |
| **Alerts**  | `AlertEvaluator` events         | ✅ EP-12.4                                                |

"Bring your own monitoring" is therefore not a mode to build. It is what remains when the overlay
is deleted — and this spike verifies that claim rather than asserting it.

## What is measured

1. **Bundle cost** — image sizes, and the delta to the offline bundle (currently **117 MB**). This
   is the main argument against shipping a stack, so it is measured first.
2. **Memory at idle and under load** — a broadcast facility's Atlas node is not a monitoring node.
3. **Scrape correctness** — Prometheus discovering and scraping real Atlas pods, not a fixture.
4. **Log pipeline** — a line logged by MAM becoming queryable in Loki.
5. **Removal** — the overlay deleted, and all three surfaces still answering.

## Running it

```bash
kubectl apply -k spikes/observability/k8s
node spikes/observability/measure.mjs
```
