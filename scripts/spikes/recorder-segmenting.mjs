#!/usr/bin/env node
// Spike for ADR-0007 (recorders): what FFmpeg's segment muxer actually does to a LIVE input.
//
//   node scripts/spikes/recorder-segmenting.mjs
//
// A sender streams a test pattern as MPEG-TS over UDP in real time (GOP 2 s), the way an encoder
// or an SDI-to-IP gateway would. A recorder takes it with `-c copy` into segments. Three
// questions, answered by ffprobe rather than by reading documentation:
//
//   1. GAPLESS — does each segment start where the previous one ended (no lost frames at a cut)?
//      And with stream copy, where do cuts land relative to the requested segment time?
//   2. FINALISATION — does the segment list name a segment only once it is finished, so it can be
//      the signal "this file is complete, ingest it"?
//   3. CRASH — killed hard mid-segment, is the partial file readable, and how much of it?
//
// Needs ffmpeg and ffprobe on PATH. Takes about 40 s (real time: it is a live input). Prints JSON.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 12000 + Math.floor(Math.random() * 1000);
const URL_OUT = `udp://127.0.0.1:${PORT}?pkt_size=1316`;
const URL_IN = `udp://127.0.0.1:${PORT}?fifo_size=1000000&overrun_nonfatal=1`;
const FPS = 25;
const GOP = 50; // 2 s — a common broadcast contribution GOP
const SEGMENT_SECONDS = 5;

function sender(seconds) {
  return spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-re',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=640x360:rate=${FPS}:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      String(GOP),
      '-keyint_min',
      String(GOP),
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-f',
      'mpegts',
      URL_OUT,
    ],
    { stdio: 'ignore' },
  );
}

function recorder(dir, extra = []) {
  return spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      URL_IN,
      '-c',
      'copy',
      '-map',
      '0',
      ...extra,
      '-f',
      'segment',
      '-segment_time',
      String(SEGMENT_SECONDS),
      '-segment_format',
      'mpegts',
      '-segment_list',
      join(dir, 'list.csv'),
      '-segment_list_type',
      'csv',
      join(dir, 'seg-%03d.ts'),
    ],
    { stdio: 'ignore' },
  );
}

function probe(file) {
  const bytes = statSync(file).size;
  let out;
  try {
    out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_packets',
        '-show_entries',
        'stream=nb_read_packets:format=start_time,duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const lines = String(err.stderr ?? err.message)
      .trim()
      .split(/\r?\n/);
    return { readable: false, bytes, error: lines[lines.length - 1] };
  }
  const j = JSON.parse(out);
  return {
    readable: true,
    bytes,
    start: Number(j.format?.start_time),
    duration: Number(j.format?.duration),
    frames: Number(j.streams?.[0]?.nb_read_packets ?? 0),
  };
}

const segmentsIn = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort();
const listed = (dir) => {
  try {
    return readFileSync(join(dir, 'list.csv'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(',')[0]);
  } catch {
    return [];
  }
};

async function run(label, { sendSeconds, killAfterMs, hardKill, extra = [] }) {
  const dir = mkdtempSync(join(tmpdir(), `rec-${label}-`));
  const rec = recorder(dir, extra);
  await sleep(1000); // the recorder is listening before the first packet
  const snd = sender(sendSeconds);
  const listedMidway = [];
  const started = Date.now();
  while (Date.now() - started < killAfterMs) {
    await sleep(500);
    const onDisk = segmentsIn(dir);
    const inList = listed(dir);
    // What is on disk but NOT in the list: the one being written.
    listedMidway.push({
      t: Math.round((Date.now() - started) / 100) / 10,
      onDisk: onDisk.length,
      listed: inList.length,
    });
  }
  rec.kill(hardKill ? 'SIGKILL' : 'SIGINT');
  snd.kill('SIGKILL');
  await sleep(1500);
  const files = segmentsIn(dir);
  const segs = files.map((f) => ({ file: f, ...probe(join(dir, f)) }));
  const readable = segs.filter((s) => s.readable);
  const gaps = readable
    .slice(1)
    .map((s, i) => Math.round((s.start - (readable[i].start + readable[i].duration)) * 1000));
  const result = {
    label,
    recorderExtraArgs: extra,
    requestedSegmentSeconds: SEGMENT_SECONDS,
    gopSeconds: GOP / FPS,
    segments: segs.map((s) =>
      s.readable
        ? { file: s.file, bytes: s.bytes, duration: +s.duration.toFixed(3), frames: s.frames }
        : { file: s.file, bytes: s.bytes, readable: false, error: s.error },
    ),
    gapsBetweenSegmentsMs: gaps,
    listedAtEnd: listed(dir),
    // Was there ever a moment where a file existed on disk that the list did not name?
    listLagsDisk: listedMidway.some((m) => m.onDisk > m.listed),
    listNeverAhead: listedMidway.every((m) => m.listed <= m.onDisk),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// NOTE: on Windows, Node's kill('SIGINT') is an abrupt TerminateProcess like SIGKILL — there are
// no signals — so there every run is a hard kill. On Linux the `stop` run is a graceful SIGINT.
const stop = await run('stop', { sendSeconds: 16, killAfterMs: 17000, hardKill: false });
const crash = await run('crash', { sendSeconds: 30, killAfterMs: 12000, hardKill: true });
// The same crash, with every packet written as it arrives rather than in buffered blocks.
const crashFlushed = await run('crash-flush-packets', {
  sendSeconds: 30,
  killAfterMs: 12000,
  hardKill: true,
  extra: ['-flush_packets', '1'],
});
// …with the option passed to the INNER muxer, which is the one that writes each segment file.
const crashInnerFlushed = await run('crash-inner-flush-packets', {
  sendSeconds: 30,
  killAfterMs: 12000,
  hardKill: true,
  extra: ['-segment_format_options', 'flush_packets=1'],
});
const ffmpeg = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
console.log(
  JSON.stringify(
    { ffmpeg, platform: process.platform, stop, crash, crashFlushed, crashInnerFlushed },
    null,
    2,
  ),
);
