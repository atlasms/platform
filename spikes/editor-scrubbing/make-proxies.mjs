#!/usr/bin/env node
// EP-26.1 spike — generate H.264/MP4 editing-proxy candidates at a range of GOP lengths.
//
//   node spikes/editor-scrubbing/make-proxies.mjs
//
// Each proxy carries the SAME content (ffmpeg `testsrc2`, which changes every frame) with the
// exact frame number burned in by `drawtext=%{n}`, so a human can see which frame is on screen and
// the harness can trust what it measures. The only variable between files is the keyframe interval
// (`-g`, with scenecut disabled so the GOP is actually fixed). That is the one number the spike is
// here to set, so it is the one thing we vary.
//
// Output (git-ignored) lands in spikes/editor-scrubbing/out/. Override with FPS / DURATION / GOPS.
//
// drawtext needs a FONT FILE, and a Windows path's drive-colon cannot survive the filtergraph
// parser however it is escaped. So we copy a TTF into the output dir and reference it by a bare
// relative name with ffmpeg's cwd set there — no colon, no fontconfig. If no font is found we fall
// back to plain `testsrc`, whose built-in burned-in timestamp is ground truth enough.

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

const FPS = Number(process.env.FPS ?? 25); // broadcast PAL cadence; this is a TV/radio platform
const DURATION = Number(process.env.DURATION ?? 20); // seconds → FPS*DURATION frames to seek within
const GOPS = (process.env.GOPS ?? '1,5,12,30,60,250').split(',').map((g) => Number(g.trim()));
const SIZE = process.env.SIZE ?? '1280x720'; // a 720p proxy, typical for an editing proxy

// Copy a system font into OUT and return its bare name, or null if none is found.
function installFont() {
  const candidates = process.env.FONTFILE
    ? [process.env.FONTFILE]
    : process.platform === 'win32'
      ? [
          'C:/Windows/Fonts/arial.ttf',
          'C:/Windows/Fonts/consola.ttf',
          'C:/Windows/Fonts/segoeui.ttf',
        ]
      : [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          '/System/Library/Fonts/Supplemental/Arial.ttf',
        ];
  for (const src of candidates) {
    if (existsSync(src)) {
      copyFileSync(src, join(OUT, 'font.ttf'));
      return 'font.ttf';
    }
  }
  return null;
}

function run(args) {
  try {
    // cwd = OUT so the relative font name and output files carry no drive-colon.
    execFileSync('ffmpeg', args, { cwd: OUT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    process.stderr.write(Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err));
    throw err;
  }
}

mkdirSync(OUT, { recursive: true });
const font = installFont();
const frames = FPS * DURATION;
// testsrc2 content differs every frame; drawtext burns the frame number when a font is available,
// otherwise testsrc's own timestamp is the on-screen ground truth.
const source = font
  ? `testsrc2=size=${SIZE}:rate=${FPS}:duration=${DURATION}`
  : `testsrc=size=${SIZE}:rate=${FPS}:duration=${DURATION}`;
const vf = font
  ? `drawtext=fontfile=${font}:text=%{n}:x=24:y=24:fontsize=120:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=12`
  : null;

console.log(`Editing-proxy candidates — ${SIZE} @ ${FPS}fps, ${DURATION}s (${frames} frames)`);
console.log(
  `Ground truth: ${font ? 'drawtext frame number' : 'testsrc timestamp (no font found)'}`,
);
console.log(`GOP lengths: ${GOPS.join(', ')}\n`);

for (const gop of GOPS) {
  const file = `proxy-g${gop}.mp4`;
  console.log(`  g${gop} → out/${file}`);
  run([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    ...(vf ? ['-vf', vf] : []),
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '4M',
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-x264-params',
    'scenecut=0:open_gop=0',
    '-an',
    '-movflags',
    '+faststart', // moov atom up front: the browser can start seeking before the whole file loads
    file,
  ]);
}

console.log(`\nDone. ${GOPS.length} proxies in ${OUT}`);
console.log('Serve the harness:  node spikes/editor-scrubbing/serve.mjs');
