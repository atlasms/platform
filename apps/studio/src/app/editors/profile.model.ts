import type { Profile, ProfileInput } from '../core/generated/mts.types.ts';

/**
 * The transcode profile form's model (EP-16.6), pure so it is tested without a DOM.
 *
 * MTS owns the grammar (`apps/mts/src/profile.ts`) and is the only judge of a profile: it refuses
 * a combination FFmpeg would refuse with a 422 whose message names each rule. This file does NOT
 * re-implement that check — a second copy of the rules in the browser would drift from the one
 * that decides. It offers the values the contract allows, sensible starting targets, and a way to
 * put MTS's answer next to the field it is about.
 */

type Video = NonNullable<ProfileInput['video']>;
type Audio = NonNullable<ProfileInput['audio']>;

/**
 * The option lists, derived from the GENERATED contract types: `keys` of a `Record` over the
 * union, so a value the contract gains or loses is a compile error here rather than a select that
 * quietly offers the old set.
 */
const keys = <T extends string>(record: Record<T, true>): readonly T[] =>
  Object.keys(record) as T[];

export const KINDS = keys<ProfileInput['kind']>({ proxy: true, broadcast: true, thumbnail: true });
export const CONTAINERS = keys<ProfileInput['container']>({
  mp4: true,
  mov: true,
  mxf: true,
  m4a: true,
  jpg: true,
});
export const VIDEO_CODECS = keys<Video['codec']>({ h264: true, mpeg2: true, prores: true });
export const FITS = keys<NonNullable<Video['fit']>>({ pad: true, fit: true });
export const FRAME_RATES = keys<NonNullable<Video['frameRate']>>({
  '23.976': true,
  '24': true,
  '25': true,
  '29.97': true,
  '30': true,
  '50': true,
  '59.94': true,
  '60': true,
});
export const SCANS = keys<NonNullable<Video['scan']>>({ progressive: true, tff: true, bff: true });
export const CHROMAS = keys<NonNullable<Video['chroma']>>({ '420': true, '422': true });
export const GPUS = keys<NonNullable<Video['gpu']>>({ none: true, nvenc: true, qsv: true });
export const AUDIO_CODECS = keys<Audio['codec']>({ aac: true, pcm_s16le: true, pcm_s24le: true });
export const SAMPLE_RATES: readonly number[] = [44100, 48000];

/**
 * The built-in presets' ids (mts.md §4). A profile with one of these ids REDEFINES the built-in
 * for its scope — which is how a channel makes `broadcast` 1080i25 — so the list says so.
 */
export const BUILT_IN_IDS: readonly string[] = ['proxy', 'thumbnail', 'audio-proxy', 'broadcast'];

/** MTS's id rule: kebab-case, up to 63 characters. */
export const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The form's state: flat, so each control binds one field, and with the optional parts kept while
 * switched off — unticking "video" and ticking it again gives back what was there.
 */
export interface ProfileDraft {
  name: string;
  description: string;
  kind: ProfileInput['kind'];
  container: ProfileInput['container'];
  enabled: boolean;

  hasVideo: boolean;
  codec: Video['codec'];
  width: number | null;
  height: number | null;
  fit: NonNullable<Video['fit']>;
  /** '' keeps the source's rate. */
  frameRate: NonNullable<Video['frameRate']> | '';
  scan: NonNullable<Video['scan']>;
  chroma: NonNullable<Video['chroma']>;
  /** A constant bit rate or a quality target — MTS takes one or the other, never both. */
  rateMode: 'bitrate' | 'quality';
  bitrateMbps: number | null;
  quality: number | null;
  gpu: NonNullable<Video['gpu']>;

  hasAudio: boolean;
  audioCodec: Audio['codec'];
  /** null leaves it to MTS (48 kHz). */
  sampleRate: number | null;
  /** null keeps the source's layout. */
  channels: number | null;
  /** AAC only; null leaves it to MTS (128 kb/s). */
  bitrateKbps: number | null;
}

/**
 * A starting target for a kind — what a new profile of that kind usually is, so the first save is
 * a valid one and the administrator edits a difference rather than assembling a whole target.
 */
export function draftForKind(kind: ProfileInput['kind'], name = ''): ProfileDraft {
  const common = {
    name,
    description: '',
    kind,
    enabled: true,
    fit: 'pad',
    frameRate: '',
    gpu: 'none',
    channels: null,
  } as const;
  switch (kind) {
    case 'broadcast':
      return {
        ...common,
        container: 'mxf',
        hasVideo: true,
        codec: 'mpeg2',
        width: 1920,
        height: 1080,
        frameRate: '25',
        scan: 'tff',
        chroma: '422',
        rateMode: 'bitrate',
        bitrateMbps: 50,
        quality: null,
        hasAudio: true,
        audioCodec: 'pcm_s24le',
        sampleRate: 48000,
        bitrateKbps: null,
      };
    case 'thumbnail':
      return {
        ...common,
        container: 'jpg',
        hasVideo: true,
        codec: 'h264',
        width: 320,
        height: 180,
        scan: 'progressive',
        chroma: '420',
        rateMode: 'quality',
        bitrateMbps: null,
        quality: null,
        hasAudio: false,
        audioCodec: 'aac',
        sampleRate: null,
        bitrateKbps: null,
      };
    case 'proxy':
      return {
        ...common,
        container: 'mp4',
        hasVideo: true,
        codec: 'h264',
        width: 1280,
        height: 720,
        scan: 'progressive',
        chroma: '420',
        rateMode: 'quality',
        bitrateMbps: null,
        quality: 23,
        hasAudio: true,
        audioCodec: 'aac',
        sampleRate: null,
        bitrateKbps: 128,
      };
  }
}

/** A stored profile as the form's state. */
export function draftFrom(p: Profile | ProfileInput): ProfileDraft {
  const base = draftForKind(p.kind, p.name);
  const v = p.video;
  const a = p.audio;
  return {
    ...base,
    description: p.description ?? '',
    container: p.container,
    enabled: p.enabled,
    hasVideo: !!v,
    ...(v
      ? {
          codec: v.codec,
          width: v.width,
          height: v.height,
          fit: v.fit ?? 'pad',
          frameRate: v.frameRate ?? '',
          scan: v.scan ?? 'progressive',
          chroma: v.chroma ?? (v.codec === 'h264' ? '420' : '422'),
          rateMode: v.bitrateMbps !== undefined ? 'bitrate' : 'quality',
          bitrateMbps: v.bitrateMbps ?? null,
          quality: v.quality ?? null,
          gpu: v.gpu ?? 'none',
        }
      : {}),
    hasAudio: !!a,
    ...(a
      ? {
          audioCodec: a.codec,
          sampleRate: a.sampleRate ?? null,
          channels: a.channels ?? null,
          bitrateKbps: a.bitrateKbps ?? null,
        }
      : {}),
  };
}

/** Whether the container takes a single still, not a stream — rate, scan and GPU do not apply. */
export const isStill = (d: Pick<ProfileDraft, 'container'>): boolean => d.container === 'jpg';

/**
 * The body MTS is sent. Only what the form says: a field left at "the source's" / "MTS's default"
 * is omitted rather than sent as a guess, and the rate is the one the mode names.
 */
export function toInput(id: string, d: ProfileDraft): ProfileInput {
  const still = isStill(d);
  const num = (n: number | null): number | undefined => (n === null ? undefined : n);
  const video: Video | undefined = d.hasVideo
    ? {
        codec: d.codec,
        width: d.width ?? 0,
        height: d.height ?? 0,
        fit: d.fit,
        ...(!still && d.frameRate !== '' ? { frameRate: d.frameRate } : {}),
        ...(!still ? { scan: d.scan, chroma: d.chroma, gpu: d.gpu } : {}),
        ...(!still && d.rateMode === 'bitrate' && d.bitrateMbps !== null
          ? { bitrateMbps: d.bitrateMbps }
          : {}),
        ...(!still && d.rateMode === 'quality' && d.quality !== null ? { quality: d.quality } : {}),
      }
    : undefined;
  const sampleRate = num(d.sampleRate);
  const channels = num(d.channels);
  const bitrateKbps = d.audioCodec === 'aac' ? num(d.bitrateKbps) : undefined;
  const audio: Audio | undefined = d.hasAudio
    ? {
        codec: d.audioCodec,
        ...(sampleRate !== undefined ? { sampleRate } : {}),
        ...(channels !== undefined ? { channels } : {}),
        ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
      }
    : undefined;
  const description = d.description.trim();
  return {
    id,
    name: d.name.trim(),
    ...(description ? { description } : {}),
    kind: d.kind,
    container: d.container,
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    enabled: d.enabled,
  };
}

/** MTS's 422, placed: the messages about one field under it, the rest above the form. */
export interface Problems {
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly general: readonly string[];
}

export const NO_PROBLEMS: Problems = { fields: {}, general: [] };

/**
 * Split MTS's refusal into its rules and place each one.
 *
 * The service joins its reasons with `; ` and starts a rule about one field with that field's
 * path (`video.width must be…`, `name is required`). A rule about a COMBINATION (`mp4 carries
 * h264 video`) belongs to no single control and is shown above the form. Placement is a
 * convenience; the text is MTS's, unchanged — it is the authority.
 */
export function splitProblems(message: string): Problems {
  const fields: Record<string, string[]> = {};
  const general: string[] = [];
  for (const rule of message
    .split('; ')
    .map((r) => r.trim())
    .filter(Boolean)) {
    const path = /^((?:video|audio)\.[a-zA-Z]+|id|name|kind|container|enabled)\b/.exec(rule)?.[1];
    if (path) (fields[path] ??= []).push(rule);
    else general.push(rule);
  }
  return { fields, general };
}
