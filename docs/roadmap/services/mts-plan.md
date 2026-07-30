# MTS — Media Transcoding System — Implementation Plan

> Build plan for the elastic transcoder: consume transcode commands, drive **FFmpeg** to produce
> the configured rendition set, report progress, write checksums.
> Spec: [mts](../../architecture/services/mts.md) · Stack: **Node + NestJS orchestrator over FFmpeg
> subprocesses** (GPU-optional) · Ships: **Phase 1 (v1)** → **Phase 2 (autoscale + VTT/hover)**.
> The canonical **scale-to-many** service.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 1 | Queue-driven FFmpeg transcode to **proxy + broadcast + thumbnail**; progress/complete/fail events; **manual** multi-instance scaling; checksums per output. |
| v2 | 2 | **Auto-scale on queue depth** (KEDA); **VTT filmstrip + hover preview**; per-channel/type profiles. |
| v2.5 | 3 | **GPU** acceleration (NVENC/QSV); cloud burst where internet exists. |

**Non-goals.** No storage (I/O paths come from [HSM](hsm-plan.md)); no scheduling of *when* to transcode
(that's [BMS](bms-plan.md)/RIM). Language is incidental — the heavy work is FFmpeg + GPU.

## 2. Build sequence

1. **Job model + queue (v1)** — persisted job records (preset + input/output paths) for retry/audit;
   consume from the broker/queue.
2. **FFmpeg orchestrator** — build FFmpeg command lines from **profile presets**; spawn via
   `child_process`; parse stderr for **progress**; enforce timeouts; capture failures with logs.
3. **Rendition set (v1)** — proxy, broadcast, thumbnail; write each output via HSM paths; compute +
   record checksums; emit `transcode.started/progress/completed/failed`.
4. **Preview renditions (v2)** — **VTT scrub filmstrip** + **hover preview**; per-channel/type profiles
   selectable by media type.
5. **Elastic scaling (v2)** — scale worker instances on **queue depth** (KEDA); drain on empty; ensure
   idempotent job claim (one worker per job).
6. **GPU + burst (v2.5)** — optional NVENC/QSV workers; cloud-burst pool where egress is allowed.

## 3. Components / modules

- `jobs` (queue + records), `presets` (profile config), `ffmpeg-runner` (spawn/parse/timeout),
  `progress`, `outputs` (write via HSM + checksum), `scaler` (KEDA hooks), `gpu` (optional).

## 4. Data plane & migrations

- **Queue + job records** (persisted for retry/audit); **profile presets** as config. Minimal
  relational footprint; object I/O via HSM. Additive migrations.

## 5. APIs & events

- REST (thin): [`mts.yaml`](../../architecture/openapi/mts.yaml) — `GET /jobs/{id}`, `POST /jobs`
  (normally issued by BMS/RIM, not users).
- **Emits:** [`transcode.started`](../../architecture/schemas/events/transcode.started.payload.schema.json),
  `transcode.progress`, `transcode.completed`, `transcode.failed`. **Consumes:** `ingest.accepted`,
  `transcode.job.create` (cmd, from BMS/RIM),
  [`editor.render.requested`](../../architecture/schemas/events/editor.render.requested.payload.schema.json).

## 6. Dependencies & integration points

- **Requires first:** [HSM](hsm-plan.md) (I/O paths), broker, FFmpeg. **Consumed by:** [MAM](mam-plan.md)
  (attaches renditions on `transcode.completed` → `asset.ready`), HSM (place outputs), editor renders.

## 7. Testing focus

- Progress parsing accuracy + timeout/kill on stuck jobs.
- **Idempotent job claim** under many workers (exactly-once output per job).
- Failure isolation (one bad input doesn't stall the queue); retry/backoff.
- Autoscale behavior vs queue depth (v2); GPU vs CPU output parity (v2.5).

## 8. Scaling & deployment

- **Scale the workers, not the runtime** — queue-depth-driven horizontal scale (KEDA); GPU-optional.
  Config: profile presets per channel/type, concurrency per worker, timeouts, scale thresholds, GPU
  enable, burst pool.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Transcode capacity underestimated | Size to peak + autoscale (v2) + cloud burst where possible ([Roadmap risks](../08-roadmap.md#risks)). |
| Stuck/zombie FFmpeg processes | Timeouts + kill + heartbeat; job re-queue on worker death. |
| Duplicate outputs from redelivery | Idempotent claim + deterministic output paths. |
| GPU/driver variance | Keep CPU path as fallback; validate output parity. |
