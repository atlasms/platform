// The transcode profile registry's grammar (EP-16.6) — mts.md §11.1.
//
// A profile is a Tier-1 registry entry (configuration §2.2): the administrator owns WHICH profiles
// exist and their parameters; the code owns what a parameter can be. So a profile is a STRUCTURED
// target — a rendition kind, a container, a video target and an audio target — and this module is
// the only place that turns one into FFmpeg arguments, from an allowlist.
//
// Never raw arguments. A profile is written from an admin page, and an arguments field there would
// let it add an input (`-i /etc/shadow`), switch the muxer, or write a side file anywhere the
// process can — that is handing out a shell, not configuring a transcoder. Every value below is
// either an enum the code knows or a number with bounds, and every argument is built here.

import type { Preset } from './preset.ts';

// --- the grammar (Tier 0: the code knows these; a profile can only choose among them) -----------

/** The kinds a profile may produce — the RenditionKinds MTS has a builder for. */
export const PROFILE_KINDS = ['proxy', 'broadcast', 'thumbnail'] as const;
export const CONTAINERS = ['mp4', 'mov', 'mxf', 'm4a', 'jpg'] as const;
export const VIDEO_CODECS = ['h264', 'mpeg2', 'prores'] as const;
export const AUDIO_CODECS = ['aac', 'pcm_s16le', 'pcm_s24le'] as const;
/** Frame rates broadcast formats use; conforming to one is a profile's decision, never a built-in's. */
export const FRAME_RATES = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'] as const;
/** `tff`/`bff` are interlaced (top or bottom field first). */
export const SCANS = ['progressive', 'tff', 'bff'] as const;
export const CHROMAS = ['420', '422'] as const;
/** How the picture meets the frame: `pad` letter/pillarboxes to exactly W×H; `fit` scales within. */
export const FITS = ['pad', 'fit'] as const;
/** GPU encoders a profile may ask for — H.264 only; the node's ability to use one is TESTED. */
export const GPUS = ['none', 'nvenc', 'qsv'] as const;
export const SAMPLE_RATES = [44100, 48000] as const;

export type ProfileKind = (typeof PROFILE_KINDS)[number];
export type Container = (typeof CONTAINERS)[number];
export type VideoCodec = (typeof VIDEO_CODECS)[number];
export type AudioCodec = (typeof AUDIO_CODECS)[number];
export type FrameRate = (typeof FRAME_RATES)[number];
export type Scan = (typeof SCANS)[number];
export type Chroma = (typeof CHROMAS)[number];
export type Fit = (typeof FITS)[number];
export type Gpu = (typeof GPUS)[number];

export interface VideoTarget {
  codec: VideoCodec;
  width: number;
  height: number;
  fit?: Fit;
  /** Absent keeps the source's rate — and a container that refuses it refuses the input. */
  frameRate?: FrameRate;
  scan?: Scan;
  chroma?: Chroma;
  /** Constant for MPEG-2 (a playout decoder's budget), capped VBR for H.264. Or `quality`. */
  bitrateMbps?: number;
  /** H.264: CRF / CQ, 0–51, lower is better. MPEG-2: qscale, 1–31. */
  quality?: number;
  gpu?: Gpu;
}

export interface AudioTarget {
  codec: AudioCodec;
  sampleRate?: (typeof SAMPLE_RATES)[number];
  channels?: number;
  /** AAC only. */
  bitrateKbps?: number;
}

export interface TranscodeProfile {
  /** Kebab-case. The same id as a built-in preset REDEFINES it for the profile's channel. */
  id: string;
  /** Absent: platform-wide, every channel's unless a channel defines the same id. */
  channelId?: string;
  name: string;
  description?: string;
  kind: ProfileKind;
  container: Container;
  /** Absent for an audio-only profile. */
  video?: VideoTarget;
  /** Absent: the output has no audio. */
  audio?: AudioTarget;
  /** Disabled, never deleted (configuration §2.2): hidden from new jobs, still readable. */
  enabled: boolean;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What an administrator sends — everything the registry derives is absent. */
export type ProfileInput = Omit<
  TranscodeProfile,
  'channelId' | 'version' | 'createdBy' | 'createdAt' | 'updatedAt'
> & { channelId?: string | null };

// --- validation --------------------------------------------------------------------------------

const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

const oneOf = <T extends readonly (string | number)[]>(
  list: T,
  value: unknown,
): value is T[number] => (list as readonly unknown[]).includes(value);

const between = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/**
 * Every reason this profile cannot be compiled, or none. Pure; the service refuses a write with
 * these as the 422's message. The combinations below are the ones FFmpeg would refuse (or, worse,
 * accept and write something a playout server will not) — caught at the admin page, not at 3 am.
 */
export function profileErrors(p: ProfileInput): string[] {
  const errors: string[] = [];
  const add = (m: string) => errors.push(m);

  if (typeof p.id !== 'string' || !ID_RE.test(p.id))
    add('id must be kebab-case, up to 63 characters');
  if (typeof p.name !== 'string' || p.name.trim() === '') add('name is required');
  if (!oneOf(PROFILE_KINDS, p.kind)) add(`kind must be one of ${PROFILE_KINDS.join(', ')}`);
  if (!oneOf(CONTAINERS, p.container)) add(`container must be one of ${CONTAINERS.join(', ')}`);
  if (typeof p.enabled !== 'boolean') add('enabled must be true or false');

  const v = p.video;
  const a = p.audio;
  if (!v && !a) add('a profile needs a video target, an audio target, or both');

  if (v) {
    if (!oneOf(VIDEO_CODECS, v.codec)) add(`video.codec must be one of ${VIDEO_CODECS.join(', ')}`);
    for (const [key, max] of [
      ['width', 7680],
      ['height', 4320],
    ] as const) {
      const n = v[key];
      if (!between(n, 16, max) || !Number.isInteger(n) || n % 2 !== 0) {
        add(`video.${key} must be an even whole number from 16 to ${max}`);
      }
    }
    if (v.fit !== undefined && !oneOf(FITS, v.fit))
      add(`video.fit must be one of ${FITS.join(', ')}`);
    if (v.frameRate !== undefined && !oneOf(FRAME_RATES, v.frameRate)) {
      add(`video.frameRate must be one of ${FRAME_RATES.join(', ')}`);
    }
    if (v.scan !== undefined && !oneOf(SCANS, v.scan))
      add(`video.scan must be one of ${SCANS.join(', ')}`);
    if (v.chroma !== undefined && !oneOf(CHROMAS, v.chroma)) {
      add(`video.chroma must be one of ${CHROMAS.join(', ')}`);
    }
    if (v.gpu !== undefined && !oneOf(GPUS, v.gpu))
      add(`video.gpu must be one of ${GPUS.join(', ')}`);
    if (v.bitrateMbps !== undefined && !between(v.bitrateMbps, 0.1, 400)) {
      add('video.bitrateMbps must be from 0.1 to 400');
    }
    if (v.quality !== undefined && !(Number.isInteger(v.quality) && between(v.quality, 0, 51))) {
      add('video.quality must be a whole number from 0 to 51');
    }
    if (v.bitrateMbps !== undefined && v.quality !== undefined) {
      add('video: give bitrateMbps or quality, not both');
    }
    // What the codecs can actually do.
    const gpu = v.gpu ?? 'none';
    if (gpu !== 'none' && v.codec !== 'h264') add('video.gpu applies to h264 only');
    if (gpu !== 'none' && v.chroma === '422') {
      add('video.gpu cannot encode 4:2:2 — NVENC and QSV H.264 are 4:2:0');
    }
    if (v.codec === 'prores' && v.chroma === '420')
      add('prores is 4:2:2; chroma 420 is not available');
    if (v.codec === 'mpeg2' && v.quality !== undefined && v.quality > 31) {
      add('mpeg2 quality (qscale) is 1–31');
    }
    if (v.codec === 'mpeg2' && v.bitrateMbps === undefined && v.quality === undefined) {
      add('mpeg2 needs bitrateMbps (constant, as a playout decoder expects) or quality');
    }
  }

  if (a) {
    if (!oneOf(AUDIO_CODECS, a.codec)) add(`audio.codec must be one of ${AUDIO_CODECS.join(', ')}`);
    if (a.sampleRate !== undefined && !oneOf(SAMPLE_RATES, a.sampleRate)) {
      add(`audio.sampleRate must be one of ${SAMPLE_RATES.join(', ')}`);
    }
    if (a.channels !== undefined && !(Number.isInteger(a.channels) && between(a.channels, 1, 16))) {
      add('audio.channels must be a whole number from 1 to 16');
    }
    if (a.bitrateKbps !== undefined) {
      if (a.codec !== 'aac') add('audio.bitrateKbps applies to aac only');
      else if (!between(a.bitrateKbps, 32, 512)) add('audio.bitrateKbps must be from 32 to 512');
    }
  }

  // The container decides which codecs can be in it.
  const vc = v?.codec;
  const ac = a?.codec;
  switch (p.container) {
    case 'mp4':
      if (vc && vc !== 'h264') add('mp4 carries h264 video');
      if (ac && ac !== 'aac') add('mp4 carries aac audio');
      break;
    case 'mov':
      if (vc && vc !== 'h264' && vc !== 'prores') add('mov carries h264 or prores video');
      break;
    case 'mxf':
      // FFmpeg's MXF muxer takes MPEG-2 (the XDCAM family) with PCM.
      if (!v) add('mxf needs exactly one video track');
      if (vc && vc !== 'mpeg2') add('mxf carries mpeg2 video');
      if (ac && ac === 'aac') add('mxf carries pcm audio');
      if (a && a.sampleRate !== undefined && a.sampleRate !== 48000) add('mxf audio is 48 kHz');
      break;
    case 'm4a':
      if (v) add('m4a is audio only');
      if (ac && ac !== 'aac') add('m4a carries aac audio');
      break;
    case 'jpg':
      if (!v) add('jpg needs a video target to take the still from');
      if (a) add('jpg has no audio');
      if (p.kind !== 'thumbnail') add('jpg is a thumbnail container');
      break;
  }
  if (p.kind === 'thumbnail' && p.container !== 'jpg') add('a thumbnail is a jpg');
  return errors;
}

// --- compilation --------------------------------------------------------------------------------

/** What an encoder choice came to on THIS node. */
export interface EncoderChoice {
  /** The FFmpeg encoder used, e.g. `libx264`, `h264_nvenc`. */
  encoder: string;
  /** The profile asked for a GPU the node cannot use, and got the CPU. */
  fallback: boolean;
}

export interface CompiledProfile extends Preset {
  encoder?: string;
  fallback?: boolean;
}

const GPU_ENCODER: Record<Exclude<Gpu, 'none'>, string> = { nvenc: 'h264_nvenc', qsv: 'h264_qsv' };

/** The encoder a profile's GPU choice names, for the service to test before compiling. */
export function gpuEncoderFor(p: TranscodeProfile): string | undefined {
  const gpu = p.video?.gpu ?? 'none';
  return p.video?.codec === 'h264' && gpu !== 'none' ? GPU_ENCODER[gpu] : undefined;
}

/**
 * Arguments for one profile. `gpuUsable` is whether the node passed the one-frame test for the
 * GPU encoder this profile asks for; when it did not, the CPU encoder is used and the result says
 * so (mts.md §9's fallback, made visible).
 *
 * Only called on a profile `profileErrors` accepted. Every argument is built from an enum or a
 * bounded number — there is no string a profile supplies that reaches the command line.
 */
export function compileProfile(p: TranscodeProfile, gpuUsable = false): CompiledProfile {
  const args: string[] = [];
  const v = p.video;
  const a = p.audio;
  const still = p.container === 'jpg';
  let choice: EncoderChoice | undefined;

  if (v) {
    const filters: string[] = [];
    if (still) filters.push('thumbnail');
    const fit = v.fit ?? 'pad';
    filters.push(
      fit === 'pad'
        ? `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2`
        : `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    );
    filters.push('setsar=1');
    if (v.frameRate && !still) filters.push(`fps=${fpsExpr(v.frameRate)}`);
    const scan = v.scan ?? 'progressive';
    if (scan !== 'progressive' && !still) filters.push(`setfield=${scan}`);
    args.push('-vf', filters.join(','));

    if (still) {
      args.push('-frames:v', '1', '-q:v', '3');
    } else {
      choice = encoderFor(v, gpuUsable);
      args.push(...videoArgs(v, choice.encoder));
      if (scan !== 'progressive') {
        args.push('-flags', '+ildct+ilme', '-top', scan === 'tff' ? '1' : '0');
      }
    }
  } else {
    args.push('-vn');
  }

  if (a && !still) {
    args.push('-c:a', a.codec);
    if (a.codec === 'aac') args.push('-b:a', `${a.bitrateKbps ?? 128}k`);
    args.push('-ar', String(a.sampleRate ?? 48000));
    if (a.channels !== undefined) args.push('-ac', String(a.channels));
  } else if (!still) {
    args.push('-an');
  }

  switch (p.container) {
    case 'mp4':
      args.push('-movflags', '+faststart');
      break;
    case 'mxf':
      args.push('-f', 'mxf');
      break;
    case 'mov':
      args.push('-f', 'mov');
      break;
  }

  return {
    id: p.id,
    kind: p.kind,
    requires: v ? 'video' : 'audio',
    extension: p.container,
    ...(still ? { still: true } : {}),
    args,
    ...(choice ? { encoder: choice.encoder, fallback: choice.fallback } : {}),
  };
}

function encoderFor(v: VideoTarget, gpuUsable: boolean): EncoderChoice {
  const gpu = v.gpu ?? 'none';
  if (v.codec === 'h264' && gpu !== 'none') {
    return gpuUsable
      ? { encoder: GPU_ENCODER[gpu], fallback: false }
      : { encoder: 'libx264', fallback: true };
  }
  const cpu: Record<VideoCodec, string> = {
    h264: 'libx264',
    mpeg2: 'mpeg2video',
    prores: 'prores_ks',
  };
  return { encoder: cpu[v.codec], fallback: false };
}

function videoArgs(v: VideoTarget, encoder: string): string[] {
  const chroma = v.chroma ?? (v.codec === 'h264' ? '420' : '422');
  const args = ['-c:v', encoder];
  switch (v.codec) {
    case 'prores':
      // HQ (profile 3), 10-bit 4:2:2 — ProRes has no rate control to speak of.
      return [...args, '-profile:v', '3', '-pix_fmt', 'yuv422p10le'];
    case 'mpeg2': {
      args.push('-pix_fmt', chroma === '422' ? 'yuv422p' : 'yuv420p', '-g', '12', '-bf', '2');
      if (v.bitrateMbps !== undefined) {
        const rate = `${v.bitrateMbps}M`;
        // Constant: min = max = target, as a playout server's decoder budget assumes.
        args.push(
          '-b:v',
          rate,
          '-minrate',
          rate,
          '-maxrate',
          rate,
          '-bufsize',
          `${Math.round(v.bitrateMbps * 728166)}`,
        );
      } else {
        args.push('-q:v', String(v.quality));
      }
      return args;
    }
    case 'h264': {
      const cpu = encoder === 'libx264';
      if (cpu) args.push('-preset', 'medium', '-pix_fmt', chroma === '422' ? 'yuv422p' : 'yuv420p');
      else args.push('-pix_fmt', 'yuv420p');
      if (v.bitrateMbps !== undefined) {
        const rate = `${v.bitrateMbps}M`;
        args.push('-b:v', rate, '-maxrate', rate, '-bufsize', `${v.bitrateMbps * 2}M`);
      } else {
        const q = String(v.quality ?? 23);
        if (cpu) args.push('-crf', q);
        else if (encoder === 'h264_nvenc') args.push('-cq', q);
        else args.push('-global_quality', q);
      }
      return args;
    }
  }
}

/** NTSC rates as the exact fractions FFmpeg means by them. */
function fpsExpr(rate: FrameRate): string {
  switch (rate) {
    case '23.976':
      return '24000/1001';
    case '29.97':
      return '30000/1001';
    case '59.94':
      return '60000/1001';
    default:
      return rate;
  }
}
