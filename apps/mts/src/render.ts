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

/** The clip fields a v1 render cannot honour yet: transitions and filters are EP-26.5's. */
export interface ClipIn extends RenderClip {
  transitionIn?: string;
  filters?: string[];
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
    if (clip.transitionIn !== undefined || (clip.filters?.length ?? 0) > 0) {
      return `clip ${i}: transitions and filters are not rendered before EP-26.5`;
    }
  }
  if (!preset) return `unknown output profile ${outputProfile}`;
  if (preset.still || preset.filmstrip || !RENDER_OUTPUT_KINDS.includes(preset.kind)) {
    return `output profile ${preset.id} makes a ${preset.kind}, not media a render can become`;
  }
  if (preset.requires !== command.mediaKind) {
    return `output profile ${preset.id} needs ${preset.requires}, and this is a ${command.mediaKind} render`;
  }
  return undefined;
}

/** The whole timeline's length — what turns the encoder's `out_time` into a percentage. */
export function timelineSec(clips: readonly RenderClip[]): number {
  return clips.reduce((sum, c) => sum + (c.outSec - c.inSec), 0);
}

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
  const segments = clips
    .map((_, i) => `${video ? `[${i}:v:0]` : ''}${audio ? `[${i}:a:0]` : ''}`)
    .join('');
  const outs = `${video ? '[cv]' : ''}${audio ? '[ca]' : ''}`;
  const graph = [
    `${segments}concat=n=${n}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}${outs}`,
    ...(video && vf !== undefined ? [`[cv]${vf}[v]`] : []),
  ].join(';');

  const maps = [
    ...(video ? ['-map', vf !== undefined ? '[v]' : '[cv]'] : []),
    ...(audio ? ['-map', '[ca]'] : []),
  ];
  return { inputs, args: ['-filter_complex', graph, ...maps, ...rest] };
}
