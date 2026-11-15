# Raw harness runs

One `window.__spikeAll` blob per browser, pasted verbatim. These are the numbers in
[ADR-0011 §2](../../../docs/adr/0011-editing-proxy-scrubbing.md).

| File               | Harness mapping        | Result                                                                                                               |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `chrome-150.json`  | `round(mediaTime·fps)` | Frame-exact at every GOP; 1–2/148 random seeks missed the rVFC callback (GOP 5, 60).                                 |
| `firefox-156.json` | `round(mediaTime·fps)` | Dead-constant **off-by-one** (maxAbsDelta 1, 0 timeouts) — Firefox reports `mediaTime` higher in the frame interval. |

Both baseline files were measured with the original `round()` frame mapping, which is what **exposed**
the cross-browser offset. `measure.js` now uses `floor(mediaTime·fps + ε)` — the portable mapping —
and reports a signed `deltaCounts` / `modalDelta` so a residual offset is unmistakable. A confirming
run of both browsers under the fixed harness is the remaining step (saved here as
`<browser>-floor.json` when done); the spike moves to Accepted only if both are then frame-exact.
