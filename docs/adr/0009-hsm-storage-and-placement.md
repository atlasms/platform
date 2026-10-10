# ADR-0009 — HSM: two storage drivers behind one port, bytes pushed to HSM over signed calls

- **Status:** Accepted — the three choices below were made by the product owner, 2026-10-01, and
  the implementation (#375) was merged at the product owner's direction the same day, **before** the
  two-reviewer pairing AGENTS.md §5.7 asks of HSM file operations. That review is still owed: treat
  this code as merged-unreviewed until it has had one, and record it here when it has
- **Date:** 2026-10-01
- **Stories:** EP-14.1 – EP-14.7 ([#14](https://github.com/atlasms/platform/issues/14))
- **Code:** [`apps/hsm`](../../apps/hsm/), `signInternalDigest` / `verifyInternalDigest` in
  [`@atlas/service-kit`](../../libs/service-kit/src/internal-auth.ts)

## Context

HSM is the only component that touches stored bytes ([hsm.md §1](../architecture/services/hsm.md),
FR-HSM-5, NFR-SEC-4). Until now there was no HSM, and three services held bytes of their own: RIM's
staging, MTS's work area (a PVC that pinned MTS to one replica) and the recorder workers' volumes.
MAM's FileRef mirror already consumed `file.placed` — from a producer that did not exist.

The design names what HSM does and leaves open how. Three choices had lasting consequences and were
the product owner's:

| Question | Chosen |
|---|---|
| The online tier's storage | **Both drivers now** — a POSIX filesystem and S3-compatible object storage, behind one port |
| How bytes reach HSM | **Producers push to HSM** over a signed internal call; only HSM mounts storage |
| The first slice | **All of EP-14** |

## Decision

### 1. One `StorageDriver` port, two drivers, one conformance suite

```
write(key, source) → { sizeBytes, sha256 }   hashes the bytes as it writes them; never partial
read(key)          → Readable
stat(key)          → { sizeBytes } | undefined
remove(key)        → idempotent
probe()            → readiness
```

- **`fs`** — a root directory (a SAN/NAS mount; a ReadWriteMany volume on Kubernetes). A write goes
  to `<key>.part-<ulid>` in the same directory, is `fsync`ed, then `rename`d — atomic on POSIX, so a
  reader never sees half a file and a crash leaves only a `.part-` file. Keys are relative and
  contained: `..`, absolute paths and symlinks out of the root are refused.
- **`s3`** — any S3-compatible store (MinIO on-prem, AWS, …) via `@aws-sdk/client-s3` and
  `lib-storage`'s multipart `Upload`, fed from a stream that hashes as it passes. A failed upload is
  aborted, so no partial object is left under the key.
- **SHA-256 is computed by HSM from the bytes it writes**, never taken from a producer's claim; a
  producer's claim is checked against it (§3).
- The suite (`driver-conformance.ts`) runs against `fs` everywhere and against a real
  S3-compatible server in CI — **SeaweedFS**, since MinIO no longer publishes community images to a
  public registry; the driver is not specific to either — skipped on a laptop without
  `ATLAS_S3_URL`, **failed** in CI without it (the Postgres/JetStream rule).

Hand-rolled SigV4 (the ADR-0004 move) was rejected here: multipart upload with its abort and
retry is where the subtle bugs are, and this code is correctness-critical.

### 2. Storage targets are data; credentials are not

A **storage target** is a Tier-1 registry row (`storage:admin`, audited): `tier`, `kind`
(`fs`|`s3`), the non-secret settings (a root; an endpoint, bucket, region, key prefix, path-style
flag) and a **`credentialRef`** — the NAME of a directory in HSM's credentials Secret, mounted only
into the HSM pod (`<ref>/accessKeyId`, `<ref>/secretAccessKey`). No credential is in the database, a
request, a response, an event or a log. A platform-wide target (no `channelId`) needs an unscoped
grant; a channel may have its own, which wins. A target is **disabled, never deleted** — ledger rows
name it.

### 3. Placement: the producer pushes, signed over the file's own checksum

`PUT /internal/v1/assets/{assetId}/files/{kind}` with the bytes as the body, streamed, never
buffered. ADR-0008's signature covers `SHA256(BODY)`; for a multi-gigabyte body the producer signs
the digest it already has (MTS hashes every rendition; RIM hashes on assembly) with
`signInternalDigest`, and HSM:

1. checks the header's shape, key set and time window **before reading the body** — a stale or
   unsigned request is refused without streaming gigabytes;
2. streams the body into the target driver, hashing as it writes, to a key no file has used —
   `<channel>/<asset>/<kind>[.<variant>]/<fileId>` — so a placement **never overwrites** bytes;
3. verifies the signature with the digest it computed (`verifyInternalDigest`). A mismatch — a
   tampered body, or a producer whose bytes are not the ones it hashed — is a bare 401 and the
   written object is removed;
4. commits the ledger row, `file.placed` and `audit.recorded` in ONE transaction.

So the checksum in the ledger is HSM's own, and it equals the producer's, and the signature is what
proves both. A placement that replaces a file (same asset/kind/variant) is a new row version
pointing at the new key; the old bytes are deleted by a queued operation after the commit, never
before. Placing the same bytes again is a no-op that returns the current row.

**Scope of ADR-0008 widened.** ADR-0008 scoped signed calls to the components of ONE service. This
decision extends the mechanism to a **producer service calling HSM**: each receiving service has its
own key Secret (`hsm-internal-keys`), mounted into the receiver and into exactly the producers that
call it; authority comes from what the request names (the asset, the channel it carries), and every
such route is idempotent. The gateway never routes `/internal/`. This is a security decision and is
flagged for review with the rest.

**Widened again for a READER (EP-31, 2026-10-09 — chosen by the product owner).** Scheduling asks HSM
where each rendition is when a reel is validated: `POST /internal/v1/availability`, read-only. It
signs with a key from a SEPARATE Secret, `hsm-read-keys`, which HSM accepts on that route alone —
the producers' `hsm-internal-keys` still open every internal route, a reader's key opens no write,
no byte read and no operation, so a leaked Scheduling key tells someone where files are and nothing
more. The request names assets and kinds, never a channel; the answer carries each file's channel
and Scheduling holds it to the schedule's. Flagged for review with the rest.

### 4. The ledger

`files`: the [File record](../architecture/schemas/file.schema.json) as the system of record — one
LIVE row per `(assetId, kind, variant)` (a partial unique index where `deleted_at IS NULL`), `version`
for compare-and-set, `storage{targetId, path, tier, status}`, `checksum`, `sizeBytes`, `technical`,
`provenance`. A deleted file keeps its row (`deletedAt`), for audit. `file_replicas`: verified copies
of a file on other targets (what a copy makes, and what an integrity sweep will restore from).
Every write audits `file` (read under `asset:read`/`files`, as MAM's mirror rows are).

### 5. Operations: a table, leased, restartable

`copy` (a verified replica on another target), `move` (the file to another target/tier: copy,
verify, compare-and-set the ledger, then delete the source) and `delete` (bytes and replicas; the row
keeps `deletedAt`). `POST /internal/v1/files/operations` enqueues — idempotent by the caller's
operation id — and returns at once; a worker **leases** the row by compare-and-set (MTS's queue:
`putOperation(op, ifState)`), streams the bytes outside any transaction with `bytesDone`/`bytesTotal`
progress, and commits the outcome guarded by the state it leased. **Resume is an idempotent
restart**: the destination key is derived from the operation id, so a retry overwrites its own
partial work and nothing else; a dead worker's lease lapses and the sweep takes it back. A failure is
retried with backoff and dead-lettered after three. Ranged/multipart resume is a later optimisation,
not a correctness property.

**Verification at the destination** is the hash of the bytes as they were written there, compared to
the ledger's; re-reading a written file (a second full read) is the integrity sweep's, EP-36.

### 6. Enforcement (14.7)

- **MTS** pushes every rendition to HSM (§3) instead of keeping it, and may take its input from HSM
  (an asset's file by kind, streamed to its scratch space) — the work area stays for the sample
  clips a deployment renders until RIM places originals.
- **RIM** places every accepted file in HSM as its asset's `original` (EP-15.5): the asset id is the
  ingest job's id, the placement is signed over the checksum RIM computed on receipt, and the staged
  copy is removed only after the job commits `registered`. Its staging is intake, not storage.
- `k8s:check` fails if any workload but `hsm` mounts the storage volume or the storage credentials
  Secret — so "only HSM touches storage" is a property of the manifests CI renders, not a promise.

### 7. What is not decided here

Tiering policy, restore and integrity sweeps (EP-36); send-to-air export and the path rewrite
(EP-31 with HSM, v1.5); a separate worker deployment (the queue already allows it); worker-threads
for hashing — deferred until profiling says Node's streaming hash does not saturate the storage path
(hsm.md §8's escape hatch).

## Consequences

- One more network copy per file placed (the producer's local file → HSM). Accepted for the
  guarantee that no other workload holds storage credentials or a storage mount.
- MTS no longer needs its work area for outputs; since EP-16.6 it is per-pod scratch and MTS
  scales by replica count (with lease-guarded writes and a heartbeat — mts.md §11).
- The AWS SDK is a new dependency of HSM alone (not of any library).
- Until 15.5, the only producer in a deployment is MTS; originals do not yet reach HSM.

## Alternatives considered

- **A shared landing area** that producers write and HSM claims — no extra hop, but every producer
  mounts a volume next to storage, which is the property this decision exists to remove. Declined by
  the product owner.
- **Filesystem only, S3 later** — less work now; the owner chose both, so the port is proved by two
  implementations from the start.
