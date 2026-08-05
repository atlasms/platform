# The offline install bundle

Atlas installs into air-gapped facilities ([A9 / FR-PLat-7](../requirements/05-functional-requirements.md#platform)),
so the bundle is the only artifact an isolated site ever receives. Built by
[`scripts/build-bundle.mjs`](../../scripts/build-bundle.mjs).

```sh
npm run bundle -- --version 0.1.0
# → dist/bundle/atlas-0.1.0/
```

```
atlas-0.1.0/
├── images/            one tar per service (docker save)
├── manifests/         RENDERED Kubernetes YAML — no kustomize or helm needed to install
├── install.sh         verify → load → apply
├── bundle.json        version, git commit, image IDs
└── SHA256SUMS         every file above
```

## Installing

```sh
./install.sh --verify-only    # integrity only
./install.sh                  # load images and apply
```

`install.sh` verifies checksums **before** it loads anything and exits non-zero on any mismatch, so
a corrupted or altered bundle cannot be half-installed. It uses `docker load` where Docker exists
and `ctr -n k8s.io images import` otherwise, which is what a Kubernetes node actually runs.

## Choices worth knowing

**Manifests are rendered, not templated.** The installing site needs `kubectl` and nothing else —
no kustomize, no Helm, no chart repository. It also means what ships is exactly what was reviewed.
Packaging as a Helm chart for customer distribution stays open
([ADR-0002](../adr/0002-deployment-target.md)); it is additive.

**Images are tagged with the bundle version, never `:dev` or `:latest`.** A floating tag inside an
air-gapped bundle is a lie: the artifact is fixed at build time, so the tag has to say which one.
`bundle.json` also records each image ID, which a tag cannot be reassigned away from, plus the git
commit that produced it — the first question in an incident is *what is actually installed*.

**The bundle contains no Kubernetes.** The site brings its own cluster. Shipping a distribution
would still be wrong about the site's storage, networking and node topology.

**Integrity is checksums, not signatures.** `SHA256SUMS` detects corruption and tampering by
anyone who cannot rewrite the file; it does not prove origin. The
[runbook](17-operations-runbook.md) calls for a verified signature, and that needs a signing key
and a distribution path for the public half — **not yet implemented**, and the bundle does not
pretend otherwise.

## Verified, not asserted

The air-gapped path was exercised, not described:

1. A kind cluster created from scratch, confirmed to hold **no Atlas images**.
2. The bundle copied in and installed with the node's own `ctr` — no registry, no network.
3. Kubernetes reported every image **`already present on machine`**: nothing was pulled.
4. The [smoke suite](../../infra/smoke/smoke.test.mjs) passed **8/8**, including minting a token
   and verifying it against IAM's JWKS.
5. Appending one line to a manifest made `install.sh` fail verification and abort with exit 1
   before loading anything — a checksum that never fails is not a check.
