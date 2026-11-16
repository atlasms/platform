// EP-26.1 spike — shared measurement, used by harness.html (one GOP) and run-all.html (every GOP).
//
// The question: on a short-GOP H.264 proxy, does seeking to frame N show frame N (accuracy), and
// how long does the seek take (latency — the number that actually sets the GOP)? Ground truth is
// the burned-in frame number; the measurement trusts requestVideoFrameCallback's mediaTime (the
// presentation time of the frame on screen) against the frame we asked for. Two gestures:
// SEQUENTIAL stepping (drag the playhead — the browser already holds the decoded GOP) and RANDOM
// jumps (click around the timeline — worst case, a fresh decode from the nearest keyframe).

export const hasRvfc = () => 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function seekOnce(video, fps, target) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ target, latency: performance.now() - t0, shown: null, timeout: true });
    }, 3000);
    video.requestVideoFrameCallback((_now, meta) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        target,
        latency: performance.now() - t0,
        // floor, NOT round. Browsers report mediaTime at different points INSIDE a frame's
        // interval: Chrome near the frame start, Firefox higher up (near the seeked point). So
        // round(mediaTime*fps) lands a frame LATE in Firefox — a dead-constant off-by-one (EP-26.1
        // measured +1 on ~90% of seeks, maxAbsDelta 1, 0 timeouts). The frame actually on screen is
        // the one whose interval [n/fps, (n+1)/fps) contains mediaTime, i.e. floor(mediaTime*fps);
        // the tiny epsilon absorbs float jitter at the lower boundary. This is the portable mapping.
        shown: Math.floor(meta.mediaTime * fps + 1e-6),
        timeout: false,
      });
    });
    // Mid-frame, so float jitter at a frame boundary cannot flip floor() onto the neighbour.
    video.currentTime = (target + 0.5) / fps;
  });
}

async function sweep(video, fps, targets) {
  const samples = [];
  for (const t of targets) samples.push(await seekOnce(video, fps, t));
  const warm = samples.slice(2); // drop first two as warm-up (first paint / first decode)
  const deltas = warm.filter((s) => !s.timeout).map((s) => s.shown - s.target);
  const lat = warm.map((s) => s.latency);
  const exact = deltas.filter((d) => d === 0).length;
  // SIGNED tally, keyed by delta. A dead-constant offset (one browser reporting the neighbour frame)
  // and scattered misses both read as maxAbsDelta 1 — only the sign separates them. modalDelta is the
  // offset to calibrate out if it is non-zero; deltaCounts shows whether it is truly constant.
  const deltaCounts = {};
  for (const d of deltas) deltaCounts[d] = (deltaCounts[d] ?? 0) + 1;
  const modalDelta = Number(Object.entries(deltaCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  return {
    n: warm.length,
    exactPct: Math.round((100 * exact) / warm.length),
    maxAbsDelta: deltas.reduce((m, d) => Math.max(m, Math.abs(d)), 0),
    modalDelta,
    deltaCounts,
    timeouts: warm.filter((s) => s.timeout).length,
    latMedian: Math.round(quantile(lat, 0.5)),
    latP95: Math.round(quantile(lat, 0.95)),
    latMax: Math.round(Math.max(...lat)),
  };
}

// Measure one proxy. `video` is an attached <video> whose src is already the proxy; resolves to a
// result object { gop, fps, totalFrames, sequential, random, accurate }.
export async function measureProxy(video, { gop, fps, steps }) {
  await new Promise((r) => {
    if (video.readyState >= 2) r();
    else video.addEventListener('loadeddata', r, { once: true });
  });
  const total = Math.floor(video.duration * fps);
  const seqStart = Math.floor(total / 4);
  const sequential = Array.from({ length: steps }, (_, i) => (seqStart + i) % total);
  const random = Array.from({ length: steps }, () => Math.floor(Math.random() * total));
  const seq = await sweep(video, fps, sequential);
  const rnd = await sweep(video, fps, random);
  const accurate = seq.maxAbsDelta === 0 && rnd.maxAbsDelta === 0 && !seq.timeouts && !rnd.timeouts;
  return { gop, fps, totalFrames: total, sequential: seq, random: rnd, accurate };
}

export function browserTag() {
  const ua = navigator.userAgent;
  const m =
    /(Firefox)\/(\d+)/.exec(ua) ||
    /(Edg)\/(\d+)/.exec(ua) ||
    /(Chrome)\/(\d+)/.exec(ua) ||
    /(Version)\/(\d+).*(Safari)/.exec(ua);
  return m ? `${m[1] === 'Version' ? 'Safari' : m[1]} ${m[2]}` : ua.slice(0, 40);
}
