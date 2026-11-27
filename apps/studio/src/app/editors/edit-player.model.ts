// The media editor's player, as rules (EP-26.4; ADR-0011, ADR-0012) — kept out of the component so
// each is tested without a browser decoding video.
//
// - The frame on screen is `floor(mediaTime · fps)`, from `requestVideoFrameCallback`'s
//   `mediaTime`, with a small epsilon for float jitter at a frame boundary. NOT `round`: that
//   encodes Chrome's reporting point and lands a frame late in Firefox (ADR-0011 point 2).
// - A seek aims at the MIDDLE of a frame, `(n + ½) / fps`, as the spike's harness did: the frame
//   whose interval contains it is `n` under either browser's convention.
// - A seek's wait is BOUNDED (ADR-0011 point 4): rVFC sometimes fires nothing for a seek (a seek to
//   the frame already shown is the usual case), so the wait ends after `SEEK_WAIT_MS` and reads
//   `currentTime` instead. A scrub never hangs on a callback that is not coming.
// - A mark is a frame turned into seconds for the timeline, which keeps milliseconds. It is
//   rounded DOWN to the millisecond: an input seek (`-ss`) keeps the frames at or after it, so a
//   start a fraction early still begins on the marked frame, and one a fraction late would skip
//   it. An out mark includes the frame shown, so it is the start of the NEXT frame.
// - A signed URL is fetched again a minute before it expires (ADR-0012), and on a media error.

import type { FileRef } from '../core/generated/mam.types.ts';

/** How long a seek waits for its frame callback before reading `currentTime` (ADR-0011 point 4). */
export const SEEK_WAIT_MS = 400;
/** Ask for a fresh URL this long before the old one expires. */
export const REFRESH_MARGIN_MS = 60_000;
/** Float jitter at a frame boundary, in frames: 29.999999 frames is frame 30. */
const EPSILON_FRAMES = 1e-3;

/** The frame a `mediaTime` (seconds) falls in, on a grid of `fps` (ADR-0011 point 2). */
export function frameAt(mediaTime: number, fps: number): number {
  return Math.max(0, Math.floor(mediaTime * fps + EPSILON_FRAMES));
}

/** Where to seek to show frame `n`: the middle of its interval. */
export function seekTargetSec(frame: number, fps: number): number {
  return (Math.max(0, frame) + 0.5) / fps;
}

/**
 * The timeline seconds a mark on frame `n` writes: the frame's start, rounded down to the
 * millisecond. `out` includes the frame shown, so it is where the next frame starts.
 */
export function markSec(frame: number, fps: number, which: 'in' | 'out'): number {
  const start = (which === 'out' ? frame + 1 : frame) / fps;
  return Math.floor(start * 1000 + 1e-6) / 1000;
}

/** The last frame of a file `durationSec` long. */
export function lastFrame(durationSec: number, fps: number): number {
  return Math.max(0, Math.ceil(durationSec * fps - EPSILON_FRAMES) - 1);
}

/** `hh:mm:ss:ff` — the frame-exact readout beside the millisecond timecode. */
export function frameTimecode(frame: number, fps: number): string {
  const perSecond = Math.round(fps);
  const ff = frame % perSecond;
  const total = Math.floor(frame / perSecond);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}:${two(ff)}`;
}

/**
 * The file the player plays: the editing proxy (`proxy`/`edit`, GOP 12, ADR-0011), else the
 * playback proxy. Only an online, available file can be signed (ADR-0012).
 */
export function playableOf(files: readonly FileRef[]): FileRef | undefined {
  const online = (f: FileRef) => f.storage?.tier === 'online' && f.storage?.status === 'available';
  return (
    files.find((f) => f.kind === 'proxy' && f.variant === 'edit' && online(f)) ??
    files.find((f) => f.kind === 'proxy' && f.variant === undefined && online(f))
  );
}

/** The filmstrip's two files (EP-29.4), when the asset has both online. */
export function filmstripOf(
  files: readonly FileRef[],
): { cues: FileRef; sprite: FileRef } | undefined {
  const online = (f: FileRef) => f.storage?.tier === 'online' && f.storage?.status === 'available';
  const cues = files.find((f) => f.kind === 'vtt-filmstrip' && f.variant === 'cues' && online(f));
  const sprite = files.find(
    (f) => f.kind === 'vtt-filmstrip' && f.variant === 'sprite' && online(f),
  );
  return cues && sprite ? { cues, sprite } : undefined;
}

/** One thumbnail of the filmstrip: the span it stands for and its rectangle on the sprite. */
export interface FilmstripCue {
  startSec: number;
  endSec: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `hh:mm:ss.mmm` or `mm:ss.mmm` (WebVTT's two forms) → seconds. */
function vttTime(text: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/**
 * The cues of MTS's filmstrip VTT (mts.md EP-29.4): `start --> end` then `<image>#xywh=x,y,w,h`.
 * The image name is ignored: it is relative (`filmstrip.jpg`), and a signed URL cannot be resolved
 * beside another, so the player signs the sprite on its own and uses that. A cue it cannot read
 * is skipped, never guessed at.
 */
export function parseFilmstrip(vtt: string): FilmstripCue[] {
  const cues: FilmstripCue[] = [];
  const lines = vtt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const timing = /^\s*(\S+)\s+-->\s+(\S+)/.exec(lines[i]!);
    if (!timing) continue;
    const startSec = vttTime(timing[1]!);
    const endSec = vttTime(timing[2]!);
    const xywh = /#xywh=(\d+),(\d+),(\d+),(\d+)/.exec(lines[i + 1] ?? '');
    if (startSec === undefined || endSec === undefined || !xywh) continue;
    cues.push({
      startSec,
      endSec,
      x: Number(xywh[1]),
      y: Number(xywh[2]),
      w: Number(xywh[3]),
      h: Number(xywh[4]),
    });
  }
  return cues;
}

/** The cue covering `sec` — the last one for a time at or past the end. */
export function cueAt(cues: readonly FilmstripCue[], sec: number): FilmstripCue | undefined {
  return (
    cues.find((c) => sec >= c.startSec && sec < c.endSec) ?? (sec >= 0 ? cues.at(-1) : undefined)
  );
}

/** How long until a URL expiring at `expiresAt` should be fetched again. Never negative. */
export function refreshInMs(expiresAt: string, now: number): number {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? Math.max(0, at - now - REFRESH_MARGIN_MS) : 0;
}

/** What {@link awaitFrame} needs of a `<video>` — a test hands in a fake. */
export interface FrameSource {
  currentTime: number;
  requestVideoFrameCallback?(cb: (now: number, meta: { mediaTime: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

/**
 * The `mediaTime` of the next frame presented, or — when no callback comes within `waitMs`, or the
 * browser has no rVFC — `currentTime`. Bounded either way (ADR-0011 point 4).
 */
export function awaitFrame(
  video: FrameSource,
  waitMs = SEEK_WAIT_MS,
): Promise<{ mediaTime: number; exact: boolean }> {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      resolve({ mediaTime: video.currentTime, exact: false });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      video.cancelVideoFrameCallback?.(handle);
      resolve({ mediaTime: video.currentTime, exact: false });
    }, waitMs);
    const handle = video.requestVideoFrameCallback((_now, meta) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ mediaTime: meta.mediaTime, exact: true });
    });
  });
}
