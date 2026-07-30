# RIM — Recording & Ingest Management — Implementation Plan

> Build plan for the system's **entry point**: bring media in from uploads, folder watchers,
> FTP, and stream/broadcast recording; validate it; hand off to HSM/MTS/MAM.
> Spec: [rim](../../architecture/services/rim.md) · Stack: **Node + NestJS (worker processes)**;
> recording shells out to **FFmpeg/capture** · Ships: **Phase 1 (v1 ingest)** → **Phase 3 (recording)**.
> Critical path — first link in the chain.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 | 1 | Chunked/resumable **upload** + **folder watchers**; **acceptance rules**; technical-metadata extract; handoff to HSM (place) + MTS (proxy) + MAM (create). |
| v1.5 | 2 | FTP/inbound endpoints; per-channel/type acceptance rules editor; quarantine review. |
| v2 | 3 | **Stream/broadcast recording** with segmentation (e.g. 24h → 1h files). |

**Non-goals.** No transcoding (MTS), no byte storage (HSM), no catalog (MAM). RIM detects, validates,
extracts technical metadata, and orchestrates the initial handoff only.

## 2. Build sequence

1. **Upload endpoint (v1)** — chunked/resumable `POST /uploads`; stream to HSM placement; dedupe by
   checksum; backpressure for large files.
2. **Folder watchers (v1)** — per-source watcher (singleton) detecting new files; debounce partial
   writes; emit `ingest.detected`.
3. **Acceptance rules engine (v1)** — customizable per channel/type: container/format, min size,
   aspect ratio, etc. Pass → `ingest.accepted`; fail → `ingest.rejected` (quarantine + reason + notify,
   [FR-ING-5](../../requirements/05-functional-requirements.md#ingest)).
4. **Technical metadata extract** — probe (ffprobe) duration/codec/resolution/aspect/audio; attach to
   the accept event so MAM can create the asset and MTS can pick a profile.
5. **Handoff orchestration** — on accept: HSM places bytes, MTS is asked for proxy+thumbnail, MAM
   creates the `Created` asset. Idempotent per source file.
6. **Inbound endpoints (v1.5)** — FTP/upload connectors; rules editor UI surface; quarantine review flow.
7. **Recording (v2)** — capture streams/broadcasts per channel; **segment** into files; each segment
   emits `recording.segment.completed` → the same ingest path.

## 3. Components / modules

- `uploads` (resumable), `watchers` (per-source singletons), `recorders` (FFmpeg/capture, v2),
  `acceptance` (rule engine), `probe` (technical metadata), `handoff` (HSM/MTS/MAM orchestration),
  `quarantine`.

## 4. Data plane & migrations

- **Relational:** ingest queue, watcher/recorder config, acceptance rules, quarantine records.
  Additive migrations; rules are config-editable without deploy.

## 5. APIs & events

- REST: [`rim.yaml`](../../architecture/openapi/rim.yaml) — `/uploads`, `/ingest/queue`,
  `/ingest/{id}/accept`, `/watchers`, `/recorders`, `/acceptance-rules`.
- **Emits:** `ingest.detected`, `ingest.accepted`, `ingest.rejected`, `recording.segment.completed`.
  **Consumes:** `acceptance-rules.updated`.

## 6. Dependencies & integration points

- **Requires first:** [HSM](hsm-plan.md), [MTS](mts-plan.md), [MAM](mam-plan.md), broker.
- **Consumed by:** the whole ingest flow starts here; MAM creates assets from `ingest.accepted`.

## 7. Testing focus

- Resumable upload correctness (pause/resume, partial-write dedupe).
- Watcher debounce (don't ingest a file mid-copy).
- Acceptance rules matrix (accept/reject/quarantine per rule) + reason recording.
- Idempotent handoff (same file detected twice → one asset).
- Recording segmentation boundaries + gapless capture (v2).

## 8. Scaling & deployment

- **Watchers are singletons per source** (leader-elected); **recorders scale per capture channel**;
  **upload endpoints scale statelessly**. Config: watcher sources, acceptance rules, recorder channels,
  quarantine retention.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Ingesting partial/in-flight files | Debounce + size/stability checks + checksum on place. |
| Duplicate ingest from re-detection | Idempotency keyed on source+checksum. |
| Recording drift/gaps (v2) | FFmpeg capture with segmenting; monitor segment continuity. |
| Watcher single point per source | Leader election + fast failover; queue survives restart. |
