import test from 'node:test';
import assert from 'node:assert/strict';
import { addDuration } from '../src/index.ts';

const at = (iso: string): Date => new Date(iso);
const iso = (d: Date): string => d.toISOString();

test('days, weeks and time are exact', () => {
  assert.equal(iso(addDuration(at('2026-11-27T10:00:00Z'), 'P30D')), '2026-12-27T10:00:00.000Z');
  assert.equal(iso(addDuration(at('2026-11-27T10:00:00Z'), 'P2W')), '2026-12-11T10:00:00.000Z');
  assert.equal(iso(addDuration(at('2026-11-27T10:00:00Z'), 'PT36H30M15S')), '2026-11-28T22:30:15.000Z');
  assert.equal(iso(addDuration(at('2026-11-27T10:00:00Z'), 'P1DT1H')), '2026-11-28T11:00:00.000Z');
});

test('months and years are calendar units, clamped to the month end', () => {
  assert.equal(iso(addDuration(at('2026-01-31T00:00:00Z'), 'P1M')), '2026-02-28T00:00:00.000Z');
  assert.equal(iso(addDuration(at('2028-02-29T12:00:00Z'), 'P1Y')), '2029-02-28T12:00:00.000Z');
  assert.equal(iso(addDuration(at('2026-11-15T00:00:00Z'), 'P1Y2M')), '2028-01-15T00:00:00.000Z');
  assert.equal(iso(addDuration(at('2026-03-31T08:00:00Z'), 'P1M1D')), '2026-05-01T08:00:00.000Z');
});

test('a value that is not a duration is refused, not read as zero', () => {
  for (const bad of ['', 'P', 'PT', '30D', 'P30', 'P1.5D', 'forever']) {
    assert.throws(() => addDuration(at('2026-11-27T00:00:00Z'), bad), RangeError, bad);
  }
});
