// The encoder (EP-16.2): a port, and the FFmpeg subprocess behind it.
//
// Node's job here is supervision, not encoding — spawn it, read its progress, kill it when asked,
// and classify what came back. Three outcomes, kept apart because the job does different things
// with each:
//
//   an output          the file exists and its size is known; the caller checksums it.
//   TranscodeRefusal   FFmpeg READ the input and refused it — not media, or media it cannot
//                      decode. No number of retries makes an unreadable file readable, so the
//                      job goes to dead-letter rather than round the retry loop.
//   anything else      the tool or the machine failed: a missing binary, no space, a kill. The
//                      attempt is retried, because the next one may well succeed.
//
// Cancellation is a first-class argument rather than a `kill()` on some handle the caller has to
// keep: a transcode outlives the request that asked for it, and the thing that cancels it is a
// pod shutting down or an operator, both of which have an AbortSignal and nothing else.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface TranscodeSpec {
  inputPath: string;
  outputPath: string;
  /** The arguments between input and output — the preset's. */
  args: readonly string[];
  /** For progress: the input's duration, when something already knows it. */
  durationSec?: number;
}

export interface TranscodeOutput {
  sizeBytes: number;
  /** What the encoder reported for the OUTPUT, when it reported one. */
  durationSec?: number;
}

/** The input is at fault. Never retried: the bytes will be the same next time. */
export class TranscodeRefusal extends Error {
  override readonly name = 'TranscodeRefusal';
}

export interface Transcoder {
  /**
   * Produce one output. Resolves when the file is written, throws {@link TranscodeRefusal} when
   * the input is at fault, and anything else when the tool or the machine is.
   *
   * `onProgress` is best-effort and may never be called — mts.md says progress drives progress
   * bars, not state, and a caller that waits for it waits forever on a still.
   */
  run(
    spec: TranscodeSpec,
    options?: { signal?: AbortSignal; onProgress?: (percent: number) => void },
  ): Promise<TranscodeOutput>;
  /** Is the binary there — for readiness, so a deploy without FFmpeg is visible before a job is. */
  available(): Promise<boolean>;
}

export interface FfmpegOptions {
  /** The binary; `ffmpeg` on the PATH by default. */
  binary?: string;
  /**
   * The ceiling on one output. Past it the process is killed and the attempt is RETRYABLE: a
   * transcode that ran out of time may be the machine's fault, unlike one FFmpeg refused.
   */
  timeoutMs?: number;
  /** How long a killed process has to exit before SIGKILL. */
  graceMs?: number;
}

export const DEFAULT_TRANSCODE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_GRACE_MS = 5_000;

/**
 * The lines FFmpeg prints when it will not decode the input. Matching on prose is unpleasant and
 * version-dependent, which is why the set is narrow and the DEFAULT is to retry: mistaking a
 * machine fault for a bad file dead-letters something that would have worked, and that is the
 * more expensive error of the two.
 */
const REFUSAL_PATTERNS = [
  /Invalid data found when processing input/i,
  /Unknown format|Unrecognized/i,
  /Decoder \(codec .*\) not found/i,
  /does not contain any stream/i,
  /Output file (is empty|does not contain any stream)/i,
  /moov atom not found/i,
  // MXF's own refusals (the broadcast preset): a frame rate no broadcast format uses, and an
  // input with no picture to put in the one video track MXF requires. Both are the input's.
  /Unsupported frame rate/i,
  /there must be exactly one video stream/i,
];

export function ffmpegTranscoder(options: FfmpegOptions = {}): Transcoder {
  const binary = options.binary ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSCODE_TIMEOUT_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  return {
    async run(spec, runOptions = {}) {
      // `-nostdin` because a transcode has no console: without it FFmpeg can block reading a
      // stdin nobody will ever write to. `-y` because the output path is ours and a retry of the
      // same attempt must overwrite its own half-written file rather than stop and ask.
      const args = [
        '-nostdin',
        '-y',
        '-loglevel',
        'error',
        '-progress',
        'pipe:1',
        '-i',
        spec.inputPath,
        ...spec.args,
        spec.outputPath,
      ];

      const stderr: string[] = [];
      let outputDurationSec: number | undefined;

      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const finished = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.on('error', (error) => resolve({ code: null, error }));
        child.on('close', (code) => resolve({ code }));
      });

      let timedOut = false;
      let cancelled = false;
      const stop = (): void => {
        child.kill('SIGTERM');
        // A transcode that ignores SIGTERM is holding a CPU we need back. The grace is generous
        // enough for FFmpeg to flush its output file and short enough to matter to a drain.
        setTimeout(() => child.kill('SIGKILL'), graceMs).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = (): void => {
        cancelled = true;
        stop();
      };
      runOptions.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const [key, value] = line.split('=');
          if (key === 'out_time_us' || key === 'out_time_ms') {
            // `out_time_ms` is a misnomer in FFmpeg's own output: it is MICROseconds, the same as
            // `out_time_us`. Reading it as milliseconds makes every progress report 1000x too
            // small, which looks like a stuck job rather than a wrong unit.
            const seconds = Number(value) / 1_000_000;
            if (Number.isFinite(seconds)) {
              outputDurationSec = seconds;
              if (spec.durationSec && spec.durationSec > 0 && runOptions.onProgress) {
                runOptions.onProgress(Math.min(100, (seconds / spec.durationSec) * 100));
              }
            }
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr.push(chunk);
        // Bounded: a pathological input can print a line per frame, and the reason field this
        // ends up in is a sentence, not a log.
        if (stderr.length > 50) stderr.splice(0, stderr.length - 50);
      });

      const { code, error } = await finished;
      clearTimeout(timer);
      runOptions.signal?.removeEventListener('abort', onAbort);

      const message = stderr.join('').trim();
      if (cancelled) throw new Error('transcode cancelled');
      if (timedOut) throw new Error(`transcode exceeded ${timeoutMs}ms`);
      if (error) throw error;
      if (code !== 0) {
        if (REFUSAL_PATTERNS.some((p) => p.test(message))) {
          throw new TranscodeRefusal(message || `ffmpeg refused the input (exit ${code})`);
        }
        throw new Error(message || `ffmpeg exited ${code}`);
      }

      // The file, not the exit code, is the evidence. FFmpeg can exit 0 having written nothing
      // when every input stream was filtered away — a "success" that produces no rendition is a
      // refusal of the input, not a completion.
      const info = await stat(spec.outputPath).catch(() => undefined);
      if (!info || info.size === 0) {
        throw new TranscodeRefusal(message || 'ffmpeg produced no output');
      }

      return {
        sizeBytes: info.size,
        ...(outputDurationSec !== undefined ? { durationSec: outputDurationSec } : {}),
      };
    },

    async available() {
      return new Promise<boolean>((resolve) => {
        const child = spawn(binary, ['-version'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    },
  };
}
