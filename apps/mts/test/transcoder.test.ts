// The FFmpeg adapter (EP-16.2) against the REAL binary, on media ffmpeg generates: every built-in
// preset produces a playable file, bytes that are not media are a refusal rather than a retry, a
// preset the input cannot satisfy is a refusal too, cancellation kills the process, and progress
// is reported in the unit FFmpeg actually uses.
//
// Skipped on a laptop without ffmpeg; FAILED in CI without it (the workflow installs it) — the
// same rule as RIM's probe test and the JetStream suite. A silent skip in CI is a passing suite
// that tested nothing.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BUILT_IN_PRESETS, ffmpegTranscoder, presetById, TranscodeRefusal } from '../src/index.ts';

const run = promisify(execFile);

async function haveFfmpeg(t: TestContext): Promise<boolean> {
  const ok = await ffmpegTranscoder().available();
  if (ok) return true;
  if (process.env['CI']) assert.fail('ffmpeg is required in CI: install it in the workflow');
  t.skip('ffmpeg not on the PATH');
  return false;
}

/** A 3-second 320×240 clip with a tone — small, fast, and a real container with both streams. */
async function clip(dir: string, name = 'clip.mp4', seconds = 3): Promise<string> {
  const path = join(dir, name);
  await run('ffmpeg', [
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x240:rate=25:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    path,
  ]);
  return path;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mts-ffmpeg-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('every built-in preset produces a non-empty output from a real clip, with progress in the right unit', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  await withDir(async (dir) => {
    const input = await clip(dir);
    const transcoder = ffmpegTranscoder();
    for (const preset of BUILT_IN_PRESETS) {
      const outputPath = join(dir, `out-${preset.id}.${preset.extension}`);
      const reports: number[] = [];
      const out = await transcoder.run(
        { inputPath: input, outputPath, args: preset.args, durationSec: 3 },
        { onProgress: (p) => reports.push(p) },
      );
      assert.ok(out.sizeBytes > 0, `${preset.id} wrote something`);
      assert.equal((await stat(outputPath)).size, out.sizeBytes);
      if (!preset.still) {
        // `out_time_ms` is MICROseconds despite its name; read as milliseconds this would be ~0.003.
        assert.ok(
          out.durationSec !== undefined && out.durationSec > 2 && out.durationSec < 4,
          `${preset.id} duration ${out.durationSec}`,
        );
        assert.ok(reports.length > 0, `${preset.id} reported progress`);
        assert.ok(reports.every((p) => p >= 0 && p <= 100));
      }
    }
  });
});

test('bytes that are not media are a REFUSAL — the job dead-letters rather than retrying them', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  await withDir(async (dir) => {
    const input = join(dir, 'not-media.mxf');
    await writeFile(input, 'this is a text file with a broadcast extension');
    await assert.rejects(
      ffmpegTranscoder().run({
        inputPath: input,
        outputPath: join(dir, 'out.mp4'),
        args: presetById('proxy')!.args,
      }),
      (err: unknown) => err instanceof TranscodeRefusal,
    );
  });
});

test('a video preset on an audio-only input is a refusal, not an empty success', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  await withDir(async (dir) => {
    const input = join(dir, 'tone.wav');
    await run('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      input,
    ]);
    // A thumbnail of audio: FFmpeg has no frame to write. Whether it says so by exit code or by
    // writing nothing, the adapter must call it the input's fault.
    await assert.rejects(
      ffmpegTranscoder().run({
        inputPath: input,
        outputPath: join(dir, 'thumb.jpg'),
        args: presetById('thumbnail')!.args,
      }),
      (err: unknown) => err instanceof TranscodeRefusal,
    );
    // And the audio preset on the same input works.
    const out = await ffmpegTranscoder().run({
      inputPath: input,
      outputPath: join(dir, 'tone.m4a'),
      args: presetById('audio-proxy')!.args,
    });
    assert.ok(out.sizeBytes > 0);
  });
});

test('the broadcast preset: MPEG-2 4:2:2 at 50 Mb/s, 1920×1080, PCM 24/48 in MXF — and what it refuses', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  await withDir(async (dir) => {
    const input = await clip(dir);
    const broadcast = presetById('broadcast')!;
    const outputPath = join(dir, 'air.mxf');
    await ffmpegTranscoder().run({ inputPath: input, outputPath, args: broadcast.args });
    // Read the file back with ffprobe: the claim is about the bytes, not the arguments.
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,pix_fmt,width,height,sample_rate,bits_per_raw_sample:format=format_name',
      '-of',
      'json',
      outputPath,
    ]);
    const probe = JSON.parse(stdout) as {
      streams: Record<string, string | number>[];
      format: { format_name: string };
    };
    assert.equal(probe.format.format_name, 'mxf');
    const video = probe.streams.find((s) => s['codec_name'] === 'mpeg2video');
    assert.ok(video, 'an MPEG-2 video track');
    assert.equal(video['pix_fmt'], 'yuv422p', '4:2:2, not 4:2:0');
    // 320×240 in, pillarboxed into 1920×1080 rather than stretched.
    assert.equal(video['width'], 1920);
    assert.equal(video['height'], 1080);
    const audio = probe.streams.find((s) => s['codec_name'] === 'pcm_s24le');
    assert.ok(audio, 'PCM 24-bit audio');
    assert.equal(audio['sample_rate'], '48000');

    // A frame rate no broadcast format uses is the INPUT's fault: refused, not retried.
    const odd = join(dir, 'odd.mp4');
    await run('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      odd,
    ]);
    await assert.rejects(
      ffmpegTranscoder().run({
        inputPath: odd,
        outputPath: join(dir, 'odd.mxf'),
        args: broadcast.args,
      }),
      (err: unknown) => err instanceof TranscodeRefusal,
    );
    // So is an input with no picture at all.
    const tone = join(dir, 'tone.wav');
    await run('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      tone,
    ]);
    await assert.rejects(
      ffmpegTranscoder().run({
        inputPath: tone,
        outputPath: join(dir, 'tone.mxf'),
        args: broadcast.args,
      }),
      (err: unknown) => err instanceof TranscodeRefusal,
    );
  });
});

test('cancellation kills the encoder, and the error is not a refusal (the job is requeued, not dead)', async (t) => {
  if (!(await haveFfmpeg(t))) return;
  await withDir(async (dir) => {
    // Long enough that it cannot finish before the abort lands.
    const input = await clip(dir, 'long.mp4', 30);
    const controller = new AbortController();
    const started = Date.now();
    const running = ffmpegTranscoder({ graceMs: 500 }).run(
      {
        inputPath: input,
        outputPath: join(dir, 'slow.mp4'),
        // Deliberately slow settings so the transcode outlives the abort on any machine.
        args: ['-c:v', 'libx264', '-preset', 'veryslow', '-vf', 'scale=1920:1080'],
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(running, (err: unknown) => {
      assert.ok(!(err instanceof TranscodeRefusal));
      assert.match((err as Error).message, /cancelled/);
      return true;
    });
    assert.ok(Date.now() - started < 10_000, 'the process died promptly');
  });
});

test('a missing binary is "not available" and a tool failure — never a refusal', async () => {
  const missing = ffmpegTranscoder({ binary: 'ffmpeg-that-is-not-installed' });
  assert.equal(await missing.available(), false);
  await assert.rejects(
    missing.run({ inputPath: 'x', outputPath: join(tmpdir(), 'never.mp4'), args: [] }),
    (err: unknown) => {
      assert.ok(!(err instanceof TranscodeRefusal), 'a machine fault must be retried');
      return true;
    },
  );
});
