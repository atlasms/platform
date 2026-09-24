// The built-in transcode profiles (EP-16.3, Tier-1) — what a preset IS, and the four that ship.
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
  kind: 'proxy' | 'thumbnail' | 'broadcast';
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
  {
    // The rendition that goes to air (EP-16.3). XDCAM HD422-class: MPEG-2 4:2:2 long-GOP at a
    // constant 50 Mb/s, 1920×1080, PCM 24-bit at 48 kHz, in MXF OP1a — the format playout servers
    // ingest natively, and one FFmpeg writes without a licensed codec, which matters for an
    // air-gapped install that cannot fetch one.
    //
    // What it does NOT do, on purpose:
    //  - conform the frame rate. MXF refuses a rate no broadcast format uses (15 fps), and that is
    //    a refusal of the INPUT; converting it to the channel's house rate is an editorial choice
    //    per channel, which is the profile registry's (16.6), not a built-in's.
    //  - interlace. The output is progressive; a channel airing 1080i sets that in its profile.
    //  - claim a specific XDCAM flavour (no `-vtag`): the fourcc names a frame rate and scan
    //    type, and stamping 1080i50's on a 1080p25 file would be a lie a playout server believes.
    // A smaller picture is letterboxed or pillarboxed into 1920×1080, never stretched.
    id: 'broadcast',
    kind: 'broadcast',
    requires: 'video',
    extension: 'mxf',
    args: [
      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v',
      'mpeg2video',
      '-pix_fmt',
      'yuv422p',
      // Constant bit rate, as a playout server's decoder budget assumes: min = max = target, with
      // the VBV buffer XDCAM HD422 declares.
      '-b:v',
      '50M',
      '-minrate',
      '50M',
      '-maxrate',
      '50M',
      '-bufsize',
      '36408333',
      '-g',
      '12',
      '-bf',
      '2',
      '-dc',
      '10',
      '-intra_vlc',
      '1',
      '-non_linear_quant',
      '1',
      '-qmin',
      '1',
      '-qmax',
      '12',
      '-c:a',
      'pcm_s24le',
      '-ar',
      '48000',
      '-f',
      'mxf',
    ],
  },
];

export function presetById(id: string): Preset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}

/** The ids that do not exist, in the order asked for — the message an enqueue is refused with. */
export function unknownPresets(ids: readonly string[]): string[] {
  return ids.filter((id) => presetById(id) === undefined);
}
