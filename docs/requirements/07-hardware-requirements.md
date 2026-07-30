# Hardware & Infrastructure Requirements

> Minimum and recommended sizing per deployment tier, and the reasoning behind it. These
> satisfy the [Non-Functional targets](06-non-functional-requirements.md). Parent:
> [Technical Brief](../01-technical-brief.md). Deployment shapes:
> [Architecture §Deployment](../architecture/02-system-architecture.md#7-deployment-shapes).

> **Note on transcoding.** Media transcoding dominates compute. Sizing below assumes
> **FFmpeg** with optional GPU acceleration (NVENC/QSV). One modern GPU with NVENC can do
> several realtime HD encodes in parallel; CPU-only is viable for proxies but slow for
> multiple high-res/4K profiles. Right-size MTS to the ingest peak, not the average — it is
> the elastic service.

## 1. Deployment tiers

| Tier | Who it's for | Channels | Concurrent users | Ingest peak |
|------|--------------|:--------:|:----------------:|:-----------:|
| **Evaluation / Dev** | POC, single developer, demos | 1 | ≤ 5 | light |
| **Small** (baseline — first customer) | Mid-size broadcaster ([A6](../README.md#assumptions-register)) | 1–3 | ≤ 100 | ≤ 50/hr |
| **Medium** | Larger broadcaster | 5–15 | ≤ 150 | ≤ 100/hr |
| **Large** | Multi-brand / multi-region group | 15+ | 150–500 | 100–300/hr |

The **Small tier is the reference** the NFR targets are written against — it matches the
first customer (1–3 channels, up to ~100 concurrent users, [A6](../README.md#assumptions-register)).
Medium/Large describe headroom for growth. Note that the first customer has **few channels
but a relatively high user count** for its size, so size the API/Studio and WebSocket path for
~100 concurrent users even though channel count is low.

> **Air-gapped deployments** ([A9](../README.md#assumptions-register)): assume **no internet**.
> Compute, storage, and installs are all on-prem (installs come from a **local artifact/model
> registry** — an offline bundle). Cloud burst and the **full (online) AI tier are
> unavailable** by design; these sites run the **optional limited AI tier** (small local
> model, modest hardware) or no AI. See [§7](#7-gpu-guidance).

## 2. Compute — control-plane & domain services

These run as containers on the orchestrator. Numbers are **usable capacity** (exclude OS/k8s
overhead); provision N+1 for HA at the Small tier from v1.0 onward (HA is a v1.0 target for
the first customer, not only for larger tiers — see
[NFR-AVAIL](06-non-functional-requirements.md#availability)).

| Tier | Nodes | Per node (vCPU / RAM) | Notes |
|------|:-----:|-----------------------|-------|
| Evaluation | 1 | 8 vCPU / 32 GB | Single box, all-in-one, no HA. |
| Small | 3 | 8 vCPU / 32 GB | Small k8s/Nomad cluster; HA control plane. |
| Medium | 5–7 | 16 vCPU / 64 GB | Spreads domain services + data plane sidecars; HA. |
| Large | 10+ | 16–32 vCPU / 64–128 GB | Add nodes; separate data-plane nodes. |

Domain services are modest individually; the count and HA replication drive the total. Budget
roughly **1–2 vCPU and 1–4 GB per service replica**; the heavy consumers are MAM (cache/index
adjacency), BMS (durable timers), and the WebSocket service (many connections).

## 3. Compute — MTS (transcoding), the elastic tier

Size to the **ingest peak** and the number of profiles per asset.

| Tier | Baseline workers | Burst workers | Per worker | GPU |
|------|:----------------:|:-------------:|------------|-----|
| Evaluation | 1 (CPU) | — | 4 vCPU / 8 GB | optional |
| Small | 1–2 | +2 | 8 vCPU / 16 GB | 1× NVENC-class recommended |
| Medium | 3–4 | +8 (auto) | 8–16 vCPU / 16–32 GB | 1 GPU per 2 workers recommended |
| Large | 6–10 | +N (auto/cloud burst) | 16 vCPU / 32 GB | GPU per worker; cloud burst |

- **Rule of thumb:** to deliver [NFR-PERF-4](06-non-functional-requirements.md#performance)
  (proxy+thumb < 3 min for a 10-min HD file), one GPU worker suffices at Small; scale linearly
  with peak concurrency.
- **Hybrid burst** ([A1](../README.md#assumptions-register)): keep baseline workers on-prem,
  burst to cloud GPU instances when queue depth crosses a threshold, then release.

## 4. Data plane

| Component | Small | Medium | Large | Notes |
|-----------|-------|--------|-------|-------|
| Relational (PostgreSQL) | 1 primary + 1 replica, 8 vCPU / 32 GB, NVMe | + read replicas, 16 vCPU / 64 GB | clustered, partitioned | HA via replication/failover. |
| Document (MongoDB) | 3-node replica set, 8 vCPU / 32 GB | 16 vCPU / 64 GB | sharded | Extensible metadata. |
| Cache (Redis) | 1 primary + replica, 8–16 GB | sentinel/cluster, 32 GB | cluster | Hot reads, sessions. |
| Search (OpenSearch) | 3 nodes, 8 vCPU / 32 GB, fast SSD | 5 nodes, 16 vCPU / 64 GB | scale for 5M+ assets | Sizing tracks index size; keep index on SSD. |
| Broker (NATS/RabbitMQ) | 3-node cluster, 4 vCPU / 8 GB | 8 vCPU / 16 GB | cluster + tiered storage | Durable streams need disk; size to retention. |
| Object storage (MinIO/S3) | see §5 | see §5 | see §5 | Dominant capacity cost. |

## 5. Storage tiers (HSM)

Storage is the largest and most customer-specific cost. Estimate from library hours and the
rendition set, not from a fixed number.

**Per-hour footprint (approximate, tune to codecs/profiles):**

| Rendition | HD (~) | 4K (~) |
|-----------|-------:|-------:|
| Original master | 30–110 GB/hr | 100–400 GB/hr |
| Broadcast (high-res) | 10–25 GB/hr | 40–100 GB/hr |
| Proxy (low-res) | 0.5–1.5 GB/hr | 0.5–1.5 GB/hr |
| Thumbnail + VTT + hover | negligible | negligible |

**Tier sizing guidance:**

| Tier | Small (baseline / first customer) | Storage type | Purpose |
|------|-----------------------------------|--------------|---------|
| **Online** | Days–weeks of active schedule + proxies of everything | NVMe/SSD SAN/NAS | Day-to-day schedule media; fast access. |
| **Near-line** | Months of recent library | HDD object store / NAS | On-demand restore in seconds–minutes. |
| **Offline** | Full archive, years | Tape / **local** cold storage (or cloud archive if connected) | Backup, cold retention; restore in minutes–hours. In air-gapped sites this is on-prem tape/object only. |

Worked example (illustrative): a broadcaster with ~10,000 hours of HD library keeping
originals in near-line, broadcast+proxy online for the active window, and everything mirrored
to offline archive lands in the **low hundreds of TB** for online+near-line and **~1 PB-class**
for the full offline archive. Validate against the customer's actual library and retention
policy before quoting.

Also provision:
- **Ingest/scratch** space for uploads and transcode temp (fast SSD, sized to peak concurrent
  jobs × largest file × 2).
- **Control-room export** target on the broadcast LAN, sized to a full day's hi-res playlist.

## 6. Network

| Concern | Guidance |
|---------|----------|
| Internal fabric | 10 GbE minimum between compute and storage at Medium+; 25/40 GbE for Large or heavy 4K. |
| Control-room hand-off | Dedicated/segmented VLAN to playout; sized so a 2-hour hi-res export meets [NFR-PERF-7](06-non-functional-requirements.md#performance). |
| Ingest sources | Sufficient WAN for FTP/upload feeds; folder-watch mounts on the fast fabric. |
| Cloud burst (hybrid) | VPN/Direct-Connect with enough egress for near-line ↔ cloud transcode and archive. |
| Client access | Studio is bandwidth-light (proxies/thumbnails), but real-time WebSocket needs low latency. |

## 7. GPU guidance

- **When you need GPUs:** multiple concurrent high-res/4K profiles, or tight ingest SLAs. A
  single NVENC-class GPU handles several realtime HD encodes.
- **When CPU is fine:** proxy/thumbnail-only workloads, low volume, evaluation.
- **AI Enrichment is online-first** ([D4](../01-technical-brief.md#9-resolved-decisions)), so
  the **full tier needs no local GPU** — it calls cloud/vendor providers. Budget for that as
  **opex**, not hardware. Only the **optional offline tier** (air-gapped, suggestions/simple
  tasks) needs local inference, and that runs on **modest hardware — a single small GPU or
  even CPU** — not a large pool. This is a deliberate change from an earlier "self-hosted
  full models on-prem" stance, which would have required a mandatory GPU pool at every site.
  Keep any local AI inference off the MTS critical-path pool.
- **Editor render** ([FR-EDT](05-functional-requirements.md#editor)): video/audio renders
  reuse the MTS/FFmpeg workers; image editing runs on lightweight CPU image-processing
  workers. Interactive editing happens client-side on proxies, so only the final render
  consumes server GPU/CPU — modest additional capacity at the Small tier.

## 8. Environments

Beyond production, budget for:

| Environment | Sizing | Purpose |
|-------------|--------|---------|
| Dev | Evaluation tier per developer or shared | Feature work. |
| CI | Ephemeral runners + a small integration cluster | Build, test, contract tests. |
| Staging | Small-tier mirror of prod topology | Pre-release validation, perf tests, drills. |
| Production | Per customer tier above | — |
| DR | Replicated per [NFR-AVAIL](06-non-functional-requirements.md#availability) | RTO/RPO targets. |

## 9. Minimum viable footprint (for the MVP milestone)

To run the [MVP](../roadmap/08-roadmap.md) (one channel, ingest→metadata→transcode→search→
schedule) for a pilot:

- **3-node cluster**, 8–16 vCPU / 32–64 GB each (services + single-instance data plane).
- **1 MTS worker** with an NVENC-class GPU (or 2 CPU workers) for proxy/broadcast.
- **PostgreSQL + Redis + OpenSearch + broker + MinIO**, single-instance or minimal HA.
- **Online storage** sized to the pilot's active library; near-line/offline deferred.

This is deliberately lean; HA and near-line/offline automation arrive with
[Phase 3 / v1.0](../roadmap/08-roadmap.md).

---
_Next: [Delivery Roadmap](../roadmap/08-roadmap.md)._
