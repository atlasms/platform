# ADR-0006 — The Helm chart is generated from the manifests

- **Status:** Accepted
- **Date:** 2026-09-22
- **Stories:** EP-01.5 (IaC), EP-07.5 (environments), EP-01.7 (offline bundle)
- **Chart:** [`infra/helm/atlas/`](../../infra/helm/atlas/) · **Generator:** [`scripts/build-helm-chart.mjs`](../../scripts/build-helm-chart.mjs)
- **Follows:** [ADR-0002](0002-deployment-target.md), which chose Kubernetes + Kustomize and
  deferred this question

## Context

[ADR-0002](0002-deployment-target.md) chose Kustomize for our own environments and said why a
chart was not written at the same time:

> **Packaging for customer distribution is a separate question** and may still want a Helm chart —
> customers expect `helm install`, values files are a familiar configuration surface, and chart
> versioning maps onto product releases. Deferred rather than decided: it is additive, and building
> it before the manifests have settled would mean templating something still in motion.

The manifests have since settled: seven services, three data-plane components, a staging overlay
shaped like production, and `npm run k8s:check` holding all of it to written conventions. The
deferral's condition is met, and the reason to take the question up now is that a customer install
is not our install. A site brings its own registry, its own storage class, its own certificate,
often its own PostgreSQL — and expresses all of it in a values file, not by forking an overlay.

The same ADR also named the cost that made it wait:

> Accepting it because the alternative is maintaining _two_ deployment paths, and the second one
> always rots.

A chart hand-written beside the manifests is exactly that second path. It would drift on the first
probe timeout nobody copied across, and drift silently, because nothing renders both.

## Options

1. **A hand-written chart.** What most projects ship. Readable, idiomatic — and a second copy of
   every manifest, kept in step by discipline alone.
2. **Only the manifests; tell customers to use Kustomize.** No drift, and no chart. It moves the
   work to every customer and answers `helm install` with "not supported", which for a product
   sold into enterprise infrastructure teams is a real cost.
3. **Generate the chart from the manifests.** One source. The generator replaces the handful of
   fields a site must set with template expressions and harvests what it replaced into
   `values.yaml` as the defaults. A `--check` mode proves the committed chart is what the current
   manifests produce.
4. **Generate the manifests from the chart** (`helm template` into the overlays). Also one source,
   pointing the other way. Rejected: it makes the dev loop depend on Helm, turns readable YAML
   into templated YAML for the people who work on it daily, and ADR-0002's argument for Kustomize
   — plain manifests, one binary — was about exactly that.

## Evidence

The generated chart is checked by `npm run k8s:check`, which is in `npm run verify` and in CI.
Re-running the generator and diffing is what makes the guarantee real, and it is tested in both
directions: editing `infra/k8s/base/mam.yaml` without regenerating fails with `stale: values.yaml`,
and editing a chart file by hand fails the same way. The chart then has to clear the bar the
manifests clear — probes, resource requests, memory limits, a read-only root filesystem — in two
renders, the defaults and a production-shaped values set, plus the chart's own promises: images
from the configured registry, no seeded account, no credential as a literal env value, a
PodDisruptionBudget for every multi-replica deployment **and for no single-replica one**, no
Ingress unless asked for, and when asked for, TLS with `/ws` to the WebSocket service and `/` to
the gateway. A last check renders `infra/k8s/base` and asserts every workload in it is in the
chart under the same name, so a service added to the platform cannot be missing from the chart.

Comments survive generation. The manifests carry the reasoning for nearly every field — why IAM
has one replica, why the broker is not a readiness check, why `PGDATA` is a subdirectory of the
mount — and the generator edits the parsed YAML document in place rather than re-serialising it,
so the chart a customer reads carries the same explanations.

## Decision

**Ship a Helm chart for distribution, generated from `infra/k8s/base`, with the generator's
`--check` mode in CI. Kustomize remains the way our own environments are configured.**

What became a value, and nothing else did: the image registry, repository, tag, pull policy and
pull secrets (including for the data plane — the half a chart usually forgets, and the half an
air-gapped mirror needs); replica counts for the workloads that can scale; resources; storage
sizes and the storage class; whether each data-plane component is installed at all, and the
host/port/database when it is not; the credentials Secret's name and key names; and the Ingress.

What deliberately did **not** become a value: the replica counts of IAM, RIM and the data plane.
Each is a correctness constraint the manifests state — IAM generates its signing key ring per
process, RIM's staging area is a ReadWriteOnce volume, the data plane is single-writer — and a
value that let an operator raise them would be a value that breaks the install from a values file.

## Consequences

### What this buys

`helm install atlas ./atlas --set image.registry=registry.internal` is now the whole installation
for a site with a mirror, and `helm upgrade` with a changed values file is the whole
reconfiguration. Chart version and appVersion are both the repository's version, so a release is
one number. The values file is also documentation of what a site is allowed to change, which an
overlay never was.

### What it costs, stated plainly

A generator is machinery, and machinery is a thing to understand before changing a manifest. The
mitigation is that it fails loudly and says what to run: `npm run helm:build`. The substitutions
are a fixed, readable list at the top of the script rather than a pattern language.

The chart cannot express what an overlay can. A site needing something outside the values — a
sidecar, a node selector, a different scheduler — has to post-process the rendered output or fork.
`helm template` producing plain YAML is the escape hatch, and it is the same YAML the bundle
ships, which is why this is a real answer rather than a shrug.

### The offline bundle is unchanged

[`scripts/build-bundle.mjs`](../../scripts/build-bundle.mjs) ships **rendered** manifests, and its
promise stays "the installing site needs kubectl and nothing else — no kustomize, no helm, no
chart repository". A site that wants Helm takes `npm run helm:package`; a site that wants to
install from a tarball with one binary is not made to install Helm first.

## Revisit when

- A customer needs something that cannot be a value, twice. Two is a pattern; the answer is a new
  value, not a fork.
- The chart needs a subchart or a dependency (an ingress controller, cert-manager, an operator).
  Generation assumes one flat chart, and a dependency is a different shape.
- IAM's signing keys move into a Secret (EP-10), at which point `replicas.iam` stops being a
  correctness constraint and becomes an ordinary value.
