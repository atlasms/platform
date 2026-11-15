# ADR-0011 — The editing proxy is short-GOP H.264, scrubbed with `requestVideoFrameCallback`

- **Status:** Proposed — the approach was chosen on the design's case 2026-10-12
  ([media-editor §7](../architecture/services/media-editor.md#7-dependencies)); this spike (EP-26.1)
  **validates** it and **sets the GOP length**. The size-at-constant-quality cost is measured below.
  The frame-accuracy and seek-latency run across Chromium and Firefox is the one open item: the
  harness is committed ([`spikes/editor-scrubbing`](../../spikes/editor-scrubbing/)) and runnable, but
  it needs a real browser — CI has none and the spike environment had none, so a human runs it and the
  numbers land here before this ADR is Accepted.
- **Date:** 2026-11-15
- **Stories:** EP-26.1 (this ADR); built by EP-26.2 – EP-26.8
  ([#26](https://github.com/atlasms/platform/issues/26))
- **Design:** [Media Editor](../architecture/services/media-editor.md) (§7 dependencies, §11 the
  transition/filter set)

## Context

The Media Editor (EP-26) is a browser trimmer: a person scrubs a clip on a timeline, sets in/out
points and simple transitions, and the server renders the cut from the **mezzanine** with FFmpeg.
The browser never touches the high-res master — it plays an **editing proxy**, a small derived file,
and every edit is expressed as frame numbers against that proxy.

Two things must be true of the proxy, and this spike is about the second:

1. The frame a person sees when they drop the playhead on frame _N_ **is** frame _N_ — otherwise the
   in/out points they set do not match the render. (Accuracy.)
2. Dropping the playhead feels immediate — a scrub that takes half a second per frame is unusable.
   (Latency.)

The approach was decided 2026-10-12 (media-editor §7): **H.264/MP4 with a short GOP**, played in a
plain `<video>`, the on-screen frame identified with
[`requestVideoFrameCallback`](https://wicg.github.io/video-rvfc/) (rVFC) — whose `mediaTime` is the
presentation time of the frame actually displayed. **No WebCodecs in v1**: it would give
frame-perfect control but is a second decode path to build, test and keep working across browsers,
and the proxy approach is the industry-standard one for web trimmers. This spike confirms the simple
path works and, if it does, fixes the one free variable — **how long the GOP should be** — against
evidence, because that number trades scrub latency against proxy size and neither is free.

## Options (the GOP length)

The mechanism is settled; the GOP length is the decision. A GOP is the span from one keyframe
(I-frame) to the next. A seek to any frame decodes forward from the preceding keyframe, so a shorter
GOP means a shorter decode on a random jump — but more keyframes, and keyframes are large, so a
shorter GOP means a bigger file at the same visual quality.

| GOP (at 25 fps) | What it is | Expected trade |
|---|---|---|
| **1** (all-intra) | Every frame a keyframe | Perfect, instant scrub; ~2× the file (measured below) |
| **5** (~0.2 s) | | Near-instant scrub; ~20% larger |
| **12** (~0.5 s) | | Short decode walk; ~9% larger |
| **30** (~1.2 s) | | Longer decode on a cold jump; ~4% larger |
| **60 / 250** | Broadcast-typical | Smallest file; worst cold-jump latency |

## Evidence

### 1. Size at constant quality — **measured**

Encoded the same 20 s / 1280×720 / 25 fps source (`testsrc2`) at a **fixed CRF 23** (constant
quality) across GOP lengths, holding everything else equal
(`-profile:v high -preset medium -g N -keyint_min N -x264-params scenecut=0:open_gop=0`). The GOP is
the only variable, so the size delta is the keyframe cost of that GOP and nothing else:

| GOP | File size | vs long GOP (250) |
|---|---|---|
| 1 (all-intra) | 13.29 MB | **+96.9%** |
| 5 | 8.10 MB | +20.0% |
| 12 | 7.35 MB | +8.9% |
| 30 | 7.01 MB | +3.8% |
| 60 | 6.88 MB | +1.9% |
| 250 | 6.75 MB | baseline |

The shape is the point: a short GOP costs real bits, but the cost **falls off sharply past ~30** and
is modest at 12 (~9%), while all-intra roughly **doubles** the file. `testsrc2` is synthetic and
compresses unlike real footage, so treat these as the *ratio curve*, not absolute sizes — the next
revision of this ADR should repeat the row for a real clip. Reproduce:
`spikes/editor-scrubbing/out`, `ffmpeg … -crf 23 -g N -keyint_min N …`.

### 2. Frame accuracy and seek latency — **harness committed, browser run pending**

The instrument is [`spikes/editor-scrubbing`](../../spikes/editor-scrubbing/). It builds six proxy
candidates (GOP 1, 5, 12, 30, 60, 250) with the frame number **burned into every frame**
(`drawtext=%{n}`), serves them with HTTP Range support (required for `<video>` seeking), and for each
proxy seeks to a frame and — on the rVFC that follows — compares `round(mediaTime × fps)` to the
frame requested. It reports, per GOP:

- **Accuracy** — % of seeks that showed the exact frame, and the max frames off.
- **Latency** — wall-clock from setting `currentTime` to the frame appearing (median / p95 / max),
  for two gestures: **sequential** stepping (drag — the decoded GOP is already in hand) and **random**
  jumps (click around — the worst case, a cold decode from the nearest keyframe). Latency is what the
  GOP length actually sets.

Ground truth is checkable by eye: seeking to 10.000 s must show frame **250** at 25 fps.

**This run needs a real browser and has not been done yet.** To produce it:

```sh
npm run proxies -w @atlas/editor-scrubbing-spike   # needs ffmpeg; writes ./out (git-ignored)
npm run serve   -w @atlas/editor-scrubbing-spike   # → http://localhost:8126
# then, in EACH of Chrome and Firefox, open http://localhost:8126/run-all.html,
# let it finish (~1–2 min) and paste back the JSON it prints (window.__spikeAll).
```

The results table to fill — the spike **passes** only if accuracy is exact (0 frames off, no
timeouts) in **both** browsers at the chosen GOP, and random-jump p95 latency is comfortably
interactive:

| Browser | GOP | seq exact | seq p95 ms | rnd exact | rnd p95 ms | rnd max ms |
|---|---|---|---|---|---|---|
| Chromium | _tbd_ | | | | | |
| Firefox | _tbd_ | | | | | |

If rVFC turns out unsupported or accuracy is not exact in either browser, that is the finding that
sends v1 to the **WebCodecs fallback** — a new decision, recorded as its own ADR.

## Decision (provisional, pending Evidence §2)

1. **The editing proxy is H.264/MP4, closed short GOP**, played in a plain `<video>`; the displayed
   frame is read from **`requestVideoFrameCallback`'s `mediaTime`**. No WebCodecs in v1.
2. **GOP 12 (~0.5 s at 25 fps) is the recommended length**, pending the latency curve from Evidence
   §2: it is the knee of the size curve (~9% over a long GOP) and bounds a cold random-seek decode to
   ~half a second of frames. If §2 shows random-jump latency at 12 is not interactive, step down
   toward **GOP 5**; if exact scrub matters more than size for v1, **GOP 1 (all-intra)** is the
   perfect-scrub option at ~2× size. The harness measures all three, so the final pick is made on the
   numbers, not here.
3. **The proxy is a derived rendition, keyed by frame.** Every edit (in/out, transition boundary) is
   a frame number against the proxy; the proxy's fps and frame count are recorded with it so the
   server render maps frames to mezzanine timecodes exactly. The proxy fps **is** the edit grid.
4. **Fallback is WebCodecs**, taken only if Evidence §2 fails — its own ADR, not a silent pivot.

## Consequences

- MTS gains an **editing-proxy rendition** profile (short-GOP H.264, `+faststart` so the browser can
  seek before the whole file loads), produced alongside the existing playback proxy. Its GOP and fps
  are fixed by this ADR and carried in the rendition's metadata.
- The proxy is **~9% larger** than a playback proxy at the same quality (at GOP 12) — storage and the
  sizing profile account for one extra rendition at roughly playback-proxy size.
- The editor serves proxies over **HTTP Range** (206); whatever fronts them (gateway/CDN) must pass
  range requests through, or seeking silently degrades to full-file loads.
- The frame-accuracy contract is **browser behaviour**, not ours — it is pinned by the committed
  harness, re-runnable when a browser version moves, and belongs in the editor's manual-QA checklist
  until a browser-automation path exists in CI.

## Revisit when

- Evidence §2 comes back from a browser run — fill the table, pick the GOP, move this ADR to
  **Accepted** (or to the WebCodecs fallback ADR if it fails).
- A target browser drops or breaks `requestVideoFrameCallback`.
- Real-footage size numbers replace the `testsrc2` ratios and shift the knee of the curve.
