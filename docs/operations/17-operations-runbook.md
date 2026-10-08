# Operations Runbook

> How Atlas is **installed, upgraded, backed up, recovered, and cut over** — the procedures that
> turn the [availability targets](../requirements/06-non-functional-requirements.md#availability)
> (RTO < 1 h, RPO < 5 min metadata) from numbers into repeatable steps. This is the ops counterpart
> to the [hardware requirements](../requirements/07-hardware-requirements.md) (sizing) and the
> [system implementation plan](../roadmap/16-system-implementation-plan.md) (building).
>
> Audience: ops / SRE / deployment engineers. Scope: **on-prem, hybrid, and SaaS**
> ([deployment shapes](../architecture/02-system-architecture.md#7-deployment-shapes)).

## 1. Principles

1. **Everything is a container + a contract.** Services are stateless deployables; **all durable
   state is in the data plane** (Postgres, Mongo, object storage, OpenSearch, broker) — so recovery
   is "restore the data plane, redeploy the stateless tier."
2. **Config is data, secrets are mounted.** [Bootstrap config](../architecture/configuration-and-reference-data.md#3-what-this-is-not-bootstrap-configuration)
   is env/secret; [reference data](../architecture/configuration-and-reference-data.md) is seeded and
   promotable. Neither is hand-typed on a live box.
3. **No step assumes the internet.** Every procedure has an **air-gapped path**
   ([A9](../README.md#assumptions-register)); the offline bundle is the source of truth on isolated
   sites.
4. **Rehearse recovery, don't discover it.** Backups are worthless until a restore drill has passed;
   DR is a scheduled exercise, not a first-time event during an incident.
5. **Forward-only schema, expand→migrate→contract.** Upgrades never require downtime for a schema
   change; rollbacks never hit a schema they can't read.

## 2. Topology recap (what has to come up, in order)

```
data plane   →  backbone            →  domain services        →  edge
Postgres        broker (JetStream)      IAM, MAM, HSM, MTS,       API Gateway
Mongo           vault                   RIM, Scheduling, BMS,     WebSocket
object store    (Temporal for BMS)      Notifications, …          Studio (static)
OpenSearch
Redis
```

**Boot order matters only at cold start:** data plane and broker/vault first (health-gated), then
services (they retry their dependencies via `service-kit` readiness), then the edge. Kubernetes
readiness probes enforce this without manual sequencing.

## 3. Installation

### 3.1 Prerequisites
- Kubernetes (or the single-node compose profile for MVP/pilot), a container registry reachable by
  the cluster, block + object storage classes, and a secrets backend (vault / sealed-secrets).
- Sizing per [hardware requirements](../requirements/07-hardware-requirements.md) for the tier.

### 3.2 Connected install
> **As built:** the platform is Kustomize, not Helm ([ADR-0002](../adr/0002-deployment-target.md)),
> and [`infra/k8s/overlays/staging`](../../infra/k8s/overlays/staging/) is the production-shaped
> overlay an install starts from — registry images by release tag, one TLS Ingress, PDBs, a sized
> data plane, credentials from a Secret git never sees. `npm run k8s:check` holds every overlay to
> those conventions in CI. A Helm chart for customer distribution remains additive.
>
> **The MVP pilot** ([EP-21.2](../roadmap/21-epic-breakdown.md)) installs with the chart
> ([ADR-0006](../adr/0006-helm-chart.md)) and its pilot profile,
> [`infra/helm/profiles/pilot.yaml`](../../infra/helm/profiles/pilot.yaml), sized for the
> [minimum viable footprint](../requirements/07-hardware-requirements.md#9-minimum-viable-footprint-for-the-mvp-milestone)
> at its small end (3 × 8 vCPU / 32 GiB, two CPU transcode workers):
>
> ```sh
> helm install atlas infra/helm/atlas -n atlas --create-namespace >   -f infra/helm/profiles/pilot.yaml >   --set image.registry=<registry> --set image.tag=<release> >   --set ingress.enabled=true --set ingress.host=<host> >   --set postgres.auth.existingSecret=<secret>
> ```
>
> `npm run k8s:check` renders the chart with that profile in CI and fails if its requests stop
> fitting three such nodes with a quarter of each left over, or if one pod would not fit one node.
> The nodes' local disk must hold each MTS worker's 200 GiB scratch (requested as ephemeral storage).

1. Point at the registry; apply the platform Helm umbrella chart (`values.yaml` sets channel(s),
   storage classes, replica counts, external IdP if any).
2. Provision the data plane (managed or in-cluster operators), broker, vault; load secrets.
3. Run **migrations** (`atlas migrate up`) and **seed reference data** (`atlas ref seed`) — idempotent
   ([Config §6](../architecture/configuration-and-reference-data.md#6-seed-as-code--environment-promotion)).
4. Bring up services, then the edge; run the **smoke suite** (§8).
5. Create the first admin; rotate the bootstrap credential.

### 3.3 Air-gapped install ([FR-PLat-7](../requirements/05-functional-requirements.md#platform))
Identical, but sourced from the **offline install bundle**
([plan §7](../roadmap/16-system-implementation-plan.md#7-offline--air-gapped-delivery)):
- The bundle contains **all container images, Helm charts, migration + seed files, and optional AI
  models** — no external pulls.
- Load images into the on-site registry (`atlas bundle load`), then follow §3.2 from step 1.
- **Verify the bundle signature** before load; the manifest pins every artifact digest.

### 3.4 SaaS / hybrid
Vendor-hosted control/data plane; the customer runs the **[site connector](../architecture/02-system-architecture.md#saas)**
(a thin HSM edge) so send-to-air can write onto the control-room LAN. The connector is the only
on-prem component and follows the same upgrade cadence.

## 4. Upgrade & rollback

### 4.1 Zero-downtime rule: expand → migrate → contract
Schema changes ship in **three separable steps across releases**, never one:
1. **Expand** — add new columns/indices/tables, nullable/defaulted; old code ignores them.
2. **Migrate** — backfill; dual-write if needed. New code reads new *and* old.
3. **Contract** — a **later** release drops the old shape, once no running code reads it.

This is what makes a rollback safe: release _N+1_ never removes what release _N_ needs.

### 4.2 Procedure
1. Pre-flight: `atlas doctor` (versions, pending migrations, broker/DLQ depth, backup freshness).
2. **Back up** the data plane (§5) and **snapshot reference data** (`atlas ref export`).
3. Apply **expand** migrations (online, additive).
4. **Rolling deploy** services (maxUnavailable 0); readiness-gated. Contracts are versioned, so a
   new producer and an old consumer interoperate (tolerant-reader,
   [Messaging §1.3](../architecture/04-messaging-and-data.md#13-message-envelope)).
5. Run the smoke suite; watch error rate + DLQ for the bake period.
6. Schedule the **contract** migration for a subsequent release.

### 4.3 Rollback
- **Code:** redeploy the previous image tag (Helm rollback). Safe because the schema is still in its
  expanded, backward-compatible state.
- **Data:** only if a migration corrupted data — restore from the pre-upgrade backup (§5) and replay
  the broker from the last consumed offset where applicable.
- **Never** run a *contract* migration you cannot roll back without a restore; that is the whole
  point of deferring it.
- **Studio** is static assets; roll back by republishing the prior bundle (it revalidates against the
  API version and the reference `configVersion`).

## 5. Backup & restore (meeting RPO < 5 min)

| Store | What | Method | Cadence → RPO |
|-------|------|--------|---------------|
| **Postgres** (metadata, identity, ledger, schedules) | the SoR for structured state | streaming WAL / PITR + nightly base backup | continuous → **< 5 min** ([NFR-AVAIL-6](../requirements/06-non-functional-requirements.md#availability)) |
| **Mongo** (extensible metadata, edit projects, scripts) | document state | oplog tailing / managed continuous backup | continuous → < 5 min |
| **Object storage** (asset files) | the bytes | tier replication + versioning; masters protected by [tiering + checksum](../architecture/services/hsm.md) | replicated; **RPO = last placement** |
| **OpenSearch** (search + audit/history) | projections | rebuildable from events; snapshot the audit index (compliance) | snapshot hourly; **rebuild** for search |
| **Broker** (JetStream) | in-flight + retained streams | replicated streams; periodic stream backup | replicated |
| **Vault** | secrets | vault's own backup/HA | per vault policy |
| **Reference data** | vocabularies/settings/registries | `atlas ref export` bundle | per change + nightly |

**Key point:** search and history indices are **projections** — treat them as rebuildable from the
audit/event log rather than as primary backups. Only the audit store itself (compliance record) and
the structured/document/object stores are authoritative.

**Restore drill (quarterly, required before v1.0 GA):** restore Postgres+Mongo to a scratch
namespace at a chosen PITR timestamp, rebuild indices from events, verify a sample of assets resolve
end-to-end (metadata ↔ file ledger ↔ bytes ↔ checksum). A restore is not "done" until the smoke
suite passes against it.

> **As built — the first drill, rehearsed (EP-21.3, 2026-10-04).** `npm run drill -- --yes`
> ([`scripts/restore-drill.mjs`](../../scripts/restore-drill.mjs)) on the kind dev cluster. It is a
> **logical** drill — `pg_dump` of the one database every service's schema lives in, and a tar of
> HSM's online tier — because continuous WAL archiving (the table above) is not stood up yet; that
> needs its own decision (a tool and an archive target) and an ADR. The order is the one a PITR
> restore must keep too:
>
> 1. **Quiesce** — every service outbox drained (logging has none: it is the sink), every service
>    and the recorder workers stopped, HSM's operation queue idle. HSM stays up only to read its bytes.
> 2. **Back up and fingerprint** — rows per table in every service schema, the audit log's chain head
>    (seq and hash) per channel, and every live file's path and checksum.
> 3. **Destroy** the namespace, volumes included; **reinstall** from the same manifests with every
>    service held at zero.
> 4. **Restore the data plane first**: a fresh database, `pg_restore`; then HSM's bytes, with HSM
>    *started* but not *Ready* — its readiness asks IAM, which is still down, by design.
> 5. **Verify before anything writes**: the same row counts, the same chain heads, the same ledger,
>    and every ledger file's bytes hashing to the ledger's checksum.
> 6. **Start the services.** OpenSearch is NOT restored — the projector rebuilds the hot index from
>    Postgres ([ADR-0005](../adr/0005-audit-log-storage.md)). Then the smoke suite and the MVP journey.
>
> First full run: 2.1 MB database, 757 MB online tier; 55 tables, one chain head
> (`ch12` at seq 5462), 353 files — every check equal, every file's bytes matching, smoke 34/34,
> the journey 12/12. **Destroy to smoke-green: 893 s** (RTO < 1 h). The online tier dominates: 7 min
> to stream 757 MB through `kubectl exec`, 4 min to hash 353 files one exec each — a facility's
> library makes this the step to engineer (restore from replicated object storage, verify by
> sampling), as the table above already says. Found on the way: a restore that waits for HSM to be
> Ready never finishes while IAM is held back; and from Git Bash, a hand-typed
> `kubectl exec … tar -C /storage` is rewritten to a Windows path — set `MSYS_NO_PATHCONV=1` (the
> script calls kubectl directly and is not affected).

## 6. Disaster recovery (meeting RTO < 1 h)

| Scenario | Response |
|----------|----------|
| **Single service/pod loss** | Kubernetes reschedules; HA replicas absorb it ([NFR-AVAIL-2](../requirements/06-non-functional-requirements.md#availability)). No procedure. |
| **Data-plane node loss** | Operator failover (Postgres replica promote, JetStream re-replicate). Automatic; verify. |
| **Zone/site loss** | Fail over to the standby target: restore data plane from PITR + replicated object storage, redeploy the stateless tier from the registry/bundle, repoint the edge. Budget the hour: ~min restore + redeploy + smoke. |
| **Corruption / bad migration** | §4.3 data rollback: restore to the last good PITR, replay events forward. |
| **Checksum mismatch on a master** | HSM quarantines and restores from a replica/near-line copy ([HSM §6.2](../architecture/services/hsm.md#62-integrity-sweep)); no full-DR needed. |

DR runbook per deployment names the standby location, the restore order (data plane → services →
edge, §2), and the owner. **Chaos/failover drills** are scheduled in
[Phase GA](../roadmap/16-system-implementation-plan.md#5-phase--technical-deliverables).

## 7. Cutover (legacy → Atlas)

No legacy data migration ([A11](../README.md#assumptions-register)) — cutover is **operational**, not
a data import:
1. Run Atlas **in parallel**, ingesting new media, while legacy still airs.
2. Move channels one at a time: point ingest sources and the playout hand-off at Atlas; keep legacy
   as fallback for a defined window.
3. Validate a full **ingest → approve → schedule → send-to-air** cycle on the real control room
   before decommissioning the legacy path for that channel.

## 8. Smoke & health verification

- **Health/readiness:** every service exposes `service-kit` `/healthz` (liveness) and `/readyz`
  (dependencies) ([system plan §3.6](../roadmap/16-system-implementation-plan.md#36-observability-baseline)).
- **Smoke suite** (post-install/upgrade/restore): auth round-trip; create→transcode→approve an
  asset; schedule it; **dry-run** a send-to-air export and verify path-rewrite + checksum at the
  destination; confirm one event flows gateway→broker→consumer (the "hello asset" trace).
- **Golden signals** per service (latency, error rate, saturation) + Atlas specifics: **DLQ depth,
  restore-ETA accuracy, checksum-mismatch count, export duration** ([HSM §12](../architecture/services/hsm.md#12-observability)).

**Pilot feedback and defects** follow [pilot feedback & triage](pilot-feedback.md): reports carry
Studio's `error ref` (the correlation id), a **critical** report is an incident handled from §6, and
triage runs daily during pilot weeks.

## 9. Routine operations

| Task | How |
|------|-----|
| Add a channel/tenant | Helm value + `atlas ref seed --channel`; scoped roles auto-apply. |
| Rotate a secret/credential | Update vault; services re-read on the next lease. Storage creds live only in HSM ([NFR-SEC-4](../requirements/06-non-functional-requirements.md#security--privacy)). |
| Change reference data | Admin UI or `atlas ref import` → emits `config.changed`; no redeploy. |
| Scale MTS for a spike | Raise worker replicas / KEDA on queue depth; drains when idle. |
| Drain a node | Cordon + rolling evict; stateless services move freely, data-plane operators handle their own. |
| Inspect a stuck flow | BMS instance view + the correlation id across logs/traces. |
| Replay a DLQ'd message | After fixing the cause, requeue from the DLQ tool; consumers are idempotent. |

## 10. Observability & alerting baseline

Logs/metrics/traces from `service-kit`; the [Logging & Analytics](../architecture/services/logging-analytics.md)
service is the audit + ops sink and raises [`alert.raised`](../architecture/schemas/events/alert.raised.payload.schema.json)
on thresholds (DLQ growth, checksum-mismatch rate, restore-ETA breach, storage-target down) →
[Notifications](../architecture/services/notifications.md). Every access-control **denial** and access
to raw logs is itself audited ([FR-AUD](../requirements/05-functional-requirements.md#audit)).

## 11. Open items

- Multi-site replication **topology** and the DR RPO/RTO drill matrix — tracked in
  [HSM §14](../architecture/services/hsm.md#14-open-questions--future).
- LTO/tape library driver matrix vs cloud-archive-only for the offline tier.
- Per-tenant encryption-key rotation runbook for the dedicated-tenancy tier.

---
_Related: [Hardware & Infrastructure](../requirements/07-hardware-requirements.md) ·
[System Architecture §7–8](../architecture/02-system-architecture.md#7-deployment-shapes) ·
[System Implementation Plan](../roadmap/16-system-implementation-plan.md) ·
[Configuration & Reference Data](../architecture/configuration-and-reference-data.md) ·
[NFR Availability](../requirements/06-non-functional-requirements.md#availability)._
