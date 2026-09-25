// The profile grammar (EP-16.6): what a profile may say, what FFmpeg arguments it becomes, and —
// on the real binary — that what it says is what the file is. A profile is structured, never raw
// arguments, so the security property is simply that no string it carries reaches the command
// line; the validation below is what keeps a combination FFmpeg would refuse off the admin page.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  compileProfile,
  ffmpegTranscoder,
  gpuEncoderFor,
  profileErrors,
  type ProfileInput,
  type TranscodeProfile,
} from '../src/index.ts';

const run = promisify(execFile);

const profile = (over: Partial<ProfileInput> = {}): TranscodeProfile =>
  ({
    id: 'house-broadcast',
    name: 'House broadcast',
    kind: 'broadcast',
    container: 'mxf',
    video: { codec: 'mpeg2', width: 1920, height: 1080, bitrateMbps: 50, chroma: '422' },
    audio: { codec: 'pcm_s24le', sampleRate: 48000 },
    enabled: true,
    version: 1,
    createdBy: 'admin',
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    ...over,
  }) as TranscodeProfile;

test('a sound profile has no errors; each rule names what is wrong', () => {
  assert.deepEqual(profileErrors(profile()), []);
  // Loose on purpose: some cases CLEAR a field (`undefined`), which the input type does not allow.
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ id: 'Bad Id' }, /kebab-case/],
    [{ kind: 'hover-preview' as never }, /kind must be one of/],
    [{ container: 'avi' as never }, /container must be one of/],
    [{ video: undefined, audio: undefined }, /video target, an audio target/],
    [
      { video: { codec: 'mpeg2', width: 1921, height: 1080, bitrateMbps: 50 } },
      /width must be an even/,
    ],
    [
      {
        video: {
          codec: 'mpeg2',
          width: 1920,
          height: 1080,
          bitrateMbps: 50,
          frameRate: '15' as never,
        },
      },
      /frameRate must be one of/,
    ],
    [{ video: { codec: 'mpeg2', width: 1920, height: 1080 } }, /mpeg2 needs bitrateMbps/],
    [
      { video: { codec: 'mpeg2', width: 1920, height: 1080, bitrateMbps: 50, quality: 5 } },
      /not both/,
    ],
    // The container decides the codecs.
    [{ container: 'mp4' }, /mp4 carries h264/],
    [{ audio: { codec: 'aac' } }, /mxf carries pcm audio/],
    [{ audio: { codec: 'pcm_s24le', sampleRate: 44100 } }, /mxf audio is 48 kHz/],
    // What the encoders can do.
    [
      {
        container: 'mp4',
        video: { codec: 'mpeg2', width: 1920, height: 1080, bitrateMbps: 50, gpu: 'nvenc' },
        audio: { codec: 'aac' },
      },
      /gpu applies to h264 only/,
    ],
    [
      {
        kind: 'proxy',
        container: 'mp4',
        video: { codec: 'h264', width: 1280, height: 720, chroma: '422', gpu: 'nvenc' },
        audio: { codec: 'aac' },
      },
      /cannot encode 4:2:2/,
    ],
    [
      { container: 'mov', video: { codec: 'prores', width: 1920, height: 1080, chroma: '420' } },
      /prores is 4:2:2/,
    ],
    [{ kind: 'thumbnail', container: 'mp4', audio: undefined }, /a thumbnail is a jpg/],
    [
      {
        kind: 'proxy',
        container: 'm4a',
        video: { codec: 'h264', width: 16, height: 16 },
        audio: { codec: 'aac' },
      },
      /m4a is audio only/,
    ],
  ];
  for (const [over, pattern] of cases) {
    const errors = profileErrors(profile(over as Partial<ProfileInput>));
    assert.ok(
      errors.some((e) => pattern.test(e)),
      `${JSON.stringify(over)} → ${JSON.stringify(errors)}`,
    );
  }
});

test('compiling: a broadcast profile conforms the rate and interlaces — arguments from the allowlist only', () => {
  const compiled = compileProfile(
    profile({
      video: {
        codec: 'mpeg2',
        width: 1920,
        height: 1080,
        bitrateMbps: 50,
        chroma: '422',
        frameRate: '25',
        scan: 'tff',
      },
    }),
  );
  assert.equal(compiled.extension, 'mxf');
  assert.equal(compiled.kind, 'broadcast');
  assert.equal(compiled.encoder, 'mpeg2video');
  const args = compiled.args.join(' ');
  assert.match(
    args,
    /-vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:.*,setsar=1,fps=25,setfield=tff/,
  );
  assert.match(args, /-c:v mpeg2video -pix_fmt yuv422p/);
  assert.match(args, /-b:v 50M -minrate 50M -maxrate 50M/);
  assert.match(args, /-flags \+ildct\+ilme -top 1/);
  assert.match(args, /-c:a pcm_s24le -ar 48000/);
  assert.match(args, /-f mxf$/);
  // The id is data, never an argument: nothing a profile names appears on the command line.
  assert.ok(!compiled.args.includes('house-broadcast'));
  assert.ok(!compiled.args.includes('-i'));
});

test('GPU: asked for and usable → the GPU encoder; asked for and not usable → the CPU, and it says so', () => {
  const nvenc = profile({
    id: 'fast-proxy',
    kind: 'proxy',
    container: 'mp4',
    video: { codec: 'h264', width: 1280, height: 720, quality: 26, gpu: 'nvenc' },
    audio: { codec: 'aac', bitrateKbps: 96 },
  });
  assert.equal(gpuEncoderFor(nvenc), 'h264_nvenc');
  const onGpu = compileProfile(nvenc, true);
  assert.equal(onGpu.encoder, 'h264_nvenc');
  assert.equal(onGpu.fallback, false);
  assert.match(onGpu.args.join(' '), /-c:v h264_nvenc -pix_fmt yuv420p -cq 26/);
  const onCpu = compileProfile(nvenc, false);
  assert.equal(onCpu.encoder, 'libx264');
  assert.equal(onCpu.fallback, true);
  assert.match(onCpu.args.join(' '), /-c:v libx264 -preset medium -pix_fmt yuv420p -crf 26/);
  assert.equal(gpuEncoderFor(profile()), undefined, 'mpeg2 has no GPU choice');
});

async function haveFfmpeg(t: TestContext): Promise<boolean> {
  if (await ffmpegTranscoder().available()) return true;
  if (process.env['CI']) assert.fail('ffmpeg is required in CI: install it in the workflow');
  t.skip('ffmpeg not on the PATH');
  return false;
}

async function probe(path: string) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,pix_fmt,width,height,r_frame_rate,field_order,profile:format=format_name',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(stdout) as {
    streams: Record<string, string | number>[];
    format: { format_name: string };
  };
}

test('on the real binary: a 15 fps source conformed to 25i MXF, a ProRes HQ MOV, and a GPU profile on a node without one', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  const dir = await mkdtemp(join(tmpdir(), 'mts-profile-'));
  try {
    // 15 fps — the rate the built-in broadcast preset REFUSES (16.3). A profile that conforms to
    // the house rate is exactly the per-channel decision 16.3 left to this registry.
    const odd = join(dir, 'odd.mp4');
    await run('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      odd,
    ]);
    const transcoder = ffmpegTranscoder();

    const house = compileProfile(
      profile({
        video: {
          codec: 'mpeg2',
          width: 1920,
          height: 1080,
          bitrateMbps: 50,
          chroma: '422',
          frameRate: '25',
          scan: 'tff',
        },
      }),
    );
    const mxf = join(dir, 'house.mxf');
    await transcoder.run({ inputPath: odd, outputPath: mxf, args: house.args });
    const m = await probe(mxf);
    const mv = m.streams.find((s) => s['codec_name'] === 'mpeg2video')!;
    assert.equal(m.format.format_name, 'mxf');
    assert.equal(mv['r_frame_rate'], '25/1', 'conformed from 15');
    assert.equal(mv['field_order'], 'tt', 'top field first');
    assert.equal(mv['pix_fmt'], 'yuv422p');

    const prores = compileProfile(
      profile({
        id: 'mezzanine',
        container: 'mov',
        video: { codec: 'prores', width: 1280, height: 720 },
        audio: { codec: 'pcm_s24le' },
      }),
    );
    const mov = join(dir, 'mezz.mov');
    await transcoder.run({ inputPath: odd, outputPath: mov, args: prores.args });
    const p = await probe(mov);
    const pv = p.streams.find((s) => s['codec_name'] === 'prores')!;
    assert.ok(pv, 'a ProRes track');
    assert.equal(pv['pix_fmt'], 'yuv422p10le');
    assert.equal(pv['width'], 1280);

    // A GPU profile on this node: whatever the build lists, the one-frame test decides.
    const gpu = profile({
      id: 'fast-proxy',
      kind: 'proxy',
      container: 'mp4',
      video: { codec: 'h264', width: 640, height: 360, gpu: 'nvenc' },
      audio: { codec: 'aac' },
    });
    const usable = await transcoder.encoderUsable('h264_nvenc');
    const compiled = compileProfile(gpu, usable);
    assert.equal(compiled.fallback, !usable);
    const mp4 = join(dir, 'fast.mp4');
    await transcoder.run({ inputPath: odd, outputPath: mp4, args: compiled.args });
    const g = await probe(mp4);
    assert.ok(g.streams.some((s) => s['codec_name'] === 'h264'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
