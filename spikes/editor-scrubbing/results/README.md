# Raw harness runs

One `window.__spikeAll` blob per browser, pasted verbatim. These are the numbers in
[ADR-0011 §2](../../../docs/adr/0011-editing-proxy-scrubbing.md).

| File                     | Harness mapping        | Result                                                                                                               |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `chrome-150.json`        | `round(mediaTime·fps)` | Frame-exact at every GOP; 1–2/148 random seeks missed the rVFC callback (GOP 5, 60).                                 |
| `firefox-156.json`       | `round(mediaTime·fps)` | Dead-constant **off-by-one** (maxAbsDelta 1, 0 timeouts) — Firefox reports `mediaTime` higher in the frame interval. |
| `chrome-157-floor.json`  | `floor(mediaTime·fps)` | **Frame-exact, every GOP** (`modalDelta` 0); 2 rVFC-miss timeouts across the sweep.                                  |
| `firefox-157-floor.json` | `floor(mediaTime·fps)` | **Frame-exact, every GOP** (`allAccurate: true`, 0 timeouts) — the off-by-one is gone.                               |

The two `round()` baseline files are what **exposed** the cross-browser offset. `measure.js` now uses
`floor(mediaTime·fps + ε)` — the portable mapping — and reports a signed `deltaCounts` / `modalDelta`
so a residual offset would be unmistakable. The two `*-floor.json` files are the confirming run:
**both browsers frame-exact**, so ADR-0011 is Accepted (GOP 12). The Chrome timeouts are the rVFC-miss
the player must bound (ADR-0011 Decision point 4), not an accuracy miss.
