// The built-in transcode profiles (EP-16.3, Tier-1) — what a preset IS, and the three that ship.
//
// A preset is a rendition kind, the encoder arguments that produce it, and what the input must
// carry for those arguments to mean anything. Asking for a thumbnail of an audio file is a request
// that was never coherent: FFmpeg writes no frame, the adapter classifies that as a refusal of
// the INPUT, and the job is dead-lettered rather than retried (transcoder.test.ts proves it on the
// real binary). `requires` states the precondition; checking it before spawning needs a probe of
// the input, which is HSM's metadata once HSM exists (EP-14), not a second ffprobe here.
//
// The arguments are deliberately modest and CPU-only. mts.md's performance targets are a GPU
// worker's, and NVENC/QSV/VAAPI selection belongs with the profile registry (16.6) — a built-in
// set that assumed a GPU would fail on every machine that has none, including CI.

export type PresetRequires = 'video' | 'audio';

export interface Preset {
  id: string;
  /** The rendition kind this produces — `common.schema.json#/$defs/RenditionKind`. */
  kind: 'proxy' | 'thumbnail';
  /** What the input must have. A request for a preset the input cannot satisfy is refused. */
  requires: PresetRequires;
  /** The output file's extension, which also decides the container. */
  extension: string;
  /** Whether the output is a still. A still has no duration, and its progress is one step. */
  still?: boolean;
  /** The encoder arguments between the input and the output path. */
  args: readonly string[];
}

/**
 * The shipped set. Ids are stable: they travel in `transcode.job.create` from BMS/RIM, and a
 * renamed preset id is a broken command, not a cosmetic change.
 */
export const BUILT_IN_PRESETS: readonly Preset[] = [
  {
    id: 'proxy',
    kind: 'proxy',
    requires: 'video',
    extension: 'mp4',
    args: [
      // 720p at most, keeping the aspect ratio, and an even height — H.264 requires even
      // dimensions and a 1080p source scaled by a non-integer factor lands on an odd one.
      '-vf',
      'scale=-2:min(720\\,ih)',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      // The index at the FRONT: a proxy is scrubbed in a browser, and a player that has to read
      // the whole file before it can seek is a proxy that feels broken.
      '-movflags',
      '+faststart',
    ],
  },
  {
    id: 'thumbnail',
    kind: 'thumbnail',
    requires: 'video',
    extension: 'jpg',
    still: true,
    args: [
      // ffmpeg's own shot-selection over the first frames rather than "frame at 0", which on a
      // broadcast master is reliably a black slate.
      '-vf',
      'thumbnail,scale=-2:360',
      '-frames:v',
      '1',
    ],
  },
  {
    id: 'audio-proxy',
    kind: 'proxy',
    requires: 'audio',
    extension: 'm4a',
    args: ['-vn', '-c:a', 'aac', '-b:a', '128k'],
  },
];

export function presetById(id: string): Preset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}

/** The ids that do not exist, in the order asked for — the message an enqueue is refused with. */
export function unknownPresets(ids: readonly string[]): string[] {
  return ids.filter((id) => presetById(id) === undefined);
}
