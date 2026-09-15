// The probe (EP-15.4; FR-ING-6): what the bytes ARE, from ffprobe, as the platform's
// `TechnicalMetadata` (common.schema.json — the shape `ingest.accepted` will carry, 15.5).
//
// A port with one real adapter. `ffprobe` is a child process around a binary the image installs
// (infra/docker/Dockerfile, APK_PACKAGES=ffmpeg for rim only); the service holds the port so the
// conformance suite runs without the binary, and probe.test.ts runs the adapter against a file
// ffmpeg generates when it is on the PATH — in CI it must be.
//
// Three outcomes, kept apart because they mean different things to the job: metadata; a file
// the tool READ and refused (`ProbeRefusal` — not media, or not media it understands, or a file
// that took longer than a broadcast master ever should) which is a verdict about the bytes; and
// a tool that could not run at all (a missing binary, a spawn failure), which is an operational
// fault the recovery loop retries and the health report shows.

import { execFile } from 'node:child_process';
import type { TechnicalMetadata } from '@atlas/contracts';

export interface Probe {
  /** Metadata, or throws `ProbeRefusal` (the bytes) or another error (the tool). */
  probe(path: string): Promise<TechnicalMetadata>;
  /** Is the tool there — for readiness, so a deploy without the binary is visible before a job is. */
  available(): Promise<boolean>;
}

export class ProbeRefusal extends Error {
  override readonly name = 'ProbeRefusal';
}

export interface FfprobeOptions {
  /** The binary; `ffprobe` on the PATH by default. */
  binary?: string;
  /** Longer than this and the file is refused, not retried: a probe is seconds, whatever the size. */
  timeoutMs?: number;
  /** The spawn, injected for tests; execFile otherwise. It reports, it does not classify. */
  run?: Run;
}

/** What a run of the tool came back with: its output, and execFile's error when it did not exit 0. */
export interface RunResult {
  stdout: string;
  stderr: string;
  error?: RunError;
}
/** execFile's error: a numeric exit code, a string errno (ENOENT), or null when killed. */
export type RunError = Error & { code?: string | number | null; killed?: boolean };
export type Run = (binary: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

// ffprobe's JSON — the fields read here; everything else is ignored.
interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    display_aspect_ratio?: string;
    sample_aspect_ratio?: string;
    channels?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    duration?: string;
  }[];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** "25/1" → 25, "30000/1001" → 29.97; ffprobe writes "0/0" for a stream with no rate. */
function ratio(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const [n, d] = text.split('/').map(Number);
  if (n === undefined || d === undefined || !Number.isFinite(n) || !d) return undefined;
  const value = n / d;
  return value > 0 ? Math.round(value * 1000) / 1000 : undefined;
}

/**
 * The picture's aspect as W:H. ffprobe's `display_aspect_ratio` when the container states one
 * (anamorphic material says 16:9 over 1440×1080 pixels); the frame's own reduced ratio otherwise.
 */
export function aspectRatioOf(stream: {
  width?: number;
  height?: number;
  display_aspect_ratio?: string;
}): string | undefined {
  const declared = stream.display_aspect_ratio;
  if (declared && /^[1-9][0-9]*:[1-9][0-9]*$/.test(declared)) return declared;
  const { width, height } = stream;
  if (!width || !height) return undefined;
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

/** ffprobe's JSON → the platform's shape. Exported for the unit test; the adapter calls it. */
export function metadataOf(output: FfprobeOutput): TechnicalMetadata {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new ProbeRefusal('no audio or video stream');
  const out: TechnicalMetadata = {};
  // "mov,mp4,m4a,3gp,3g2,mj2" is one demuxer's list of names; the first is its own.
  const container = output.format?.format_name?.split(',')[0]?.trim();
  if (container) out.container = container;
  const duration = Number(output.format?.duration ?? video?.duration ?? audio?.duration);
  if (Number.isFinite(duration) && duration >= 0)
    out.durationSec = Math.round(duration * 1000) / 1000;
  if (video) {
    if (video.codec_name) out.videoCodec = video.codec_name;
    if (video.width) out.width = video.width;
    if (video.height) out.height = video.height;
    const aspect = aspectRatioOf(video);
    if (aspect) out.aspectRatio = aspect;
    const rate = ratio(video.avg_frame_rate) ?? ratio(video.r_frame_rate);
    if (rate) out.frameRate = rate;
  }
  if (audio) {
    if (audio.codec_name) out.audioCodec = audio.codec_name;
    if (audio.channels) out.audioChannels = audio.channels;
  }
  return out;
}

const defaultRun: Run = (binary, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          ...(error ? { error: error as RunError } : {}),
        });
      },
    );
  });

/** The bytes or the tool — see the header. Throws what `probe()` should throw. */
function classify(result: RunResult, timeoutMs: number): void {
  const { error, stderr } = result;
  if (!error) return;
  // A timeout: execFile killed the child. Deterministic for the file; a refusal, not a retry.
  if (error.killed) throw new ProbeRefusal(`probe timed out after ${timeoutMs} ms`);
  // A non-zero exit: the tool ran and refused the bytes. Its stderr says why, briefly.
  if (typeof error.code === 'number') {
    const why = stderr.trim().split('\n').filter(Boolean).pop();
    throw new ProbeRefusal(why ?? `ffprobe exited ${error.code}`);
  }
  // ENOENT, EACCES, a spawn failure: the tool, not the file.
  throw error;
}

export function ffprobeProbe(options: FfprobeOptions = {}): Probe {
  const binary = options.binary ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const run = options.run ?? defaultRun;
  return {
    async probe(path) {
      const result = await run(
        binary,
        // `-v error` keeps stderr to what went wrong; the JSON is the whole answer.
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        timeoutMs,
      );
      classify(result, timeoutMs);
      let parsed: FfprobeOutput;
      try {
        parsed = JSON.parse(result.stdout) as FfprobeOutput;
      } catch {
        throw new ProbeRefusal('ffprobe produced no readable report');
      }
      return metadataOf(parsed);
    },
    async available() {
      try {
        return (await run(binary, ['-version'], 5_000)).error === undefined;
      } catch {
        return false;
      }
    },
  };
}
