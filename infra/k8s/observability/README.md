# The observability overlay (EP-12.1 / 12.2 / 12.3)

Prometheus + Loki + Tempo + Alloy + Grafana, provisioned with dashboards. **Optional**, in its own
namespace, referenced by nothing in [`infra/k8s/base`](../base/).

Decided by [ADR-0003](../../../docs/adr/0003-observability-stack.md), which chose **standard
protocols as the product and the bundled stack as one consumer of them**. That is why this directory
is separate rather than tidy: delete the namespace and Atlas keeps serving `/metrics`, keeps logging
JSON to stdout, keeps answering `/readyz`. A site that already runs monitoring never applies it and
points its own scraper at the same annotated pods.

## Install

```bash
# No default credentials ship. Create the Secret first — without it Grafana will not start.
kubectl create namespace atlas-observability
kubectl create secret generic grafana-admin -n atlas-observability \
  --from-literal=username=admin \
  --from-literal=password="$(openssl rand -base64 24)"

kubectl apply -k infra/k8s/observability
```

Then reach Grafana at <http://localhost:3000>:

```bash
kubectl port-forward -n atlas-observability svc/grafana 3000:3000
```

`kubectl port-forward`, not a NodePort. kind only forwards 30080/30081 to the host, so a NodePort
would need the cluster recreated to be reachable — and on a real install it would put an operator
console on every node's address with nothing but a password in front. An ingress with TLS is the
production answer, and pretending a NodePort is one hides that work rather than scheduling it.

### Why the Secret is not generated for you

A `secretGenerator` here would commit a default admin password, and this overlay is meant for
customer sites. Without the Secret the pod stops at `CreateContainerConfigError` with
`secret "grafana-admin" not found` — visible and closed, which is the right way for an auth
dependency to fail.

The spike ran anonymous-admin, which was correct for measuring footprint and wrong to ship: an
unauthenticated dashboard publishes operational detail about a broadcaster's estate — traffic shape,
error rates, when the newsroom is busy and when it is empty.

## Dashboards

**Atlas — golden signals.** Traffic, errors, latency and saturation for every service through a
`service` label, with a template variable to narrow to one. One dashboard rather than one file per
service: a per-service file is something somebody must remember to add when a service ships, and the
service that gets forgotten is invisible rather than broken.

**Atlas — authentication.** Login outcomes, lockouts, refresh-token reuse, token issuance, JWKS, and
the gateway's rate-limit rejections. Every metric on it exists because of
[#205](https://github.com/atlasms/platform/issues/205) and
[#240](https://github.com/atlasms/platform/issues/240); before those, IAM was not scraped at all.

**Atlas — logs.** Volume by level and by service, errors and warnings across everything, and a
textbox that takes a correlation id and returns every line for that one request.

Two panels read oddly on purpose:

- **Saturation** floors at **1**, not 0 — the scrape counts itself while rendering the response.
  Sustained growth is the signal; the floor is noise.
- **JWKS** is mostly **empty**. Consumers cache the document, so a healthy system fetches it rarely.
  Gaps are normal; a sustained fetch rate means somebody's cache is not working.

## Logs: what actually reaches Loki

Alloy reads container stdout **through the Kubernetes API**, not `/var/log/pods`. No hostPath mount
and no privileged container — mounting the host filesystem is a large amount of trust to grant
something whose job is to read text.

`level` is promoted to a Loki **label** because it has five values. `correlationId` is deliberately
**not**: it has one value per request, and a Loki label set defines a stream, so promoting it would
mint a stream per request and shred the index. Same cardinality trap as a user id in a metric label.
It stays in the line, where `|= "01K…"` finds it across every service in one query.

**Only the gateway logs an access line per request.** MAM and IAM log lifecycle events and errors,
and those lines do carry the correlation id — `runWithContext` sees to that — so the
one-request view fills in when something goes wrong, which is when it gets read, and is thin on a
healthy request. Per-service access logging is
[#245](https://github.com/atlasms/platform/issues/245), not this story.

Loki and Alloy are themselves **scraped**. The collector is the component whose failure is hardest to
notice: when a log shipper stops, the symptom is silence, and silence looks exactly like a quiet
platform.

## Traces (EP-12.3)

Services send **OTLP/HTTP** to Alloy, which batches and forwards to **Tempo** over gRPC. One
telemetry address per service, and one place to add sampling or redaction later.

Enable it by pointing the services at the collector — deliberately **not** set in
`infra/k8s/base`, because base must not depend on an optional overlay, and an endpoint that resolves
to nothing means a failed export every flush interval:

```bash
kubectl set env -n atlas deploy/api-gateway deploy/iam deploy/mam \
  ATLAS_OTLP_ENDPOINT=http://alloy.atlas-observability:4318
```

### Why Tempo is here at all

ADR-0003 named Alloy as the trace "consumer". That was right about the **collector** and left the
**store** unnamed — Alloy receives and forwards, it keeps nothing, so a greenfield site would have
had spans arriving somewhere and going nowhere.

That is the same hole ADR-0003 rejected option D over ("ship nothing, integrate only" — _"leaves a
greenfield site with nothing at all"_). Measured with that ADR's own method, `docker save` tar:
**53 MiB**, against Grafana's 139, Prometheus' 111 and Alloy's 111. The optional stack goes 392 →
445 MiB, and none of it is in the default bundle.

### Probes are not traced

`/healthz`, `/readyz` and `/metrics` produce no spans. Liveness fires every few seconds per pod and
the scraper every fifteen, so **twenty of twenty** traces in Tempo were probes within minutes of
switching this on. They crowd real requests out of search and spend the whole retention window on
the least interesting traffic in the platform. They stay in the **metrics**, where a probe is one
increment on an existing series and costs nothing.

### The three signals are linked

- A **log line** carries `traceId`, and Grafana's derived field turns it into a link — "this error"
  becomes "the whole request that produced it", across every service it touched.
- A **span** links back to the log lines of that same request, matched on trace id rather than on
  time-plus-service, which would drag in every other request running concurrently.

Tempo displays trace ids as hex **numbers**, so one in sixteen appears a character short with its
leading zero trimmed. Cosmetic: logs carry the full 32-character id and lookup by that id resolves.

### What is not traced yet

Service-to-service **fetches** — MAM's policy fetch from IAM, the gateway's JWKS fetch — start their
own traces rather than continuing the caller's, because they are plain `fetch` calls with no
`traceparent` injected. So does anything crossing the **broker**. Both are
[EP-13.3](../../../docs/roadmap/21-epic-breakdown.md) — "one end-to-end trace spanning gateway →
service → broker → consumer" — which is exactly the remaining work.

## Discovery is annotation-driven

Prometheus keeps pods carrying `prometheus.io/scrape: "true"`. There is no static target list,
because a static list is a second place to remember every service — and the one that gets forgotten
when a service ships, silently.

That is exactly how the IAM gap surfaced: the pod announced a target and answered nothing, so
Prometheus reported it **DOWN**. A static list would have been edited to match reality and the gap
would have closed itself, invisibly.

## What it costs

ADR-0003 measured this stack at **392 MiB of images** against a 117 MB offline bundle, and **1.21×
the memory of the entire platform it watches**. That is the honest headline and the main argument
against shipping it by default — which is why it is an overlay and not part of `base`.

It is **not** in the offline bundle: `scripts/build-bundle.mjs` builds from the dev overlay, and this
directory is not referenced by it. That is the ADR's decision, not an oversight — a site that wants
the stack offline adds these images deliberately.

## Retention

Both stores keep **7 days**: an operator's debugging window, not the audit trail. Long-term retention
with tamper-evidence is the
[Logging & Analytics](../../../docs/architecture/services/logging-analytics.md) service's job, with
entirely different guarantees — and keeping them apart also means the tamper-evident record does not
live in the same place as the thing an intruder most wants to edit.

| Store          | Window | PVC    |
| -------------- | ------ | ------ |
| **Prometheus** | 7d     | 5 GiB  |
| **Loki**       | 168h   | 10 GiB |

Loki's is larger because log volume is not a fixed-cardinality time series — it scales with traffic
and with how chatty the services are, and the compactor needs headroom to rewrite indexes.

**`retention_period` alone deletes nothing.** It is only the limit; the compactor is what enforces
it, so `compactor.retention_enabled` must be set too — otherwise the disk fills while the config
claims a 7-day window. Verify with `loki_boltdb_shipper_compactor_running`.

Both Deployments use `Recreate`, because a ReadWriteOnce PVC deadlocks a rolling update: the new pod
cannot attach the volume until the old one releases it, and the old one is not terminated until the
new one is ready. Alloy is a DaemonSet with an `emptyDir` buffer instead — one pod per node cannot
share an RWO volume, and what is lost on a restart is the few seconds in flight, since the source of
truth is the container's stdout that the kubelet still holds.
