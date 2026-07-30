# RIM — Recording & Ingest Management — Service Specification

> The entry point: brings media in from files, watchers, FTP/upload, and recording. Summary
> card: [Service Catalog §RIM](../03-service-catalog.md#recording--ingest-management-rim).
> Template: [services/README](README.md#spec-template).

## 1. Purpose & boundaries

RIM is how bytes **enter** Atlas. It detects or receives incoming media, validates it against
per-source **acceptance rules**, extracts technical metadata, computes an initial checksum, asks
[HSM](hsm.md) to place the bytes, creates the asset in [MAM](mam.md), and requests the first
proxy+thumbnail from [MTS](mts.md). It also **records** live streams/broadcasts and segments
them into files.

**In scope:** web/chunked upload endpoints; FTP and folder-watch sources; stream/broadcast
recording + segmentation; acceptance-rule evaluation; technical-metadata extraction (ffprobe);
initial checksum; ingest queue + quarantine; the Ingest/Import page's backing API.

**Out of scope:** where bytes physically live and integrity over time ([HSM](hsm.md)); the
rendition set beyond kicking off the first proxy ([MTS](mts.md)); the metadata system of record
([MAM](mam.md)); business workflow around approval ([BMS](bms.md)).

## 2. Requirements covered

- [FR-ING-1…7](../../requirements/05-functional-requirements.md#ingest) — upload/FTP/watch,
  resumable uploads, recording+segmentation, acceptance rules, reject/quarantine with reason +
  notification, technical metadata + checksum on accept, and appearance on the Ingest page.
- Feeds [FR-HSM-4](../../requirements/05-functional-requirements.md#hsm) (ingest-time checksum),
  [FR-MTS-2](../../requirements/05-functional-requirements.md#transcode) (initial proxy+thumb).
- NFR: [NFR-PERF-6](../../requirements/06-non-functional-requirements.md#performance) (≥100
  items/hour sustained), [NFR-PERF-4](../../requirements/06-non-functional-requirements.md#performance)
  (proxy+thumb < 3 min, via MTS).

## 3. Domain model

| Entity | Key fields | Store |
|--------|-----------|-------|
| **IngestJob** | id, channelId, source, state, receivedPath, size, techMeta, checksum, reason?, assetId? | Relational |
| **Source** | id, channelId, kind (upload/ftp/watch), connection config, enabled | Relational |
| **Recorder** | id, channelId, input (SDI/stream URL), segmentDuration, schedule, state | Relational |
| **AcceptanceRuleSet** | id, channelId, scope (source/type), rules[] (container, minSize, aspect, …) | Relational |
| **Segment** | recorderId, index, path, tcIn/tcOut, checksum | Relational |

### 3.1 Ingest state machine

```mermaid
stateDiagram-v2
    [*] --> Detected
    Detected --> Validating
    Validating --> Rejected: fails acceptance
    Validating --> Quarantined: needs review
    Validating --> Accepted: passes
    Accepted --> Registered: asset created in MAM and placed in HSM
    Registered --> [*]
    Rejected --> [*]
    Quarantined --> Accepted: operator override
    Quarantined --> Rejected: operator discard
```

## 4. Public API

> **Contracts:** REST → [OpenAPI stub](../openapi/rim.yaml) · events → [payload schemas](../schemas/).

| Method | Path | Purpose | Authz |
|--------|------|---------|-------|
| `POST` | `/uploads` | Start a chunked/resumable upload; returns an upload id. | `ingest:write` |
| `PUT` | `/uploads/{id}/parts/{n}` | Upload a chunk (resumable). | `ingest:write` |
| `POST` | `/uploads/{id}/complete` | Finalize → creates an IngestJob. | `ingest:write` |
| `GET` | `/ingest/queue` | The Ingest/Import page listing. | `ingest:read` |
| `POST` | `/ingest/{id}/accept` · `/reject` | Manual disposition of a quarantined job. | `ingest:approve` |
| `GET/POST` | `/watchers`, `/recorders`, `/acceptance-rules` | Source/recorder/rule administration. | `ingest:admin` |

## 5. Messaging

- **Emits:** `ingest.detected` (source, path, size), `ingest.accepted` (assetId, tech metadata,
  checksum — the fan-out that triggers MAM/MTS/AI), `ingest.rejected` (reason, rule),
  `recording.segment.completed` (recorderId, segment).
- **Consumes:** `acceptance-rules.updated` (reload rules). Recording schedules may be driven by
  [Scheduling](scheduling.md)/[BMS](bms.md) commands.
- **Commands issued (sync/async):** HSM place-file; MAM create-asset; MTS
  `transcode.job.create` for the initial proxy+thumbnail.

See [Messaging §Ingest](../04-messaging-and-data.md#ingest).

## 6. Key flows

### 6.1 Upload → accepted asset

```mermaid
sequenceDiagram
    participant U as Studio/Uploader
    participant RIM
    participant HSM
    participant MAM
    participant MTS
    U->>RIM: chunked upload → complete
    RIM->>RIM: ffprobe (tech meta) + checksum
    RIM->>RIM: Evaluate acceptance rules
    alt accepted
        RIM->>HSM: place bytes (online tier)
        RIM->>MAM: create asset (tech meta + checksum)
        RIM-->>MTS: transcode.job.create (proxy+thumb)
        RIM->>RIM: emit ingest.accepted
    else rejected/quarantined
        RIM->>RIM: emit ingest.rejected (+ notify)
    end
```

### 6.2 Recording & segmentation
A recorder captures an SDI/stream input via an FFmpeg process, writing rolling segments of the
configured duration ([FR-ING-3](../../requirements/05-functional-requirements.md#ingest)); each
completed segment becomes an ingest job (checksum + place + register) and emits
`recording.segment.completed`. Segmentation is crash-safe: a partially written segment is
finalized or discarded on restart.

## 7. Dependencies

- **HSM** — place incoming bytes; RIM never writes storage directly
  ([FR-HSM-5](../../requirements/05-functional-requirements.md#hsm)).
- **MAM** — create the asset record.
- **MTS** — first proxy+thumbnail.
- **FFmpeg/ffprobe** — technical metadata + capture/segmentation.
- **Relational store**, **broker**, **Notifications** (reject alerts).

## 8. Scaling & performance

- **Upload endpoints scale statelessly**; large files are chunked/resumable
  ([FR-ING-2](../../requirements/05-functional-requirements.md#ingest)) and streamed to HSM to
  bound memory.
- **Watchers are singletons per source** (one owner per watched folder to avoid double-pickup —
  use a leader lock).
- **Recorders scale per capture channel** (one process per input).
- Sustains **≥100 items/hour** without queue growth
  ([NFR-PERF-6](../../requirements/06-non-functional-requirements.md#performance)); checksum +
  ffprobe are the per-item cost — offload hashing to worker-threads.

## 9. Failure modes & degradation

| Failure | Effect | Mitigation |
|---------|--------|-----------|
| HSM unavailable | Can't place bytes → ingest stalls | Queue jobs in `Accepted`, retry; alert (critical path). |
| MTS backed up | Proxies late, asset still registered | Ingest doesn't block on transcode; proxy arrives later. |
| Watcher double-pickup | Duplicate ingest | Leader lock + idempotency on source path + checksum. |
| Recorder crash mid-segment | Partial file | Finalize/discard on restart; segment checksummed before registration. |
| Malformed/oversized upload | Rejected | Acceptance rules + size caps; quarantine with reason. |

## 10. Security & data sensitivity

- Upload endpoints are authenticated and size/type-limited; scanned per acceptance rules.
- FTP credentials and watcher paths are secrets (vault) — RIM holds source connection config,
  not storage credentials (those stay in HSM).
- All dispositions audited (who accepted/rejected what, and why).

## 11. Configuration

Per-channel sources (upload/FTP/watch) and their connection details; acceptance rule sets
(container/format, min size, aspect-ratio match, custom checks —
[FR-ING-4](../../requirements/05-functional-requirements.md#ingest)); recorder inputs, segment
durations, and recording schedules; chunk size + resumable-upload TTL; quarantine policy.

## 12. Observability

- **Metrics:** ingest rate (items/hour), accept/reject/quarantine ratios, time-to-register,
  checksum+ffprobe duration, watcher lag, recorder health, upload throughput/resume rate.
- **Logs:** every disposition with reason and rule id.
- **Traces:** correlation id from upload/detect through place→register→proxy.

## 13. Implementation notes

- **Node.js + NestJS** with worker processes/threads. Streamed chunked upload (`busboy`/tus-
  style resumable); `child_process` around **ffprobe/FFmpeg** for metadata and capture;
  worker-threads for checksum on large files (escape hatch to a native hasher only if profiling
  demands). `chokidar`/native inotify for folder watch behind a leader lock.
- Stream bytes to HSM rather than buffering whole files.

## 14. Open questions / future

- Growing-file / while-recording ingest (edit-while-ingest) — Post-v1.0.
- Live stream ingest (SRT/RTMP/RIST) breadth and hardware SDI capture matrix.
- Pre-ingest virus/content scanning hook for untrusted upload sources.

---
_Related: [HSM](hsm.md) · [MTS](mts.md) · [MAM](mam.md) ·
[Messaging §Ingest](../04-messaging-and-data.md#ingest)._
