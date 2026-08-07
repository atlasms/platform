# ADR-0004 — Tracing: W3C Trace Context and OTLP, written by hand

**Status:** Accepted · **Date:** 2026-08-08 · **Epic:** EP-04.7

## Context

[ADR-0003](0003-observability-stack.md) already decided the **protocol**: traces leave Atlas as
**OTLP to a configurable endpoint**, and Alloy — already in the observability overlay — receives it.
What that ADR left open is the **implementation**: which code in `@atlas/service-kit` produces the
spans and puts them on the wire.

This is worth a record because it lands in **every service**. `service-kit` is a dependency of all
of them, so whatever this pulls in, every image carries.

Two constraints frame it:

- **Air-gapped installs** ([FR-PLat-7](../requirements/05-functional-requirements.md#platform)).
  Everything ships in an offline bundle that is currently **117 MB**, and ADR-0003 already found the
  observability stack's footprint to be the main argument against shipping it by default.
- **There is a precedent.** `service-kit` writes **Prometheus exposition format by hand** rather
  than pulling a client library, for exactly this reason plus one more: control over the thing that
  actually breaks metrics in production, which is label cardinality. Tracing has the same shape of
  hazard — span volume — and the same delivery constraint.

## Options

| #   | Option                                                            | Verdict     |
| --- | ----------------------------------------------------------------- | ----------- |
| A   | **W3C Trace Context + OTLP/HTTP JSON, written by hand**           | **Chosen**  |
| B   | Minimal OpenTelemetry SDK (`api` + `sdk-trace-node` + OTLP export) | Rejected    |
| C   | Full OTel SDK with `auto-instrumentations-node`                    | Rejected    |

## Evidence

Measured with `npm install --omit=dev` into an empty project, on the versions current at the date
above. Re-runnable in an afternoon; disagree with data.

| Option                                   | `node_modules` | Packages |
| ---------------------------------------- | -------------: | -------: |
| **C** — full SDK + auto-instrumentations |      **71 MB** |       83 |
| **B** — minimal SDK                      |      **27 MB** |       14 |
| **A** — hand-written                     |       **0 MB** |        0 |

Against a **117 MB** bundle, option C is a **~60% increase** for one signal. Option B is ~23%.

Two details make B worse than its headline. `@opentelemetry/semantic-conventions` alone is **12 MB**
— over a third of the minimal install — and it is a constants file. And the OTLP transformer pulls
in `sdk-metrics` and `sdk-logs`, another **6 MB** of code for two signals Atlas already emits by
other means and would never route through it.

The usual argument for the SDK is **auto-instrumentation**: spans appear for `http`, `pg` and
friends without writing any. That argument is weaker here than it normally is, because the hops that
matter in this platform are ones no auto-instrumentation understands:

- **gateway → service** carries an internal header set the gateway establishes, not a raw JWT.
- **service → broker → consumer** rides the Atlas message envelope, so propagation means putting
  the trace context in **our** envelope. EP-13.3 — "one end-to-end trace spanning gateway → service
  → broker → consumer" — is only reachable by writing that hop by hand under any option.

What is actually needed is small and fully specified: parse and format one header, keep a span
tree in the AsyncLocalStorage context that already exists for correlation ids, and POST a documented
JSON shape. [W3C Trace Context](https://www.w3.org/TR/trace-context/) is a stable Recommendation,
and OTLP/HTTP with `application/json` is a stable, supported transport that Alloy accepts.

## Decision

**Write it.** `@atlas/service-kit` gains a tracer that:

- propagates **W3C `traceparent`**, so anything OTel-instrumented up or downstream interoperates
  without Atlas depending on OTel;
- exports **OTLP/HTTP JSON** to a configurable endpoint, batched, and **disabled when no endpoint
  is configured** — a site without a collector pays nothing and still gets propagation;
- keeps span context in the **existing** `runWithContext` AsyncLocalStorage, so a log line and a
  span agree about which request they belong to without either being passed the other.

**The gateway starts the trace and does not adopt an inbound one.**
[api-gateway.md §12](../architecture/services/api-gateway.md) already specifies this — "the gateway
**starts** the trace and correlation id and propagates them to every hop" — and it is also what
stops a public client from pinning every request to one trace id, or setting the sampled flag on
every request and flooding the collector. Internal hops adopt the upstream context, because there
the caller is trusted and a re-decision would leave holes in the trace.

## Consequences

- **No auto-instrumentation.** A span exists where somebody wrote one. Database and outbound HTTP
  calls are not traced until they are instrumented deliberately. This is the real cost, and it is
  accepted: the spans that answer "where did this request go" are the ones at service boundaries,
  and those are the ones being written.
- **We own the correctness.** Id validity, sampling propagation and malformed-header handling are
  ours to get right, and are pinned by tests rather than trusted to a library.
- **Interoperability is preserved.** The wire formats are standard in both directions. A site that
  runs its own OTel collector points the endpoint at it; a service written elsewhere that receives
  our `traceparent` continues the same trace.
- **Reversible.** The surface is `startSpan`/`endSpan` plus one header. Swapping in the SDK later
  means reimplementing that surface, not rewriting call sites — which is the test the
  [ADR README](README.md) sets for whether a decision needs an ADR at all. It gets one anyway
  because the dependency lands in every image, and that part is not cheap to undo.

## Revisit when

- The bundle stops being a constraint — a site that installs from a registry has no 117 MB ceiling.
- Auto-instrumentation of `pg` or outbound `fetch` becomes the thing an operator actually needs,
  and hand-written spans at those call sites become the larger cost.
- OTLP/JSON is deprecated in favour of protobuf-only, which would make hand-writing the exporter
  meaningfully harder.
