// The recorder plan (EP-39; ADR-0007): what gets recorded, in which files, captured when, by which
// slot. Pure — instants in, files out — because the ways it goes wrong are quiet: a zone, a DST
// night, two windows that touch at midnight, a slot that repeats and puts both sides of a cut on
// one worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, planFiles, recorderErrors, type RecorderInput } from '../src/index.ts';

const at = (iso: string) => Date.parse(iso);
const every = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const plan = (
  windows: RecorderInput['windows'],
  from: string,
  to: string,
  over: { timezone?: string; fileMinutes?: number; padSeconds?: number; previous?: 0 | 1 } = {},
) =>
  planFiles(
    {
      timezone: over.timezone ?? 'UTC',
      windows,
      fileMinutes: over.fileMinutes ?? 60,
      padSeconds: over.padSeconds ?? 5,
    },
    at(from),
    at(to),
    over.previous !== undefined ? { slot: over.previous } : undefined,
  );
const hhmm = (iso: string) => iso.slice(11, 19);

test("the product owner's example: 01:00–03:00 is two files, two workers, 10 s of overlap", () => {
  const files = plan(
    [{ days: [...every], from: '01:00', to: '03:00' }],
    '2026-09-28T00:00:00Z',
    '2026-09-29T00:00:00Z',
  );
  assert.deepEqual(
    files.map((f) => [hhmm(f.captureFrom), hhmm(f.captureTo), f.slot]),
    [
      ['00:59:55', '02:00:05', 0], // worker 1
      ['01:59:55', '03:00:05', 1], // worker 2
    ],
  );
  assert.deepEqual(
    files.map((f) => [hhmm(f.fileStart), hhmm(f.fileEnd)]),
    [
      ['01:00:00', '02:00:00'],
      ['02:00:00', '03:00:00'],
    ],
  );
});

test('a window that does not start on the grid: its first file is clipped, the rest are whole hours', () => {
  const files = plan(
    [{ days: [...every], from: '06:30', to: '08:00' }],
    '2026-09-28T00:00:00Z',
    '2026-09-29T00:00:00Z',
  );
  assert.deepEqual(
    files.map((f) => [hhmm(f.fileStart), hhmm(f.fileEnd), f.slot]),
    [
      ['06:30:00', '07:00:00', 0],
      ['07:00:00', '08:00:00', 1],
    ],
  );
});

test('windows that touch at midnight are ONE recording — no gap, slots alternate straight through', () => {
  // 2026-09-28 is a Monday.
  const files = plan(
    [
      { days: ['mon'], from: '22:00', to: '24:00' },
      { days: ['tue'], from: '00:00', to: '02:00' },
    ],
    '2026-09-28T00:00:00Z',
    '2026-09-30T00:00:00Z',
  );
  assert.deepEqual(
    files.map((f) => [f.fileStart.slice(0, 19), f.slot]),
    [
      ['2026-09-28T22:00:00', 0],
      ['2026-09-28T23:00:00', 1],
      ['2026-09-29T00:00:00', 0],
      ['2026-09-29T01:00:00', 1],
    ],
  );
  // Every file ends where the next begins.
  for (let i = 1; i < files.length; i += 1)
    assert.equal(files[i]!.fileStart, files[i - 1]!.fileEnd);
});

test("overlapping windows merge; a day not in `days` records nothing; windows are in the recorder's zone", () => {
  const files = plan(
    [
      { days: ['mon'], from: '10:00', to: '12:00' },
      { days: ['mon'], from: '11:00', to: '13:00' },
    ],
    '2026-09-27T00:00:00Z', // Sunday
    '2026-09-30T00:00:00Z',
    { timezone: 'Europe/London' }, // BST, UTC+1, in September
  );
  assert.deepEqual(
    files.map((f) => f.fileStart.slice(0, 16)),
    ['2026-09-28T09:00', '2026-09-28T10:00', '2026-09-28T11:00'],
  );
});

test('slots continue from the last file planned, so consecutive plan runs never repeat a slot', () => {
  const windows = [{ days: [...every], from: '00:00', to: '24:00' }];
  const a = plan(windows, '2026-09-28T00:00:00Z', '2026-09-28T03:00:00Z');
  const b = plan(windows, '2026-09-28T03:00:00Z', '2026-09-28T06:00:00Z', {
    previous: a[a.length - 1]!.slot,
  });
  const slots = [...a, ...b].map((f) => f.slot);
  assert.deepEqual(slots, [0, 1, 0, 1, 0, 1]);
});

test('a spring DST night records every instant once: the skipped local hour is simply not a file', () => {
  // Europe/London, 2026-03-29: 01:00 GMT becomes 02:00 BST.
  const files = plan(
    [{ days: [...every], from: '00:00', to: '04:00' }],
    '2026-03-28T23:00:00Z',
    '2026-03-29T04:00:00Z',
    { timezone: 'Europe/London' },
  );
  assert.deepEqual(
    files.map((f) => [f.fileStart.slice(11, 16), f.fileEnd.slice(11, 16)]),
    [
      ['00:00', '01:00'], // 00:00–01:00 GMT
      ['01:00', '02:00'], // 02:00–03:00 BST
      ['02:00', '03:00'], // 03:00–04:00 BST
    ],
  );
});

test("an autumn DST night's repeated hour is in ONE file — two hours long, nothing recorded twice", () => {
  // Europe/London, 2026-10-25: 02:00 BST becomes 01:00 GMT; local 01:xx happens twice.
  const files = plan(
    [{ days: [...every], from: '00:00', to: '03:00' }],
    '2026-10-24T22:00:00Z',
    '2026-10-25T04:00:00Z',
    { timezone: 'Europe/London' },
  );
  assert.deepEqual(
    files.map((f) => [f.fileStart.slice(11, 16), f.fileEnd.slice(11, 16), f.slot]),
    [
      ['23:00', '00:00', 0], // 00:00–01:00 BST
      ['00:00', '02:00', 1], // 01:00 BST → 02:00 GMT: both 01:00s
      ['02:00', '03:00', 0], // 02:00–03:00 GMT
    ],
  );
});

test('a local time names the right instant, and the earlier of a repeated one', () => {
  assert.equal(
    new Date(localToUtc('Asia/Tehran', { y: 2026, m: 9, d: 28 }, 9 * 60)).toISOString(),
    '2026-09-28T05:30:00.000Z',
  );
  assert.equal(
    new Date(localToUtc('Europe/London', { y: 2026, m: 10, d: 25 }, 90)).toISOString(),
    '2026-10-25T00:30:00.000Z', // 01:30 BST, not 01:30 GMT
  );
});

test('a recorder that could not run is refused with every reason, each naming its field', () => {
  const good: RecorderInput = {
    name: 'Channel 1 air',
    input: { url: 'srt://encoder-1:9000?mode=caller' },
    timezone: 'Europe/London',
    windows: [{ days: ['mon'], from: '06:00', to: '24:00' }],
  };
  assert.deepEqual(recorderErrors(good), []);
  const errors = recorderErrors({
    name: '',
    input: { url: 'srt://user:secret@encoder-1:9000', passphraseSecret: 'Bad Secret' },
    timezone: 'Mars/Olympus',
    windows: [{ days: ['someday' as 'mon'], from: '23:00', to: '01:00' }],
    fileMinutes: 7,
    padSeconds: 90,
  });
  for (const field of [
    'name',
    'input.url must carry no credential',
    'input.passphraseSecret',
    'timezone',
    'windows[0].days',
    'windows[0].to must be after from',
    'fileMinutes',
    'padSeconds',
  ]) {
    assert.ok(
      errors.some((e) => e.startsWith(field)),
      `${field}: ${errors.join(' | ')}`,
    );
  }
  assert.match(
    recorderErrors({ ...good, input: { url: 'http://x/' } }).join(),
    /input\.url must be one of/,
  );
  assert.match(
    recorderErrors({ ...good, input: { url: 'srt://e:9000?passphrase=abc' } }).join(),
    /no credential/,
  );
});
