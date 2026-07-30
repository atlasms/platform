# AI Enrichment — Implementation Plan

> Build plan for AI-derived metadata and **suggestions** — strictly **off the critical path** and
> **online-first**. Spec: [ai-enrichment](../../architecture/services/ai-enrichment.md) · Stack:
> **Node + NestJS orchestrator**; optional **Python/ONNX sidecar** for offline inference · Ships:
> **Phase 3 (v1 online)**. Non-critical — never blocks ingest/approval; may be disabled entirely.

## 1. Scope & versions

| Version | Phase | Delivers |
|---------|-------|----------|
| v1 (online) | 3 | Provider-abstracted **online tier** (cloud/vendor, full accuracy): face-matching against the **people register**, object/logo/shot/scene detection, **STT/subtitles**, language ID, keywords/summaries — all as **human-confirmed suggestions**. |
| v2 (offline) | Post | Optional **limited local tier** (small ONNX model) for suggestions/simple tasks in air-gapped sites. |

**Non-goals.** **Never** auto-writes mandatory on-air metadata or auto-creates people
([FR-AI-3](../../requirements/05-functional-requirements.md#ai),
[FR-PPL-5](../../requirements/05-functional-requirements.md#people)); never blocks the critical path
([FR-AI-4](../../requirements/05-functional-requirements.md#ai)); the platform runs fine with AI **off**.

## 2. Build sequence

1. **Job model + queue (v1)** — fully async, queue-driven enrichment jobs; consume `asset.created`,
   `transcode.completed`; persist job records.
2. **Provider abstraction** — a provider interface with pluggable **cloud/vendor** implementations
   (online tier, primary); config registry for provider selection/credentials
   ([D4](../../01-technical-brief.md#9-resolved-decisions)).
3. **Enrichment tasks (v1)** — face-match vs the **[people register](mam-plan.md)** (name/role/image
   only), object/logo/shot/scene detection, STT/subtitles, language ID, keywords/summaries.
4. **Suggestion emission** — results become **suggestions** surfaced for human confirmation: emit
   `ai.suggestion.raised` (people/tags) and `ai.enrichment.completed`; MAM stores them as
   *derived/suggested* (never auto-applied). `ai.enrichment.failed` on error — **never** blocks ingest.
5. **Degradation** — if providers are unreachable/disabled, jobs no-op gracefully; the media path is
   unaffected.
6. **Offline tier (v2)** — a **Python/ONNX Runtime sidecar** the Node orchestrator calls over local
   HTTP/gRPC; small model, suggestions/simple tasks only, modest hardware.

## 3. Components / modules

- `jobs` (queue + records), `providers` (abstraction + cloud impls + config registry), `tasks`
  (face/object/STT/…), `suggestions` (emit for confirmation), `offline-sidecar` (v2, Python/ONNX).

## 4. Data plane & migrations

- **Queue + job records**; provider/config registry; optional local model store (offline tier). Minimal
  relational footprint; results attach to assets via MAM. Additive migrations.

## 5. APIs & events

- REST (thin): [`ai-enrichment.yaml`](../../architecture/openapi/ai-enrichment.yaml) — `POST /enrich`
  (normally event-triggered), `GET /jobs/{id}`.
- **Emits:** [`ai.enrichment.completed`](../../architecture/schemas/events/ai.enrichment.completed.payload.schema.json),
  [`ai.suggestion.raised`](../../architecture/schemas/events/ai.suggestion.raised.payload.schema.json),
  `ai.enrichment.failed`. **Consumes:** `asset.created`, `transcode.completed`.

## 6. Dependencies & integration points

- **Requires first:** [MAM](mam-plan.md) (attach results/people; consume suggestions), broker; cloud AI
  provider (online) or local model (offline). **Consumed by:** [MAM](mam-plan.md) (records suggestions),
  Studio (confirm/reject suggestions).

## 7. Testing focus

- **Critical-path isolation** — provider failure/disable never blocks ingest/approval (the headline
  guarantee).
- Suggestions are **never** auto-applied to mandatory metadata; no auto-created people.
- Provider abstraction swap (cloud ↔ offline); graceful no-op when disabled.
- STT/subtitle quality gates; face-match confidence thresholds surfaced to reviewers.

## 8. Scaling & deployment

- **Online tier calls out to cloud** (no local GPU); optional offline tier runs small models on modest
  hardware; **fully async**, queue-driven, scale-to-many. Config: provider registry/credentials, task
  enable per type, confidence thresholds, online/offline tier selection, global on/off.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| AI failure blocks the media path | Fully async + off-critical-path by design; failures are non-fatal. |
| Auto-writing wrong on-air metadata | Suggestions only + human confirmation; provenance kept separate in MAM. |
| Air-gapped sites need AI | Optional offline tier (small local model), suggestions only; else disabled. |
| Cloud provider cost/latency | Provider abstraction + per-type enable + batching. |
