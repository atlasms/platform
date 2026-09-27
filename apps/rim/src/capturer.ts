// The capture itself (EP-39; ADR-0007): one FFmpeg process per capture, bounded to its window.
//
// A port, like MTS's Transcoder: `ffmpegCapturer` runs the real binary; `fakeCapturer` lets the
// worker's suite decide how a capture ends. The real one is exactly ADR-0007 decision 6 — stream
// copy (`-c copy -map 0`), MPEG-TS, `-flush_packets 1` so a crash leaves what was received on disk
// (measured: without it a hard kill 2 s in left an EMPTY file), `-t` the window — and nothing else:
// the feed's URL is the recorder's, and no argument comes from anywhere but this file.

import { spawn } from 'node:child_process';

export interface CaptureRun {
  /** The feed, as the recorder names it — with any passphrase already applied, never logged. */
  url: string;
  /** Where the file is written: the worker's own disk. */
  file: string;
  /** How long to record: the rest of the capture's span. */
  durationMs: number;
  /** Stops the capture early — a drain. The file so far is kept. */
  signal?: AbortSignal;
}

export interface CaptureResult {
  /** 0 when FFmpeg ended by itself at the end of `-t`; anything else is a crash or a stop. */
  exitCode: number | null;
  /** The last lines FFmpeg wrote to stderr — the reason a partial file is partial. */
  stderrTail: string;
}

export interface Capturer {
  run(run: CaptureRun): Promise<CaptureResult>;
}

export interface FfmpegCapturerOptions {
  binary?: string;
  /** After a stop is asked (SIGINT: FFmpeg finishes the file), how long before SIGKILL. */
  graceMs?: number;
}

/** The FFmpeg arguments for one capture — exported so the test can hold them to the ADR. */
export function captureArgs(run: Pick<CaptureRun, 'url' | 'file' | 'durationMs'>): string[] {
  return [
    ...['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'],
    // FFmpeg holds a live input in its analysis buffer and opens the output only when probing
    // ends — 5 s by default for MPEG-TS. A crash inside that loses everything so far: measured,
    // killed 3.5 s in, NO file existed. One second of probing is plenty for a TS feed's streams.
    ...['-analyzeduration', '1000000', '-probesize', '1000000'],
    ...['-i', run.url],
    ...['-t', (Math.max(run.durationMs, 0) / 1000).toFixed(3)],
    ...['-c', 'copy', '-map', '0', '-flush_packets', '1'],
    ...['-f', 'mpegts', run.file],
  ];
}

export function ffmpegCapturer(options: FfmpegCapturerOptions = {}): Capturer {
  const binary = options.binary ?? 'ffmpeg';
  const graceMs = options.graceMs ?? 5_000;
  return {
    run(run) {
      return new Promise((resolve) => {
        const child = spawn(binary, captureArgs(run), { stdio: ['ignore', 'ignore', 'pipe'] });
        let tail = '';
        child.stderr.on('data', (chunk: Buffer) => {
          tail = (tail + chunk.toString('utf8')).slice(-2_000);
        });
        let killer: NodeJS.Timeout | undefined;
        const stop = () => {
          child.kill('SIGINT');
          killer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        };
        run.signal?.addEventListener('abort', stop, { once: true });
        let settled = false;
        const done = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          if (killer) clearTimeout(killer);
          run.signal?.removeEventListener('abort', stop);
          resolve({ exitCode, stderrTail: tail.trim().split('\n').slice(-3).join(' | ') });
        };
        // The binary could not be started (not installed): a crash with its reason, not a hang.
        child.on('error', (err) => {
          tail = err.message;
          done(-1);
        });
        child.on('exit', (code) => done(code));
      });
    },
  };
}
