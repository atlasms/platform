# ADR-0003 — Observability stack

**Status:** Accepted · **Date:** 2026-08-06 · **Epic:** EP-12 · **Spike:**
[`spikes/observability`](../../spikes/observability/)

## Context

Every Atlas service already emits Prometheus exposition format and structured JSON logs (EP-12.4).
What was undecided is **where those signals go**.

Two requirements pull in opposite directions:

- Atlas installs **air-gapped** on customer hardware
  ([FR-PLat-7](../requirements/05-functional-requirements.md#platform)). A site with no monitoring
  of its own still needs dashboards and log search on day one, so the stack must be **in the box**.
- Some sites **already run monitoring**. Atlas must integrate rather than compete.

Those conflict only if the stack is load-bearing, and the design already says it is not:
[logging-analytics.md §1](../architecture/services/logging-analytics.md) puts infra scraping and
tracing backends **out of scope**, and Studio's Logs/Analytics pages are served by the Logging &
Analytics **domain service** — OpenSearch, hash-chained audit records, permission-filtered — not by
Grafana. The observability stack exists for an operator debugging a site. Nothing else depends on it.

That reframes the decision: the signals are the product, and any stack is one consumer of them.

## Options

| # | Option | Verdict |
|---|--------|---------|
| A | **Prometheus + Loki + Grafana + Alloy**, optional overlay | **Chosen** |
| B | VictoriaMetrics + VictoriaLogs + Grafana | Rejected — operability |
| C | OpenSearch for logs *and* audit, one engine | Rejected — wrong cost model |
| D | Ship nothing; integrate only | Rejected — fails the primary requirement |
| E | Prometheus + Grafana only, defer logs | Rejected — EP-12.1 *is* log aggregation |

**B** is markedly lighter and Prometheus-compatible. Rejected on operability, not merit: this is
on-prem software a customer's ops team must run, and Prometheus/Loki is what they will already know.
Familiarity is a real feature that a footprint chart does not show.

**C** forces audit-grade cost and retention onto disposable debug output, and the two have genuinely
different query and tamper-evidence requirements.

**D** leaves a greenfield site with nothing at all.

**E** omits correlation-id search across services, which is the single most useful thing an operator
does with a distributed system.

## Evidence

Deployed into the kind cluster alongside the running platform. Harness:
`spikes/observability/measure.mjs`.

### Bundle cost

`docker save` tar sizes, because that is what the offline bundle carries. **Not `docker images`** —
it reports uncompressed on-disk size, 3–4× larger, and using it would have overstated the bundle
cost badly enough to change the decision.

| Image | Bundle (tar) | On disk |
|---|---:|---:|
| `grafana/grafana:11.5.0` | 139 MiB | 723 MB |
| `prom/prometheus:v3.1.0` | 111 MiB | 414 MB |
| `grafana/alloy:v1.5.1` | 111 MiB | 521 MB |
| `grafana/loki:3.3.2` | 31 MiB | 142 MB |
| **Stack total** | **392 MiB** | 1800 MB |

### Memory (working set, idle to light load)

| Container | Memory | | Container | Memory |
|---|---:|---|---|---:|
| `mam` | 44 MiB | | `grafana` | 72 MiB |
| `api-gateway` | 39 MiB | | `loki` | 55 MiB |
| `iam` | 37 MiB | | `alloy` | 50 MiB |
| `postgres` | 37 MiB | | `prometheus` | 20 MiB |
| `nats` | 7 MiB | | | |
| **Atlas total** | **163 MiB** | | **Stack total** | **198 MiB** |

**The stack costs 1.21× the memory of the entire platform it watches.** That is the honest headline
and the main argument against shipping it by default.

### Correctness, against real pods rather than fixtures

- **Discovery** found all three annotated services with no target list.
- **Metrics** — `sum by (service) (atlas_http_requests_total)` returned live counts
  (`api-gateway 54`, `mam 53`).
- **Logs** — a gateway access line reached Loki with `level` promoted to a label and
  `correlationId` preserved in the body.
- **Removal** — with the overlay deleted, `/metrics` still served `atlas_http_requests_total`, MAM
  still logged structured JSON to stdout, and `/readyz` still returned 200.

### What the spike found

**IAM exposes no metrics at all.** No `/metrics` route, no `goldenSignals` registration — the only
Atlas service without them. Prometheus discovered it by annotation and reported the target **down**,
which is how it surfaced.

This matters more than a missing dashboard. IAM is the authentication service: failed-login rate,
token issuance, JWKS latency and lockouts are precisely the signals worth alarming on, and an IAM
outage locks every user out of the platform. **EP-12.2's "per-service golden signals" is not
deliverable until this lands.**

> **Resolved** ([#205](https://github.com/atlasms/platform/issues/205)). IAM serves `/metrics`,
> registers `goldenSignals(…, 'iam')`, and adds `atlas_iam_login_attempts_total`,
> `atlas_iam_refresh_attempts_total`, `atlas_iam_tokens_issued_total`,
> `atlas_iam_sessions_revoked_total` and `atlas_iam_policy_compile_duration_seconds`. JWKS latency
> needed no bespoke metric — the golden-signal histogram covers it under its route template.
>
> One signal named above was absent at the time, and deliberately: **there were no account lockouts
> to count, because nothing locked an account.** The `locked` state existed and refused logins, but
> no policy ever set it, so a `lockouts_total` would have been structurally always zero — a flat
> line reading as "no brute force is succeeding" when it meant "no lockout policy exists".
> `atlas_iam_login_attempts_total{outcome="locked"}` counts attempts *against* an already-locked
> account, which was what was observable.
>
> The policy landed separately in [#240](https://github.com/atlasms/platform/issues/240), and
> `atlas_iam_lockouts_total` now counts the lock EVENT — the one to alert on, since attempts against
> a locked account measure an attacker's persistence rather than a new incident.

## Decision

**Ship Prometheus + Loki + Grafana + Alloy as an OPTIONAL overlay**, and treat **standard protocols
as the product**.

| Signal | Contract Atlas guarantees | Bundled consumer |
|---|---|---|
| **Metrics** | `/metrics`, Prometheus text, on every pod, annotated for discovery | Prometheus |
| **Logs** | structured JSON on **stdout** | Alloy → Loki |
| **Traces** | OTLP to a configurable endpoint (EP-04.7) | Alloy |
| **Alerts** | `AlertEvaluator` events | — |

The overlay lives in its own namespace and its own kustomization, referenced by nothing in
`infra/k8s/base`. **"Bring your own monitoring" is not a mode to build — it is what remains when the
overlay is deleted**, which the Evidence section verified rather than asserted.

Component rationale beyond the Options table:

- **Prometheus** was never a contest — `service-kit` already emits its format by hand, with a
  cardinality cap. Switching would mean rewriting instrumentation for no gain.
- **Grafana** because dashboards ship as provisioned JSON, version-controlled with the code. A
  dashboard that exists only in a browser cannot be shipped air-gapped.
- **Alloy** earns its place twice: it ships logs today **and** speaks OTLP, so EP-12.3 becomes
  configuration rather than a fifth image in the bundle.

Scrape targets are **pod annotations**, not a central target list. A service that ships announces
itself; a central list is a second place to remember it, and the one that gets forgotten — leaving
the pod silently unmonitored with no error anywhere. Any Prometheus-compatible scraper honours
them, ours or a customer's.

## Consequences

**Good.** A greenfield site gets dashboards and log search from the bundle. A site with its own
monitoring gets three standard surfaces and can ignore ours. Tracing needs configuration, not a new
component. Dashboards are reviewable in a pull request.

**Bad.** The bundle grows from ~117 MiB to ~510 MiB — and that baseline is itself incomplete:
`mam`, Postgres and NATS are not in `build-bundle.mjs` yet, so a realistic full bundle is nearer
750 MiB with the stack. Still one USB stick, but no longer something to email. And 198 MiB of RAM
on a broadcast node buys no media throughput.

**Ugly.** Grafana is the single largest component — 139 MiB packaged, 72 MiB resident — for what is
essentially a chart renderer. If the bundle ever has to shrink, that is the first thing to question:
its dashboards are portable JSON, so a customer's existing Grafana can import them and ours can be
dropped.

## Revisit when

- **A real site reports the memory cost as a problem.** 198 MiB is affordable on a server and is not
  obviously affordable on a small edge node. VictoriaMetrics/VictoriaLogs is the prepared answer.
- **The bundle has to fit fixed media.** Drop Grafana first; ship the dashboards as importable JSON.
- **A second customer wants a monitoring system we do not speak to.** The surfaces are standard, so
  the fix should be documentation — if it is code, this decision was wrong.
- **Tracing lands (EP-12.3).** If Alloy does not carry OTLP as cleanly as assumed, the
  "no fifth component" argument fails and the choice of collector should be reopened.
