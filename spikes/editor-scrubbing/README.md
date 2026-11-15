# EP-26.1 — editing-proxy scrubbing spike

**Question.** The Media Editor (EP-26) plays an **editing proxy** and must scrub frame-accurately
in the browser. The approach was decided 2026-10-12
([media-editor §7](../../docs/architecture/services/media-editor.md#7-dependencies)): H.264/MP4 with
a **short GOP**, played in a plain `<video>`, the on-screen frame identified with
`requestVideoFrameCallback` (no WebCodecs in v1). This spike **confirms** that works in Chromium and
Firefox and **sets the GOP length**. If it cannot, WebCodecs decoding is the fallback and a new
decision.

**Artifact:** [ADR-0011](../../docs/adr/0011-editing-proxy-scrubbing.md).

## What it measures

For a proxy at a given GOP, the harness seeks to a frame and, on the `requestVideoFrameCallback`
that follows, reads `mediaTime` — the presentation time of the frame actually on screen — and
compares it to the frame requested. It records:

- **Accuracy** — does seeking to frame _N_ show frame _N_? (`exact` %, `max off-by` frames.)
- **Latency** — wall-clock from setting `currentTime` to the frame appearing. This is what degrades
  as the GOP grows (the decoder must walk from the previous keyframe), and it is the number that
  sets the GOP.

Two gestures: **sequential** stepping (dragging the playhead — the browser already holds the
decoded GOP) and **random** jumps (clicking around the timeline — worst case, a fresh decode from
the nearest keyframe).

Ground truth is visible too: each proxy has its frame number burned in (ffmpeg `drawtext=%{n}`), so
a human can confirm by eye that seeking to 10.000 s shows frame 250 at 25 fps.

## Running it

```sh
# 1. build the proxy candidates (needs ffmpeg on PATH). Git-ignored, land in ./out.
npm run proxies -w @atlas/editor-scrubbing-spike        # GOPS=1,5,12,30,60,250 FPS=25 DURATION=20

# 2. serve them (the server honours HTTP Range — required for <video> seeking)
npm run serve -w @atlas/editor-scrubbing-spike          # → http://localhost:8126

# 3. in EACH browser (Chrome and Firefox), open:
#      http://localhost:8126/run-all.html
#    let it finish (~1–2 min), then copy the JSON it prints.
#    One GOP at a time instead: http://localhost:8126/harness.html?gop=12
```

`run-all.html` sweeps every GOP and prints a combined table plus a copy-paste JSON blob
(`window.__spikeAll`). `harness.html?gop=N` runs a single proxy (`window.__spikeResults`).

## Why these ffmpeg settings

- `-g N -keyint_min N -x264-params scenecut=0:open_gop=0` — a **fixed closed** GOP of exactly _N_,
  so the file's keyframe spacing is the variable under test and nothing else.
- `-b:v 4M` constant across GOPs — holds bitrate fixed so latency differences are the GOP's doing,
  not file-size differences. The size-at-constant-quality cost of a short GOP is reported separately
  in the ADR (a short GOP spends more bits on keyframes).
- `-movflags +faststart` — moov atom up front, so the browser can seek before the whole file loads.
- `testsrc2` — content changes every frame, so a seek that lands on the wrong frame is visible.

## Files

| File               | Role                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `make-proxies.mjs` | ffmpeg → `out/proxy-g<gop>.mp4` at each GOP, frame number burned in |
| `serve.mjs`        | static server with HTTP Range (206) support                         |
| `measure.js`       | browser module: the accuracy + latency sweep                        |
| `harness.html`     | one GOP                                                             |
| `run-all.html`     | every GOP, combined table + copy-paste JSON                         |
