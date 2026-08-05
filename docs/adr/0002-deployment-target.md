# ADR-0002 — Deployment target: Kubernetes

- **Status:** Accepted
- **Date:** 2026-08-04
- **Stories:** EP-01.4 (containers), EP-01.5 (IaC)
- **Manifests:** [`infra/k8s/`](../../infra/k8s/) · **Images:** [`infra/docker/`](../../infra/docker/)

## Context

Atlas needs a deployment target before any service can be provisioned, smoke-tested against a real
environment (EP-13.4), or shipped to a customer. The choice constrains packaging, configuration,
secrets, upgrades, and the shape of the offline bundle, so it is expensive to revisit.

The binding constraints:

- **A9 / FR-PLat-7 — installs and runs fully offline**, in air-gapped broadcast facilities. There
  is no "pull it from the internet" step, ever.
- **Operated by broadcast engineers**, not a platform team. Operational surface area is a cost
  somebody pays at 3am during a live event.
- Services are independent and event-driven, with **very different scaling shapes** — MTS transcode
  workers are CPU-bound and bursty; the gateway and WebSocket service are long-lived and I/O-bound.
- Deployments range from **a single on-prem node to a multi-node cluster**, and the same artefacts
  must serve both.

## Decision

**Kubernetes**, with **Kustomize** for environment variance and **kind** for local development.

## Consequences

### What this buys

Declarative rollouts, health-gated traffic, restart policies and horizontal scaling per service —
all of which Atlas would otherwise have to invent. The differing scaling shapes above are the
strongest argument: transcode workers scaling independently of the gateway is a first-class
operation rather than a bespoke supervisor.

It is also the format customers' own infrastructure teams already understand, and it runs
air-gapped: images load from a tarball, manifests are plain YAML, nothing phones home.

### What it costs, stated plainly

Kubernetes is **a lot of machinery for a single-node install**, which some Atlas deployments will
be. A small facility running one server now needs a cluster — k3s or similar makes that tolerable,
but it is real complexity that a `docker compose` install would not have. Accepting it because the
alternative is maintaining *two* deployment paths, and the second one always rots.

It also raises the floor on operator skill, against a constraint that says operators are broadcast
engineers. The runbook has to carry more weight as a result
([operations runbook](../operations/17-operations-runbook.md)).

### Kustomize, not Helm — for now

Kustomize is built into `kubectl`, so the toolchain stays at one binary and the manifests are
readable YAML rather than templated YAML. For **our own** environments that is the right trade.

**Packaging for customer distribution is a separate question** and may still want a Helm chart —
customers expect `helm install`, values files are a familiar configuration surface, and chart
versioning maps onto product releases. Deferred rather than decided: it is additive, and building
it before the manifests have settled would mean templating something still in motion.

### No build step survives into the images

Containers run `node apps/<service>/src/main.ts` directly. Node 24 strips TypeScript types
natively, so the image ships exactly the source the tests ran against — no bundle, no transpile
output that can drift, no sourcemap indirection in a production stack trace.

This depends on the code being **strip-only compatible**: no constructor parameter properties, no
enums, no namespaces, because those *emit* code rather than only erasing types. Discovered the hard
way — the first image built cleanly and died at startup on
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Ten parameter properties were converted and
`@typescript-eslint/parameter-properties` now enforces it, because a single reintroduced one breaks
**every** container at startup while every test still passes.

A second trap in the same area: nested `node_modules` must be copied, not just the root. `ajv@8`
lives in `libs/contracts/node_modules` because eslint hoists an incompatible `ajv@6` to the root,
and an image with only the root tree dies on a package npm had installed perfectly well.

### Verified, not asserted

The manifests were applied to a real cluster, not dry-run. Both services run, the gateway reaches
IAM by service DNS, a login crosses pods, a minted token is **verified against IAM's remote JWKS**,
and the [smoke suite](../../infra/smoke/smoke.test.mjs) passes 8/8 against the deployment.

That last one matters more than it sounds. The first deployment was green — pods ready, health
checks passing, login working — while token verification was **completely broken**: the gateway
was handed a `URL` where a key resolver was required. Nothing detected it, because health checks
and public routes never verify a token. `tsc` caught it; the smoke suite now covers it, and a
deployment that cannot verify a signature can no longer look healthy.

Two smaller traps, both worth knowing because neither reports an error:

- **A kustomize file with two `patches:` keys silently drops one.** YAML duplicate keys override
  rather than merge, and neither kustomize nor kubectl warns. A patch that matches nothing is
  equally silent.
- **`kubectl config` still pointed at an unrelated cluster** from another project. Removed, after a
  backup — deploying into the wrong cluster is a failure mode with no undo.

### Follow-ups this creates

- **Ingress + TLS.** Dev uses a NodePort, which has no TLS, host routing or rate limiting.
  Deliberately not simulated — pretending a NodePort is an ingress hides the work.
- **IAM cannot scale past one replica** until its signing key ring loads from a Secret; today each
  process generates its own and replicas would reject each other's tokens. The manifest pins
  `replicas: 1` and says why.
- **Secrets management** is unaddressed — dev passes plain env vars.
- **The offline bundle** (EP-01.7) now has a concrete definition: images as tarballs plus the
  rendered manifests.
- **Observability** ([EP-12](../roadmap/21-epic-breakdown.md)) can now pick a stack, since "where
  does it run" is answered. That remains its own decision.

## Revisit when

- A meaningful share of deployments turn out to be single-node, and the Kubernetes tax is not
  paying for itself — at which point compare against k3s specifically before considering Compose.
- Customer feedback shows `helm install` is expected as the delivery mechanism; that is additive
  and does not overturn this decision.
