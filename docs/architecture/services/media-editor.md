# Media Editor — Capability Specification

> A **basic non-linear editor** for video, audio and image, embedded in Studio
> ([D3](../../01-technical-brief.md#9-resolved-decisions),
> [Brief §4.10](../../01-technical-brief.md#410-media-editor-scope)) — **not** a full NLE, and
> **not a standalone service**. It is a **Studio feature** whose timelines are persisted by
> [MAM](mam.md) and whose renders are executed by [MTS](mts.md). This document names the boundary,
> the data, and the render pipeline so the capability is estimable like a service.
>
> Requirements: [FR-EDT-1…5](../../requirements/05-functional-requirements.md#editor). Template:
> [services/README](README.md#spec-template) (adapted — sections that don't apply to a
> non-service say so).

## 0. Why a capability, not a service

The editor has **no long-running process of its own**. Everything it needs already exists:

- **Editing** is client work in Studio (scrub, trim, arrange, apply a transition/filter).
- **The timeline** is asset-adjacent metadata → **MAM** persists it as an `EditProject` document.
- **Rendering** (flatten the timeline to a file) is transcoding → **MTS** already owns FFmpeg,
  the job queue, progress, and checksum-on-output.
- **The result** is a new rendition/version → the normal `transcode.completed → MAM/HSM` path.

Adding a service would duplicate MTS's render queue and MAM's version store for no gain. So the
decision (recorded here, open to veto): **Studio + MAM (EditProject) + MTS (render), coordinated by
one command, `editor.render.requested`.**

> **This is the one design call from the gap audit.** If a future scope grows the editor into a
> collaborative, server-side timeline engine (multi-user, server-rendered previews), promote it to a
> service then — the contracts below (EditProject, `editor.render.requested`) stay the same.

> **That promotion is now scoped — for v2.0, not v1.0.** The
> [lifecycle expansion](../../strategy/19-production-lifecycle-scope.md#4-post-production) adds
> project persistence across sessions, frame-accurate timeline playback, versioning/locking, and
> **NLE interchange** (OTIO/AAF/FCPXML/EDL) — beyond what this capability should carry. It is
> specified as the [Editorial service](editorial.md), which **preserves the contracts below** and
> takes over ownership of `EditProject`. **Nothing in this document changes for v1.0**; keeping
> this scope fixed is what protects the v1.0 GA date.

## 1. Purpose & boundaries

**In scope:** trimming and arranging clips on a single-track-per-media timeline; simple
transitions (cut/dissolve) and filters (crop, gain, fade); assembling several source clips into one
output; producing a **new rendition or a new asset version** by rendering.

**Out of scope:** multi-user real-time co-editing; multi-layer compositing, CG/titling, colour
grading, keyframe animation (full-NLE territory —
[FR-SCH-7-style boundary](../../requirements/05-functional-requirements.md#editor)); frame-accurate
conform against camera-native formats. Live editing-while-ingest is an
[open question](#12-open-questions--future).

## 2. Requirements covered

- [FR-EDT-1…5](../../requirements/05-functional-requirements.md#editor) — basic NLE across
  video/audio/image; trim/arrange/transition; render to a new version; non-destructive (the source
  renditions are never modified — a render produces a **new** file).
- Uses [FR-MAM-6](../../requirements/05-functional-requirements.md#mam) version chain for the output
  and [FR-MTS](../../requirements/05-functional-requirements.md#transcode) for the render.

## 3. Domain model — `EditProject` (owned by MAM, document store)

| Field | Notes |
|-------|-------|
| `id` | ULID |
| `channelId`, `createdBy`, `createdAt`, `updatedAt` | standard |
| `sourceAssetId` | the asset whose renditions the timeline references |
| `mediaKind` | `video` / `audio` / `photo` |
| `state` | `draft` → `rendering` → `rendered` / `failed` |
| `timeline.clips[]` | ordered: `{ renditionRef, inSec, outSec, transitionIn?, filters[] }` — the **edit decision list** |
| `outputProfile?` | MTS profile ([Tier-1 registry](../configuration-and-reference-data.md#22-tier-1--registries-the-important-middle)) for the render |
| `renderJobId?`, `outputAssetId?` | set once a render is issued/completes |

**Non-destructive (normative).** A clip references a source **rendition by id with in/out points**;
the editor never rewrites source bytes. Rendering always **creates** a file (a new version of
`sourceAssetId`, or a new asset when `targetAssetId` is absent). The `timeline` is the durable,
re-openable artifact; the rendered file is derived from it.

Persisted in MAM's document store beside `AssetExtended`
([Data Model §1.10](../data-model.md#110-edit-projects--editproject-owned-by-mam)); it participates
in the normal audit/diff history like any asset edit.

## 4. Public API

Editor endpoints live on **MAM** ([mam.yaml](../openapi/mam.yaml), tag `editor`) — there is no
separate host.

| Method | Path | Purpose | Authz |
|--------|------|---------|-------|
| `POST` | `/assets/{id}/edit-projects` | Start a project over an asset. | `asset:write` |
| `GET` | `/edit-projects/{id}` | Load the timeline. | `asset:read` |
| `PATCH` | `/edit-projects/{id}` | Save the timeline. | `asset:write` |
| `POST` | `/edit-projects/{id}/render` | Flatten → issues `editor.render.requested`. | `asset:write` |

## 5. Messaging

- **Emits (command):** `editor.render.requested`
  ([payload](../schemas/events/editor.render.requested.payload.schema.json)) — carries the timeline,
  `sourceAssetId`, optional `targetAssetId`, and `outputProfile`. Produced by MAM/BFF when the user
  hits **Render**.
- **Consumed by:** [MTS](mts.md), which renders the timeline (an FFmpeg filter-graph/concat job)
  and emits `transcode.progress` then `transcode.completed` exactly as for any transcode; MAM
  attaches the output as a new version and HSM places the bytes. `transcode.failed` sets the project
  `state = failed` and raises a notification.

```mermaid
sequenceDiagram
    participant U as Studio (editor)
    participant MAM
    participant MTS
    participant HSM
    U->>MAM: PATCH /edit-projects/{id} (timeline)
    U->>MAM: POST /edit-projects/{id}/render
    MAM->>MTS: editor.render.requested (timeline, outputProfile)
    MTS-->>U: transcode.progress (jobId, pct)  %% via WebSocket
    MTS->>HSM: place rendered output
    MTS->>MAM: transcode.completed (new rendition + checksum)
    MAM->>MAM: attach as new version; EditProject.state = rendered
```

## 6. Key flows

Covered by §5. The essential property: **render reuses the transcode pipeline**, so progress,
retry/DLQ, checksums, tiering and audit come for free and behave identically to an ingest transcode.

## 7. Dependencies

MAM (EditProject persistence, version attach), MTS (render), HSM (place output), WebSocket
(scrub-time preview + progress). Studio needs **proxy** renditions to scrub against — the editor
works off proxies and renders against the **source/broadcast** rendition.

## 8. Scaling & performance

No new scaling surface — renders are MTS jobs and scale with the MTS worker pool. Client-side
editing scales with the browser. Preview scrubbing uses existing proxies; no server render for
preview in v1.

## 9. Failure modes & degradation

| Failure | Effect | Mitigation |
|---------|--------|-----------|
| MTS busy/down | Render queued/delayed | Same queue semantics as any transcode; project stays `draft`/`rendering`. |
| Render fails (bad filter graph) | `state = failed` | `transcode.failed` → notify; timeline preserved for re-edit. |
| Source rendition offline (near-line/offline) | Render can't start | HSM restore first (ETA surfaced), as for send-to-air. |

## 10. Security & data sensitivity

Reuses asset authorization: editing needs `asset:write` on the source; the rendered output inherits
the source's channel/category scope. No new secrets. Renders are audited as asset versions.

## 11. Configuration

Editor render profiles are MTS profiles (Tier-1). Available transitions/filters are a small
**code-known** set (Tier 0 — each maps to an FFmpeg filter the render worker implements); which are
exposed can be a Tier-3 setting per channel.

## 12. Open questions / future

- **Edit-while-ingest** (growing-file editing) — tied to HSM's
  [partial-file open question](hsm.md#14-open-questions--future).
- **Server-side preview render** for effects the browser can't show — only if basic filters prove
  insufficient.
- **Promote to a service** if collaborative/server-side timelines are ever required (§0).

---
_Related: [MAM](mam.md) · [MTS](mts.md) · [Studio Front-End](../studio-frontend.md) ·
[Data Model §1.10](../data-model.md#110-edit-projects--editproject-owned-by-mam) ·
[FR-EDT](../../requirements/05-functional-requirements.md#editor)._
