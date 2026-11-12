// EP-29.4 — the filmstrip geometry and its WebVTT. Pure arithmetic: the grid FFmpeg is told to pack
// and the cues that index it come from ONE computation, so these tests pin that they agree — every
// cue's rectangle lies inside the sprite the same plan describes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planFilmstrip,
  filmstripFilter,
  filmstripVtt,
  vttTimestamp,
  FILMSTRIP_SPRITE_NAME,
  type FilmstripSpec,
} from '../src/filmstrip.ts';

const SPEC: FilmstripSpec = { columns: 10, cellWidth: 160, cellHeight: 90, maxThumbs: 100 };

test('planFilmstrip: one thumbnail per second for a short clip, grid snug to the count', () => {
  const plan = planFilmstrip(12.5, SPEC);
  assert.equal(plan.intervalSec, 1);
  assert.equal(plan.thumbs, 13); // ceil(12.5 / 1)
  assert.equal(plan.gridColumns, 10);
  assert.equal(plan.gridRows, 2); // ceil(13 / 10)
});

test('planFilmstrip: the interval stretches so a long film never exceeds maxThumbs', () => {
  const plan = planFilmstrip(2 * 60 * 60, SPEC); // 7200 s
  assert.equal(plan.intervalSec, 72); // ceil(7200 / 100)
  assert.equal(plan.thumbs, 100); // ceil(7200 / 72) === 100
  assert.equal(plan.gridColumns, 10);
  assert.equal(plan.gridRows, 10);
});

test('planFilmstrip: fewer thumbnails than a row width shrink the grid, not the cells', () => {
  const plan = planFilmstrip(3, SPEC);
  assert.equal(plan.thumbs, 3);
  assert.equal(plan.gridColumns, 3);
  assert.equal(plan.gridRows, 1);
});

test('planFilmstrip: a clip shorter than one interval still gets its opening frame', () => {
  for (const d of [0, 0.4, 1]) {
    const plan = planFilmstrip(d, SPEC);
    assert.ok(plan.thumbs >= 1, `d=${d} must yield at least one thumbnail`);
    assert.equal(plan.gridColumns, Math.min(SPEC.columns, plan.thumbs));
  }
});

test('filmstripFilter: fps, a fixed letterboxed cell, and the tile grid the plan names', () => {
  const plan = planFilmstrip(12.5, SPEC);
  const vf = filmstripFilter(plan);
  assert.match(vf, /fps=1\/1,/);
  assert.match(vf, /scale=160:90:force_original_aspect_ratio=decrease/);
  assert.match(vf, /pad=160:90:/);
  assert.match(vf, /tile=10x2$/);
});

test('vttTimestamp: whole clock, milliseconds, and padding', () => {
  assert.equal(vttTimestamp(0), '00:00:00.000');
  assert.equal(vttTimestamp(1.5), '00:00:01.500');
  assert.equal(vttTimestamp(3661.5), '01:01:01.500');
});

test('filmstripVtt: one cue per thumbnail, each rectangle inside the sprite, times monotonic', () => {
  const duration = 12.5;
  const plan = planFilmstrip(duration, SPEC);
  const vtt = filmstripVtt(plan, duration);

  assert.ok(vtt.startsWith('WEBVTT\n'), 'a WebVTT file starts with the signature');

  const cues = [...vtt.matchAll(/(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)\n(.+)/g)];
  assert.equal(cues.length, plan.thumbs, 'one cue per thumbnail');

  // The first three cells walk along row 0; the 11th wraps to row 1.
  assert.equal(cues[0]![3], `${FILMSTRIP_SPRITE_NAME}#xywh=0,0,160,90`);
  assert.equal(cues[1]![3], `${FILMSTRIP_SPRITE_NAME}#xywh=160,0,160,90`);
  assert.equal(cues[10]![3], `${FILMSTRIP_SPRITE_NAME}#xywh=0,90,160,90`);

  const spriteWidth = plan.gridColumns * plan.cellWidth;
  const spriteHeight = plan.gridRows * plan.cellHeight;
  let prevStart = -1;
  for (const [, start, end, region] of cues) {
    const toMs = (t: string) => {
      const [h, m, rest] = t.split(':');
      const [s, ms] = rest!.split('.');
      return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
    };
    assert.ok(toMs(start!) > prevStart, 'cue starts increase');
    assert.ok(toMs(end!) > toMs(start!), 'each cue has positive length');
    assert.ok(toMs(end!) <= Math.ceil(duration * 1000), 'no cue runs past the clip');
    prevStart = toMs(start!);

    const [, x, y, w, hgt] = region!.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/)!.map(Number);
    assert.ok(x! + w! <= spriteWidth, 'cell fits the sprite width');
    assert.ok(y! + hgt! <= spriteHeight, 'cell fits the sprite height');
  }
});
