// Media the cluster tests write themselves — no tools, no fixtures checked in.

/**
 * A real video file with no tools: `seconds` of 160×120 4:2:0 at 25 fps in YUV4MPEG2 — a text
 * header, then each frame as `FRAME\n` and its planes. ffprobe reads it as rawvideo with a
 * duration, so RIM calls it video, and FFmpeg makes all three renditions from it. The luma ramps
 * frame by frame so the thumbnail filter has something to choose between.
 */
export function y4m(seconds) {
  const [w, h, fps] = [160, 120, 25];
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < fps * seconds; i++) {
    parts.push(Buffer.from('FRAME\n'), Buffer.alloc(w * h, 16 + ((i * 4) % 200)));
    parts.push(Buffer.alloc((w / 2) * (h / 2) * 2, 128));
  }
  return Buffer.concat(parts);
}
