#!/usr/bin/env node
// Spike for ADR-0007 (recorders), part two: padded, OVERLAPPING window captures.
//
//   node scripts/spikes/recorder-windows.mjs
//
// The accepted design records each hour as its own capture, from 5 s before the hour to 5 s after
// it, so neighbouring files overlap and two captures run at once at every boundary. Two questions
// decide whether that works, answered with ffprobe:
//
//   1. START COST — a capture is a NEW process joining a live stream. How much of its window is
//      lost before the first usable frame (it must wait for a keyframe)? The pad must cover it.
//   2. TWO READERS — can two captures take the same input at once? Over unicast UDP only one
//      socket receives each datagram; over multicast every member does.
//
// A sender streams a test pattern (25 fps, GOP 2 s) in real time, to unicast and then to a
// multicast group on the loopback interface. Needs ffmpeg + ffprobe. About 70 s. Prints JSON.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const FPS = 25;
const GOP = 50;
const WINDOW_SECONDS = 8;

function sender(url, seconds) {
  return spawn(
    'ffmpeg',
    [
      ...['-nostdin', '-loglevel', 'error', '-re'],
      ...['-f', 'lavfi', '-i', `testsrc=size=640x360:rate=${FPS}:duration=${seconds}`],
      ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(GOP)],
      ...['-keyint_min', String(GOP), '-sc_threshold', '0', '-c:a', 'aac'],
      ...['-f', 'mpegts', url],
    ],
    { stdio: 'ignore' },
  );
}

/** One window: a new process, bounded by `-t`, stream copy, the inner muxer flushing packets. */
function capture(url, file) {
  const started = Date.now();
  const child = spawn(
    'ffmpeg',
    [
      ...['-nostdin', '-loglevel', 'error', '-i', url, '-t', String(WINDOW_SECONDS)],
      ...['-c', 'copy', '-map', '0', '-flush_packets', '1', '-f', 'mpegts', file],
    ],
    { stdio: 'ignore' },
  );
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), (WINDOW_SECONDS + 10) * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, wallSeconds: (Date.now() - started) / 1000 });
    });
  });
}

function probe(file) {
  let bytes = 0;
  try {
    bytes = statSync(file).size;
  } catch {
    return { bytes: 0, readable: false };
  }
  try {
    const out = execFileSync(
      'ffprobe',
      [
        ...['-v', 'error', '-select_streams', 'v:0', '-count_frames'],
        ...['-show_entries', 'stream=nb_read_frames:format=duration', '-of', 'json', file],
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const j = JSON.parse(out);
    const decoded = Number(j.streams?.[0]?.nb_read_frames ?? 0);
    return {
      bytes,
      readable: true,
      duration: Number(Number(j.format?.duration).toFixed(3)),
      decodedFrames: decoded,
      // What the window asked for, less what came out decodable: the start cost.
      lostSeconds: Number((WINDOW_SECONDS - decoded / FPS).toFixed(2)),
    };
  } catch {
    return { bytes, readable: false };
  }
}

async function twoReaders(label, sendUrl, readUrl) {
  const dir = mkdtempSync(join(tmpdir(), `win-${label}-`));
  const snd = sender(sendUrl, 25);
  // Join a stream already running, at an arbitrary point in its GOP — as an hourly window does.
  await sleep(3300);
  const a = capture(readUrl, join(dir, 'a.ts'));
  await sleep(1700); // the second starts part-way through the first, as at an overlap
  const b = capture(readUrl, join(dir, 'b.ts'));
  const [ra, rb] = await Promise.all([a, b]);
  snd.kill('SIGKILL');
  const result = {
    label,
    windowSeconds: WINDOW_SECONDS,
    gopSeconds: GOP / FPS,
    a: { ...ra, ...probe(join(dir, 'a.ts')) },
    b: { ...rb, ...probe(join(dir, 'b.ts')) },
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

const port = () => 13000 + Math.floor(Math.random() * 1000);
const u = port();
const unicast = await twoReaders(
  'unicast',
  `udp://127.0.0.1:${u}?pkt_size=1316`,
  `udp://127.0.0.1:${u}?reuse=1&fifo_size=1000000&overrun_nonfatal=1&timeout=4000000`,
);
const m = port();
const multicast = await twoReaders(
  'multicast',
  // No `localaddr`: on Windows, binding the group to the loopback address delivers nothing at
  // all (measured) — the host's default interface, with TTL 1, keeps it on this machine.
  `udp://239.255.42.1:${m}?pkt_size=1316&ttl=1`,
  `udp://239.255.42.1:${m}?reuse=1&fifo_size=1000000&overrun_nonfatal=1&timeout=4000000`,
);
const ffmpeg = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
console.log(JSON.stringify({ ffmpeg, platform: process.platform, unicast, multicast }, null, 2));
