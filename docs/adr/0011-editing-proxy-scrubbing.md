# ADR-0011 — The editing proxy is short-GOP H.264, scrubbed with `requestVideoFrameCallback`

- **Status:** Proposed — the approach was chosen on the design's case 2026-10-12
  ([media-editor §7](../architecture/services/media-editor.md#7-dependencies)); this spike (EP-26.1)
  **validates** it and **sets the GOP length**. The size-at-constant-quality cost and the **Chrome**
  accuracy/latency run are measured below — the approach works and scrubs frame-accurately in Chrome.
  The one open item before Accepted is the same run in **Firefox** (its `requestVideoFrameCallback` is
  the newer, less-proven implementation): the harness is committed
  ([`spikes/editor-scrubbing`](../../spikes/editor-scrubbing/)) and runnable, but it needs a real
  browser — CI has none and the spike environment had none, so a human runs it and the numbers land
  here.
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

### 2. Frame accuracy and seek latency — **Chrome measured; Firefox pending**

The instrument is [`spikes/editor-scrubbing`](../../spikes/editor-scrubbing/). It builds six proxy
candidates (GOP 1, 5, 12, 30, 60, 250) with the frame number **burned into every frame**
(`drawtext=%{n}`), serves them with HTTP Range support (required for `<video>` seeking), and for each
proxy seeks to a frame and — on the rVFC that follows — compares `round(mediaTime × fps)` to the
frame requested. It reports, per GOP, over 148 measured seeks (two warm-up seeks dropped) of each of
two gestures: **sequential** stepping (drag — the decoded GOP is already in hand) and **random** jumps
(click around — the worst case, a cold decode from the nearest keyframe).

Ground truth is checkable by eye: seeking to 10.000 s must show frame **250** at 25 fps.

**Chrome 150 (2026-11-15), 20 s / 1280×720 / 25 fps proxies, 148 seeks per gesture.** Latency ms;
"off" = max frames the displayed frame differed from the one requested; "t/o" = seeks with no rVFC
callback within 3 s:

| GOP | seq off | seq median | seq p95 | rnd off | rnd median | rnd p95 | rnd max | t/o (seq+rnd) |
|---|---|---|---|---|---|---|---|---|
| 1 (all-intra) | 0 | 18 | 49 | 0 | 17 | 20 | 49 | 0 |
| 5 | 0 | 17 | 47 | 0 | 18 | 49 | 3013 | 1 |
| 12 | 0 | 17 | 22 | 0 | 17 | 41 | 47 | 0 |
| 30 | 0 | 19 | 50 | 0 | 17 | 40 | 51 | 0 |
| 60 | 0 | 31 | 69 | 0 | 20 | 59 | 3013 | 2 |
| 250 | 0 | 129 | 161 | 0 | 111 | 208 | 266 | 0 |

Two readings:

- **Accuracy is exact at every GOP** — every frame Chrome displayed was the one asked for (0 off,
  including on the all-intra and the long-GOP proxies). The rVFC `mediaTime` approach is sound: a seek
  to frame _N_ shows frame _N_. **Frame accuracy does not depend on the GOP** — it is the *latency*
  the GOP sets, not the correctness.
- **Latency is flat up to GOP 30, then climbs steeply.** GOP ≤ 30 holds a ~17 ms median seek
  (imperceptible) and a sub-50 ms p95; GOP 60 starts to show (31 ms seq median); **GOP 250 is ~7×
  worse** (111–129 ms median, 161–208 ms p95) — a lag a person feels on every scrub. GOP 12 and GOP 30
  are within noise of each other on this run.
- **One robustness finding, not a GOP effect:** 1–2 of 148 random seeks (at GOP 5 and GOP 60) returned
  **no rVFC callback within 3 s** (`latMax` 3013 ms). It is non-monotonic — absent at GOP 12/30/250 —
  so it reads as an occasional rVFC miss (a seek that lands on the frame already shown fires no new
  frame callback), not slow decoding. **The editor must bound the wait on a seek and retry / fall back
  to `seeked`, never block on rVFC indefinitely.** This is a note for EP-26's player, carried here so
  it is not re-discovered.

**Remaining: the same run in Firefox.** Firefox shipped `requestVideoFrameCallback` only recently and
it is the less-proven implementation, so the spike is not complete until it is confirmed there. The
decision below holds the recommendation to a GOP that is exact and interactive in **both** browsers;
if Firefox is not frame-exact, that is the finding that sends v1 to the **WebCodecs fallback** — a new
decision, its own ADR. To produce the Firefox column:

```sh
npm run proxies -w @atlas/editor-scrubbing-spike   # needs ffmpeg; writes ./out (git-ignored)
npm run serve   -w @atlas/editor-scrubbing-spike   # → http://localhost:8126
# open http://localhost:8126/run-all.html in Firefox, let it finish (~1–2 min),
# paste back the JSON it prints (window.__spikeAll).
```

## Decision (provisional — holds once Firefox confirms Evidence §2)

1. **The editing proxy is H.264/MP4, closed short GOP**, played in a plain `<video>`; the displayed
   frame is read from **`requestVideoFrameCallback`'s `mediaTime`**. No WebCodecs in v1. Chrome
   confirms this is frame-exact at every GOP tested (Evidence §2); Firefox must confirm the same
   before the decision is Accepted.
2. **GOP 12 (~0.5 s at 25 fps) is the recommended length.** Evidence §2 (Chrome) shows accuracy is
   exact regardless of GOP, so the choice is purely the latency/size trade: latency is flat and
   interactive up to GOP 30 (~17 ms median seek) and degrades sharply by GOP 250 (~7× worse), while
   size falls off past ~30. GOP 12 sits safely inside the flat region (~17 ms median, 41 ms p95 random
   in Chrome, zero timeouts) at a ~9% size premium, and its shorter decode walk leaves **headroom for
   slower devices and for Firefox**, where the knee may sit earlier. **GOP 30 is a defensible
   alternative** — within noise of GOP 12 on Chrome latency at less than half the size cost (~4%); if
   Firefox holds up as well as Chrome and storage is the pressure, 30 is the cheaper pick. The two
   bracket the answer; Firefox decides between them. **GOP 1 (all-intra)** remains the perfect-scrub
   option (fastest seek, 0 timeouts) if latency ever matters more than its ~2× size — not needed on
   this evidence.
3. **The player must bound the seek wait.** rVFC occasionally fires no callback for a seek (Evidence
   §2: 1–2 in 148 random seeks). The editor times out a pending seek and retries or falls back to the
   `seeked` event; it never blocks on rVFC indefinitely.
4. **The proxy is a derived rendition, keyed by frame.** Every edit (in/out, transition boundary) is
   a frame number against the proxy; the proxy's fps and frame count are recorded with it so the
   server render maps frames to mezzanine timecodes exactly. The proxy fps **is** the edit grid.
5. **Fallback is WebCodecs**, taken only if Firefox fails Evidence §2 — its own ADR, not a silent
   pivot.

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

- The Firefox run completes Evidence §2 — add its column, settle GOP 12 vs 30, and move this ADR to
  **Accepted** (or to the WebCodecs fallback ADR if Firefox is not frame-exact).
- A target browser drops or breaks `requestVideoFrameCallback`.
- Real-footage size numbers replace the `testsrc2` ratios and shift the knee of the curve.
