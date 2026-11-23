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
| `renderJobId?`, `outputAssetId?` | `outputAssetId` minted when a render is requested; `renderJobId` once MTS answers (§5.1) |
| `targetAssetId?` | the asset the render becomes the next version of, when one was asked for (§5.1) |
| `failure?`, `versionRefused?` | why the last render failed; why its version link could not be made (§5.1) |

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

### 5.1 The render, as decided in building it (EP-26.6 / EP-26.7)

The sketch above left five things open. Decided here, built in MTS ([mts.md §13](mts.md#ep-266--rendering-an-edit-decision-list))
and MAM ([mam.md §13ab](mam.md#13ab-as-built--ep-266--267-a-render-becomes-an-asset-of-its-own)):

- **The render is new media, so it is an asset of its own.** This is the version chain's model
  ([mam.md §13t](mam.md#13t-as-built--ep-276-the-version-chain)): new media is a new asset id. MAM
  **mints that id when the render is requested** (`outputAssetId`, on the project and in the command),
  because MAM owns asset ids, and because Studio can then follow the render's progress
  (`transcode.progress.assetId`) the moment it asks. A render after a failure mints a fresh one. The
  rendered file is that asset's **`original`**, placed in HSM under its id like an upload's. In the
  same transaction that completes the render, MTS queues the new asset's first renditions from that
  original (`FIRST_RENDITIONS`, as for an ingest), so the asset gets a proxy and a thumbnail like any other.
- **A clip names a file of the source asset by kind:** `renditionRef` is `original`, `broadcast` or
  `proxy`, optionally `kind/variant`. Studio scrubs the editing proxy and writes `original`: the
  render is cut from the master (§7). **In v1 every clip draws from the same file.** A concat of
  files with different picture sizes is not a cut, it is an FFmpeg error. The source must have that
  file (422 at render otherwise).
- **The output profile** is any MTS preset or profile (Tier-1) that is not a still, whose `requires`
  matches the media kind: `broadcast` or `proxy` for video, `audio-proxy` for audio. **A photo is
  not rendered in v1** (422), and neither is a clip with a transition or filter **until EP-26.5**
  brings the allowlist (422): until then MAM would store a name MTS cannot render.
- **The FFmpeg shape:** one input per clip, input-seeked (`-ss in -t (out−in)`). Accurate on a
  re-encode, it decodes nothing before the in-point, unlike a `trim` filter. The clips are joined
  by the `concat` filter, and the profile's own `-vf` is applied after the join. Audio is carried
  only when the source has an audio stream; a silent source renders a silent video, never an error.
- **The result, in ONE MAM transaction:** `transcode.completed` carries `editProjectId`, and MAM
  then creates the asset (state `created`, its file row, `asset.created`) and moves the project to
  `rendered` with `renderJobId`/`outputAssetId`, with both audit deltas and the seen-mark.
  - **With `targetAssetId`** (Studio passes the source), the new asset is made that asset's next
    version: the version chain's copy and link (`replacesId`/`replacedById`, `asset.replaced`),
    committed together.
  - **Without it**, the asset stands alone. It takes the source's metadata, title suffixed
    `(edit)`, so it inherits the source's category scope (§10) rather than landing unscoped.
  - **A link that became impossible** while the render ran (someone versioned the target first) is
    no reason to lose the render: the asset is created unlinked, and the project says why
    (`versionRefused`).
- **Failure** (26.8's backend): `transcode.failed` with `editProjectId` covers a refused command,
  a refused input and exhausted retries alike. It moves the project to `failed` with the reason
  (`failure: { code, message }`). The timeline is kept, a save returns the project to `draft`, and
  Notifications already tells `requestedBy` (EP-25.5).
- **Authorization is taken when the render is requested.** That needs `asset:write` on `core` of
  the source and, with a `targetAssetId`, of the target too. The target is also checked there: it
  must be the newest in its chain and of the same media type. A doomed link is a 409/422 at the
  request, not a failed render minutes later. The completion is the platform's own write.

### 5.2 The editor in Studio, as built (EP-26.3 / EP-26.8)

The asset editor's **Edits** section lists the asset's projects (`GET /assets/{id}/edit-projects`,
newest first: a timeline is reopened rather than started again) and opens each in an
**edit-project tab** ([studio-frontend.md](../studio-frontend.md)). There the timeline is a table of
clips: the file each cuts from, in/out as timecodes (to the millisecond, kept in seconds), reordered
by ↑/↓, saved compare-and-set. Render flattens the SAVED timeline, so it is offered only with
nothing unsaved. The editor defaults to the source's next version, and follows the render live:
`transcode.progress` under `outputAssetId` plus a poll for the outcome (26.8's editor half).

**The media path ([ADR-0012](../../adr/0012-signed-media-urls.md), EP-26.4's first half).** Studio
had no way to give a browser media: HSM's content reads are internal signed calls, and a
`<video src>` cannot carry the bearer token. Decided 2026-11-21 and built: **signed short-lived
URLs**. MAM's `GET /assets/{id}/files/{kind}/url` authorizes `asset:read` on `files` and returns
`{ url, expiresAt }`; HSM serves that URL with HTTP Range, verifying an HMAC from `media-url-keys`;
the gateway's `/media/` route is public and streamed, because the signature is the credential.
**Still to come in 26.4:** the player in the timeline. A `<video>` on the editing proxy (every
video gets one at ingest, mts.md §13), frames identified by `requestVideoFrameCallback` with
`floor(mediaTime·fps)`, a bounded seek wait (ADR-0011), a fresh URL when the old one expires, and
scrubbing on the VTT filmstrip.

## 6. Key flows

Covered by §5. The essential property: **render reuses the transcode pipeline**, so progress,
retry/DLQ, checksums, tiering and audit come for free and behave identically to an ingest transcode.

## 7. Dependencies

MAM (EditProject persistence, version attach), MTS (render), HSM (place output), WebSocket
(scrub-time preview + progress). Studio needs **proxy** renditions to scrub against — the editor
works off proxies and renders against the **source/broadcast** rendition.

**Playback (decided 2026-10-12, confirmed by the EP-26.1 spike — [ADR-0011](../../adr/0011-editing-proxy-scrubbing.md)).**
The editor plays an **editing proxy**: H.264 in MP4 with a **GOP of 12 (~0.5 s at 25 fps)**, written
by MTS as its own preset beside the browse proxy. Studio plays it in a plain `<video>` and identifies
the frame on screen with `requestVideoFrameCallback`; WebCodecs is not used in v1. The spike measured
scrubbing in Chrome and Firefox: frame-exact in both, and interactive (~17 ms median seek) up to
GOP 30, degrading by GOP 250 — GOP 12 for decode headroom (GOP 30 a cheaper alternative). **Two
implementation requirements the spike surfaced:** the frame index is `floor(mediaTime·fps)`, not
`round` (which is browser-dependent and lands a frame late in Firefox — a one-frame-late in/out point
is a wrong edit); and the player must **bound the wait on a seek** and retry / fall back to the
`seeked` event, because `requestVideoFrameCallback` occasionally fires no callback for a seek.

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
