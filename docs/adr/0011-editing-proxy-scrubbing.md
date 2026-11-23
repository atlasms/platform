# ADR-0011 — The editing proxy is short-GOP H.264, scrubbed with `requestVideoFrameCallback`

- **Status:** Accepted (2026-11-16) — the approach was chosen on the design's case 2026-10-12
  ([media-editor §7](../architecture/services/media-editor.md#7-dependencies)); this spike (EP-26.1)
  **validated** it and **set the GOP length**. Measured below: the size-at-constant-quality cost, and
  **Chrome + Firefox** accuracy/latency. Short-GOP H.264 scrubbed through `requestVideoFrameCallback`
  is **frame-exact in both browsers** with the `floor(mediaTime·fps)` mapping (confirmed after the
  `round()` version exposed a Firefox one-frame offset), and interactive up to GOP 30. **GOP 12** is
  chosen. WebCodecs stays the fallback if a future browser breaks this, as its own ADR.
- **Date:** 2026-11-15 (Proposed); 2026-11-16 (Accepted, after the `floor` confirmation run)
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

### 2. Frame accuracy and seek latency — **both browsers measured; a mapping fix to confirm**

The instrument is [`spikes/editor-scrubbing`](../../spikes/editor-scrubbing/). It builds six proxy
candidates (GOP 1, 5, 12, 30, 60, 250) with the frame number **burned into every frame**
(`drawtext=%{n}`), serves them with HTTP Range support (required for `<video>` seeking), and for each
proxy seeks to a frame and — on the rVFC that follows — maps `mediaTime` to a frame index and compares
it to the frame requested. It reports, per GOP, over 148 measured seeks (two warm-up seeks dropped) of
each of two gestures: **sequential** stepping (drag — the decoded GOP is already in hand) and **random**
jumps (click around — the worst case, a cold decode from the nearest keyframe).

Ground truth is checkable by eye: seeking to 10.000 s must show frame **250** at 25 fps.

The two runs below used the first frame mapping, `round(mediaTime·fps)`; they are what **exposed** a
cross-browser offset in it (diagnosed and fixed under the Firefox table). Raw blobs:
[`results/`](../../spikes/editor-scrubbing/results/).

**Chrome 150 (2026-11-15), 20 s / 1280×720 / 25 fps proxies, 148 seeks per gesture** ([`results/chrome-150.json`](../../spikes/editor-scrubbing/results/chrome-150.json)). Latency ms;
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

Reading the Chrome run:

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

**Firefox 156 (2026-11-15), same proxies and seek counts** ([`results/firefox-156.json`](../../spikes/editor-scrubbing/results/firefox-156.json)):

| GOP | seq off | seq median | seq p95 | rnd off | rnd median | rnd p95 | rnd max | t/o (seq+rnd) |
|---|---|---|---|---|---|---|---|---|
| 1 (all-intra) | 1 | 17 | 18 | 1 | 17 | 18 | 144 | 0 |
| 5 | 1 | 17 | 18 | 1 | 17 | 18 | 26 | 0 |
| 12 | 1 | 17 | 27 | 1 | 17 | 24 | 36 | 0 |
| 30 | 1 | 22 | 46 | 1 | 27 | 46 | 184 | 0 |
| 60 | 1 | 32 | 91 | 1 | 39 | 94 | 120 | 0 |
| 250 | 1 | 206 | 361 | 1 | 188 | 431 | 686 | 0 |

- **Latency has the same shape as Chrome** — flat and interactive up to GOP 30, heavy by GOP 60,
  bad at GOP 250 (188–206 ms median). This **reinforces GOP ≤ 30** across both browsers. And Firefox
  had **zero rVFC misses** at every GOP — the occasional callback miss was a Chrome-only quirk.
- **But accuracy is off by exactly one frame, everywhere** — `maxAbsDelta` is 1 at every GOP, only
  ~5–10% of seeks exact, 0 timeouts. Not scatter and not a decode problem: a **dead-constant +1**.
  The cause is in the harness, not the browser. The harness seeks mid-frame to `(n+0.5)/fps` and read
  the shown frame as `round(mediaTime·fps)`. Chrome reports `mediaTime` near the **frame start** so
  `round` lands on `n`; Firefox reports it **higher inside the frame** (near the seeked point ≈
  `n+0.5`), so `round(n+0.5)` lands on `n+1`. `round` was the wrong mapping — it baked in Chrome's
  reporting convention.

**The fix.** The on-screen frame is the one whose interval `[n/fps, (n+1)/fps)` contains `mediaTime` —
i.e. **`floor(mediaTime·fps)`**, which is `n` under *either* browser's reporting point. `measure.js`
now uses `floor(mediaTime·fps + ε)` and also reports a signed `deltaCounts` / `modalDelta`, so a
residual offset would be unmistakable rather than hidden inside an unsigned `maxAbsDelta`.

**Confirmed (2026-11-16): `floor` makes both browsers frame-exact.** Re-running the full sweep under
the fixed harness ([`results/chrome-157-floor.json`](../../spikes/editor-scrubbing/results/chrome-157-floor.json),
[`results/firefox-157-floor.json`](../../spikes/editor-scrubbing/results/firefox-157-floor.json)):

| Browser | accuracy, every GOP | latency ≤ GOP 30 (median) | GOP 250 (median) | rVFC misses |
|---|---|---|---|---|
| Chrome 157 | **0 off, `modalDelta` 0** (`deltaCounts {"0": …}`) | ~17 ms | 75–105 ms | 2 across the sweep (GOP 12, 30) |
| Firefox 157 | **0 off, `modalDelta` 0** (`allAccurate: true`) | ~17 ms | 81–103 ms | 0 |

Every delta fell in the `0` bucket in both browsers — the Firefox one-frame offset is gone and Chrome
is unchanged. The only non-exact rows are Chrome's two random-seek **timeouts** (callback never fired
within 3 s), the same non-monotonic rVFC-miss seen before and already handled by the player
requirement (point 4). The approach is sound in both browsers; WebCodecs was not needed.

## Decision

1. **The editing proxy is H.264/MP4, closed short GOP**, played in a plain `<video>`; the displayed
   frame is identified from **`requestVideoFrameCallback`'s `mediaTime`**. No WebCodecs in v1. Confirmed
   frame-exact in both Chrome and Firefox with the mapping in point 2 (Evidence §2); rVFC fires
   reliably in both (Firefox had zero misses).
2. **The frame mapping is `floor(mediaTime · fps)`, not `round`.** `round` encodes Chrome's
   reporting point and lands a frame late in Firefox (Evidence §2). `floor` gives the frame whose
   interval contains `mediaTime` under either browser's convention; EP-26's player must use it, with a
   small epsilon for float jitter at the frame boundary. This is correctness-shaped — a one-frame-late
   in/out point is a wrong edit — so it is a decision, not an implementation detail.
3. **GOP 12 (~0.5 s at 25 fps) is the recommended length.** Accuracy is independent of GOP in both
   browsers, so the choice is the latency/size trade. Latency is flat and interactive up to GOP 30 in
   **both** Chrome and Firefox (~17–27 ms median seek) and degrades sharply by GOP 250 (~7× worse);
   size falls off past ~30. GOP 12 sits safely inside the flat region at a ~9% size premium, with a
   short decode walk that holds up on the slower of the two browsers. **GOP 30 is a defensible
   cheaper alternative** (~4% size, latency within noise of GOP 12 in both). **GOP 1 (all-intra)** is
   the perfect-scrub option at ~2× size — not needed on this evidence.
4. **The player must bound the seek wait.** rVFC occasionally fires no callback for a seek (Evidence
   §2: 1–2 of 148 random seeks, Chrome). The editor times out a pending seek and retries or falls back
   to the `seeked` event; it never blocks on rVFC indefinitely.
5. **The proxy is a derived rendition, keyed by frame.** Every edit (in/out, transition boundary) is
   a frame number against the proxy; the proxy's fps and frame count are recorded with it so the
   server render maps frames to mezzanine timecodes exactly. The proxy fps **is** the edit grid.
6. **Fallback is WebCodecs**, taken only if `floor` fails to make Firefox frame-exact — its own ADR,
   not a silent pivot.

## Consequences

- MTS gains an **editing-proxy rendition** profile (short-GOP H.264, `+faststart` so the browser can
  seek before the whole file loads), produced alongside the existing playback proxy. **Built in
  EP-26.3:** the `edit-proxy` preset, `proxy`/`variant: edit`, closed GOP 12, in every video's first
  renditions ([mts.md §13](../architecture/services/mts.md#ep-263--the-editing-proxy)). Its GOP and fps
  are fixed by this ADR and carried in the rendition's metadata.
- The proxy is **~9% larger** than a playback proxy at the same quality (at GOP 12) — storage and the
  sizing profile account for one extra rendition at roughly playback-proxy size.
- The editor serves proxies over **HTTP Range** (206); whatever fronts them (gateway/CDN) must pass
  range requests through, or seeking silently degrades to full-file loads.
- The frame-accuracy contract is **browser behaviour plus our mapping**, so it is browser-specific:
  the `floor` mapping and the one-frame cross-browser gap it fixes are pinned by the committed harness,
  re-runnable when a browser version moves, and belong in the editor's manual-QA checklist until a
  browser-automation path exists in CI.

## Revisit when

- A target browser drops or breaks `requestVideoFrameCallback`, or reports `mediaTime` such that
  `floor(mediaTime·fps)` is no longer the on-screen frame — re-run the harness; that is the trigger
  for the WebCodecs fallback ADR.
- Real-footage size numbers replace the `testsrc2` ratios and shift the knee of the curve enough to
  reopen GOP 12 vs 30.
- A low-end target device decodes a cold GOP-12 random seek too slowly to feel interactive (the spike
  ran on dev hardware) — shorten the GOP toward all-intra, which the harness already brackets.
