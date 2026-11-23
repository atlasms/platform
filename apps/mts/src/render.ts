// The render (EP-26.6; media-editor.md §5.1): an edit decision list, flattened by FFmpeg into one
// new file. Pure — what a render command must say to be one MTS can carry out, and the FFmpeg
// arguments that carry it out. The service fetches the source, runs these and places the result.
//
// The shape, and why:
//  - ONE INPUT PER CLIP, seeked at the input (`-ss in -t (out−in) -i source`). On a re-encode an
//    input seek is frame-accurate, and FFmpeg decodes nothing before the in-point — a `trim` filter
//    on one shared input would decode from zero for every clip, so a cut near the end of a long
//    master would cost the whole master per clip.
//  - joined by the `concat` FILTER (not the demuxer, which cannot cut mid-GOP), and the output
//    profile's own `-vf` applied AFTER the join, so a profile's scale or pad means what it means on
//    any other transcode.
//  - audio carried only when the source HAS it: `concat` must be told each segment's stream count,
//    and asking a silent source for an audio stream is an error, not silence.

import { ClipFilterValues, TransitionValues } from '@atlas/contracts';
import type { RenderClip } from './job.ts';
import type { Preset } from './preset.ts';
import type { TranscodeInput } from './transcoder.ts';

/** The files of the source a clip may be cut from — media files, never a still or a filmstrip. */
export const RENDER_SOURCE_KINDS = ['original', 'broadcast', 'proxy'] as const;

/** The rendition kinds an output profile may produce — a render is new MEDIA, not a still. */
const RENDER_OUTPUT_KINDS: readonly string[] = ['proxy', 'broadcast'];

/** `kind` or `kind/variant`, the kind one of {@link RENDER_SOURCE_KINDS}. */
export function parseRenditionRef(ref: string): { kind: string; variant?: string } | undefined {
  const match = /^([a-z][a-z0-9-]*)(?:\/([A-Za-z0-9][A-Za-z0-9._-]*))?$/.exec(ref.trim());
  if (!match) return undefined;
  const kind = match[1]!;
  if (!(RENDER_SOURCE_KINDS as readonly string[]).includes(kind)) return undefined;
  return match[2] !== undefined ? { kind, variant: match[2] } : { kind };
}

/** A clip as a command carries it — the same shape as a job's. */
export type ClipIn = RenderClip;

/** A transition's overlap when none is given, and its bounds (media-editor.md §5.3). */
export const DEFAULT_TRANSITION_SEC = 0.5;
const MIN_TRANSITION_SEC = 0.04;
const MAX_TRANSITION_SEC = 5;

/**
 * Each Tier-0 transition as FFmpeg draws it (media-editor.md §5.3): the `xfade` transition for the
 * picture; the sound always crossfades (`acrossfade`). A wipe has no meaning for audio.
 */
export const TRANSITION_XFADE: Readonly<Record<string, string>> = {
  dissolve: 'dissolve',
  'fade-black': 'fadeblack',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
};
const AUDIO_TRANSITIONS: readonly string[] = ['dissolve', 'fade-black'];

/** Each Tier-0 filter as a FIXED FFmpeg filter — on the picture, or (`mute`) on the sound. */
export const FILTER_GRAPH: Readonly<Record<string, { video?: string; audio?: string }>> = {
  grayscale: { video: 'hue=s=0' },
  sepia: { video: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131' },
  brighten: { video: 'eq=brightness=0.08' },
  darken: { video: 'eq=brightness=-0.08' },
  contrast: { video: 'eq=contrast=1.2' },
  blur: { video: 'gblur=sigma=4' },
  sharpen: { video: 'unsharp=5:5:1.0' },
  mute: { audio: 'volume=0' },
};

/** The overlap a clip's transition takes; 0 for a cut. */
const overlapOf = (c: RenderClip): number =>
  c.transitionIn === undefined ? 0 : (c.transitionSec ?? DEFAULT_TRANSITION_SEC);

/**
 * What a command's transitions and filters cannot be (media-editor.md §5.3) — MAM's rule, applied
 * again here so a render can never run one: names from the Tier-0 sets only, no transition on the
 * first clip, an overlap shorter than both clips it joins, and only sound on an audio timeline.
 */
function effectsRefusal(mediaKind: string, clips: readonly ClipIn[]): string | undefined {
  for (const [i, clip] of clips.entries()) {
    if (clip.transitionIn !== undefined) {
      if (!(TransitionValues as readonly string[]).includes(clip.transitionIn)) {
        return `clip ${i}: ${clip.transitionIn} is not a transition (${TransitionValues.join(', ')})`;
      }
      if (i === 0) return 'clip 0: the first clip has nothing to transition from';
      const d = overlapOf(clip);
      if (d < MIN_TRANSITION_SEC || d > MAX_TRANSITION_SEC) {
        return `clip ${i}: a transition lasts ${MIN_TRANSITION_SEC}–${MAX_TRANSITION_SEC} s`;
      }
      const before = clips[i - 1]!;
      if (d >= clip.outSec - clip.inSec || d >= before.outSec - before.inSec) {
        return `clip ${i}: a ${d} s transition must be shorter than both clips it joins`;
      }
      if (mediaKind === 'audio' && !AUDIO_TRANSITIONS.includes(clip.transitionIn)) {
        return `clip ${i}: ${clip.transitionIn} has no meaning for audio`;
      }
    } else if (clip.transitionSec !== undefined) {
      return `clip ${i}: transitionSec is only for a clip with a transition`;
    }
    const filters = clip.filters ?? [];
    const unknown = filters.find((f) => !(ClipFilterValues as readonly string[]).includes(f));
    if (unknown !== undefined) {
      return `clip ${i}: ${unknown} is not a filter (${ClipFilterValues.join(', ')})`;
    }
    if (new Set(filters).size !== filters.length) return `clip ${i}: a filter named twice`;
    if (mediaKind === 'audio' && filters.some((f) => FILTER_GRAPH[f]!.audio === undefined)) {
      return `clip ${i}: a picture filter on an audio timeline`;
    }
  }
  return undefined;
}

/**
 * Why this render cannot be carried out, or undefined. Everything here is a property of the
 * COMMAND — the same command refused the same way every time — so MTS answers it `COMMAND_REFUSED`
 * at once rather than queueing a job that fails a minute later.
 */
export function renderRefusal(
  command: { mediaKind: string; clips: readonly ClipIn[] },
  preset: Pick<Preset, 'id' | 'kind' | 'requires' | 'still' | 'filmstrip'> | undefined,
  outputProfile: string,
): string | undefined {
  if (command.mediaKind !== 'video' && command.mediaKind !== 'audio') {
    return `a ${command.mediaKind} render is not supported in v1 — video and audio only`;
  }
  if (command.clips.length === 0) return 'the timeline has no clips';
  const refs = new Set(command.clips.map((c) => c.renditionRef.trim()));
  if (refs.size > 1) {
    return `every clip of a v1 render must draw from the same file — got ${[...refs].join(', ')}`;
  }
  const [ref] = refs;
  if (parseRenditionRef(ref!) === undefined) {
    return `renditionRef ${ref} is not a file a render can cut from (${RENDER_SOURCE_KINDS.join(', ')}, optionally kind/variant)`;
  }
  for (const [i, clip] of command.clips.entries()) {
    if (!(clip.outSec > clip.inSec)) return `clip ${i}: outSec must be after inSec`;
  }
  const effects = effectsRefusal(command.mediaKind, command.clips);
  if (effects) return effects;
  if (!preset) return `unknown output profile ${outputProfile}`;
  if (preset.still || preset.filmstrip || !RENDER_OUTPUT_KINDS.includes(preset.kind)) {
    return `output profile ${preset.id} makes a ${preset.kind}, not media a render can become`;
  }
  if (preset.requires !== command.mediaKind) {
    return `output profile ${preset.id} needs ${preset.requires}, and this is a ${command.mediaKind} render`;
  }
  return undefined;
}

/**
 * The whole timeline's length — what turns the encoder's `out_time` into a percentage. A transition
 * overlaps two clips, so each one shortens the timeline by its overlap.
 */
export function timelineSec(clips: readonly RenderClip[]): number {
  return clips.reduce((sum, c) => sum + (c.outSec - c.inSec) - overlapOf(c), 0);
}

/** Seconds as a graph option: fixed to the microsecond, never exponent notation. */
const sec = (v: number): string => String(Number(v.toFixed(6)));

/**
 * The inputs and the arguments between them and the output: the clips joined, then the profile's
 * encoder arguments with its `-vf` folded into the graph after the join.
 */
export function renderArgs(
  clips: readonly RenderClip[],
  sourcePath: string,
  presetArgs: readonly string[],
  options: { mediaKind: 'video' | 'audio'; sourceHasAudio: boolean },
): { inputs: TranscodeInput[]; args: string[] } {
  const inputs: TranscodeInput[] = clips.map((c) => ({
    path: sourcePath,
    seekSec: c.inSec,
    durationSec: c.outSec - c.inSec,
  }));

  // The profile's video filter, lifted out: `-vf` cannot be combined with `-filter_complex` for
  // the same output, so it becomes the graph's last step.
  const rest: string[] = [];
  let vf: string | undefined;
  for (let i = 0; i < presetArgs.length; i++) {
    if (presetArgs[i] === '-vf') {
      vf = presetArgs[i + 1];
      i++;
    } else {
      rest.push(presetArgs[i]!);
    }
  }

  const video = options.mediaKind === 'video';
  // A profile that drops the audio (`-an`) says so; a source without any cannot supply it.
  const audio = options.sourceHasAudio && !rest.includes('-an');
  const n = clips.length;
  const steps: string[] = [];

  // Each clip's own streams: its filters (EP-26.5) applied first, or the input's stream as it is.
  const prepared = (i: number, kind: 'v' | 'a'): string => {
    const graphs = (clips[i]!.filters ?? [])
      .map((f) => FILTER_GRAPH[f]?.[kind === 'v' ? 'video' : 'audio'])
      .filter((g): g is string => g !== undefined);
    if (graphs.length === 0) return `[${i}:${kind}:0]`;
    steps.push(`[${i}:${kind}:0]${graphs.join(',')}[${kind}f${i}]`);
    return `[${kind}f${i}]`;
  };
  const v = video ? clips.map((_, i) => prepared(i, 'v')) : [];
  const a = audio ? clips.map((_, i) => prepared(i, 'a')) : [];

  if (clips.every((c) => c.transitionIn === undefined)) {
    // Cuts only: one n-way concat, as before EP-26.5.
    const segments = clips.map((_, i) => `${v[i] ?? ''}${a[i] ?? ''}`).join('');
    const outs = `${video ? '[cv]' : ''}${audio ? '[ca]' : ''}`;
    steps.push(`${segments}concat=n=${n}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}${outs}`);
  } else {
    // A transition overlaps two clips, so the timeline is joined PAIRWISE, left to right: an
    // `xfade` (picture) or `acrossfade` (sound) where a clip has a transition, a two-way concat
    // where it is a cut. xfade's offset is where the overlap starts on the joined-so-far timeline:
    // its length so far less the overlap.
    let accV = v[0];
    let accA = a[0];
    let length = clips[0]!.outSec - clips[0]!.inSec;
    for (let i = 1; i < n; i++) {
      const clip = clips[i]!;
      const d = overlapOf(clip);
      const last = i === n - 1;
      const outV = last ? '[cv]' : `[vx${i}]`;
      const outA = last ? '[ca]' : `[ax${i}]`;
      if (video) {
        steps.push(
          clip.transitionIn === undefined
            ? `${accV}${v[i]}concat=n=2:v=1:a=0${outV}`
            : `${accV}${v[i]}xfade=transition=${TRANSITION_XFADE[clip.transitionIn]}:duration=${sec(d)}:offset=${sec(length - d)}${outV}`,
        );
        accV = outV;
      }
      if (audio) {
        steps.push(
          clip.transitionIn === undefined
            ? `${accA}${a[i]}concat=n=2:v=0:a=1${outA}`
            : `${accA}${a[i]}acrossfade=d=${sec(d)}${outA}`,
        );
        accA = outA;
      }
      length += clip.outSec - clip.inSec - d;
    }
    if (n === 1) {
      // Unreachable — the first clip takes no transition — but a graph must always end labelled.
      if (video) steps.push(`${accV}null[cv]`);
      if (audio) steps.push(`${accA}anull[ca]`);
    }
  }
  if (video && vf !== undefined) steps.push(`[cv]${vf}[v]`);
  const graph = steps.join(';');

  const maps = [
    ...(video ? ['-map', vf !== undefined ? '[v]' : '[cv]'] : []),
    ...(audio ? ['-map', '[ca]'] : []),
  ];
  return { inputs, args: ['-filter_complex', graph, ...maps, ...rest] };
}
