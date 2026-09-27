// The capture, on the real FFmpeg (EP-39; ADR-0007). ADR-0007's evidence was measured with a
// segment muxer; the worker uses a plain one. So the claims the design rests on are checked here,
// on exactly `captureArgs`, against a live UDP feed FFmpeg generates:
//   - a capture bounded to its window ends by itself (exit 0) with a readable file;
//   - KILLED hard mid-capture it still leaves a readable file of what it received — the crash
//     case decision 3 keeps, and the one the draft ADR found empty without packet flushing.
//     Written, this test found a SECOND way to lose it: FFmpeg opens the output only when it has
//     finished probing a live input — 5 s by default — so a crash 3.5 s in left no file at all.
//     `captureArgs` probes for 1 s.
// Skipped without ffmpeg/ffprobe on a laptop; FAILED without them in CI, which installs them.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { captureArgs, ffmpegCapturer } from '../src/index.ts';

const hasTools = () =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function needTools(t: TestContext): boolean {
  if (hasTools()) return true;
  if (process.env['CI'])
    assert.fail('ffmpeg/ffprobe are required in CI: install them in the workflow');
  t.skip('ffmpeg not on the PATH');
  return false;
}

/** A live feed: a test pattern, in real time, GOP 1 s, as MPEG-TS to a UDP port. */
function feed(port: number, seconds: number) {
  return spawn(
    'ffmpeg',
    [
      ...['-nostdin', '-loglevel', 'error', '-re'],
      ...['-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${seconds}`],
      ...[
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '25',
        '-keyint_min',
        '25',
        '-sc_threshold',
        '0',
      ],
      ...['-f', 'mpegts', `udp://127.0.0.1:${port}?pkt_size=1316`],
    ],
    { stdio: 'ignore' },
  );
}

const input = (port: number) => `udp://127.0.0.1:${port}?fifo_size=1000000&overrun_nonfatal=1`;

function probe(file: string): { duration: number; frames: number } {
  const out = execFileSync(
    'ffprobe',
    [
      ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
      ...['-show_entries', 'stream=nb_read_frames:format=duration', '-of', 'json', file],
    ],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(out);
  return {
    duration: Number(j.format?.duration),
    frames: Number(j.streams?.[0]?.nb_read_frames ?? 0),
  };
}

test('the arguments are the ADR: short probing, stream copy, MPEG-TS, packets flushed, bounded to the window', () => {
  assert.deepEqual(
    captureArgs({ url: 'udp://239.1.1.1:5000', file: '/w/c.ts', durationMs: 3_605_000 }),
    [
      ...['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'],
      // Without it FFmpeg writes nothing until 5 s of probing end — the next test's crash found it.
      ...['-analyzeduration', '1000000', '-probesize', '1000000'],
      ...['-i', 'udp://239.1.1.1:5000'],
      ...['-t', '3605.000'],
      ...['-c', 'copy', '-map', '0', '-flush_packets', '1'],
      ...['-f', 'mpegts', '/w/c.ts'],
    ],
  );
});

test('a capture bounded to its window ends by itself, and its file is readable', async (t) => {
  if (!needTools(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'rim-capture-'));
  const port = 14000 + Math.floor(Math.random() * 1000);
  const source = feed(port, 12);
  try {
    await sleep(500);
    const file = join(dir, 'c.ts');
    const result = await ffmpegCapturer().run({ url: input(port), file, durationMs: 4_000 });
    assert.equal(result.exitCode, 0, result.stderrTail);
    const { duration, frames } = probe(file);
    // A new reader waits up to a GOP (1 s) for its first keyframe; the rest is the window.
    assert.ok(duration > 2.5 && duration < 4.5, `duration ${duration}`);
    assert.ok(frames > 60, `frames ${frames}`);
  } finally {
    source.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('KILLED mid-capture, the file holds what was received — readable, not empty', async (t) => {
  if (!needTools(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'rim-capture-'));
  const port = 15000 + Math.floor(Math.random() * 1000);
  const source = feed(port, 12);
  try {
    await sleep(500);
    const file = join(dir, 'crash.ts');
    const child = spawn('ffmpeg', captureArgs({ url: input(port), file, durationMs: 60_000 }), {
      stdio: 'ignore',
    });
    // Kill it once it has WRITTEN — not at a fixed moment: under load FFmpeg starts later, and a
    // wall-clock threshold made this test flaky (1.44 s recorded against a 1.5 s floor). That
    // FFmpeg starts writing within a second of probing is the arguments test's to hold.
    const deadline = Date.now() + 15_000;
    while (
      (await stat(file).then(
        (s) => s.size,
        () => 0,
      )) === 0
    ) {
      assert.ok(Date.now() < deadline, 'FFmpeg never started writing');
      await sleep(100);
    }
    await sleep(1_000);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const { duration, frames } = probe(file);
    assert.ok(duration > 0.5, `readable, with ${duration} s of what was received`);
    assert.ok(frames > 10, `frames ${frames}`);
  } finally {
    source.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('a capturer with no binary reports a crash with the reason, not a hang', async () => {
  const result = await ffmpegCapturer({ binary: 'no-such-ffmpeg-binary' }).run({
    url: 'udp://127.0.0.1:1',
    file: join(tmpdir(), 'never.ts'),
    durationMs: 1000,
  });
  assert.equal(result.exitCode, -1);
  assert.match(result.stderrTail, /ENOENT/);
});
