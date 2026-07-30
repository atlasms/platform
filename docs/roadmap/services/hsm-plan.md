# HSM — Hierarchical Storage Manager — Implementation Plan

> Build plan for the **only** component that touches storage: the file-location ledger and all
> place/copy/move/delete/restore/export operations across online / near-line / offline tiers.
> Spec: [hsm](../../architecture/services/hsm.md) · Stack: **Node + NestJS API; worker-threads for
> hashing/copy** (escape hatch: native/Go mover) · Ships: **Phase 1 (v1 online)** → **Phase 3 (tiering)**.
> The one genuinely CPU/IO-heavy service — profile it.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 1 | Online tier; place/copy/move/delete; **checksum on ingest**; file-ops-only-via-HSM; location ledger. |
| v1.5 | 2 | Send-to-air **export** (copy hi-res + playlist to control room, path rewrite). |
| v2 | 3 | Near-line/offline tiering + **restore with ETA**; periodic **integrity sweeps**; HA. |

**Non-goals.** No metadata meaning (that's [MAM](mam-plan.md)); no encoding (that's [MTS](mts-plan.md)).
Storage credentials never leave HSM — other services request ops, never touch storage.

## 2. Build sequence

1. **Location ledger + operations queue** — relational model of every rendition's tier/status and an
   idempotent operation record (copy/move/delete/restore/export) with state/progress/retries.
2. **Storage abstraction** — driver interface over object storage (S3/MinIO on-prem) + local FS;
   least-privilege credentials held only here.
3. **Core file ops (v1)** — place bytes on ingest, copy/move/delete via `POST /files/operations`
   (internal, permissioned); stream-based, resumable, with **worker-threads** for hashing and large copies.
4. **Checksums** — compute on placement, store records; emit `checksum.verified` / `checksum.mismatch`
   (alert + quarantine on mismatch).
5. **Send-to-air export (v1.5)** — consume `schedule.sent-to-air`; copy hi-res renditions + the exported
   playlist to the control-room destination with **path rewrite** so `src_path` resolves on the playout
   host; emit `playout.export.completed`.
6. **Tiering + restore (v2)** — tier policies (age/usage/schedule-proximity); move online↔near-line↔
   offline (tape/archive gateway); on-demand `POST /assets/{id}/restore` with **ETA**; emit
   `restore.completed`.
7. **Integrity sweeps (v2)** — scheduled re-hash + replica compare; alert/quarantine/restore-from-replica
   on drift.
8. **Purge** — consume `asset.deleted` (from [MAM retention](../15-review-lifecycle-implementation-plan.md));
   remove bytes per policy, **idempotently**.

## 3. Components / modules

- `ledger`, `operations` (queue + workers), `storage-drivers`, `checksum` (worker-threads),
  `export` (control-room copy + path rewrite), `tiering`, `restore`, `integrity-sweep`, `purge`.

## 4. Data plane & migrations

- **Relational:** file-location ledger, operation queue/records, checksum records, tier policy config.
  **Object/tape:** the byte stores themselves. Additive migrations; the ledger is the recovery source.

## 5. APIs & events

- REST: [`hsm.yaml`](../../architecture/openapi/hsm.yaml) — `/assets/{id}/restore`,
  `/assets/{id}/location`, `/files/operations`, `/playout/exports`.
- **Emits:** `file.placed`, `file.moved`, `restore.completed`, `checksum.verified`,
  `checksum.mismatch`, `playout.export.completed`. **Consumes:** `transcode.completed`,
  `schedule.sent-to-air`, `asset.deleted`.

## 6. Dependencies & integration points

- **Requires first:** object storage, broker, `service-kit`. **Consumed by:** RIM (place), MTS
  (I/O paths), MAM (location mirror), Scheduling (export).

## 7. Testing focus

- **Idempotent operations** — replayed copy/move/delete/purge = no-op; interrupted op resumes/rolls back.
- Checksum correctness + mismatch → quarantine + alert path.
- Export path-rewrite correctness (playout-host resolvable `src_path`).
- Restore ETA accuracy; tiering policy transitions; **throughput profiling** (Node vs escape-hatch decision).

## 8. Scaling & deployment

- **Horizontally scalable workers** for file ops; throughput-bound. worker-threads for CPU-bound
  hashing/copy; **escape hatch:** native addon (napi-rs) or Go/Rust mover only if profiling shows Node
  can't saturate the storage/hash path. Config: storage endpoints/credentials, tier policies, checksum
  algorithm, sweep schedule/throttle, control-room destinations + path-rewrite rules, restore concurrency,
  delete/retention policy.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Byte movement can't saturate storage in Node | Profile in Phase 1; worker-threads first, native mover escape hatch. |
| Silent corruption | Checksums on place + periodic integrity sweeps + replica restore. |
| Credential exposure | Storage creds held only in HSM; others go through the API. |
| Export to wrong control-room path | Path-rewrite rules tested per channel; export is audited. |
