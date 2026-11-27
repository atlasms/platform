import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileRef } from '../core/generated/mam.types.ts';
import {
  awaitFrame,
  cueAt,
  filmstripOf,
  frameAt,
  frameTimecode,
  lastFrame,
  markSec,
  parseFilmstrip,
  playableOf,
  refreshInMs,
  SEEK_WAIT_MS,
  seekTargetSec,
} from './edit-player.model.ts';

const NTSC = 30000 / 1001;

const file = (kind: string, variant?: string, tier = 'online', frameRate?: number) =>
  ({
    kind,
    ...(variant !== undefined ? { variant } : {}),
    storage: { path: `/${kind}`, tier, status: 'available' },
    ...(frameRate !== undefined ? { frameRate } : {}),
  }) as FileRef;

describe('the frame grid (ADR-0011)', () => {
  it('maps mediaTime with floor, not round — the frame whose interval contains it', () => {
    // Firefox reports mediaTime near the seeked point inside the frame; round() lands one late.
    expect(frameAt(10.02, 25)).toBe(250);
    expect(frameAt(10.039, 25)).toBe(250);
    expect(frameAt(10.04, 25)).toBe(251);
    // Float jitter at the boundary is the frame it is at, not the one before.
    expect(frameAt(250 / 25 - 1e-9, 25)).toBe(250);
    expect(frameAt(-0.01, 25)).toBe(0);
  });

  it('is exact for every frame of an hour at 29.97, both ways round', () => {
    for (let n = 0; n < 108_000; n += 997) {
      expect(frameAt(n / NTSC, NTSC)).toBe(n);
      expect(frameAt(seekTargetSec(n, NTSC), NTSC)).toBe(n);
    }
  });

  it('seeks to the middle of a frame', () => {
    expect(seekTargetSec(250, 25)).toBeCloseTo(10.02, 9);
    expect(seekTargetSec(-3, 25)).toBeCloseTo(0.02, 9);
  });

  it('marks: in at the frame start, out at the next frame’s — rounded DOWN to the millisecond', () => {
    expect(markSec(25, 25, 'in')).toBe(1);
    expect(markSec(25, 25, 'out')).toBe(1.04);
    // Frame 31 at 29.97 starts at 1.03433…: 1.034 keeps it (an input seek keeps what is at or after).
    expect(markSec(31, NTSC, 'in')).toBe(1.034);
    for (let n = 1; n < 5000; n += 37) {
      const sec = markSec(n, NTSC, 'in');
      expect(sec).toBeLessThanOrEqual(n / NTSC);
      expect(sec).toBeGreaterThan((n - 1) / NTSC);
    }
  });

  it('knows the last frame and a frame timecode', () => {
    expect(lastFrame(4, 25)).toBe(99);
    expect(lastFrame(4.01, 25)).toBe(100);
    expect(frameTimecode(0, 25)).toBe('00:00:00:00');
    expect(frameTimecode(3 * 3600 * 25 + 61 * 25 + 24, 25)).toBe('03:01:01:24');
  });
});

describe('what plays', () => {
  it('the editing proxy, else the playback proxy — online and available only', () => {
    const edit = file('proxy', 'edit', 'online', 25);
    expect(playableOf([file('original'), file('proxy'), edit])).toBe(edit);
    expect(playableOf([file('original'), file('proxy')])?.variant).toBeUndefined();
    expect(playableOf([file('proxy', 'edit', 'near-line')])).toBeUndefined();
    expect(playableOf([file('original')])).toBeUndefined();
  });

  it('a filmstrip only with both of its files', () => {
    expect(filmstripOf([file('vtt-filmstrip', 'cues')])).toBeUndefined();
    const both = filmstripOf([file('vtt-filmstrip', 'sprite'), file('vtt-filmstrip', 'cues')]);
    expect(both?.cues.variant).toBe('cues');
    expect(both?.sprite.variant).toBe('sprite');
  });
});

describe('the filmstrip cues (EP-29.4)', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'filmstrip.jpg#xywh=0,0,160,90',
    '',
    '00:02.000 --> 00:04.000',
    'filmstrip.jpg#xywh=160,0,160,90',
    '',
    '00:00:04.000 --> 00:00:06.500',
    'not a rectangle',
    '',
    '01:00:04.000 --> 01:00:06.000',
    'filmstrip.jpg#xywh=0,90,160,90',
  ].join('\r\n');

  it('reads both time forms and the rectangle; skips a cue it cannot read', () => {
    expect(parseFilmstrip(vtt)).toEqual([
      { startSec: 0, endSec: 2, x: 0, y: 0, w: 160, h: 90 },
      { startSec: 2, endSec: 4, x: 160, y: 0, w: 160, h: 90 },
      { startSec: 3604, endSec: 3606, x: 0, y: 90, w: 160, h: 90 },
    ]);
  });

  it('finds the cue for a time, the last past the end', () => {
    const cues = parseFilmstrip(vtt);
    expect(cueAt(cues, 0)?.x).toBe(0);
    expect(cueAt(cues, 2)?.x).toBe(160);
    expect(cueAt(cues, 99_999)?.y).toBe(90);
    expect(cueAt([], 1)).toBeUndefined();
  });
});

describe('the signed URL (ADR-0012)', () => {
  it('is fetched again a minute before it expires, never at a negative delay', () => {
    const now = Date.parse('2026-11-27T10:00:00Z');
    expect(refreshInMs('2026-11-27T10:30:00Z', now)).toBe(29 * 60_000);
    expect(refreshInMs('2026-11-27T10:00:30Z', now)).toBe(0);
    expect(refreshInMs('nonsense', now)).toBe(0);
  });
});

describe('the bounded seek wait (ADR-0011 point 4)', () => {
  afterEach(() => vi.useRealTimers());

  it('answers with the presented frame’s mediaTime when the callback comes', async () => {
    const video = {
      currentTime: 9,
      requestVideoFrameCallback: (cb: (n: number, m: { mediaTime: number }) => void) => {
        queueMicrotask(() => cb(0, { mediaTime: 10.02 }));
        return 1;
      },
    };
    await expect(awaitFrame(video)).resolves.toEqual({ mediaTime: 10.02, exact: true });
  });

  it('gives up on a callback that never comes, and reads currentTime — never hangs', async () => {
    vi.useFakeTimers();
    const cancelled: number[] = [];
    const video = {
      currentTime: 4.5,
      requestVideoFrameCallback: () => 7,
      cancelVideoFrameCallback: (h: number) => cancelled.push(h),
    };
    const answer = awaitFrame(video);
    vi.advanceTimersByTime(SEEK_WAIT_MS);
    await expect(answer).resolves.toEqual({ mediaTime: 4.5, exact: false });
    expect(cancelled).toEqual([7]);
  });

  it('without rVFC at all, reads currentTime', async () => {
    await expect(awaitFrame({ currentTime: 2 })).resolves.toEqual({ mediaTime: 2, exact: false });
  });
});
