# The observability overlay (EP-12.2)

Prometheus + Grafana, provisioned with dashboards. **Optional**, in its own namespace, referenced by
nothing in [`infra/k8s/base`](../base/).

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

Two panels read oddly on purpose:

- **Saturation** floors at **1**, not 0 — the scrape counts itself while rendering the response.
  Sustained growth is the signal; the floor is noise.
- **JWKS** is mostly **empty**. Consumers cache the document, so a healthy system fetches it rarely.
  Gaps are normal; a sustained fetch rate means somebody's cache is not working.

## Discovery is annotation-driven

Prometheus keeps pods carrying `prometheus.io/scrape: "true"`. There is no static target list,
because a static list is a second place to remember every service — and the one that gets forgotten
when a service ships, silently.

That is exactly how the IAM gap surfaced: the pod announced a target and answered nothing, so
Prometheus reported it **DOWN**. A static list would have been edited to match reality and the gap
would have closed itself, invisibly.

## What it costs

ADR-0003 measured the full four-component stack at **392 MiB of images** against a 117 MB offline
bundle, and **1.21× the memory of the entire platform it watches**. This overlay is the metrics half;
logs (Loki + Alloy) are EP-12.1.

It is **not** in the offline bundle — `scripts/build-bundle.mjs` builds from the dev overlay, and
this directory is not referenced by it. That is the ADR's decision, not an oversight: a site that
wants the stack offline adds these images deliberately.

## Retention

Prometheus keeps **7 days** on a 5 GiB PVC. That is an operator's debugging window, not the audit
trail — long-term retention with tamper-evidence is the
[Logging & Analytics](../../../docs/architecture/services/logging-analytics.md) service's job, with
different guarantees. Raising retention means raising the PVC; Prometheus does not shrink to fit.

The Deployment uses `Recreate`, because a ReadWriteOnce PVC would deadlock a rolling update: the new
pod cannot attach the volume until the old one releases it, and the old one is not terminated until
the new one is ready.
